import { kanbanWsUrl } from "./kanban-api.server";

// Версия доски: монотонный счётчик в памяти сервера плагина. Живёт от подписки на
// ws://…/ws: любое событие kanban → version++. Клиент опрашивает `kanban.version`
// (дёшево, без REST) и перезабирает снапшот только когда номер вырос.
//
// Подписку поднимаем лениво, из обработчиков RPC: тело contribute() исполняется
// и на клиенте тоже, а туда серверный модуль не приезжает.

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Запасной путь для рантайма без глобального WebSocket: крутим версию по таймеру,
// клиент деградирует до обычного поллинга REST-снапшота.
const FALLBACK_POLL_MS = 5000;

const LIVE_EVENT_PREFIXES = ["ticket:", "subtask:", "session:", "column:"];

let boardVersion = 1;
let socket: WebSocket | null = null;
let started = false;
let connected = false;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

export function currentVersion(): number {
  return boardVersion;
}

export function isConnected(): boolean {
  return connected;
}

export function bumpVersion(): number {
  boardVersion += 1;
  return boardVersion;
}

// Идемпотентно: первый вызов поднимает подписку, остальные ничего не делают.
export function ensureLive(): void {
  if (started) return;
  started = true;
  if (typeof WebSocket === "undefined") {
    console.warn("[kanban-board] в рантайме нет WebSocket — версия крутится по таймеру");
    startFallbackPolling();
    return;
  }
  connect();
}

export function stopLive(): void {
  started = false;
  connected = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (fallbackTimer !== null) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  const previous = socket;
  socket = null;
  if (previous !== null) {
    try {
      previous.close();
    } catch {
      // сокет мог уже умереть — закрывать нечего
    }
  }
}

function connect(): void {
  if (!started) return;
  const url = kanbanWsUrl();
  let next: WebSocket;
  try {
    next = new WebSocket(url);
  } catch (cause) {
    // Конструктор бросает на кривом URL — не роняем плагин, пробуем позже.
    console.warn(`[kanban-board] не удалось открыть ${url}: ${describe(cause)}`);
    scheduleReconnect();
    return;
  }
  socket = next;

  next.onopen = () => {
    if (socket !== next) return;
    connected = true;
    reconnectDelayMs = RECONNECT_MIN_MS;
    // Пока связи не было, доска могла измениться — считаем, что изменилась.
    bumpVersion();
  };

  next.onmessage = (event: MessageEvent) => {
    if (socket !== next) return;
    if (isBoardEvent(event.data)) bumpVersion();
  };

  // Node 22 при неудачном connect шлёт только `error`, без `close` (проверено:
  // ws://…:<закрытый порт> → «Received network error or non-101 status code»),
  // а при обрыве живого соединения — оба события. Поэтому реконнект вешаем на
  // оба, а гонку снимаем обнулением socket: второе событие уже не сработает.
  next.onerror = () => {
    handleDisconnect(next);
  };

  next.onclose = () => {
    handleDisconnect(next);
  };
}

function handleDisconnect(dead: WebSocket): void {
  if (socket !== dead) return;
  socket = null;
  connected = false;
  try {
    dead.close();
  } catch {
    // соединение уже мертво — закрывать нечего
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (!started || reconnectTimer !== null) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

function startFallbackPolling(): void {
  if (fallbackTimer !== null) return;
  fallbackTimer = setInterval(() => {
    bumpVersion();
  }, FALLBACK_POLL_MS);
  fallbackTimer.unref?.();
}

function isBoardEvent(payload: unknown): boolean {
  if (typeof payload !== "string") return false;
  let type: unknown;
  try {
    type = (JSON.parse(payload) as { type?: unknown }).type;
  } catch {
    return false;
  }
  if (typeof type !== "string") return false;
  return LIVE_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message || cause.name : String(cause);
}
