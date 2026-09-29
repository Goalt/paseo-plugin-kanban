import type { PluginClientContext } from "@getpaseo/plugin/client";
import { KanbanBoard } from "./client/board";

export default function contribute(plugin: PluginClientContext) {
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
  return () => {};
}
