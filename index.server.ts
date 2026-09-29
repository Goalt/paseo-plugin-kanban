import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  kanbanCompleteSubtask,
  kanbanCreateSubtask,
  kanbanCreateTicket,
  kanbanDeleteTicket,
  kanbanMoveTicket,
  kanbanProjectDelete,
  kanbanProjects,
  kanbanSnapshot,
  kanbanStateGet,
  kanbanStateSet,
  kanbanTicket,
  kanbanUpdateTicket,
  kanbanVersion,
  type Snapshot,
} from "./shared/contract";
import { ensureBoardRunning } from "./server/kanban-autostart";
import {
  completeSubtask,
  createSubtask,
  createTicket,
  deleteProject,
  deleteTicket,
  fetchBoard,
  fetchProjects,
  fetchTicketDetails,
  moveTicket,
  updateTicket,
} from "./server/kanban-api";
import { bumpVersion, currentVersion, ensureLive, isConnected, stopLive } from "./server/kanban-live";
import { getSelectedProject, setSelectedProject } from "./server/plugin-state";

// Серверная точка входа (Paseo >= 0.8): RPC-обработчики поверх REST/WS mcp-kanban.

function reply(version: number, result: { snapshot: Omit<Snapshot, "version"> | null }) {
  const board = result.snapshot;
  return {
    ok: true,
    error: null,
    snapshot: board === null ? null : { version, ...board },
  };
}

export default function contribute(plugin: PluginServerContext) {
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

  plugin.handle(kanbanProjectDelete, ({ projectId }) => {
    return deleteProject(projectId).then((error) => {
      if (error !== null) return { ok: false, error };
      // Иначе сервер продолжит открывать доску по id, которого больше нет:
      // fetchBoard молча откатится на первый проект, но память останется битой.
      if (getSelectedProject() === projectId) setSelectedProject(null);
      // Событий project:* борда по WS не шлёт (kanban-live.server слушает только
      // ticket:/subtask:/session:/column:), поэтому версию двигаем руками —
      // без этого соседняя панель узнает об удалении лишь по кнопке «Обновить».
      bumpVersion();
      return { ok: true, error: null };
    });
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

  return () => {
    stopLive();
  };
}
