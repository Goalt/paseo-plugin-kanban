import { useEffect } from "react";
import { Pressable, Text } from "react-native";
import type { Styles } from "./ui";

// Тост об ошибке мутации (паттерн из modal-ui): всплывает снизу, гаснет сам,
// закрывается тапом. Держим как отдельный компонент — доска и модалка
// показывают его каждая в своём слое.

const AUTO_HIDE_MS = 6000;

export function Toast({
  message,
  onDismiss,
  styles,
}: {
  message: string | null;
  onDismiss: () => void;
  styles: Styles;
}) {
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(onDismiss, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  if (message === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Скрыть сообщение об ошибке"
      onPress={onDismiss}
      style={styles.toast}
    >
      <Text style={styles.toastText}>{message}</Text>
    </Pressable>
  );
}
