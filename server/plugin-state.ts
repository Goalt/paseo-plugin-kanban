import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Последний выбранный проект. Поверхности плагина перемонтируются (переход по
// сайдбару, смена вкладки воркспейса), а хранилища состояния у клиента 0.6.1 нет —
// поэтому выбор держим на сервере плагина: в памяти процесса + файлом, чтобы он
// пережил и `paseo plugin reload`.
//
// Путь к файлу задаётся явно: серверный бандл исполняется через `globalThis.eval`
// в глобальной области (plugin-process.js), поэтому ни `__dirname`, ни каталог
// плагина внутри рантайма не известны, а cwd процесса — домашний каталог демона.
const STATE_FILE =
  process.env.KANBAN_STATE_FILE ?? path.join(os.homedir(), ".paseo-kanban-board.json");

interface PluginState {
  projectId: string | null;
}

let state: PluginState | null = null;

function load(): PluginState {
  if (state !== null) return state;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<PluginState>;
    state = { projectId: typeof parsed.projectId === "string" ? parsed.projectId : null };
  } catch {
    // файла нет или он битый — начинаем с чистого состояния
    state = { projectId: null };
  }
  return state;
}

export function getSelectedProject(): string | null {
  return load().projectId;
}

export function setSelectedProject(projectId: string | null): void {
  state = { projectId };
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch {
    // Файл недоступен — не беда: в памяти процесса выбор всё равно сохранён,
    // перемонтирование поверхности он переживёт.
  }
}
