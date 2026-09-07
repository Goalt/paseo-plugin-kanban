import { useRpc } from "@getpaseo/plugin";
import { useCallback, useState } from "react";
import { Modal as NativeModal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { kanbanCreateTicket, type Column, type Priority } from "./contract";
import { useMutationRunner } from "./mutations.client";
import { Toast } from "./toast.client";
import { PRIORITIES, PRIORITY_LABEL, priorityStyle, type Colors, type Styles } from "./ui.client";

// Формы создания тикета и выбора приоритета. Клиентские ограничения 0.6.1 в силе:
// только промис-цепочки, только react / react-native / @getpaseo/plugin.

export function PriorityPicker({
  value,
  onChange,
  disabled,
  colors,
  styles,
}: {
  value: Priority | null;
  onChange: (next: Priority | null) => void;
  disabled: boolean;
  colors: Colors;
  styles: Styles;
}) {
  return (
    <View style={styles.modalMetaRow}>
      {PRIORITIES.map((priority) => {
        const active = value === priority;
        const tone = priorityStyle(priority, colors);
        return (
          <Pressable
            key={priority}
            accessibilityRole="button"
            accessibilityLabel={`Приоритет ${PRIORITY_LABEL[priority]}`}
            disabled={disabled}
            onPress={() => onChange(priority)}
            style={[
              styles.chip,
              { borderColor: tone.color },
              active ? { backgroundColor: tone.color } : null,
              disabled ? styles.disabledButton : null,
            ]}
          >
            <Text style={active ? { color: colors.surface0, fontSize: 12, fontWeight: "600" } : { color: tone.color, fontSize: 12 }}>
              {PRIORITY_LABEL[priority]}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Без приоритета"
        disabled={disabled}
        onPress={() => onChange(null)}
        style={[
          styles.chip,
          value === null ? styles.chipActive : null,
          disabled ? styles.disabledButton : null,
        ]}
      >
        <Text style={value === null ? styles.chipTextActive : styles.chipText}>без приоритета</Text>
      </Pressable>
    </View>
  );
}

export function CreateTicketModal({
  projectId,
  column,
  colors,
  styles,
  onClose,
  onCreated,
}: {
  projectId: string;
  column: Column;
  colors: Colors;
  styles: Styles;
  onClose: () => void;
  onCreated: () => void;
}) {
  const sendCreate = useRpc(kanbanCreateTicket);
  const mutation = useMutationRunner();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority | null>(null);

  const trimmed = title.trim();
  const canCreate = trimmed.length > 0 && !mutation.busy;

  const submit = useCallback(() => {
    if (trimmed.length === 0) return;
    mutation.run(
      () =>
        sendCreate({
          projectId,
          title: trimmed,
          description: description.trim().length > 0 ? description : undefined,
          priority,
          columnId: column.id,
        }),
      () => {
        onCreated();
        onClose();
      },
    );
  }, [trimmed, mutation, sendCreate, projectId, description, priority, column.id, onCreated, onClose]);

  return (
    <NativeModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Закрыть форму создания"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              Новый тикет в «{column.name}»
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose}>
              <Text style={styles.modalClose}>✕</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>Заголовок</Text>
              <TextInput
                accessibilityLabel="Заголовок тикета"
                value={title}
                onChangeText={setTitle}
                editable={!mutation.busy}
                placeholder="Что нужно сделать"
                placeholderTextColor={colors.foregroundMuted}
                style={styles.input}
              />
            </View>

            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>Описание</Text>
              <TextInput
                accessibilityLabel="Описание тикета"
                value={description}
                onChangeText={setDescription}
                editable={!mutation.busy}
                multiline
                placeholder="Контекст, критерии приёмки"
                placeholderTextColor={colors.foregroundMuted}
                style={[styles.input, styles.inputMultiline]}
              />
            </View>

            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>Приоритет</Text>
              <PriorityPicker
                value={priority}
                onChange={setPriority}
                disabled={mutation.busy}
                colors={colors}
                styles={styles}
              />
            </View>

            <View style={styles.formActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Отмена"
                onPress={onClose}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Отмена</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Создать тикет"
                disabled={!canCreate}
                onPress={submit}
                style={[styles.primaryButton, canCreate ? null : styles.disabledButton]}
              >
                <Text style={styles.primaryButtonText}>Create</Text>
              </Pressable>
            </View>
          </ScrollView>

          <Toast message={mutation.error} onDismiss={mutation.clearError} styles={styles} />
        </View>
      </View>
    </NativeModal>
  );
}
