// Смоук серверной половины плагина без UI: компилируем index.ts тем же компилятором,
// что и демон 0.6.1, поднимаем server-бандл в этом процессе и дёргаем RPC напрямую,
// проверяя ответы zod-схемами контракта.
//
//   node dev/rpc-smoke.mjs [projectName]
//
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const nodeRequire = createRequire(path.join(pluginDir, "package.json"));

const { compilePlugin } = await import(
  "/usr/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js"
);

const { serverBundle, clientBundle } = await compilePlugin(path.join(pluginDir, "index.ts"));

// Внешние для бандла модули: SDK-специфаеры и zod (см. compiler.js).
const sdkStub = { defineRpc: (definition) => definition, defineAttachmentSource: (d) => d };
function bundleRequire(specifier) {
  if (specifier === "zod") return nodeRequire("zod");
  if (specifier.startsWith("@getpaseo/plugin")) return sdkStub;
  return nodeRequire(specifier);
}

const contribute = eval(serverBundle)(bundleRequire).default;

const handlers = new Map();
const noop = () => {};
const cleanup = contribute({
  handle: (contract, handler) => handlers.set(contract.name, { contract, handler }),
  addSurface: noop,
  addSidebarItem: noop,
  addWorkspacePanel: noop,
  addCommandCenterItem: noop,
  addAttachmentSource: noop,
  addTheme: noop,
});

function invoke(name, input) {
  const entry = handlers.get(name);
  if (!entry) throw new Error(`RPC ${name} не зарегистрирован`);
  return Promise.resolve(entry.handler(input, { paseo: null })).then((output) => {
    const parsed = entry.contract.output.safeParse(output);
    if (!parsed.success) {
      throw new Error(`${name}: ответ не проходит схему — ${JSON.stringify(parsed.error.issues)}`);
    }
    return parsed.data;
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wanted = process.argv[2] ?? "kanban-board";

console.log("RPC:", [...handlers.keys()].join(", "));
console.log("client bundle:", clientBundle.length, "байт; async/await в нём:", /\basync\b|\bawait\b/.test(clientBundle));

const projects = await invoke("kanban.projects", {});
console.log("kanban.projects:", projects.ok, "| проектов:", projects.projects.length, "| error:", projects.error);

const target = projects.projects.find((project) => project.name === wanted) ?? null;
const snapshot = await invoke("kanban.snapshot", { projectId: target?.id ?? null });
if (!snapshot.ok || snapshot.snapshot === null) {
  console.log("kanban.snapshot: ok=false, error:", snapshot.error);
} else {
  const board = snapshot.snapshot;
  console.log(
    `kanban.snapshot: проект «${board.project?.name}», version ${board.version},`,
    `тикетов ${board.tickets.length}, сессий ${board.sessions.length}`,
  );
  for (const column of board.columns) {
    const cards = board.tickets.filter((ticket) => ticket.column_id === column.id);
    const stories = cards.filter((ticket) => ticket.parent_ticket_id === null).length;
    console.log(`  ${column.name}: ${cards.length} карточек (историй ${stories})`);
  }
}

const first = await invoke("kanban.version", {});
await wait(1200);
const second = await invoke("kanban.version", {});
console.log("kanban.version:", JSON.stringify(first), "→", JSON.stringify(second));

if (typeof cleanup === "function") cleanup();
process.exit(0);
