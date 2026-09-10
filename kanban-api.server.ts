import type {
  Attachment,
  Column,
  Dependency,
  DependencyType,
  Priority,
  Project,
  Session,
  Snapshot,
  Subtask,
  TicketCard,
  TicketDetails,
} from "./contract";

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

// Мутации: POST/PUT/DELETE с JSON-телом. Как и apiGet, ошибок не бросает.
export function apiSend<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const url = `${kanbanBaseUrl()}${path}`;
  return fetch(url, {
    method,
    headers: body === undefined
      ? { accept: "application/json" }
      : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
    .then((response): Promise<ApiResult<T>> => {
      if (!response.ok) {
        // Текст ошибки от Hono приезжает JSON'ом вида {"error":"..."} — достаём его.
        return response.text().then(
          (text): ApiResult<T> => ({
            error: `${method} ${path}: ${errorText(response.status, text)}`,
            data: null,
          }),
          (): ApiResult<T> => ({ error: `${method} ${path}: HTTP ${response.status}`, data: null }),
        );
      }
      return response.json().then(
        (data): ApiResult<T> => ({ error: null, data: data as T }),
        // Пустое тело (204 или голый ok) — не ошибка: мутация прошла.
        (): ApiResult<T> => ({ error: null, data: null }),
      );
    })
    .catch((cause: unknown): ApiResult<T> => ({
      error: `kanban API недоступен по ${kanbanBaseUrl()} — ${describe(cause)}`,
      data: null,
    }));
}

function errorText(status: number, body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      if (typeof parsed.error === "string") return `${parsed.error} (HTTP ${status})`;
    } catch {
      // не JSON — покажем как есть
    }
  }
  return trimmed.length > 0 && trimmed.length < 200 ? `${trimmed} (HTTP ${status})` : `HTTP ${status}`;
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
  created_at: string;
  updated_at: string;
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

// ————— спринт 2: детали тикета и мутации —————

interface RawAttachment {
  id: string;
  ticket_id: string;
  file_path: string;
  file_type: string;
}

interface RawDependency {
  id: string;
  ticket_id: string;
  depends_on_ticket_id: string;
  type: string;
}

const DEPENDENCY_TYPES = ["blocked_by", "blocks", "related_to"];

// Детали тикета одним ответом: сам тикет + сабтаски + вложения + зависимости.
// Номера и заголовки связанных тикетов достаём из листинга проекта — в строках
// зависимостей лежат только id.
export function fetchTicketDetails(ticketId: string): Promise<{
  error: string | null;
  ticket: TicketDetails | null;
}> {
  const encoded = encodeURIComponent(ticketId);
  return apiGet<RawTicket>(`/api/tickets/${encoded}`).then((ticketResult) => {
    if (ticketResult.error !== null || ticketResult.data === null) {
      return { error: ticketResult.error ?? "тикет не найден", ticket: null };
    }
    const ticket = ticketResult.data;
    return Promise.all([
      apiGet<RawTicket[]>(`/api/tickets/${encoded}/subtasks`),
      apiGet<RawAttachment[]>(`/api/tickets/${encoded}/attachments`),
      apiGet<RawDependency[]>(`/api/tickets/${encoded}/dependencies`),
      apiGet<RawColumn[]>(`/api/projects/${encodeURIComponent(ticket.project_id)}/columns`),
      apiGet<RawTicket[]>(`/api/tickets?project_id=${encodeURIComponent(ticket.project_id)}`),
    ]).then(([subtasksResult, attachmentsResult, depsResult, columnsResult, projectTickets]) => {
      const failure =
        subtasksResult.error ?? attachmentsResult.error ?? depsResult.error ?? columnsResult.error;
      if (failure !== null) return { error: failure, ticket: null };

      const rawColumns = Array.isArray(columnsResult.data) ? columnsResult.data : [];
      const doneColumnId = rawColumns.find((column) => column.name === "Done")?.id ?? null;
      const rawSubtasks = Array.isArray(subtasksResult.data) ? subtasksResult.data : [];
      const siblings = Array.isArray(projectTickets.data) ? projectTickets.data : [];

      const subtasks: Subtask[] = rawSubtasks.map((subtask) => ({
        id: subtask.id,
        ticket_number: subtask.ticket_number,
        title: subtask.title,
        priority: normalizePriority(subtask.priority),
        column_id: subtask.column_id,
        done: doneColumnId !== null && subtask.column_id === doneColumnId,
      }));

      const attachments: Attachment[] = (
        Array.isArray(attachmentsResult.data) ? attachmentsResult.data : []
      ).map((attachment) => ({
        id: attachment.id,
        file_path: attachment.file_path,
        file_type: attachment.file_type,
      }));

      const byId = new Map<string, RawTicket>();
      for (const item of siblings) byId.set(item.id, item);

      const dependencies: Dependency[] = (Array.isArray(depsResult.data) ? depsResult.data : [])
        .filter((row) => DEPENDENCY_TYPES.includes(row.type))
        .map((row) => {
          const outgoing = row.ticket_id === ticket.id;
          const otherId = outgoing ? row.depends_on_ticket_id : row.ticket_id;
          const other = byId.get(otherId) ?? null;
          return {
            id: row.id,
            type: row.type as DependencyType,
            direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
            ticket_id: otherId,
            ticket_number: other?.ticket_number ?? null,
            title: other?.title ?? null,
          };
        });

      const parent = ticket.parent_ticket_id === null ? null : byId.get(ticket.parent_ticket_id) ?? null;

      return {
        error: null,
        ticket: {
          id: ticket.id,
          project_id: ticket.project_id,
          ticket_number: ticket.ticket_number,
          title: ticket.title,
          description: ticket.description,
          priority: normalizePriority(ticket.priority),
          column_id: ticket.column_id,
          session_id: ticket.session_id,
          parent_ticket_id: ticket.parent_ticket_id,
          parent_ticket_number: parent?.ticket_number ?? null,
          created_at: ticket.created_at,
          updated_at: ticket.updated_at,
          subtasks,
          subtask_total: subtasks.length,
          subtask_completed: subtasks.filter((subtask) => subtask.done).length,
          attachments,
          dependencies,
        },
      };
    });
  });
}

// PUT /api/tickets/:id/move — тело {column_id, order?} (server/routes/tickets.ts).
// order не задан → dal.moveTicket положит тикет в конец колонки.
export function moveTicket(
  ticketId: string,
  columnId: string,
  order?: number,
): Promise<string | null> {
  const body: { column_id: string; order?: number } = { column_id: columnId };
  if (order !== undefined) body.order = order;
  return apiSend<RawTicket>("PUT", `/api/tickets/${encodeURIComponent(ticketId)}/move`, body).then(
    (result) => result.error,
  );
}

// POST /api/tickets — тело CreateTicketInput (title, description?, project_id,
// session_id?, priority?, column_id?). Без column_id тикет уедет в Backlog проекта.
export function createTicket(input: {
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority | null;
  columnId?: string;
}): Promise<{ error: string | null; ticketId: string | null }> {
  const body: Record<string, unknown> = {
    project_id: input.projectId,
    title: input.title,
  };
  if (input.description !== undefined) body.description = input.description;
  if (input.priority !== undefined && input.priority !== null) body.priority = input.priority;
  if (input.columnId !== undefined) body.column_id = input.columnId;
  return apiSend<RawTicket>("POST", "/api/tickets", body).then((result) => ({
    error: result.error,
    ticketId: result.data?.id ?? null,
  }));
}

// PUT /api/tickets/:id — UpdateTicketInput. Поля, которых нет в теле, dal не трогает;
// priority: null снимает приоритет (drizzle пишет NULL).
export function updateTicket(input: {
  ticketId: string;
  title?: string;
  description?: string;
  priority?: Priority | null;
}): Promise<string | null> {
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.priority !== undefined) body.priority = input.priority;
  if (Object.keys(body).length === 0) return Promise.resolve("нечего менять");
  return apiSend<RawTicket>("PUT", `/api/tickets/${encodeURIComponent(input.ticketId)}`, body).then(
    (result) => result.error,
  );
}

// DELETE /api/tickets/:id. Сабтаски удаляются каскадом: в drizzle-описании
// (db/schema.ts) у parent_ticket_id внешнего ключа нет, но реальная таблица создана
// миграционным SQL с `parent_ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE`
// и включённым PRAGMA foreign_keys — проверено на живой базе.
export function deleteTicket(ticketId: string): Promise<string | null> {
  return apiSend<{ ok: boolean }>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}`).then(
    (result) => result.error,
  );
}

// DELETE /api/projects/:id. Колонки, тикеты и сабтаски проекта уходят каскадом:
// в схеме борды (db/dal.ts, runMigrations) у columns.project_id и tickets.project_id
// стоит REFERENCES projects(id) ON DELETE CASCADE при включённом PRAGMA foreign_keys.
// Единственный оставшийся проект борда удалять не даёт — вернёт 400
// «Cannot delete the only project» (проверка идёт ДО поиска проекта по id).
export function deleteProject(projectId: string): Promise<string | null> {
  return apiSend<{ ok: boolean }>("DELETE", `/api/projects/${encodeURIComponent(projectId)}`).then(
    (result) => result.error,
  );
}

// POST /api/tickets/:id/subtasks — CreateSubtaskInput (title, description?, priority?).
// Сабтаск наследует проект, колонку и сессию родителя (dal.createSubtask).
export function createSubtask(input: {
  parentTicketId: string;
  title: string;
  description?: string;
  priority?: Priority | null;
}): Promise<{ error: string | null; ticketId: string | null }> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.description !== undefined) body.description = input.description;
  if (input.priority !== undefined && input.priority !== null) body.priority = input.priority;
  return apiSend<RawTicket>(
    "POST",
    `/api/tickets/${encodeURIComponent(input.parentTicketId)}/subtasks`,
    body,
  ).then((result) => ({ error: result.error, ticketId: result.data?.id ?? null }));
}

// Завершение сабтаска = перенос в колонку Done его проекта — ровно как
// complete_subtask в mcp/index.ts (dal.getDoneColumn + dal.moveTicket).
export function completeSubtask(ticketId: string): Promise<string | null> {
  return apiGet<RawTicket>(`/api/tickets/${encodeURIComponent(ticketId)}`).then((ticketResult) => {
    if (ticketResult.error !== null || ticketResult.data === null) {
      return ticketResult.error ?? "тикет не найден";
    }
    const projectId = ticketResult.data.project_id;
    return apiGet<RawColumn[]>(`/api/projects/${encodeURIComponent(projectId)}/columns`).then(
      (columnsResult) => {
        if (columnsResult.error !== null || !Array.isArray(columnsResult.data)) {
          return columnsResult.error ?? "не удалось получить колонки проекта";
        }
        const done = columnsResult.data.find((column) => column.name === "Done") ?? null;
        if (done === null) return "в проекте нет колонки Done";
        return moveTicket(ticketId, done.id);
      },
    );
  });
}
