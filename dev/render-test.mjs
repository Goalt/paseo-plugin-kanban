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
const moveCalls = [];
const createCalls = [];
const updateCalls = [];
const subtaskCalls = [];
const completeCalls = [];
const deleteCalls = [];
const projectDeleteCalls = [];
// «Память сервера плагина» для теста перемонтирования.
let storedProjectId = process.env.STORED_PROJECT ?? null;
const snapshotCalls = [];
const rpcImpl = {
  'kanban.snapshot': ({ projectId }) => (snapshotCalls.push(projectId ?? null), Promise.resolve(process.env.MODE === 'error'
    ? { ok: false, error: 'kanban API недоступен по http://mcp-hub:3010 — fetch failed', snapshot: null }
    : { ok: true, error: null, snapshot: structuredClone(snapshotFixture) })),
  'kanban.version': () => Promise.resolve({ ok: true, error: null, version: versionCounter, connected: true }),
  'kanban.projects': () => Promise.resolve({ ok: true, error: null, projects: snapshotFixture.projects }),
  'kanban.state.get': () => Promise.resolve({ ok: true, error: null, projectId: storedProjectId }),
  'kanban.state.set': ({ projectId }) => {
    storedProjectId = projectId;
    return Promise.resolve({ ok: true, error: null });
  },
  'kanban.ticket': ({ ticketId }) => {
    const card = snapshotFixture.tickets.find((t) => t.id === ticketId);
    if (!card) return Promise.resolve({ ok: false, error: 'тикет не найден', ticket: null });
    const doneColumn = snapshotFixture.columns.find((c) => c.name === 'Done');
    const subtasks = snapshotFixture.tickets
      .filter((t) => t.parent_ticket_id === card.id)
      .map((t) => ({ id: t.id, ticket_number: t.ticket_number, title: t.title, priority: t.priority, column_id: t.column_id, done: t.column_id === doneColumn?.id }));
    return Promise.resolve({
      ok: true,
      error: null,
      ticket: {
        ...card,
        project_id: 'p1',
        description: `Описание тикета #${card.ticket_number}`,
        created_at: '2026-09-06T18:00:00.000Z',
        updated_at: '2026-09-06T19:00:00.000Z',
        subtasks,
        subtask_total: subtasks.length,
        subtask_completed: subtasks.filter((t) => t.done).length,
        attachments: [{ id: 'a1', file_path: '/tmp/shots/demo.mp4', file_type: 'video' }],
        dependencies: card.ticket_number === 1
          ? [
              { id: 'd1', type: 'blocked_by', direction: 'outgoing', ticket_id: 't2', ticket_number: 2, title: '[S1] UI доски read-only' },
              { id: 'd2', type: 'related_to', direction: 'incoming', ticket_id: 't30', ticket_number: 30, title: 'Зависимости в модалке' },
              { id: 'd3', type: 'blocks', direction: 'outgoing', ticket_id: 'tX', ticket_number: null, title: null },
            ]
          : [],
      },
    });
  },
  'kanban.ticket.create': (input) => {
    createCalls.push(input);
    const number = 100 + createCalls.length;
    snapshotFixture.tickets.push({
      id: 'new' + number, ticket_number: number, title: input.title, priority: input.priority ?? null,
      column_id: input.columnId, session_id: null, parent_ticket_id: null, parent_ticket_number: null,
      subtask_total: 0, subtask_completed: 0, order: number,
    });
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    return Promise.resolve({ ok: true, error: null, ticketId: 'new' + number });
  },
  'kanban.ticket.update': (input) => {
    updateCalls.push(input);
    const card = snapshotFixture.tickets.find((t) => t.id === input.ticketId);
    if (card) {
      if (input.title !== undefined) card.title = input.title;
      if (input.priority !== undefined) card.priority = input.priority;
    }
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    return Promise.resolve({ ok: true, error: null });
  },
  'kanban.subtask.create': ({ parentTicketId, title }) => {
    subtaskCalls.push({ parentTicketId, title });
    const parent = snapshotFixture.tickets.find((t) => t.id === parentTicketId);
    const number = 200 + subtaskCalls.length;
    snapshotFixture.tickets.push({
      id: 'sub' + number, ticket_number: number, title, priority: null, column_id: parent.column_id,
      session_id: null, parent_ticket_id: parentTicketId, parent_ticket_number: parent.ticket_number,
      subtask_total: 0, subtask_completed: 0, order: number,
    });
    parent.subtask_total += 1;
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    return Promise.resolve({ ok: true, error: null, ticketId: 'sub' + number });
  },
  'kanban.subtask.complete': ({ ticketId }) => {
    completeCalls.push(ticketId);
    const sub = snapshotFixture.tickets.find((t) => t.id === ticketId);
    const done = snapshotFixture.columns.find((c) => c.name === 'Done');
    if (sub) {
      sub.column_id = done.id;
      const parent = snapshotFixture.tickets.find((t) => t.id === sub.parent_ticket_id);
      if (parent) parent.subtask_completed += 1;
    }
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    return Promise.resolve({ ok: true, error: null });
  },
  'kanban.ticket.delete': ({ ticketId }) => {
    deleteCalls.push(ticketId);
    const index = snapshotFixture.tickets.findIndex((t) => t.id === ticketId);
    if (index >= 0) snapshotFixture.tickets.splice(index, 1);
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    return Promise.resolve({ ok: true, error: null });
  },
  'kanban.project.delete': ({ projectId }) => {
    projectDeleteCalls.push(projectId);
    if (process.env.PROJECT_DELETE_FAIL === '1') {
      return Promise.resolve({
        ok: false,
        error: 'DELETE /api/projects/' + projectId + ': Cannot delete the only project (HTTP 400)',
      });
    }
    const index = snapshotFixture.projects.findIndex((p) => p.id === projectId);
    if (index >= 0) snapshotFixture.projects.splice(index, 1);
    // Сервер плагина забывает выбор и откатывается на первый проект (fetchBoard).
    if (snapshotFixture.project?.id === projectId) {
      snapshotFixture.project = snapshotFixture.projects[0] ?? null;
      // У соседнего проекта свои тикеты — в фикстуре их нет, доска должна пережить пустоту.
      snapshotFixture.tickets = [];
    }
    if (storedProjectId === projectId) storedProjectId = null;
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    return Promise.resolve({ ok: true, error: null });
  },
  'kanban.ticket.move': ({ ticketId, columnId }) => {
    moveCalls.push({ ticketId, columnId });
    if (process.env.MODE === 'mutation-error') {
      return new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, error: 'PUT /api/tickets/x/move: Ticket not found (HTTP 404)' }), 40),
      );
    }
    const card = snapshotFixture.tickets.find((t) => t.id === ticketId);
    if (card) card.column_id = columnId;
    versionCounter += 1;
    snapshotFixture.version = versionCounter;
    // Небольшая задержка — чтобы было видно, ловится ли двойной клик защёлкой.
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, error: null }), 60));
  },
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

// Палитры взяты из toPluginTheme демона (тёмная zinc и светлая по умолчанию).
const THEMES = {
  dark: { surface0: '#18181b', foreground: '#fafafa', foregroundMuted: '#a1a1aa', accent: '#e4e4e7', accentForeground: '#18181b', statusDanger: '#c44a4a' },
  light: { surface0: '#ffffff', foreground: '#1a1a1e', foregroundMuted: '#71717a', accent: '#20744A', accentForeground: '#ffffff', statusDanger: '#9d433b' },
};
// Фикстура без проектов (все удалены) — теоретический, но не запрещённый кейс:
// интерактивные сценарии на ней пропускаем, проверяем только empty-states.
const emptyBoard = snapshotFixture.projects.length === 0;
const themeName = process.env.THEME ?? 'dark';
const compact = process.env.COMPACT === '1';
const theme = { colors: THEMES[themeName] ?? THEMES.dark };
const props = { theme, host: { id: 'test', label: 'test' }, layout: { compact, platform: 'web' } };

let root = ReactDOMClient.createRoot(document.getElementById('root'));
await act(async () => { root.render(React.createElement(Surface, props)); });
await act(async () => { await new Promise(r => setTimeout(r, 50)); });
const text = () => document.getElementById('root').textContent;
if (process.env.DUMP) {
  // Открываем модалку, если просили: на скриншоте нужно и её оформление.
  if (process.env.DUMP_MODAL === '1') {
    const anyCard = document.querySelector('[aria-label^="Открыть тикет #"]');
    await act(async () => { anyCard.click(); });
    // Modal у RN-web появляется через fade-анимацию: снимать дамп раньше её
    // окончания бессмысленно — в HTML уедет полупрозрачное промежуточное состояние.
    await act(async () => { await new Promise(r => setTimeout(r, 900)); });
  }
  const { writeFileSync } = await import('node:fs');
  // react-native-web добавляет правила через CSSOM (insertRule), а такие правила
  // в outerHTML не сериализуются — вытаскиваем их из document.styleSheets вручную,
  // иначе в дампе не будет ни раскладки, ни цветов.
  const css = [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  const bodyBackground = theme.colors.surface0;
  writeFileSync(
    process.env.DUMP,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:${bodyBackground};}#root{height:100%;display:flex;flex-direction:column;}
/* fade-анимация Modal при открытии дампа в Chrome стартует заново и попадает
   в кадр полупрозрачной — для статичного снимка её глушим. */
*{animation:none !important;opacity:inherit;}\n${css}</style></head><body>${document.body.innerHTML}</body></html>`,
    'utf8',
  );
  console.log('HTML дамп записан:', process.env.DUMP, '| тема:', themeName, '| compact:', compact);
  process.exit(0);
}

console.log('--- после загрузки ---');
console.log('счётчик в работе:', document.querySelector('[aria-label^="В работе"]')?.textContent ?? '(нет)');
console.log(text().slice(0, 600));

// Создание тикета из колонки: «+» → форма → Create.
if (process.env.MODE !== 'error' && !emptyBoard) {
  console.log('--- создание тикета ---');
  const plus = document.querySelector('[aria-label="Создать тикет в Todo"]');
  await act(async () => { plus.click(); });
  const createButton = () => document.querySelector('[aria-label="Создать тикет"]');
  console.log('форма открылась:', createButton() !== null);
  console.log('Create при пустом заголовке disabled:', createButton()?.getAttribute('aria-disabled') === 'true' || createButton()?.disabled === true);
  const titleInput = document.querySelector('[aria-label="Заголовок тикета"]');
  const descInput = document.querySelector('[aria-label="Описание тикета"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(titleInput, 'тикет из UI');
    titleInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const areaSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    areaSetter.call(descInput, 'описание из UI');
    descInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => { document.querySelector('[aria-label="Приоритет urgent"]').click(); });
  console.log('Create после ввода disabled:', createButton()?.getAttribute('aria-disabled') === 'true');
  await act(async () => { createButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  console.log('createTicket вызван с:', JSON.stringify(createCalls[0]));
  console.log('форма закрылась:', document.querySelector('[aria-label="Создать тикет"]') === null);
  console.log('карточка на доске:', text().includes('тикет из UI'));
}

// Перемещение с карточки: ◀ ▶ и защита от двойного клика.
if (process.env.MODE !== 'error' && snapshotFixture.tickets.length > 0) {
  const card = snapshotFixture.tickets.find((t) => t.column_id === 'c1');
  const next = document.querySelector(`[aria-label="Переместить #${card.ticket_number} в Todo"]`);
  console.log('--- перемещение с карточки ---');
  console.log('кнопка ▶ есть:', next !== null);
  console.log('кнопка ◀ у первой колонки:', document.querySelector(`[aria-label="Переместить #${card.ticket_number} в Backlog"]`) !== null);
  await act(async () => { next.click(); next.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  console.log('вызовов move после двойного клика:', moveCalls.length, '| колонка тикета:', card.column_id);
  const toast = document.querySelector('[aria-label="Скрыть сообщение об ошибке"]');
  console.log('тост об ошибке:', toast === null ? '(нет — мутация прошла)' : toast.textContent);
  if (toast !== null) {
    await act(async () => { toast.click(); });
    console.log('после тапа тост исчез:', document.querySelector('[aria-label="Скрыть сообщение об ошибке"]') === null);
  }
}

// Модалка деталей: тапаем по карточке.
if (process.env.MODE !== 'error' && snapshotFixture.tickets.length > 0) {
  const first = snapshotFixture.tickets[0];
  const card = document.querySelector(`[aria-label="Открыть тикет #${first.ticket_number}"]`);
  await act(async () => { card.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  console.log('--- модалка деталей ---');
  // RN-web рендерит Modal порталом в body, а не внутрь #root.
  const dialog = document.querySelector('[aria-label="Закрыть окно тикета"]')?.parentElement;
  console.log('модалка открылась:', dialog !== undefined && dialog !== null);
  console.log((dialog?.textContent ?? '(модалки нет)').slice(0, 400));
  const chips = [...document.querySelectorAll('[aria-label^="Переместить в "]')].map((n) => n.textContent);
  console.log('чипы колонок в модалке:', chips.join(' / '));

  // Зависимости: подписи, цвет блокировки и переход по связи.
  console.log('--- зависимости в модалке ---');
  const depRows = [...document.querySelectorAll('[aria-label^="Открыть зависимость"]')];
  const depDialog = document.querySelector('[aria-label="Закрыть окно тикета"]')?.parentElement;
  const depSection = depDialog?.textContent.match(/Зависимости(.*?)Вложения/s)?.[1] ?? '(секции нет)';
  console.log('строки связей:', depSection.replace(/\s+/g, ' ').trim());
  console.log('кликабельных связей:', depRows.length, '(третья — из другого проекта, без перехода)');
  await act(async () => { depRows[0].click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 80)); });
  const header = document.querySelector('[aria-label="Закрыть окно тикета"]')?.parentElement?.textContent ?? '';
  console.log('после тапа открылся тикет:', header.slice(0, 60));
  // возвращаемся к исходному тикету
  await act(async () => { document.querySelector('[aria-label="Закрыть"]').click(); });
  await act(async () => {
    document.querySelector(`[aria-label="Открыть тикет #${first.ticket_number}"]`).click();
  });
  await act(async () => { await new Promise(r => setTimeout(r, 80)); });

  // Сабтаски: добавить и завершить.
  console.log('--- сабтаски в модалке ---');
  const subInput = document.querySelector('[aria-label="Заголовок нового сабтаска"]');
  const addButton = () => document.querySelector('[aria-label="Добавить сабтаск"]');
  console.log('«Добавить» при пустом поле disabled:', addButton()?.getAttribute('aria-disabled') === 'true');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(subInput, 'новый сабтаск из UI');
    subInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => { addButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  console.log('createSubtask вызван с:', JSON.stringify(subtaskCalls[0]));
  const boxes = [...document.querySelectorAll('[aria-label^="Завершить сабтаск"]')];
  console.log('чекбоксов сабтасков:', boxes.length, '| disabled у завершённого:', boxes.map((b) => b.getAttribute('aria-disabled')).join(','));
  const open2 = boxes.find((b) => b.getAttribute('aria-disabled') !== 'true');
  await act(async () => { open2.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 150)); });
  console.log('completeSubtask вызван:', completeCalls.length, '| прогресс на доске:', text().match(/\d+\/\d+/g)?.join(' '));

  // Режим редактирования: Изменить → правки → Save.
  await act(async () => { document.querySelector('[aria-label="Редактировать тикет"]').click(); });
  const titleField = document.querySelector('[aria-label="Заголовок тикета"]');
  console.log('форма редактирования открылась:', titleField !== null, '| значение подставлено:', titleField?.value);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(titleField, '');
    titleField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const saveButton = () => document.querySelector('[aria-label="Сохранить тикет"]');
  console.log('Save при пустом заголовке disabled:', saveButton()?.getAttribute('aria-disabled') === 'true');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(titleField, 'заголовок из модалки');
    titleField.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => { document.querySelector('[aria-label="Приоритет low"]').click(); });
  await act(async () => { saveButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  console.log('updateTicket вызван с:', JSON.stringify(updateCalls[0]));
  console.log('форма закрылась:', document.querySelector('[aria-label="Заголовок тикета"]') === null);
  console.log('доска показывает новый заголовок:', text().includes('заголовок из модалки'));
  // Закрытие по крестику (и повторное открытие для сценария удаления).
  await act(async () => { document.querySelector('[aria-label="Закрыть"]').click(); });
  console.log('✕ закрывает модалку:', document.querySelector('[aria-label="Закрыть окно тикета"]') === null);
  await act(async () => {
    document.querySelector(`[aria-label="Открыть тикет #${first.ticket_number}"]`).click();
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });

  // Удаление: Delete → подтверждение → Удалить.
  console.log('--- удаление тикета ---');
  await act(async () => { document.querySelector('[aria-label="Удалить тикет"]').click(); });
  const confirmNode = document.querySelector('[aria-label="Подтвердить удаление"]');
  console.log('подтверждение показано:', confirmNode !== null);
  console.log('текст подтверждения:', confirmNode?.parentElement?.parentElement?.textContent?.slice(0, 200));
  await act(async () => { document.querySelector('[aria-label="Отменить удаление"]').click(); });
  console.log('после «Отмена» удаление не вызвано:', deleteCalls.length === 0, '| кнопка Delete снова видна:', document.querySelector('[aria-label="Удалить тикет"]') !== null);
  await act(async () => { document.querySelector('[aria-label="Удалить тикет"]').click(); });
  await act(async () => { document.querySelector('[aria-label="Подтвердить удаление"]').click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 120)); });
  console.log('delete вызван:', deleteCalls.length, '| модалка закрылась:', document.querySelector('[aria-label="Закрыть окно тикета"]') === null);
  console.log('карточка исчезла с доски:', !text().includes('заголовок из модалки'));
}

// Перемонтирование поверхности: выбор проекта живёт на сервере плагина.
if (process.env.MODE !== 'error' && !emptyBoard) {
  console.log('--- перемонтирование поверхности ---');
  await act(async () => { document.querySelector('[aria-label="Выбрать проект"]').click(); });
  await act(async () => { document.querySelector('[aria-label="Открыть проект freqtrade"]').click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
  console.log('в память сервера записан проект:', storedProjectId);
  await act(async () => { root.unmount(); });
  const root2 = ReactDOMClient.createRoot(document.getElementById('root'));
  await act(async () => { root2.render(React.createElement(Surface, props)); });
  await act(async () => { await new Promise(r => setTimeout(r, 80)); });
  console.log('после перемонтирования запрошен projectId:', snapshotCalls[snapshotCalls.length - 1]);
  root = root2;
}

// Фильтр по сессии.
if (process.env.MODE !== 'error' && !emptyBoard) {
  console.log('--- фильтр по сессии ---');
  await act(async () => { document.querySelector('[aria-label="Фильтр по сессии"]').click(); });
  const options = [...document.querySelectorAll('[aria-label^="Фильтр по сессии "], [aria-label="Показать все сессии"]')].map((n) => n.textContent);
  console.log('пункты фильтра:', options.join(' / '));
  await act(async () => { document.querySelector('[aria-label="Фильтр по сессии main"]').click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  const filtered = text();
  console.log('подзаголовок:', filtered.match(/\d+ из \d+ тикетов[^·]*/)?.[0]?.trim());
  const visible = () => [...document.querySelectorAll('[aria-label^="Открыть тикет #"]')].map((n) => n.getAttribute('aria-label').replace('Открыть тикет ', ''));
  const withSession = snapshotFixture.tickets.filter((t) => t.session_id === 's1').map((t) => '#' + t.ticket_number);
  console.log('видны карточки:', visible().join(' '), '| ожидались (сессия main):', withSession.join(' '));
  console.log('совпало:', JSON.stringify(visible().sort()) === JSON.stringify(withSession.sort()));
  console.log('пустая колонка под фильтром:', (filtered.match(/Пусто/g) ?? []).length, 'шт.');
  await act(async () => { document.querySelector('[aria-label="Фильтр по сессии"]').click(); });
  await act(async () => { document.querySelector('[aria-label="Показать все сессии"]').click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  console.log('после снятия фильтра тикеты вернулись:', text().includes('#2'));
}

// Выпадашка проектов: жмём на имя проекта и смотрим, что список раскрылся.
if (process.env.MODE !== 'error') {
  const trigger = document.querySelector('[aria-label="Выбрать проект"]');
  await act(async () => { trigger.click(); });
  const menuItems = [...document.querySelectorAll('[aria-label^="Открыть проект"]')].map((n) => n.textContent);
  console.log('--- выпадашка проектов ---');
  console.log('пунктов:', menuItems.length, '|', menuItems.join(' / '));
  if (emptyBoard) {
    console.log('доска без проектов:', text().replace(/\s+/g, ' ').slice(0, 120));
  }
  const backdrop = document.querySelector('[aria-label="Закрыть список проектов"]');
  await act(async () => { backdrop.click(); });
  console.log('после закрытия пунктов:', document.querySelectorAll('[aria-label^="Открыть проект"]').length);
}

// Удаление проекта: ✕ в выпадашке → подтверждение вводом имени → доска переключается.
if (process.env.MODE !== 'error' && !emptyBoard) {
  console.log('--- удаление проекта ---');
  const setValue = (node, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(node, value);
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const confirmButton = () => document.querySelector('[aria-label="Подтвердить удаление проекта"]');
  const nameField = () => document.querySelector('[aria-label="Имя проекта для подтверждения"]');
  const openPicker = async () => {
    await act(async () => { document.querySelector('[aria-label="Выбрать проект"]').click(); });
  };

  await openPicker();
  console.log(
    'кнопок ✕ в списке:', document.querySelectorAll('[aria-label^="Удалить проект"]').length,
    '| проектов:', snapshotFixture.projects.length,
  );

  // 1. Соседний (не открытый) проект.
  const other = snapshotFixture.projects.find((p) => p.id !== snapshotFixture.project.id);
  await act(async () => { document.querySelector(`[aria-label="Удалить проект ${other.name}"]`).click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
  console.log('подтверждение открылось:', confirmButton() !== null);
  console.log('«Удалить» до ввода имени disabled:', confirmButton()?.getAttribute('aria-disabled') === 'true');
  await act(async () => { setValue(nameField(), other.name.slice(0, -1)); });
  console.log('после неточного ввода disabled:', confirmButton()?.getAttribute('aria-disabled') === 'true');
  await act(async () => { setValue(nameField(), other.name); });
  console.log('после точного ввода disabled:', confirmButton()?.getAttribute('aria-disabled') === 'true');
  const toastNow = () => document.querySelector('[aria-label="Скрыть сообщение об ошибке"]');
  await act(async () => { confirmButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 150)); });
  if (process.env.PROJECT_DELETE_FAIL === '1') {
    console.log('ошибка ушла в тост:', toastNow()?.textContent ?? '(тоста нет)');
    console.log('модалка осталась открытой:', confirmButton() !== null);
    process.exit(0);
  }
  console.log('project.delete вызван с:', JSON.stringify(projectDeleteCalls));
  console.log('подтверждение закрылось:', confirmButton() === null, '| выпадашка закрылась:', document.querySelectorAll('[aria-label^="Открыть проект"]').length === 0);
  console.log('открытый проект не менялся:', text().includes(snapshotFixture.project.name), '| запрошен projectId:', snapshotCalls[snapshotCalls.length - 1]);

  // 2. Текущий проект: доска должна переехать на первый оставшийся.
  const current = snapshotFixture.project;
  await openPicker();
  await act(async () => { document.querySelector(`[aria-label="Удалить проект ${current.name}"]`).click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
  const warning = confirmButton()?.parentElement?.parentElement?.textContent ?? '';
  console.log('текст предупреждения:', warning.replace(/\s+/g, ' ').slice(0, 160));
  await act(async () => { setValue(nameField(), current.name); });
  await act(async () => { confirmButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 200)); });
  console.log('после удаления запрошен projectId:', snapshotCalls[snapshotCalls.length - 1], '(ожидался null)');
  console.log('в шапке новый проект:', text().slice(0, 80).replace(/\s+/g, ' '));
  console.log('счётчик тикетов в шапке:', text().match(/\d+ тикетов · \d+ колонок/)?.[0] ?? '(нет)');

  // 3. Остался один проект — удалять нечего, ✕ не рендерим.
  await openPicker();
  console.log(
    'проектов осталось:', snapshotFixture.projects.length,
    '| кнопок ✕:', document.querySelectorAll('[aria-label^="Удалить проект"]').length,
  );
  await act(async () => { document.querySelector('[aria-label="Закрыть список проектов"]').click(); });
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
