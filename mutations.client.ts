import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describe } from "./ui.client";

// Общий раннер мутаций для доски и модалки: одна мутация за раз (второй быстрый
// тап по ◀ не уедет на две колонки), ошибка кладётся в state, успех дёргает
// колбэк — обычно немедленный перезабор снапшота, не дожидаясь поллинга.
//
// Клиентский бандл 0.6.1: только промис-цепочки, никакого асинхронного сахара.

export interface MutationResult {
  ok: boolean;
  error: string | null;
}

export interface MutationRunner {
  busy: boolean;
  error: string | null;
  run: (
    action: () => Promise<MutationResult>,
    onSuccess?: () => void,
    onSettled?: () => void,
  ) => void;
  clearError: () => void;
}

export function useMutationRunner(): MutationRunner {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Защёлка живёт в ref: state обновится только к следующему рендеру, а два
  // тапа подряд успевают проскочить раньше.
  const busyRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback(
    (
      action: () => Promise<MutationResult>,
      onSuccess?: () => void,
      onSettled?: () => void,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      action()
        .then((result) => {
          if (!aliveRef.current) return;
          if (!result.ok) {
            setError(result.error ?? "не удалось выполнить действие");
            return;
          }
          setError(null);
          if (onSuccess) onSuccess();
        })
        .catch((cause: unknown) => {
          if (aliveRef.current) setError(describe(cause));
        })
        .then(() => {
          busyRef.current = false;
          if (!aliveRef.current) return;
          setBusy(false);
          // Снапшот перезабираем в любом случае: после неудачи состояние на
          // сервере могло всё-таки измениться (или измениться не так, как ждали).
          if (onSettled) onSettled();
        });
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  // Стабильная ссылка: раннер уходит в зависимости useCallback у потребителей.
  return useMemo(() => ({ busy, error, run, clearError }), [busy, error, run, clearError]);
}
