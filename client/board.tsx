import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  kanbanMoveTicket,
  kanbanSnapshot,
  kanbanStateGet,
  kanbanStateSet,
  kanbanVersion,
  type Column,
  type Project,
  type Session,
  type Snapshot,
  type TicketCard,
} from "../shared/contract";
import { useMutationRunner } from "./mutations";
import { DeleteProjectModal } from "./project-delete";
import { CreateTicketModal } from "./ticket-form";
import { TicketModal } from "./ticket-modal";
import { Toast } from "./toast";
import {
  createStyles,
  describe,
  PRIORITY_LABEL,
  priorityStyle,
  type Colors,
  type Styles,
} from "./ui";

// ВАЖНО: компилятор демона 0.6.1 не понижает синтаксис ES2017 в клиентском бандле,
// и Hermes на iOS/Android молча не грузит такой плагин. Поэтому здесь только
// промис-цепочки (.then/.catch), никакого асинхронного сахара.

// Поллинг только номера версии: снапшот тянется лишь когда доска реально изменилась.
const POLL_MS = 2000;
// Не мигаем ошибкой на одной случайной неудаче фонового обновления.
const FAIL_THRESHOLD = 3;
// Если доски нет (упала при загрузке), сами пробуем ещё раз раз в ~10 с — чтобы
// после восстановления API она ожила без нажатия Retry.
const RETRY_TICKS = 5;

export function KanbanBoard({ theme, layout }: PluginSurfaceProps) {
  const fetchSnapshot = useRpc(kanbanSnapshot);
  const fetchVersion = useRpc(kanbanVersion);
  const sendMove = useRpc(kanbanMoveTicket);
  const fetchState = useRpc(kanbanStateGet);
  const saveState = useRpc(kanbanStateSet);
  const mutation = useMutationRunner();

  const [board, setBoard] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [live, setLive] = useState(true);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [createInColumn, setCreateInColumn] = useState<Column | null>(null);
  // Фильтр по сессии агента: null — показывать все тикеты.
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  // Проект, для которого открыто подтверждение удаления (null — подтверждения нет).
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

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

  // ◀ ▶ на карточке: соседняя колонка, после успеха — сразу снапшот.
  const moveCard = useCallback(
    (ticketId: string, columnId: string) => {
      const refresh = () => load(projectIdRef.current, true);
      mutation.run(() => sendMove({ ticketId, columnId }), refresh, refresh);
    },
    [mutation, sendMove, load],
  );

  // Смена показываемой доски: старую не оставляем на экране, пока грузится новая.
  // id === null — «первый проект по списку API» (после удаления открытого проекта).
  const switchTo = useCallback(
    (id: string | null) => {
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

  const selectProject = useCallback(
    (id: string) => {
      setPickerOpen(false);
      if (id === projectIdRef.current) return;
      // Выбор живёт на сервере плагина: поверхность перемонтируется при каждом
      // переходе по сайдбару, локальный state этого не переживает.
      saveState({ projectId: id }).catch(() => {
        // не смогли запомнить — доска всё равно откроет выбранный проект сейчас
      });
      switchTo(id);
    },
    [switchTo, saveState],
  );

  // Успешное удаление проекта. Память сервера плагина уже очищена хендлером,
  // поэтому saveState тут не нужен: снапшот с projectId=null сам выберет
  // projects[0], а load пересинхронизирует projectIdRef из ответа.
  const projectDeleted = useCallback(
    (deletedId: string) => {
      const wasCurrent = deletedId === projectIdRef.current;
      setDeleteTarget(null);
      setPickerOpen(false);
      if (wasCurrent) {
        switchTo(null);
        return;
      }
      // Удалили соседний проект — открытую доску не трогаем, обновляем список.
      load(projectIdRef.current, true);
    },
    [switchTo, load],
  );

  useEffect(() => {
    // Ровно один стартовый запрос: даже если колбэк useRpc окажется нестабильным,
    // эффект не должен превратиться в цикл «рендер → запрос → рендер».
    if (startedRef.current) return;
    startedRef.current = true;
    // Сначала спрашиваем сервер, какой проект смотрели последним; если памяти
    // нет (первое открытие) — как раньше, первый проект из API.
    fetchState({})
      .then((result) => {
        if (!aliveRef.current) return;
        load(result.ok ? result.projectId : null, false);
      })
      .catch(() => {
        if (aliveRef.current) load(null, false);
      });
  }, [load, fetchState]);

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

  // Фильтр применяется на клиенте: снапшот и так приходит целиком, лишний
  // круг к серверу ради выборки по session_id не нужен.
  const visibleTickets = useMemo(() => {
    const all = board?.tickets ?? [];
    if (sessionFilter === null) return all;
    return all.filter((ticket) => ticket.session_id === sessionFilter);
  }, [board, sessionFilter]);

  const ticketsByColumn = useMemo(() => {
    const map: Record<string, TicketCard[]> = {};
    for (const column of board?.columns ?? []) map[column.id] = [];
    for (const ticket of visibleTickets) {
      const list = map[ticket.column_id];
      if (list) list.push(ticket);
    }
    return map;
  }, [board, visibleTickets]);

  // Счётчик «в работе». Бейджа у пунктов сайдбара/панелей в 0.6.1 нет
  // (клиент оставляет у sidebar item только id/title/icon/surface), поэтому
  // счётчик живёт в шапке доски — см. заметку #31 и README.
  const inProgressCount = useMemo(() => {
    const column = (board?.columns ?? []).find((item) => item.name === "In Progress");
    if (column === undefined) return null;
    return visibleTickets.filter((ticket) => ticket.column_id === column.id).length;
  }, [board, visibleTickets]);

  // Выбранной сессии может не оказаться в новом проекте — тогда фильтр снимаем.
  const activeSession = sessionFilter === null ? null : sessionById[sessionFilter] ?? null;
  useEffect(() => {
    if (sessionFilter !== null && board !== null && activeSession === null) setSessionFilter(null);
  }, [sessionFilter, board, activeSession]);

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
              : `${visibleTickets.length}${
                  sessionFilter === null ? "" : ` из ${board?.tickets.length ?? 0}`
                } тикетов · ${board?.columns.length ?? 0} колонок · ` +
                (live ? "live" : "нет связи с kanban")}
          </Text>
        </View>
        <View style={styles.headerControls}>
          {inProgressCount !== null ? (
            <View style={styles.counterBadge} accessibilityLabel={`В работе: ${inProgressCount}`}>
              <Text style={styles.counterText}>в работе {inProgressCount}</Text>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Фильтр по сессии"
            onPress={() => setSessionPickerOpen((open) => !open)}
            style={styles.sessionButton}
          >
            {activeSession !== null ? (
              <View style={[styles.sessionDot, { backgroundColor: activeSession.color }]} />
            ) : null}
            <Text style={styles.secondaryButtonText} numberOfLines={1}>
              {activeSession === null ? "Все сессии" : activeSession.name}
            </Text>
            <Text style={styles.caret}>{sessionPickerOpen ? "▲" : "▼"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Обновить доску"
            onPress={reload}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Обновить</Text>
          </Pressable>
        </View>
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
              {board.tickets.length > 0 && visibleTickets.length === 0 ? (
                <Text style={styles.hint}>
                  У сессии «{activeSession?.name ?? "?"}» тикетов нет — снимите фильтр
                </Text>
              ) : null}
              <ScrollView horizontal contentContainerStyle={styles.boardRow}>
                {board.columns.map((column, index) => (
                  <BoardColumn
                    key={column.id}
                    column={column}
                    tickets={ticketsByColumn[column.id] ?? []}
                    sessionById={sessionById}
                    colors={theme.colors}
                    styles={styles}
                    width={columnWidth}
                    onOpenTicket={setOpenTicketId}
                    previousColumn={index > 0 ? board.columns[index - 1] : null}
                    nextColumn={index + 1 < board.columns.length ? board.columns[index + 1] : null}
                    onMove={moveCard}
                    busy={mutation.busy}
                    onCreateTicket={setCreateInColumn}
                  />
                ))}
              </ScrollView>
            </>
          )}
        </>
      )}

      {createInColumn !== null && board?.project ? (
        <CreateTicketModal
          projectId={board.project.id}
          column={createInColumn}
          colors={theme.colors}
          styles={styles}
          onClose={() => setCreateInColumn(null)}
          onCreated={() => load(projectIdRef.current, true)}
        />
      ) : null}

      {deleteTarget !== null ? (
        <DeleteProjectModal
          project={deleteTarget}
          ticketCount={
            deleteTarget.id === (board?.project?.id ?? null) ? board?.tickets.length ?? null : null
          }
          colors={theme.colors}
          styles={styles}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => projectDeleted(deleteTarget.id)}
        />
      ) : null}

      {openTicketId !== null ? (
        <TicketModal
          ticketId={openTicketId}
          columns={board?.columns ?? []}
          sessionById={sessionById}
          colors={theme.colors}
          styles={styles}
          onClose={() => setOpenTicketId(null)}
          onChanged={() => load(projectIdRef.current, true)}
          onOpenTicket={setOpenTicketId}
        />
      ) : null}

      <Toast message={mutation.error} onDismiss={mutation.clearError} styles={styles} />

      {pickerOpen ? (
        <ProjectPicker
          projects={board?.projects ?? []}
          currentId={board?.project?.id ?? null}
          onSelect={selectProject}
          onDelete={setDeleteTarget}
          onDismiss={() => setPickerOpen(false)}
          styles={styles}
        />
      ) : null}

      {sessionPickerOpen ? (
        <SessionPicker
          sessions={board?.sessions ?? []}
          currentId={sessionFilter}
          onSelect={(id) => {
            setSessionFilter(id);
            setSessionPickerOpen(false);
          }}
          onDismiss={() => setSessionPickerOpen(false)}
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
  onDelete,
  onDismiss,
  styles,
}: {
  projects: Project[];
  currentId: string | null;
  onSelect: (id: string) => void;
  // Только открывает подтверждение — само удаление живёт в DeleteProjectModal.
  onDelete: (project: Project) => void;
  onDismiss: () => void;
  styles: Styles;
}) {
  // Последний проект борда удалять не даёт (400 «Cannot delete the only
  // project») — кнопку в этом случае не показываем вовсе.
  const deletable = projects.length > 1;
  return (
    <View style={styles.pickerLayer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Закрыть список проектов"
        onPress={onDismiss}
        style={styles.pickerBackdrop}
      />
      <View style={[styles.pickerMenu, styles.pickerMenuLeft]}>
        <ScrollView contentContainerStyle={styles.pickerList}>
          {projects.length === 0 ? (
            <Text style={styles.pickerEmpty}>Проектов нет</Text>
          ) : null}
          {projects.map((project) => {
            const active = project.id === currentId;
            return (
              // Вложенные Pressable на вебе ловят один клик дважды, поэтому
              // «открыть» и «удалить» — соседи в строке (как ◀▶ на карточке).
              <View
                key={project.id}
                style={[styles.pickerRow, active ? styles.pickerItemActive : null]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Открыть проект ${project.name}`}
                  onPress={() => onSelect(project.id)}
                  style={[styles.pickerItem, styles.pickerItemFill]}
                >
                  <Text
                    style={active ? styles.pickerTextActive : styles.pickerText}
                    numberOfLines={1}
                  >
                    {project.name}
                  </Text>
                </Pressable>
                {deletable ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Удалить проект ${project.name}`}
                    onPress={() => onDelete(project)}
                    style={[styles.dangerButton, styles.pickerDelete]}
                  >
                    <Text style={styles.dangerButtonText}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

// Фильтр по сессии: та же выпадашка, что и у проектов, но прижата к правому краю.
function SessionPicker({
  sessions,
  currentId,
  onSelect,
  onDismiss,
  styles,
}: {
  sessions: Session[];
  currentId: string | null;
  onSelect: (id: string | null) => void;
  onDismiss: () => void;
  styles: Styles;
}) {
  return (
    <View style={styles.pickerLayer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Закрыть список сессий"
        onPress={onDismiss}
        style={styles.pickerBackdrop}
      />
      <View style={[styles.pickerMenu, styles.pickerMenuRight]}>
        <ScrollView contentContainerStyle={styles.pickerList}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Показать все сессии"
            onPress={() => onSelect(null)}
            style={[styles.pickerItem, currentId === null ? styles.pickerItemActive : null]}
          >
            <Text style={currentId === null ? styles.pickerTextActive : styles.pickerText}>
              Все сессии
            </Text>
          </Pressable>
          {sessions.length === 0 ? <Text style={styles.pickerEmpty}>Сессий нет</Text> : null}
          {sessions.map((session) => {
            const active = session.id === currentId;
            return (
              <Pressable
                key={session.id}
                accessibilityRole="button"
                accessibilityLabel={`Фильтр по сессии ${session.name}`}
                onPress={() => onSelect(session.id)}
                style={[styles.pickerItem, styles.pickerItemRow, active ? styles.pickerItemActive : null]}
              >
                <View style={[styles.sessionDot, { backgroundColor: session.color }]} />
                <Text style={active ? styles.pickerTextActive : styles.pickerText} numberOfLines={1}>
                  {session.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

function BoardColumn({
  column,
  tickets,
  sessionById,
  colors,
  styles,
  width,
  onOpenTicket,
  previousColumn,
  nextColumn,
  onMove,
  busy,
  onCreateTicket,
}: {
  column: Column;
  tickets: TicketCard[];
  sessionById: Record<string, Session>;
  colors: Colors;
  styles: Styles;
  width: number;
  onOpenTicket: (ticketId: string) => void;
  previousColumn: Column | null;
  nextColumn: Column | null;
  onMove: (ticketId: string, columnId: string) => void;
  busy: boolean;
  onCreateTicket: (column: Column) => void;
}) {
  return (
    <View style={[styles.column, { width }]}>
      <View style={styles.columnHeader}>
        <Text style={styles.columnTitle} numberOfLines={1}>
          {column.name}
        </Text>
        <Text style={styles.columnCount}>{tickets.length}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Создать тикет в ${column.name}`}
          onPress={() => onCreateTicket(column)}
          style={styles.columnAdd}
        >
          <Text style={styles.columnAddText}>+</Text>
        </Pressable>
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
            onOpen={onOpenTicket}
            previousColumn={previousColumn}
            nextColumn={nextColumn}
            onMove={onMove}
            busy={busy}
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
  onOpen,
  previousColumn,
  nextColumn,
  onMove,
  busy,
}: {
  ticket: TicketCard;
  session: Session | null;
  colors: Colors;
  styles: Styles;
  onOpen: (ticketId: string) => void;
  previousColumn: Column | null;
  nextColumn: Column | null;
  onMove: (ticketId: string, columnId: string) => void;
  busy: boolean;
}) {
  const priority = ticket.priority === null ? null : priorityStyle(ticket.priority, colors);
  const done = ticket.subtask_total > 0 && ticket.subtask_completed === ticket.subtask_total;
  return (
    <View style={styles.card}>
      {/* Вложенные Pressable на вебе ловят один клик дважды, поэтому «открыть» и
          «переместить» — соседние элементы, а не вложенные. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть тикет #${ticket.ticket_number}`}
        onPress={() => onOpen(ticket.id)}
        style={styles.cardContent}
      >
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
      </Pressable>

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
        <View style={styles.spacer} />
        {previousColumn !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Переместить #${ticket.ticket_number} в ${previousColumn.name}`}
            disabled={busy}
            onPress={() => onMove(ticket.id, previousColumn.id)}
            style={[styles.moveButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.moveButtonText}>◀</Text>
          </Pressable>
        ) : null}
        {nextColumn !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Переместить #${ticket.ticket_number} в ${nextColumn.name}`}
            disabled={busy}
            onPress={() => onMove(ticket.id, nextColumn.id)}
            style={[styles.moveButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.moveButtonText}>▶</Text>
          </Pressable>
        ) : null}
      </View>
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
