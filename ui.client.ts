import type { PluginSurfaceProps } from "@getpaseo/plugin";
import type { Priority } from "./contract";

// Общие для доски и модалки цвета, стили и мелкие хелперы.
// Ограничения клиентского бандла 0.6.1 те же: никакого асинхронного сахара,
// импорты только react / react-native / @getpaseo/plugin.

export type Colors = PluginSurfaceProps["theme"]["colors"];

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
};

export const PRIORITIES: Priority[] = ["urgent", "high", "medium", "low"];

// Палитра плагинов 0.6.1 — ровно шесть цветов (surface0, foreground, foregroundMuted,
// accent, accentForeground, statusDanger), отдельного «warning» в ней нет. Поэтому
// приоритеты различаем не только цветом, но и заливкой: urgent — плашка, остальные — контур.
export function priorityStyle(priority: Priority, colors: Colors): { color: string; filled: boolean } {
  if (priority === "urgent") return { color: colors.statusDanger, filled: true };
  if (priority === "high") return { color: colors.statusDanger, filled: false };
  if (priority === "medium") return { color: colors.accent, filled: false };
  return { color: colors.foregroundMuted, filled: false };
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message || cause.name : String(cause);
}

export type Styles = ReturnType<typeof createStyles>;

export function createStyles(colors: Colors, compact: boolean) {
  return {
    screen: {
      flex: 1,
      padding: compact ? 12 : 16,
      gap: compact ? 8 : 12,
      backgroundColor: colors.surface0,
    },
    // В узкой панели воркспейса шапка раскладывается в две строки: на перенос
    // внутри строки полагаться нельзя — RN-web оставляет ряд кнопок за краем.
    headerRow: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    headerLeft: { flexShrink: 1, flexGrow: 1, minWidth: 140, gap: 2 },
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
    headerControls: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: compact ? ("flex-start" as const) : ("flex-end" as const),
      gap: 8,
      flexWrap: "wrap" as const,
      // В узкой панели воркспейса кнопки должны переноситься, а не уезжать за край.
      flexShrink: 1,
    },
    counterBadge: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
    counterText: { color: colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
    sessionButton: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      maxWidth: compact ? 130 : 180,
    },
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
      minWidth: 200,
      maxWidth: 320,
      maxHeight: 280,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      borderRadius: 10,
      backgroundColor: colors.surface0,
      overflow: "hidden" as const,
    },
    pickerMenuLeft: { left: compact ? 12 : 16 },
    pickerMenuRight: { right: compact ? 12 : 16 },
    pickerList: { paddingVertical: 4 },
    pickerItemRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    pickerItem: { paddingVertical: 8, paddingHorizontal: 12 },
    pickerItemActive: { backgroundColor: colors.accent },
    // Строка проекта: имя и кнопка удаления — СОСЕДНИЕ Pressable внутри View.
    // Вложенные Pressable на вебе ловят один клик дважды (см. карточку тикета).
    pickerRow: { flexDirection: "row" as const, alignItems: "center" as const },
    pickerItemFill: { flexGrow: 1, flexShrink: 1 },
    // Компактный вариант dangerButton: в выпадашке шириной 200–320 px обычные
    // отступы кнопки съедают половину строки.
    pickerDelete: { paddingVertical: 2, paddingHorizontal: 7, marginRight: 8 },
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
    disabledButton: { opacity: 0.5 },
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
    columnCount: { color: colors.foregroundMuted, fontSize: 12, flexGrow: 1, textAlign: "right" as const },
    columnBody: { gap: 8, paddingBottom: 4 },
    columnEmpty: {
      color: colors.foregroundMuted,
      fontSize: 12,
      textAlign: "center" as const,
      paddingVertical: 12,
    },
    card: {
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      borderRadius: 8,
      padding: 10,
      gap: 6,
    },
    cardContent: { gap: 6 },
    moveButton: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
    },
    moveButtonText: { color: colors.foreground, fontSize: 12, lineHeight: 16 },
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

    input: {
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: colors.foreground,
      fontSize: 13,
    },
    inputMultiline: { minHeight: 96, textAlignVertical: "top" as const },
    formActions: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
      alignItems: "center" as const,
      gap: 8,
      flexWrap: "wrap" as const,
    },
    dangerButton: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.statusDanger,
    },
    dangerButtonText: { color: colors.statusDanger, fontSize: 13 },
    columnAdd: {
      paddingHorizontal: 8,
      paddingVertical: 1,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
    },
    columnAddText: { color: colors.foreground, fontSize: 13, lineHeight: 17 },
    subtaskRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingVertical: 3,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    checkboxDone: { backgroundColor: colors.accent, borderColor: colors.accent },
    checkboxMark: { color: colors.accentForeground, fontSize: 12, lineHeight: 14 },
    subtaskText: { color: colors.foreground, fontSize: 13, flexShrink: 1 },
    subtaskTextDone: {
      color: colors.foregroundMuted,
      fontSize: 13,
      flexShrink: 1,
      textDecorationLine: "line-through" as const,
    },
    depTag: {
      fontSize: 10,
      fontWeight: "600" as const,
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
      overflow: "hidden" as const,
    },
    addRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    addInput: { flexGrow: 1, flexShrink: 1 },
    toast: {
      position: "absolute" as const,
      left: 12,
      right: 12,
      bottom: 12,
      padding: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.statusDanger,
      backgroundColor: colors.surface0,
    },
    toastText: { color: colors.statusDanger, fontSize: 12 },

    // ————— модалка деталей —————
    modalBackdrop: {
      flex: 1,
      justifyContent: "center" as const,
      padding: compact ? 8 : 16,
      backgroundColor: "rgba(0,0,0,0.5)",
    },
    modalCard: {
      width: "100%" as const,
      maxWidth: 720,
      maxHeight: "88%" as const,
      alignSelf: "center" as const,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
      backgroundColor: colors.surface0,
      overflow: "hidden" as const,
    },
    modalHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      padding: 12,
      borderBottomWidth: 1,
      borderColor: colors.foregroundMuted,
    },
    modalNumber: {
      color: colors.foregroundMuted,
      fontSize: 13,
      fontWeight: "700" as const,
    },
    modalTitle: {
      color: colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
      flexShrink: 1,
      flexGrow: 1,
    },
    modalClose: { color: colors.foregroundMuted, fontSize: 16, paddingHorizontal: 6 },
    modalBody: { padding: 12, gap: 12 },
    modalSection: { gap: 6 },
    modalSectionTitle: {
      color: colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600" as const,
      textTransform: "uppercase" as const,
    },
    modalMetaRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    chip: {
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.foregroundMuted,
    },
    chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { color: colors.foreground, fontSize: 12 },
    chipTextActive: { color: colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
    modalText: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    modalMuted: { color: colors.foregroundMuted, fontSize: 12 },
    modalFill: { flexShrink: 1 },
  };
}
