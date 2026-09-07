import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  kanbanSnapshot,
  kanbanVersion,
  type Column,
  type Priority,
  type Project,
  type Session,
  type Snapshot,
  type TicketCard,
} from "./contract";

// ВАЖНО: компилятор демона 0.6.1 не понижает синтаксис ES2017 в клиентском бандле,
// и Hermes на iOS/Android молча не грузит такой плагин. Поэтому здесь только
// промис-цепочки (.then/.catch), никакого асинхронного сахара.

type Colors = PluginSurfaceProps["theme"]["colors"];

// Поллинг только номера версии: снапшот тянется лишь когда доска реально изменилась.
const POLL_MS = 2000;
// Не мигаем ошибкой на одной случайной неудаче фонового обновления.
const FAIL_THRESHOLD = 3;
// Если доски нет (упала при загрузке), сами пробуем ещё раз раз в ~10 с — чтобы
// после восстановления API она ожила без нажатия Retry.
const RETRY_TICKS = 5;

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
};

// Палитра плагинов 0.6.1 — ровно шесть цветов (surface0, foreground, foregroundMuted,
// accent, accentForeground, statusDanger), отдельного «warning» в ней нет. Поэтому
// приоритеты различаем не только цветом, но и заливкой: urgent — плашка, остальные — контур.
function priorityStyle(priority: Priority, colors: Colors): { color: string; filled: boolean } {
  if (priority === "urgent") return { color: colors.statusDanger, filled: true };
  if (priority === "high") return { color: colors.statusDanger, filled: false };
  if (priority === "medium") return { color: colors.accent, filled: false };
  return { color: colors.foregroundMuted, filled: false };
}

export function KanbanBoard({ theme, layout }: PluginSurfaceProps) {
  const fetchSnapshot = useRpc(kanbanSnapshot);
  const fetchVersion = useRpc(kanbanVersion);

  const [board, setBoard] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [live, setLive] = useState(true);

  const aliveRef = useRef(true);
  // Какой проект хотим видеть: null — «первый по списку API» (дефолт до первого ответа).
  const projectIdRef = useRef<string | null>(null);
  // Номер последнего запроса: ответы на устаревшие запросы (например, успели
  // переключить проект) отбрасываем, чтобы доска не мигала чужими данными.
  const seqRef = useRef(0);
  const inFlightRef = useRef(0);
  // Версия уже показанного снапшота и подряд идущие неудачи фоновых запросов.
  const appliedVersionRef = useRef(-1);
  const failsRef = useRef(0);
  const hasBoardRef = useRef(false);
  const idleTicksRef = useRef(0);
  const startedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Одиночная неудача фонового обновления не должна подменять уже показанную
  // доску экраном ошибки — ждём FAIL_THRESHOLD подряд.
  const failure = useCallback((message: string, background: boolean) => {
    failsRef.current += 1;
    if (!background || failsRef.current >= FAIL_THRESHOLD) {
      hasBoardRef.current = false;
      setError(message);
    }
  }, []);

  // background=true — обновление по росту версии.
  const load = useCallback(
    (wantedProjectId: string | null, background: boolean) => {
      projectIdRef.current = wantedProjectId;
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      inFlightRef.current += 1;
      fetchSnapshot({ projectId: wantedProjectId })
        .then((result) => {
          if (!aliveRef.current || seq !== seqRef.current) return;
          if (!result.ok || result.snapshot === null) {
            failure(result.error ?? "доска недоступна", background);
            return;
          }
          // Сервер мог откатиться на первый проект (выбранный исчез) — запоминаем факт.
          projectIdRef.current = result.snapshot.project?.id ?? null;
          appliedVersionRef.current = result.snapshot.version;
          failsRef.current = 0;
          hasBoardRef.current = true;
          setBoard(result.snapshot);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (aliveRef.current && seq === seqRef.current) failure(describe(cause), background);
        })
        .then(() => {
          inFlightRef.current -= 1;
          if (aliveRef.current && seq === seqRef.current) setLoading(false);
        });
    },
    [fetchSnapshot, failure],
  );

  const reload = useCallback(() => {
    failsRef.current = 0;
    load(projectIdRef.current, false);
  }, [load]);

  const selectProject = useCallback(
    (id: string) => {
      setPickerOpen(false);
      if (id === projectIdRef.current) return;
      setBoard(null);
      setError(null);
      setLoading(true);
      hasBoardRef.current = false;
      failsRef.current = 0;
      appliedVersionRef.current = -1;
      load(id, false);
    },
    [load],
  );

  useEffect(() => {
    // Ровно один стартовый запрос: даже если колбэк useRpc окажется нестабильным,
    // эффект не должен превратиться в цикл «рендер → запрос → рендер».
    if (startedRef.current) return;
    startedRef.current = true;
    load(null, false);
  }, [load]);

  // Живое обновление: раз в 2 с спрашиваем только номер версии (он лежит в памяти
  // сервера плагина и растёт от событий WS), снапшот перезабираем лишь при росте.
  useEffect(() => {
    const tick = () => {
      fetchVersion({})
        .then((result) => {
          if (!aliveRef.current) return;
          if (!result.ok) {
            failsRef.current += 1;
            if (failsRef.current >= FAIL_THRESHOLD) setError(result.error ?? "kanban недоступен");
            return;
          }
          failsRef.current = 0;
          setLive(result.connected);
          const changed = result.version !== appliedVersionRef.current;
          // Пока предыдущий снапшот в полёте, новый не запускаем: версия не отмечена
          // применённой, поэтому следующий тик всё равно вернётся к этому изменению.
          if (changed && inFlightRef.current === 0) {
            idleTicksRef.current = 0;
            load(projectIdRef.current, true);
            return;
          }
          // Доски нет (упала при загрузке) — раз в ~10 с пробуем сами, без Retry.
          if (!hasBoardRef.current && inFlightRef.current === 0) {
            idleTicksRef.current += 1;
            if (idleTicksRef.current >= RETRY_TICKS) {
              idleTicksRef.current = 0;
              load(projectIdRef.current, true);
            }
          }
        })
        .catch(() => {
          if (!aliveRef.current) return;
          failsRef.current += 1;
          if (failsRef.current >= FAIL_THRESHOLD) setLive(false);
        });
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchVersion, load]);

  const columnWidth = layout.compact ? 240 : 300;
  const styles = useMemo(() => createStyles(theme.colors, layout.compact), [theme, layout.compact]);

  const sessionById = useMemo(() => {
    const map: Record<string, Session> = {};
    for (const session of board?.sessions ?? []) map[session.id] = session;
    return map;
  }, [board]);

  const ticketsByColumn = useMemo(() => {
    const map: Record<string, TicketCard[]> = {};
    for (const column of board?.columns ?? []) map[column.id] = [];
    for (const ticket of board?.tickets ?? []) {
      const list = map[ticket.column_id];
      if (list) list.push(ticket);
    }
    return map;
  }, [board]);

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Выбрать проект"
            onPress={() => setPickerOpen((open) => !open)}
            style={styles.projectButton}
          >
            <Text style={styles.title} numberOfLines={1}>
              {board?.project?.name ?? "Kanban"}
            </Text>
            <Text style={styles.caret}>{pickerOpen ? "▲" : "▼"}</Text>
          </Pressable>
          <Text style={styles.subtitle}>
            {loading && board === null
              ? "Загрузка…"
              : `${board?.tickets.length ?? 0} тикетов · ${board?.columns.length ?? 0} колонок · ` +
                (live ? "live" : "нет связи с kanban")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Обновить доску"
          onPress={reload}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>Обновить</Text>
        </Pressable>
      </View>

      {board === null ? (
        error !== null ? (
          <ErrorState message={error} onRetry={reload} styles={styles} />
        ) : (
          <View style={styles.centered}>
            <Text style={styles.placeholder}>Загрузка доски…</Text>
          </View>
        )
      ) : (
        <>
          {error !== null ? (
            <View style={styles.banner}>
              <Text style={styles.errorText} numberOfLines={2}>
                {error}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Повторить запрос"
                onPress={reload}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Повторить</Text>
              </Pressable>
            </View>
          ) : null}

          {board.columns.length === 0 ? (
            <View style={styles.centered}>
              <Text style={styles.placeholder}>В проекте нет колонок</Text>
            </View>
          ) : (
            <>
              {board.tickets.length === 0 ? (
                <Text style={styles.hint}>Тикетов нет — агенты создадут их через MCP</Text>
              ) : null}
              <ScrollView horizontal contentContainerStyle={styles.boardRow}>
                {board.columns.map((column) => (
                  <BoardColumn
                    key={column.id}
                    column={column}
                    tickets={ticketsByColumn[column.id] ?? []}
                    sessionById={sessionById}
                    colors={theme.colors}
                    styles={styles}
                    width={columnWidth}
                  />
                ))}
              </ScrollView>
            </>
          )}
        </>
      )}

      {pickerOpen ? (
        <ProjectPicker
          projects={board?.projects ?? []}
          currentId={board?.project?.id ?? null}
          onSelect={selectProject}
          onDismiss={() => setPickerOpen(false)}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

// Своя выпадашка на Pressable: готового dropdown в клиентском рантайме плагинов нет,
// а Modal из react-native здесь избыточен — список короткий и живёт внутри поверхности.
function ProjectPicker({
  projects,
  currentId,
  onSelect,
  onDismiss,
  styles,
}: {
  projects: Project[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDismiss: () => void;
  styles: Styles;
}) {
  return (
    <View style={styles.pickerLayer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Закрыть список проектов"
        onPress={onDismiss}
        style={styles.pickerBackdrop}
      />
      <View style={styles.pickerMenu}>
        <ScrollView contentContainerStyle={styles.pickerList}>
          {projects.length === 0 ? (
            <Text style={styles.pickerEmpty}>Проектов нет</Text>
          ) : null}
          {projects.map((project) => {
            const active = project.id === currentId;
            return (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                accessibilityLabel={`Открыть проект ${project.name}`}
                onPress={() => onSelect(project.id)}
                style={[styles.pickerItem, active ? styles.pickerItemActive : null]}
              >
                <Text style={active ? styles.pickerTextActive : styles.pickerText} numberOfLines={1}>
                  {project.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

type Styles = ReturnType<typeof createStyles>;

function BoardColumn({
  column,
  tickets,
  sessionById,
  colors,
  styles,
  width,
}: {
  column: Column;
  tickets: TicketCard[];
  sessionById: Record<string, Session>;
  colors: Colors;
  styles: Styles;
  width: number;
}) {
  return (
    <View style={[styles.column, { width }]}>
      <View style={styles.columnHeader}>
        <Text style={styles.columnTitle} numberOfLines={1}>
          {column.name}
        </Text>
        <Text style={styles.columnCount}>{tickets.length}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.columnBody}>
        {tickets.length === 0 ? <Text style={styles.columnEmpty}>Пусто</Text> : null}
        {tickets.map((ticket) => (
          <TicketView
            key={ticket.id}
            ticket={ticket}
            session={ticket.session_id === null ? null : sessionById[ticket.session_id] ?? null}
            colors={colors}
            styles={styles}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function TicketView({
  ticket,
  session,
  colors,
  styles,
}: {
  ticket: TicketCard;
  session: Session | null;
  colors: Colors;
  styles: Styles;
}) {
  const priority = ticket.priority === null ? null : priorityStyle(ticket.priority, colors);
  const done = ticket.subtask_total > 0 && ticket.subtask_completed === ticket.subtask_total;
  return (
    <View style={styles.card}>
      <View style={styles.cardTopRow}>
        <Text style={styles.cardNumber}>#{ticket.ticket_number}</Text>
        {ticket.parent_ticket_number !== null ? (
          <Text style={styles.cardParent}>↳ #{ticket.parent_ticket_number}</Text>
        ) : null}
        <View style={styles.spacer} />
        {priority !== null && ticket.priority !== null ? (
          <View
            style={[
              styles.badge,
              priority.filled
                ? { backgroundColor: priority.color, borderColor: priority.color }
                : { borderColor: priority.color },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                { color: priority.filled ? colors.surface0 : priority.color },
              ]}
            >
              {PRIORITY_LABEL[ticket.priority]}
            </Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.cardTitle} numberOfLines={2}>
        {ticket.title}
      </Text>

      {session !== null || ticket.subtask_total > 0 ? (
        <View style={styles.cardMetaRow}>
          {session !== null ? (
            <View style={styles.sessionTag}>
              <View style={[styles.sessionDot, { backgroundColor: session.color }]} />
              <Text style={styles.metaText} numberOfLines={1}>
                {session.name}
              </Text>
            </View>
          ) : null}
          {ticket.subtask_total > 0 ? (
            <Text style={[styles.metaText, done ? styles.metaDone : null]}>
              {ticket.subtask_completed}/{ticket.subtask_total}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ErrorState({
  message,
  onRetry,
  styles,
}: {
  message: string;
  onRetry: () => void;
  styles: Styles;
}) {
  return (
    <View style={styles.centered}>
      <Text style={styles.errorTitle}>Доска недоступна</Text>
      <Text style={styles.errorBody}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Повторить запрос"
        onPress={onRetry}
        style={styles.primaryButton}
      >
        <Text style={styles.primaryButtonText}>Retry</Text>
      </Pressable>
    </View>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message || cause.name : String(cause);
}

function createStyles(colors: Colors, compact: boolean) {
  return {
    screen: {
      flex: 1,
      padding: compact ? 12 : 16,
      gap: compact ? 8 : 12,
      backgroundColor: colors.surface0,
    },
    headerRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    headerLeft: { flexShrink: 1, gap: 2 },
    title: {
      color: colors.foreground,
      fontSize: compact ? 17 : 20,
      fontWeight: "700" as const,
    },
    subtitle: { color: colors.foregroundMuted, fontSize: 12 },
    projectButton: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    caret: { color: colors.foregroundMuted, fontSize: 10 },
    pickerLayer: {
      position: "absolute" as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    pickerBackdrop: { flex: 1 },
    pickerMenu: {
      position: "absolute" as const,
      top: compact ? 44 : 52,
      left: compact ? 12 : 16,
      minWidth: 200,
      maxWidth: 320,
      maxHeight: 280,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      borderRadius: 10,
      backgroundColor: colors.surface0,
      overflow: "hidden" as const,
    },
    pickerList: { paddingVertical: 4 },
    pickerItem: { paddingVertical: 8, paddingHorizontal: 12 },
    pickerItemActive: { backgroundColor: colors.accent },
    pickerText: { color: colors.foreground, fontSize: 13 },
    pickerTextActive: { color: colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    pickerEmpty: { color: colors.foregroundMuted, fontSize: 13, padding: 12 },
    primaryButton: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
    primaryButtonText: { color: colors.accentForeground, fontSize: 13 },
    secondaryButton: {
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
    },
    secondaryButtonText: { color: colors.foreground, fontSize: 12 },
    errorText: { color: colors.statusDanger, fontSize: 13, flexShrink: 1 },
    banner: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    centered: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 10,
      padding: 16,
    },
    placeholder: { color: colors.foregroundMuted, fontSize: 14 },
    hint: { color: colors.foregroundMuted, fontSize: 13 },
    errorTitle: {
      color: colors.foreground,
      fontSize: 16,
      fontWeight: "600" as const,
    },
    errorBody: {
      color: colors.statusDanger,
      fontSize: 13,
      textAlign: "center" as const,
      maxWidth: 520,
    },
    columnEmpty: {
      color: colors.foregroundMuted,
      fontSize: 12,
      textAlign: "center" as const,
      paddingVertical: 12,
    },
    boardRow: {
      flexDirection: "row" as const,
      alignItems: "stretch" as const,
      gap: compact ? 8 : 12,
      paddingBottom: 4,
    },
    column: {
      flexGrow: 0,
      flexShrink: 0,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      borderRadius: 10,
      padding: 8,
      gap: 8,
    },
    columnHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
      paddingHorizontal: 2,
    },
    columnTitle: {
      color: colors.foreground,
      fontSize: 14,
      fontWeight: "600" as const,
      flexShrink: 1,
    },
    columnCount: { color: colors.foregroundMuted, fontSize: 12 },
    columnBody: { gap: 8, paddingBottom: 4 },
    card: {
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      borderRadius: 8,
      padding: 10,
      gap: 6,
    },
    cardTopRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    cardNumber: {
      color: colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    cardParent: { color: colors.foregroundMuted, fontSize: 11 },
    spacer: { flexGrow: 1 },
    badge: {
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    badgeText: { fontSize: 10, fontWeight: "600" as const },
    cardTitle: { color: colors.foreground, fontSize: 13, lineHeight: 18 },
    cardMetaRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    sessionTag: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 5,
      flexShrink: 1,
    },
    sessionDot: { width: 8, height: 8, borderRadius: 4 },
    metaText: { color: colors.foregroundMuted, fontSize: 11 },
    metaDone: { color: colors.accent },
  };
}
