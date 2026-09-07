// Смоук серверной половины плагина без UI: компилируем index.ts тем же компилятором,
// что и демон 0.6.1, поднимаем server-бандл в этом процессе и дёргаем RPC напрямую,
// проверяя ответы zod-схемами контракта.
//
//   node dev/rpc-smoke.mjs [projectName]     — только чтение (по умолчанию kanban-board)
//   node dev/rpc-smoke.mjs --mutations       — полный CRUD-цикл в проекте plugin-sandbox
//
// Мутации гоняются ТОЛЬКО в проекте plugin-sandbox: живые доски — реальные планы,
// а deleteTicket необратим. Скрипт отказывается мутировать любой другой проект.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const nodeRequire = createRequire(path.join(pluginDir, "package.json"));

const SANDBOX_PROJECT = "plugin-sandbox";

const { compilePlugin } = await import(
  "/usr/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js"
);

const { serverBundle, clientBundle } = await compilePlugin(path.join(pluginDir, "index.ts"));

// Внешние для бандла модули: SDK-специфаеры и zod (см. compiler.js).
// Демон валидирует имена RPC этой же регуляркой (plugin-process.js) — держим
// проверку и здесь, иначе camelCase-имя всплывёт только на reload.
const RPC_NAME = /^[a-z][a-z0-9._-]*$/;
const sdkStub = {
  defineRpc: (definition) => {
    if (!RPC_NAME.test(definition.name.trim())) {
      throw new Error(`Invalid plugin RPC method: ${definition.name}`);
    }
    return definition;
  },
  defineAttachmentSource: (d) => d,
};
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

function expect(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    return;
  }
  console.log(`  ✗ ${message}`);
  failures += 1;
}

let failures = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mutating = process.argv.includes("--mutations");

console.log("RPC:", [...handlers.keys()].join(", "));
console.log(
  "client bundle:",
  clientBundle.length,
  "байт; async/await в нём:",
  /\basync\b|\bawait\b/.test(clientBundle),
);

if (!mutating) {
  const wanted = process.argv[2] ?? "kanban-board";
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
} else {
  await runMutations();
}

if (typeof cleanup === "function") cleanup();
console.log(failures === 0 ? "\nИТОГ: всё зелёное" : `\nИТОГ: провалов ${failures}`);
process.exit(failures === 0 ? 0 : 1);

async function runMutations() {
  const projects = await invoke("kanban.projects", {});
  const sandbox = projects.projects.find((project) => project.name === SANDBOX_PROJECT) ?? null;
  if (sandbox === null) {
    throw new Error(
      `проект ${SANDBOX_PROJECT} не найден — создайте его: curl -X POST $KANBAN/api/projects -d '{"name":"${SANDBOX_PROJECT}"}'`,
    );
  }

  const board = async () => {
    const result = await invoke("kanban.snapshot", { projectId: sandbox.id });
    if (!result.ok || result.snapshot === null) throw new Error(`снапшот песочницы: ${result.error}`);
    // Страховка от порчи чужих данных: мутируем только то, что лежит в песочнице.
    if (result.snapshot.project?.id !== sandbox.id) {
      throw new Error("сервер вернул не тот проект — мутации отменены");
    }
    return result.snapshot;
  };

  const start = await board();
  const columnByName = (name) => start.columns.find((column) => column.name === name);
  console.log(`\nПесочница «${sandbox.name}»: колонок ${start.columns.length}, тикетов ${start.tickets.length}`);

  console.log("\n[create] создание тикета");
  const stamp = new Date().toISOString();
  const created = await invoke("kanban.ticket.create", {
    projectId: sandbox.id,
    title: `смоук ${stamp}`,
    description: "создан RPC-смоуком",
    priority: "high",
    columnId: columnByName("Backlog").id,
  });
  expect(created.ok && created.ticketId !== null, "kanban.ticket.create вернул id");
  const ticketId = created.ticketId;
  const afterCreate = await invoke("kanban.ticket", { ticketId });
  expect(
    afterCreate.ticket?.title === `смоук ${stamp}` &&
      afterCreate.ticket?.priority === "high" &&
      afterCreate.ticket?.column_id === columnByName("Backlog").id,
    "тикет создан с нужными title/priority/колонкой",
  );

  console.log("\n[update] редактирование");
  const updated = await invoke("kanban.ticket.update", {
    ticketId,
    title: "смоук: переименован",
    description: "описание переписано",
    priority: "low",
  });
  expect(updated.ok, "kanban.ticket.update ok");
  const afterUpdate = await invoke("kanban.ticket", { ticketId });
  expect(
    afterUpdate.ticket?.title === "смоук: переименован" &&
      afterUpdate.ticket?.description === "описание переписано" &&
      afterUpdate.ticket?.priority === "low",
    "детали показывают новые title/description/priority",
  );
  await invoke("kanban.ticket.update", { ticketId, priority: null });
  const cleared = await invoke("kanban.ticket", { ticketId });
  expect(cleared.ticket?.priority === null, "priority: null снимает приоритет");

  console.log("\n[subtasks] сабтаски");
  const subtask = await invoke("kanban.subtask.create", {
    parentTicketId: ticketId,
    title: "смоук: сабтаск",
    priority: "medium",
  });
  expect(subtask.ok && subtask.ticketId !== null, "kanban.subtask.create вернул id");
  const withSubtask = await invoke("kanban.ticket", { ticketId });
  expect(withSubtask.ticket?.subtask_total === 1, "сабтаск виден в деталях родителя");
  expect(
    withSubtask.ticket?.subtasks[0]?.column_id === withSubtask.ticket?.column_id,
    "сабтаск создан в колонке родителя (dal.createSubtask)",
  );
  const completed = await invoke("kanban.subtask.complete", { ticketId: subtask.ticketId });
  expect(completed.ok, "kanban.subtask.complete ok");
  const afterComplete = await invoke("kanban.ticket", { ticketId });
  expect(
    afterComplete.ticket?.subtask_completed === 1 &&
      afterComplete.ticket?.subtasks[0]?.done === true &&
      afterComplete.ticket?.subtasks[0]?.column_id === columnByName("Done").id,
    "сабтаск уехал в Done, прогресс 1/1",
  );
  const progressCard = (await board()).tickets.find((card) => card.id === ticketId);
  expect(
    progressCard?.subtask_completed === 1 && progressCard?.subtask_total === 1,
    "снапшот доски показывает прогресс 1/1",
  );

  console.log("\n[delete] удаление");
  const removedSubtask = await invoke("kanban.ticket.delete", { ticketId: subtask.ticketId });
  expect(removedSubtask.ok, "сабтаск удалён");
  const removed = await invoke("kanban.ticket.delete", { ticketId });
  expect(removed.ok, "тикет удалён");
  const gone = await invoke("kanban.ticket", { ticketId });
  expect(!gone.ok, "удалённый тикет больше не читается");
  const boardAfter = await board();
  expect(
    boardAfter.tickets.every((card) => card.id !== ticketId),
    "снапшот доски больше не содержит удалённый тикет",
  );

  console.log("\n[delete] родитель с сабтаском (каскад)");
  const parent = await invoke("kanban.ticket.create", {
    projectId: sandbox.id,
    title: "смоук: родитель для проверки каскада",
    columnId: columnByName("Backlog").id,
  });
  const child = await invoke("kanban.subtask.create", {
    parentTicketId: parent.ticketId,
    title: "смоук: сабтаск-сирота",
  });
  const parentRemoved = await invoke("kanban.ticket.delete", { ticketId: parent.ticketId });
  expect(parentRemoved.ok, "родитель удалён");
  const orphan = await invoke("kanban.ticket", { ticketId: child.ticketId });
  // Реальная таблица создана миграционным SQL с FK ON DELETE CASCADE на
  // parent_ticket_id (в drizzle-описании этого FK нет) — сабтаск уходит с родителем.
  expect(!orphan.ok, "сабтаск удалён каскадом вместе с родителем");
  const boardNoOrphans = await board();
  expect(
    boardNoOrphans.tickets.every((card) => card.id !== child.ticketId),
    "на доске не осталось осиротевших сабтасков",
  );

  console.log("\n[move] перемещение тикета");
  const moveVictim = start.tickets.find((ticket) => ticket.parent_ticket_id === null);
  if (!moveVictim) {
    console.log("  — в песочнице нет тикетов для перемещения");
    return;
  }
  const from = start.columns.find((column) => column.id === moveVictim.column_id);
  const to = start.columns.find((column) => column.id !== moveVictim.column_id);
  const moved = await invoke("kanban.ticket.move", { ticketId: moveVictim.id, columnId: to.id });
  expect(moved.ok && moved.error === null, `moveTicket #${moveVictim.ticket_number}: ${from?.name} → ${to.name}`);
  const afterMove = await invoke("kanban.ticket", { ticketId: moveVictim.id });
  expect(afterMove.ok && afterMove.ticket?.column_id === to.id, "kanban.ticket показывает новую колонку");
  const back = await invoke("kanban.ticket.move", { ticketId: moveVictim.id, columnId: moveVictim.column_id });
  expect(back.ok, "тикет возвращён в исходную колонку");

  console.log("\n[errors] ошибки мутаций не бросают исключений");
  const badMove = await invoke("kanban.ticket.move", {
    ticketId: "00000000-0000-0000-0000-000000000000",
    columnId: to.id,
  });
  expect(!badMove.ok && badMove.error !== null, `move несуществующего тикета → ${badMove.error}`);

  console.log("\n[details] детали тикета");
  const details = await invoke("kanban.ticket", { ticketId: moveVictim.id });
  expect(details.ok && details.ticket !== null, "kanban.ticket отвечает и проходит схему");
  if (details.ticket) {
    console.log(
      `  #${details.ticket.ticket_number} «${details.ticket.title}» · сабтасков ${details.ticket.subtask_completed}/${details.ticket.subtask_total}`,
      `· вложений ${details.ticket.attachments.length} · зависимостей ${details.ticket.dependencies.length}`,
    );
  }
  const missing = await invoke("kanban.ticket", { ticketId: "00000000-0000-0000-0000-000000000000" });
  expect(!missing.ok && missing.error !== null, "несуществующий тикет → ok=false с текстом ошибки");
}
