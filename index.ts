import type { PluginContext } from "@getpaseo/plugin";
import { KanbanBoard } from "./board.client";
import {
  kanbanCompleteSubtask,
  kanbanCreateSubtask,
  kanbanCreateTicket,
  kanbanDeleteTicket,
  kanbanMoveTicket,
  kanbanProjects,
  kanbanSnapshot,
  kanbanStateGet,
  kanbanStateSet,
  kanbanTicket,
  kanbanUpdateTicket,
  kanbanVersion,
  type Snapshot,
} from "./contract";
import { ensureBoardRunning } from "./kanban-autostart.server";
import {
  completeSubtask,
  createSubtask,
  createTicket,
  deleteTicket,
  fetchBoard,
  fetchProjects,
  fetchTicketDetails,
  moveTicket,
  updateTicket,
} from "./kanban-api.server";
import { currentVersion, ensureLive, isConnected, stopLive } from "./kanban-live.server";
import { getSelectedProject, setSelectedProject } from "./plugin-state.server";

// Точка входа. Компилируется дважды: в server-бандле остаются plugin.handle(...),
// в client-бандле они вырезаются вместе с импортами `*.server` — поэтому серверный
// код (fetch к kanban, WS) в клиентский бандл не попадает.

function reply(version: number, result: { snapshot: Omit<Snapshot, "version"> | null }) {
  const board = result.snapshot;
  return {
    ok: true,
    error: null,
    snapshot: board === null ? null : { version, ...board },
  };
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(kanbanSnapshot, ({ projectId }) => {
    ensureLive();
    // Версию снимаем ДО запроса: если событие придёт пока тянем данные,
    // клиент увидит рост версии и перезаберёт снапшот, а не застрянет на старом.
    const version = currentVersion();
    return fetchBoard(projectId ?? null).then((result) => {
      if (result.error === null && result.snapshot !== null) return reply(version, result);
      // Борда могла быть просто не поднята — пробуем поднять и повторяем один раз.
      const failure = result.error ?? "не удалось собрать доску";
      return ensureBoardRunning().then((start) => {
        if (!start.healthy) {
          const reason = start.error === null ? failure : `${failure} · ${start.error}`;
          return { ok: false, error: reason, snapshot: null };
        }
        if (!start.attempted) {
          // API живо, значит дело не в упавшей борде — отдаём исходную ошибку.
          return { ok: false, error: failure, snapshot: null };
        }
        return fetchBoard(projectId ?? null).then((retry) => {
          if (retry.error !== null || retry.snapshot === null) {
            return { ok: false, error: retry.error ?? failure, snapshot: null };
          }
          return reply(currentVersion(), retry);
        });
      });
    });
  });

  // Лёгкий поллинг клиента: только счётчик из памяти, никакого REST.
  plugin.handle(kanbanVersion, () => {
    ensureLive();
    return { ok: true, error: null, version: currentVersion(), connected: isConnected() };
  });

  plugin.handle(kanbanProjects, () => {
    return fetchProjects().then((result) => {
      if (result.error !== null || result.data === null) {
        return { ok: false, error: result.error ?? "не удалось получить проекты", projects: [] };
      }
      return { ok: true, error: null, projects: result.data };
    });
  });

  plugin.handle(kanbanTicket, ({ ticketId }) => {
    return fetchTicketDetails(ticketId).then((result) => {
      if (result.error !== null || result.ticket === null) {
        return { ok: false, error: result.error ?? "тикет не найден", ticket: null };
      }
      return { ok: true, error: null, ticket: result.ticket };
    });
  });

  plugin.handle(kanbanMoveTicket, ({ ticketId, columnId, order }) => {
    return moveTicket(ticketId, columnId, order).then((error) =>
      error === null ? { ok: true, error: null } : { ok: false, error },
    );
  });

  plugin.handle(kanbanCreateTicket, (input) => {
    return createTicket(input).then((result) =>
      result.error === null
        ? { ok: true, error: null, ticketId: result.ticketId }
        : { ok: false, error: result.error, ticketId: null },
    );
  });

  plugin.handle(kanbanUpdateTicket, (input) => {
    return updateTicket(input).then((error) =>
      error === null ? { ok: true, error: null } : { ok: false, error },
    );
  });

  plugin.handle(kanbanDeleteTicket, ({ ticketId }) => {
    return deleteTicket(ticketId).then((error) =>
      error === null ? { ok: true, error: null } : { ok: false, error },
    );
  });

  plugin.handle(kanbanCreateSubtask, (input) => {
    return createSubtask(input).then((result) =>
      result.error === null
        ? { ok: true, error: null, ticketId: result.ticketId }
        : { ok: false, error: result.error, ticketId: null },
    );
  });

  plugin.handle(kanbanCompleteSubtask, ({ ticketId }) => {
    return completeSubtask(ticketId).then((error) =>
      error === null ? { ok: true, error: null } : { ok: false, error },
    );
  });

  plugin.handle(kanbanStateGet, () => {
    return { ok: true, error: null, projectId: getSelectedProject() };
  });

  plugin.handle(kanbanStateSet, ({ projectId }) => {
    setSelectedProject(projectId);
    return { ok: true, error: null };
  });

  plugin.addSurface("main", KanbanBoard);
  plugin.addSidebarItem({
    id: "main",
    title: "Kanban",
    icon: "SquareKanban",
    surface: "main",
  });
  plugin.addWorkspacePanel({
    id: "board",
    title: "Kanban",
    icon: "SquareKanban",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: KanbanBoard,
  });
  plugin.addCommandCenterItem({
    id: "open-kanban-board",
    title: "Open Kanban board",
    icon: "SquareKanban",
    keywords: ["kanban", "board", "tickets", "tasks"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("board");
    },
  });
  // Клиентский бандл этого модуля не видит: `typeof` по необъявленному имени там
  // просто даст "undefined", а на сервере закроет WS при выгрузке плагина.
  return () => {
    if (typeof stopLive === "function") stopLive();
  };
}
