import { useRpc } from "@getpaseo/plugin";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal as NativeModal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  kanbanCompleteSubtask,
  kanbanCreateSubtask,
  kanbanDeleteTicket,
  kanbanMoveTicket,
  kanbanTicket,
  kanbanUpdateTicket,
  type Column,
  type Dependency,
  type Priority,
  type Session,
  type TicketDetails,
} from "./contract";
import { useMutationRunner } from "./mutations.client";
import { PriorityPicker } from "./ticket-form.client";
import { Toast } from "./toast.client";
import { describe, PRIORITY_LABEL, priorityStyle, type Colors, type Styles } from "./ui.client";

// Ограничения клиентского бандла 0.6.1: только промис-цепочки, никакого
// асинхронного сахара (Hermes на iOS/Android такой бандл молча не грузит).

export function TicketModal({
  ticketId,
  columns,
  sessionById,
  colors,
  styles,
  onClose,
  onChanged,
  onOpenTicket,
}: {
  ticketId: string;
  columns: Column[];
  sessionById: Record<string, Session>;
  colors: Colors;
  styles: Styles;
  onClose: () => void;
  // Дёргается после любой успешной мутации: доска перезабирает снапшот сразу,
  // не дожидаясь тика поллинга версии.
  onChanged: () => void;
  // Переход по зависимости: доска просто меняет открытый тикет.
  onOpenTicket: (ticketId: string) => void;
}) {
  const fetchTicket = useRpc(kanbanTicket);
  const sendMove = useRpc(kanbanMoveTicket);
  const sendUpdate = useRpc(kanbanUpdateTicket);
  const sendCreateSubtask = useRpc(kanbanCreateSubtask);
  const sendCompleteSubtask = useRpc(kanbanCompleteSubtask);
  const sendDelete = useRpc(kanbanDeleteTicket);
  const mutation = useMutationRunner();

  const [ticket, setTicket] = useState<TicketDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Черновик режима редактирования: пока он не null, показываем форму.
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<{
    title: string;
    description: string;
    priority: Priority | null;
  } | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadTicket = useCallback(() => {
    setError(null);
    fetchTicket({ ticketId })
      .then((result) => {
        if (!aliveRef.current) return;
        if (!result.ok || result.ticket === null) {
          setError(result.error ?? "тикет не найден");
          return;
        }
        setTicket(result.ticket);
      })
      .catch((cause: unknown) => {
        if (aliveRef.current) setError(describe(cause));
      });
  }, [fetchTicket, ticketId]);

  useEffect(() => {
    loadTicket();
  }, [loadTicket]);

  // Переход по зависимости меняет ticketId у того же компонента — сбрасываем
  // всё, что относилось к прежнему тикету, иначе черновик или подтверждение
  // удаления уедут на соседний тикет.
  useEffect(() => {
    setTicket(null);
    setDraft(null);
    setConfirmDelete(false);
    setSubtaskTitle("");
  }, [ticketId]);

  const startEditing = useCallback(() => {
    if (ticket === null) return;
    setDraft({
      title: ticket.title,
      description: ticket.description ?? "",
      priority: ticket.priority,
    });
  }, [ticket]);

  const saveDraft = useCallback(() => {
    if (draft === null) return;
    const title = draft.title.trim();
    if (title.length === 0) return;
    mutation.run(
      () =>
        sendUpdate({
          ticketId,
          title,
          description: draft.description,
          priority: draft.priority,
        }),
      () => {
        setDraft(null);
        loadTicket();
        onChanged();
      },
    );
  }, [draft, mutation, sendUpdate, ticketId, loadTicket, onChanged]);

  // Завершение сабтаска = перенос в Done (семантика complete_subtask).
  // Обратного «раз-завершения» в v1 нет — чекбокс закрытого сабтаска disabled.
  const completeSubtask = useCallback(
    (subtaskId: string) => {
      const refresh = () => {
        loadTicket();
        onChanged();
      };
      mutation.run(() => sendCompleteSubtask({ ticketId: subtaskId }), refresh, refresh);
    },
    [mutation, sendCompleteSubtask, loadTicket, onChanged],
  );

  const addSubtask = useCallback(() => {
    const title = subtaskTitle.trim();
    if (title.length === 0) return;
    mutation.run(() => sendCreateSubtask({ parentTicketId: ticketId, title }), () => {
      setSubtaskTitle("");
      loadTicket();
      onChanged();
    });
  }, [subtaskTitle, mutation, sendCreateSubtask, ticketId, loadTicket, onChanged]);

  const removeTicket = useCallback(() => {
    mutation.run(() => sendDelete({ ticketId }), () => {
      setConfirmDelete(false);
      onChanged();
      onClose();
    });
  }, [mutation, sendDelete, ticketId, onChanged, onClose]);

  // Перенос в выбранную колонку: обновляем и детали, и доску под модалкой.
  const moveTo = useCallback(
    (columnId: string) => {
      const refresh = () => {
        loadTicket();
        onChanged();
      };
      mutation.run(() => sendMove({ ticketId, columnId }), refresh, refresh);
    },
    [mutation, sendMove, ticketId, loadTicket, onChanged],
  );

  const column = ticket === null ? null : columns.find((item) => item.id === ticket.column_id) ?? null;
  const session =
    ticket === null || ticket.session_id === null ? null : sessionById[ticket.session_id] ?? null;
  const priority = ticket?.priority ?? null;
  const badge = priority === null ? null : priorityStyle(priority, colors);

  return (
    <NativeModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Закрыть окно тикета"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalNumber}>#{ticket?.ticket_number ?? "…"}</Text>
            <Text style={styles.modalTitle} numberOfLines={2}>
              {ticket?.title ?? "Загрузка…"}
            </Text>
            {ticket !== null && draft === null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Редактировать тикет"
                onPress={startEditing}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Изменить</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose}>
              <Text style={styles.modalClose}>✕</Text>
            </Pressable>
          </View>

          {ticket === null ? (
            <View style={styles.centered}>
              {error === null ? (
                <Text style={styles.placeholder}>Загрузка тикета…</Text>
              ) : (
                <>
                  <Text style={styles.errorBody}>{error}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Повторить загрузку тикета"
                    onPress={loadTicket}
                    style={styles.primaryButton}
                  >
                    <Text style={styles.primaryButtonText}>Retry</Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              {error !== null ? <Text style={styles.errorText}>{error}</Text> : null}

              <View style={styles.modalMetaRow}>
                {badge !== null && priority !== null ? (
                  <View
                    style={[
                      styles.badge,
                      badge.filled
                        ? { backgroundColor: badge.color, borderColor: badge.color }
                        : { borderColor: badge.color },
                    ]}
                  >
                    <Text
                      style={[
                        styles.badgeText,
                        { color: badge.filled ? colors.surface0 : badge.color },
                      ]}
                    >
                      {PRIORITY_LABEL[priority]}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.modalMuted}>без приоритета</Text>
                )}
                <Text style={styles.modalMuted}>{column?.name ?? "колонка неизвестна"}</Text>
                {session !== null ? (
                  <View style={styles.sessionTag}>
                    <View style={[styles.sessionDot, { backgroundColor: session.color }]} />
                    <Text style={styles.modalMuted}>{session.name}</Text>
                  </View>
                ) : null}
                {ticket.parent_ticket_number !== null ? (
                  <Text style={styles.modalMuted}>сабтаск истории #{ticket.parent_ticket_number}</Text>
                ) : null}
                {ticket.subtask_total > 0 ? (
                  <Text style={styles.modalMuted}>
                    сабтаски {ticket.subtask_completed}/{ticket.subtask_total}
                  </Text>
                ) : null}
              </View>

              {draft !== null ? (
                <>
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>Заголовок</Text>
                    <TextInput
                      accessibilityLabel="Заголовок тикета"
                      value={draft.title}
                      onChangeText={(next) => setDraft({ ...draft, title: next })}
                      editable={!mutation.busy}
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>Описание</Text>
                    <TextInput
                      accessibilityLabel="Описание тикета"
                      value={draft.description}
                      onChangeText={(next) => setDraft({ ...draft, description: next })}
                      editable={!mutation.busy}
                      multiline
                      style={[styles.input, styles.inputMultiline]}
                    />
                  </View>
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>Приоритет</Text>
                    <PriorityPicker
                      value={draft.priority}
                      onChange={(next) => setDraft({ ...draft, priority: next })}
                      disabled={mutation.busy}
                      colors={colors}
                      styles={styles}
                    />
                  </View>
                  <View style={styles.formActions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Отменить редактирование"
                      onPress={() => setDraft(null)}
                      style={styles.secondaryButton}
                    >
                      <Text style={styles.secondaryButtonText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Сохранить тикет"
                      disabled={draft.title.trim().length === 0 || mutation.busy}
                      onPress={saveDraft}
                      style={[
                        styles.primaryButton,
                        draft.title.trim().length === 0 || mutation.busy
                          ? styles.disabledButton
                          : null,
                      ]}
                    >
                      <Text style={styles.primaryButtonText}>Save</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Колонка</Text>
                <View style={styles.modalMetaRow}>
                  {columns.map((item) => {
                    const active = item.id === ticket.column_id;
                    return (
                      <Pressable
                        key={item.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Переместить в ${item.name}`}
                        disabled={active || mutation.busy}
                        onPress={() => moveTo(item.id)}
                        style={[
                          styles.chip,
                          active ? styles.chipActive : null,
                          !active && mutation.busy ? styles.disabledButton : null,
                        ]}
                      >
                        <Text style={active ? styles.chipTextActive : styles.chipText}>
                          {item.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Описание</Text>
                <Text style={ticket.description ? styles.modalText : styles.modalMuted}>
                  {ticket.description && ticket.description.length > 0
                    ? ticket.description
                    : "Без описания"}
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>
                  Сабтаски {ticket.subtask_completed}/{ticket.subtask_total}
                </Text>
                {ticket.subtasks.length === 0 ? (
                  <Text style={styles.modalMuted}>Сабтасков нет</Text>
                ) : null}
                {ticket.subtasks.map((subtask) => (
                  <View key={subtask.id} style={styles.subtaskRow}>
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Завершить сабтаск #${subtask.ticket_number}`}
                      accessibilityState={{ checked: subtask.done, disabled: subtask.done }}
                      disabled={subtask.done || mutation.busy}
                      onPress={() => completeSubtask(subtask.id)}
                      style={[
                        styles.checkbox,
                        subtask.done ? styles.checkboxDone : null,
                        !subtask.done && mutation.busy ? styles.disabledButton : null,
                      ]}
                    >
                      <Text style={styles.checkboxMark}>{subtask.done ? "✓" : " "}</Text>
                    </Pressable>
                    <Text
                      style={subtask.done ? styles.subtaskTextDone : styles.subtaskText}
                      numberOfLines={2}
                    >
                      #{subtask.ticket_number} {subtask.title}
                    </Text>
                  </View>
                ))}
                <View style={styles.addRow}>
                  <TextInput
                    accessibilityLabel="Заголовок нового сабтаска"
                    value={subtaskTitle}
                    onChangeText={setSubtaskTitle}
                    editable={!mutation.busy}
                    placeholder="+ добавить сабтаск"
                    placeholderTextColor={colors.foregroundMuted}
                    style={[styles.input, styles.addInput]}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Добавить сабтаск"
                    disabled={subtaskTitle.trim().length === 0 || mutation.busy}
                    onPress={addSubtask}
                    style={[
                      styles.secondaryButton,
                      subtaskTitle.trim().length === 0 || mutation.busy
                        ? styles.disabledButton
                        : null,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>Добавить</Text>
                  </Pressable>
                </View>
              </View>

              {ticket.dependencies.length > 0 ? (
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>Зависимости</Text>
                  {ticket.dependencies.map((dependency) => (
                    <DependencyRow
                      key={dependency.id}
                      dependency={dependency}
                      colors={colors}
                      styles={styles}
                      onOpenTicket={onOpenTicket}
                    />
                  ))}
                </View>
              ) : null}

              {ticket.attachments.length > 0 ? (
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>Вложения</Text>
                  {ticket.attachments.map((attachment) => (
                    <Text key={attachment.id} style={styles.modalMuted} numberOfLines={1}>
                      {attachment.file_path}
                    </Text>
                  ))}
                </View>
              ) : null}

                </>
              )}

              {draft === null ? (
                <View style={styles.modalSection}>
                  {confirmDelete ? (
                    <>
                      <Text style={styles.errorText}>
                        Удалить #{ticket.ticket_number}
                        {ticket.subtask_total > 0
                          ? ` и все сабтаски (${ticket.subtask_total})`
                          : ""}
                        ? Это необратимо.
                      </Text>
                      <View style={styles.formActions}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Отменить удаление"
                          onPress={() => setConfirmDelete(false)}
                          style={styles.secondaryButton}
                        >
                          <Text style={styles.secondaryButtonText}>Отмена</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Подтвердить удаление"
                          disabled={mutation.busy}
                          onPress={removeTicket}
                          style={[styles.dangerButton, mutation.busy ? styles.disabledButton : null]}
                        >
                          <Text style={styles.dangerButtonText}>Удалить</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <View style={styles.formActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Удалить тикет"
                        onPress={() => setConfirmDelete(true)}
                        style={styles.dangerButton}
                      >
                        <Text style={styles.dangerButtonText}>Delete</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              ) : null}

              <Text style={styles.modalMuted}>обновлён {formatStamp(ticket.updated_at)}</Text>
            </ScrollView>
          )}
          <Toast message={mutation.error} onDismiss={mutation.clearError} styles={styles} />
        </View>
      </View>
    </NativeModal>
  );
}

// Подпись зависимости с точки зрения открытого тикета. Роут отдаёт связи в обе
// стороны, поэтому входящую blocked_by читаем как «этот блокирует другой».
function dependencyLabel(dependency: Dependency): { text: string; blocking: boolean } {
  const outgoing = dependency.direction === "outgoing";
  if (dependency.type === "related_to") return { text: "связан с", blocking: false };
  if (dependency.type === "blocked_by") {
    return outgoing ? { text: "заблокирован", blocking: true } : { text: "блокирует", blocking: false };
  }
  return outgoing ? { text: "блокирует", blocking: false } : { text: "заблокирован", blocking: true };
}

function DependencyRow({
  dependency,
  colors,
  styles,
  onOpenTicket,
}: {
  dependency: Dependency;
  colors: Colors;
  styles: Styles;
  onOpenTicket: (ticketId: string) => void;
}) {
  const label = dependencyLabel(dependency);
  // Номер и заголовок резолвятся из тикетов того же проекта: их отсутствие и
  // означает «связь ведёт в другой проект» — туда не прыгаем.
  const known = dependency.ticket_number !== null;
  const title = known
    ? `#${dependency.ticket_number} ${dependency.title ?? ""}`.trim()
    : "тикет другого проекта";
  const content = (
    <>
      <Text
        style={[
          styles.depTag,
          label.blocking
            ? { color: colors.statusDanger, borderColor: colors.statusDanger }
            : { color: colors.foregroundMuted, borderColor: colors.foregroundMuted },
        ]}
      >
        {label.text}
      </Text>
      <Text style={known ? styles.subtaskText : styles.modalMuted} numberOfLines={1}>
        {title}
      </Text>
    </>
  );
  if (!known) return <View style={styles.subtaskRow}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Открыть зависимость #${dependency.ticket_number}`}
      onPress={() => onOpenTicket(dependency.ticket_id)}
      style={styles.subtaskRow}
    >
      {content}
    </Pressable>
  );
}

// ISO из API → «06.09.2026, 20:31» локалью клиента; на кривой строке отдаём как есть.
function formatStamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}
