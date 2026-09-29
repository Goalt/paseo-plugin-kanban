import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useState } from "react";
import { Modal as NativeModal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { kanbanProjectDelete, type Project } from "../shared/contract";
import { useMutationRunner } from "./mutations";
import { Toast } from "./toast";
import type { Colors, Styles } from "./ui";

// Подтверждение удаления проекта. В отличие от тикета (там хватает «Удалить?»),
// здесь каскадом уходит вся доска — колонки, тикеты и сабтаски, — поэтому кнопка
// разблокируется только после точного ввода имени проекта.
//
// Ограничения клиентского бандла 0.6.1 в силе: только промис-цепочки, импорты
// только react / react-native / @getpaseo/plugin.

export function DeleteProjectModal({
  project,
  // Число тикетов известно только для открытого проекта — снапшот приходит по
  // одному проекту за раз. Для остальных показываем предупреждение без цифры.
  ticketCount,
  colors,
  styles,
  onClose,
  onDeleted,
}: {
  project: Project;
  ticketCount: number | null;
  colors: Colors;
  styles: Styles;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const sendDelete = useRpc(kanbanProjectDelete);
  const mutation = useMutationRunner();
  const [typed, setTyped] = useState("");

  // Именно точное совпадение: пробелы по краям не срезаем, иначе «подтверждение
  // вводом» вырождается в «нажать не глядя».
  const confirmed = typed === project.name;
  const canDelete = confirmed && !mutation.busy;

  const submit = useCallback(() => {
    if (!confirmed) return;
    // Ошибка (в том числе 400 «Cannot delete the only project») останется в
    // раннере и всплывёт тостом поверх модалки — окно не закрываем.
    mutation.run(() => sendDelete({ projectId: project.id }), onDeleted);
  }, [confirmed, mutation, sendDelete, project.id, onDeleted]);

  return (
    <NativeModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Закрыть подтверждение удаления проекта"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              Удалить проект «{project.name}»
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Закрыть" onPress={onClose}>
              <Text style={styles.modalClose}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.modalBody}>
            <Text style={styles.errorText}>
              Удалить проект «{project.name}»? Это необратимо: удалятся все колонки и тикеты
              {ticketCount === null ? "" : ` (${ticketCount})`} вместе с сабтасками.
            </Text>

            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>Введите имя проекта для подтверждения</Text>
              <TextInput
                accessibilityLabel="Имя проекта для подтверждения"
                value={typed}
                onChangeText={setTyped}
                editable={!mutation.busy}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={project.name}
                placeholderTextColor={colors.foregroundMuted}
                style={styles.input}
              />
            </View>

            <View style={styles.formActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Отменить удаление проекта"
                onPress={onClose}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonText}>Отмена</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Подтвердить удаление проекта"
                disabled={!canDelete}
                onPress={submit}
                style={[styles.dangerButton, canDelete ? null : styles.disabledButton]}
              >
                <Text style={styles.dangerButtonText}>Удалить</Text>
              </Pressable>
            </View>
          </View>

          <Toast message={mutation.error} onDismiss={mutation.clearError} styles={styles} />
        </View>
      </View>
    </NativeModal>
  );
}
