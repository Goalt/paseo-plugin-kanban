import { execFile } from "node:child_process";
import { checkHealth, kanbanBaseUrl } from "./kanban-api.server";

// Борда mcp-kanban на 3010 живёт только после `open_board` (или нашего старта):
// после пересоздания/рестарта контейнера её некому поднять. Если health молчит —
// поднимаем сами, CLI идемпотентен («already running»).

const CONTAINER = process.env.KANBAN_CONTAINER ?? "mcp-hub";
const CLI_PATH = "/app/servers/mcp-kanban/dist/cli/index.js";
const DOCKER_TIMEOUT_MS = 15000;
const HEALTH_WAIT_MS = 10000;
const PROBE_INTERVAL_MS = 500;
// Не долбим docker на каждый Retry: между неудачными попытками выдерживаем паузу.
const ATTEMPT_COOLDOWN_MS = 15000;

export interface AutostartResult {
  healthy: boolean;
  attempted: boolean;
  error: string | null;
}

// Защёлка: параллельные вызовы (снапшот + Retry) ждут одну и ту же попытку.
let inFlight: Promise<AutostartResult> | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;

export function ensureBoardRunning(): Promise<AutostartResult> {
  return checkHealth().then((healthy) => {
    if (healthy) return { healthy: true, attempted: false, error: null };
    if (inFlight !== null) return inFlight;

    const host = baseUrlHost();
    if (host !== CONTAINER) {
      return {
        healthy: false,
        attempted: false,
        error: `автостарт пропущен: KANBAN_URL указывает на «${host}», а борду умеем поднимать только в контейнере «${CONTAINER}»`,
      };
    }

    const sinceLast = Date.now() - lastAttemptAt;
    if (lastAttemptAt !== 0 && sinceLast < ATTEMPT_COOLDOWN_MS) {
      return {
        healthy: false,
        attempted: false,
        error:
          lastError ??
          `борда не отвечает; следующая попытка запуска через ${Math.ceil((ATTEMPT_COOLDOWN_MS - sinceLast) / 1000)} с`,
      };
    }

    const attempt = startBoard()
      .then((startError) => {
        if (startError !== null) {
          return { healthy: false, attempted: true, error: startError };
        }
        return waitForHealth(Date.now() + HEALTH_WAIT_MS).then((healthyNow) => ({
          healthy: healthyNow,
          attempted: true,
          error: healthyNow
            ? null
            : `борду запустили, но /api/health не ответил за ${HEALTH_WAIT_MS / 1000} с`,
        }));
      })
      .then((result) => {
        lastAttemptAt = Date.now();
        lastError = result.error;
        inFlight = null;
        return result;
      });

    inFlight = attempt;
    return attempt;
  });
}

function baseUrlHost(): string {
  try {
    return new URL(kanbanBaseUrl()).hostname;
  } catch {
    return "";
  }
}

// null — команда ушла успешно; строка — что именно пошло не так.
function startBoard(): Promise<string | null> {
  const args = ["exec", "-d", CONTAINER, "node", CLI_PATH, "start", "--no-open"];
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: DOCKER_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || "docker exec не удался").trim().split("\n")[0];
        resolve(`не удалось запустить борду в контейнере ${CONTAINER}: ${detail}`);
        return;
      }
      resolve(null);
    });
  });
}

function waitForHealth(deadline: number): Promise<boolean> {
  return checkHealth().then((healthy) => {
    if (healthy) return true;
    if (Date.now() >= deadline) return false;
    return delay(PROBE_INTERVAL_MS).then(() => waitForHealth(deadline));
  });
}

// Таймер намеренно НЕ unref: пока ждём health, операция в полёте и процесс
// не должен считать, что ему больше нечего делать.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
