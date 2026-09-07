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
