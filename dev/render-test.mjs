// Рендер клиентского бандла плагина в jsdom через react-native-web: проверяем,
// что поверхность не падает и показывает ожидаемые состояния (доска, пустые
// колонки, ошибка + Retry, live-обновление, выпадашка проектов).
//
// Зависимости ставятся разово и НЕ пишутся в package.json (в продакшене плагина
// их нет):  npm install --no-save react-dom@19.1.0 react-native-web jsdom
//
// Запуск:  FIXTURE='<json снапшота>' [MODE=error] node dev/render-test.mjs
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const nodeRequire = createRequire('/home/devuser/paseo-plugins/kanban-board/package.json');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.ShadowRoot = dom.window.ShadowRoot ?? class ShadowRoot {};
globalThis.CSSStyleSheet = dom.window.CSSStyleSheet;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = nodeRequire('react');
const ReactDOMClient = nodeRequire('react-dom/client');
const { act } = nodeRequire('react');
const RNW = nodeRequire('react-native-web');

const { compilePlugin } = await import('/usr/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js');
const { clientBundle } = await compilePlugin('/home/devuser/paseo-plugins/kanban-board/index.ts');

// Данные, которые «вернёт» сервер плагина
const snapshotFixture = JSON.parse(process.env.FIXTURE);
let versionCounter = snapshotFixture.version;
const rpcImpl = {
  'kanban.snapshot': () => Promise.resolve(process.env.MODE === 'error'
    ? { ok: false, error: 'kanban API недоступен по http://mcp-hub:3010 — fetch failed', snapshot: null }
    : { ok: true, error: null, snapshot: structuredClone(snapshotFixture) }),
  'kanban.version': () => Promise.resolve({ ok: true, error: null, version: versionCounter, connected: true }),
  'kanban.projects': () => Promise.resolve({ ok: true, error: null, projects: snapshotFixture.projects }),
};
// Настоящий useRpc отдаёт стабильный колбэк — иначе эффекты клиента
// пересоздавались бы на каждый рендер. Стаб держим таким же стабильным.
const rpcCallbacks = new Map();
const sdkStub = {
  defineRpc: (d) => d,
  useRpc: (contract) => {
    let fn = rpcCallbacks.get(contract.name);
    if (!fn) {
      fn = (input) => rpcImpl[contract.name](input);
      rpcCallbacks.set(contract.name, fn);
    }
    return fn;
  },
};
function bundleRequire(spec) {
  if (spec === 'zod') return nodeRequire('zod');
  if (spec === 'react') return React;
  if (spec === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime');
  if (spec === 'react-native') return RNW;
  if (spec.startsWith('@getpaseo/plugin')) return sdkStub;
  return nodeRequire(spec);
}
const contribute = eval(clientBundle)(bundleRequire).default;

let Surface = null;
const sidebar = [];
contribute({
  handle: () => {},
  addSurface: (id, Component) => { Surface = Component; },
  addSidebarItem: (item) => sidebar.push(item),
  addWorkspacePanel: () => {},
  addCommandCenterItem: () => {},
  addAttachmentSource: () => {},
  addTheme: () => {},
});
console.log('сайдбар:', JSON.stringify(sidebar));

const theme = { colors: { surface0: '#18181b', foreground: '#fafafa', foregroundMuted: '#a1a1aa', accent: '#e4e4e7', accentForeground: '#18181b', statusDanger: '#c44a4a' } };
const props = { theme, host: { id: 'test', label: 'test' }, layout: { compact: false, platform: 'web' } };

const root = ReactDOMClient.createRoot(document.getElementById('root'));
await act(async () => { root.render(React.createElement(Surface, props)); });
await act(async () => { await new Promise(r => setTimeout(r, 50)); });
const text = () => document.getElementById('root').textContent;
console.log('--- после загрузки ---');
console.log(text().slice(0, 600));

// Выпадашка проектов: жмём на имя проекта и смотрим, что список раскрылся.
if (process.env.MODE !== 'error') {
  const trigger = document.querySelector('[aria-label="Выбрать проект"]');
  await act(async () => { trigger.click(); });
  const menuItems = [...document.querySelectorAll('[aria-label^="Открыть проект"]')].map((n) => n.textContent);
  console.log('--- выпадашка проектов ---');
  console.log('пунктов:', menuItems.length, '|', menuItems.join(' / '));
  const backdrop = document.querySelector('[aria-label="Закрыть список проектов"]');
  await act(async () => { backdrop.click(); });
  console.log('после закрытия пунктов:', document.querySelectorAll('[aria-label^="Открыть проект"]').length);
}

if (process.env.MODE !== 'error' && snapshotFixture.tickets.length > 0) {
  // Живое обновление: меняем данные и крутим версию — доска должна перезабрать снапшот
  snapshotFixture.tickets[0].title = 'ИЗМЕНЁННЫЙ ЗАГОЛОВОК';
  versionCounter += 1;
  snapshotFixture.version = versionCounter;
  await act(async () => { await new Promise(r => setTimeout(r, 2500)); });
  console.log('--- после live-обновления ---');
  console.log('содержит новый заголовок:', text().includes('ИЗМЕНЁННЫЙ ЗАГОЛОВОК'));
}
process.exit(0);
