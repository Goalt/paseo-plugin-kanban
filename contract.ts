import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

// Общие для сервера и клиента схемы. Файл попадает в оба бандла, поэтому здесь
// не должно быть ни node:*-импортов, ни серверной логики — только zod и типы.

export const PrioritySchema = z.enum(["urgent", "high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ColumnSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number(),
});
export type Column = z.infer<typeof ColumnSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  branch: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

// Карточка доски. Сабтаски (parent_ticket_id !== null) тоже приезжают карточками:
// на этой доске агенты двигают именно их, прятать их было бы враньём про состояние.
export const TicketCardSchema = z.object({
  id: z.string(),
  ticket_number: z.number(),
  title: z.string(),
  priority: PrioritySchema.nullable(),
  column_id: z.string(),
  session_id: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  parent_ticket_number: z.number().nullable(),
  subtask_total: z.number(),
  subtask_completed: z.number(),
  order: z.number(),
});
export type TicketCard = z.infer<typeof TicketCardSchema>;

export const SnapshotSchema = z.object({
  version: z.number(),
  project: ProjectSchema.nullable(),
  projects: z.array(ProjectSchema),
  columns: z.array(ColumnSchema),
  tickets: z.array(TicketCardSchema),
  sessions: z.array(SessionSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// Вся доска одним ответом. projectId не задан → первый проект из API.
export const kanbanSnapshot = defineRpc({
  name: "kanban.snapshot",
  input: z.object({ projectId: z.string().nullable().optional() }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    snapshot: SnapshotSchema.nullable(),
  }),
});

// Лёгкий поллинг: номер версии из памяти сервера плагина, без похода в REST.
export const kanbanVersion = defineRpc({
  name: "kanban.version",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    version: z.number(),
    connected: z.boolean(),
  }),
});

// Список проектов для переключателя.
export const kanbanProjects = defineRpc({
  name: "kanban.projects",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    projects: z.array(ProjectSchema),
  }),
});

// ————— спринт 2: детали тикета и мутации —————

export const SubtaskSchema = z.object({
  id: z.string(),
  ticket_number: z.number(),
  title: z.string(),
  priority: PrioritySchema.nullable(),
  column_id: z.string(),
  done: z.boolean(),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

// Содержимое вложений в v1 не показываем — только имена файлов (ТЗ §6).
export const AttachmentSchema = z.object({
  id: z.string(),
  file_path: z.string(),
  file_type: z.string(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const DependencyTypeSchema = z.enum(["blocked_by", "blocks", "related_to"]);
export type DependencyType = z.infer<typeof DependencyTypeSchema>;

export const DependencySchema = z.object({
  id: z.string(),
  type: DependencyTypeSchema,
  // outgoing — связь заведена у этого тикета, incoming — у другого на этот.
  direction: z.enum(["outgoing", "incoming"]),
  ticket_id: z.string(),
  ticket_number: z.number().nullable(),
  title: z.string().nullable(),
});
export type Dependency = z.infer<typeof DependencySchema>;

export const TicketDetailsSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  ticket_number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  priority: PrioritySchema.nullable(),
  column_id: z.string(),
  session_id: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  parent_ticket_number: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  subtasks: z.array(SubtaskSchema),
  subtask_total: z.number(),
  subtask_completed: z.number(),
  attachments: z.array(AttachmentSchema),
  dependencies: z.array(DependencySchema),
});
export type TicketDetails = z.infer<typeof TicketDetailsSchema>;

export const kanbanTicket = defineRpc({
  name: "kanban.ticket",
  input: z.object({ ticketId: z.string() }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    ticket: TicketDetailsSchema.nullable(),
  }),
});

// Ответ мутации: клиент по нему сразу перезабирает снапшот, поэтому данных не отдаём.
const MutationOutput = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});

// Имена RPC демон валидирует по /^[a-z][a-z0-9._-]*$/ — camelCase он не принимает
// («Invalid plugin RPC method»), поэтому мутации живут в точечных неймспейсах.
export const kanbanMoveTicket = defineRpc({
  name: "kanban.ticket.move",
  input: z.object({
    ticketId: z.string(),
    columnId: z.string(),
    order: z.number().optional(),
  }),
  output: MutationOutput,
});

export const kanbanCreateTicket = defineRpc({
  name: "kanban.ticket.create",
  input: z.object({
    projectId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    priority: PrioritySchema.nullable().optional(),
    columnId: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    ticketId: z.string().nullable(),
  }),
});

export const kanbanUpdateTicket = defineRpc({
  name: "kanban.ticket.update",
  input: z.object({
    ticketId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    // null — снять приоритет; undefined — не трогать поле.
    priority: PrioritySchema.nullable().optional(),
  }),
  output: MutationOutput,
});

export const kanbanDeleteTicket = defineRpc({
  name: "kanban.ticket.delete",
  input: z.object({ ticketId: z.string() }),
  output: MutationOutput,
});

export const kanbanCreateSubtask = defineRpc({
  name: "kanban.subtask.create",
  input: z.object({
    parentTicketId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    priority: PrioritySchema.nullable().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    ticketId: z.string().nullable(),
  }),
});

export const kanbanCompleteSubtask = defineRpc({
  name: "kanban.subtask.complete",
  input: z.object({ ticketId: z.string() }),
  output: MutationOutput,
});
