import type { Column, Priority, Project, Session, Snapshot, TicketCard } from "./contract";

// Серверный слой плагина: HTTP к REST mcp-kanban. Имя файла оканчивается на
// `.server` — компилятор 0.6.1 вырезает импорт этого модуля из клиентского бандла
// и ругается, если его попробуют импортировать из *.client.tsx.

const DEFAULT_BASE_URL = "http://mcp-hub:3010";
const REQUEST_TIMEOUT_MS = 5000;

// IP не хардкодим: имя контейнера резолвится DNS'ом docker-сети, IP меняется при пересоздании.
export function kanbanBaseUrl(): string {
  const raw = process.env.KANBAN_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function kanbanWsUrl(): string {
  return `${kanbanBaseUrl().replace(/^http/, "ws")}/ws`;
}

export interface ApiResult<T> {
  error: string | null;
  data: T | null;
}

// Никогда не бросает: любая сетевая или форматная ошибка приезжает строкой в error.
export function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const url = `${kanbanBaseUrl()}${path}`;
  return fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then((response) => {
      if (!response.ok) {
        return { error: `${path}: HTTP ${response.status} ${response.statusText}`.trim(), data: null };
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        // Борда отдаёт SPA-фолбэк html на неизвестные пути — это не данные, а «нет такого API».
        return { error: `${path}: ответ не JSON (${contentType || "без content-type"})`, data: null };
      }
      return response.json().then(
        (data) => ({ error: null, data: data as T }),
        (cause: unknown) => ({ error: `${path}: битый JSON (${describe(cause)})`, data: null }),
      );
    })
    .catch((cause: unknown) => ({
      error: `kanban API недоступен по ${kanbanBaseUrl()} — ${describe(cause)}`,
      data: null,
    }));
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `таймаут ${REQUEST_TIMEOUT_MS} мс`;
    return cause.message || cause.name;
  }
  return String(cause);
}

export function checkHealth(): Promise<boolean> {
  return apiGet<{ ok?: boolean }>("/api/health").then(
    (result) => result.error === null && result.data?.ok === true,
  );
}

// ————— сырые формы ответов mcp-kanban (src/shared/types.ts) —————

interface RawProject {
  id: string;
  name: string;
}

interface RawColumn {
  id: string;
  project_id: string;
  name: string;
  order: number;
}

interface RawSession {
  id: string;
  name: string;
  color: string;
  branch: string | null;
}

interface RawTicket {
  id: string;
  project_id: string;
  ticket_number: number;
  title: string;
  description: string | null;
  priority: string | null;
  column_id: string;
  session_id: string | null;
  parent_ticket_id: string | null;
  order: number;
}

const PRIORITIES = ["urgent", "high", "medium", "low"];

function normalizePriority(value: string | null): Priority | null {
  return value !== null && PRIORITIES.includes(value) ? (value as Priority) : null;
}

export function fetchProjects(): Promise<ApiResult<Project[]>> {
  return apiGet<RawProject[]>("/api/projects").then((result) => {
    if (result.error !== null || result.data === null) {
      return { error: result.error ?? "пустой ответ /api/projects", data: null };
    }
    if (!Array.isArray(result.data)) {
      return { error: "/api/projects: ожидался массив", data: null };
    }
    return {
      error: null,
      data: result.data.map((project) => ({ id: project.id, name: project.name })),
    };
  });
}

export interface SnapshotResult {
  error: string | null;
  snapshot: Omit<Snapshot, "version"> | null;
}

// Вся доска одним куском: проекты + выбранный проект + его колонки, тикеты и сессии.
export function fetchBoard(projectId: string | null): Promise<SnapshotResult> {
  return fetchProjects().then((projectsResult) => {
    if (projectsResult.error !== null || projectsResult.data === null) {
      return { error: projectsResult.error ?? "не удалось получить проекты", snapshot: null };
    }
    const projects = projectsResult.data;
    if (projects.length === 0) {
      return {
        error: null,
        snapshot: { project: null, projects, columns: [], tickets: [], sessions: [] },
      };
    }
    // Выбранный проект мог исчезнуть (агент удалил) — молча откатываемся на первый.
    const project = projects.find((item) => item.id === projectId) ?? projects[0];

    // GET /api/columns?project_id=… в mcp-kanban не существует (роут columns — только
    // PUT/DELETE /:id), такой запрос уводит в SPA-фолбэк с html. Колонки живут здесь:
    const columnsPromise = apiGet<RawColumn[]>(`/api/projects/${encodeURIComponent(project.id)}/columns`);
    const ticketsPromise = apiGet<RawTicket[]>(`/api/tickets?project_id=${encodeURIComponent(project.id)}`);
    const sessionsPromise = apiGet<RawSession[]>("/api/sessions");

    return Promise.all([columnsPromise, ticketsPromise, sessionsPromise]).then(
      ([columnsResult, ticketsResult, sessionsResult]) => {
        const failure = columnsResult.error ?? ticketsResult.error ?? sessionsResult.error;
        if (failure !== null) return { error: failure, snapshot: null };

        const rawColumns = Array.isArray(columnsResult.data) ? columnsResult.data : [];
        const rawTickets = Array.isArray(ticketsResult.data) ? ticketsResult.data : [];
        const rawSessions = Array.isArray(sessionsResult.data) ? sessionsResult.data : [];

        const columns: Column[] = rawColumns
          .map((column) => ({ id: column.id, name: column.name, order: column.order }))
          .sort((left, right) => left.order - right.order);

        const sessions: Session[] = rawSessions.map((session) => ({
          id: session.id,
          name: session.name,
          color: session.color,
          branch: session.branch ?? null,
        }));

        return {
          error: null,
          snapshot: {
            project,
            projects,
            columns,
            tickets: buildCards(rawTickets, columns),
            sessions,
          },
        };
      },
    );
  });
}

// Листинг /api/tickets отдаёт голые тикеты без subtask_total/subtask_completed
// (они есть только в GET /api/tickets/:id, dal.getTicketWithSubtasks) — считаем сами.
// «Завершён» = сабтаск лежит в колонке Done, ровно как в dal.getStoryProgress.
function buildCards(rawTickets: RawTicket[], columns: Column[]): TicketCard[] {
  const doneColumnId = columns.find((column) => column.name === "Done")?.id ?? null;
  const numberById = new Map<string, number>();
  const total = new Map<string, number>();
  const completed = new Map<string, number>();

  for (const ticket of rawTickets) numberById.set(ticket.id, ticket.ticket_number);
  for (const ticket of rawTickets) {
    const parentId = ticket.parent_ticket_id;
    if (parentId === null) continue;
    total.set(parentId, (total.get(parentId) ?? 0) + 1);
    if (doneColumnId !== null && ticket.column_id === doneColumnId) {
      completed.set(parentId, (completed.get(parentId) ?? 0) + 1);
    }
  }

  return rawTickets
    .map((ticket) => ({
      id: ticket.id,
      ticket_number: ticket.ticket_number,
      title: ticket.title,
      priority: normalizePriority(ticket.priority),
      column_id: ticket.column_id,
      session_id: ticket.session_id,
      parent_ticket_id: ticket.parent_ticket_id,
      parent_ticket_number:
        ticket.parent_ticket_id === null
          ? null
          : numberById.get(ticket.parent_ticket_id) ?? null,
      subtask_total: total.get(ticket.id) ?? 0,
      subtask_completed: completed.get(ticket.id) ?? 0,
      order: ticket.order,
    }))
    .sort((left, right) => left.order - right.order || left.ticket_number - right.ticket_number);
}
