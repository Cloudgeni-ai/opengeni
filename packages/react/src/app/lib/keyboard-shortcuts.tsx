/**
 * App-global keyboard shortcuts.
 *
 * Chords use Cmd on Apple platforms and Ctrl elsewhere (`metaOrCtrl`). Keep this
 * list small and conflict-aware — a Cmd-K command palette can surface these later.
 */

export type ShortcutChord = {
  /** `KeyboardEvent.code`, e.g. `"KeyO"`. Layout-stable vs `event.key`. */
  code: string;
  /** Require ⌘ (Mac) or Ctrl (Win/Linux). */
  metaOrCtrl: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type AppShortcut = {
  id: string;
  chord: ShortcutChord;
  /** Tooltip / help labels. */
  label: { mac: string; other: string };
};

export const NEW_SESSION_SHORTCUT = {
  id: "new-session",
  chord: { code: "KeyO", metaOrCtrl: true, shift: true },
  label: { mac: "⌘⇧O", other: "Ctrl+Shift+O" },
} as const satisfies AppShortcut;

/** Every registered app shortcut — grow here; palette can read this later. */
export const APP_SHORTCUTS = [NEW_SESSION_SHORTCUT] as const;

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function shortcutLabel(shortcut: Pick<AppShortcut, "label">): string {
  return isApplePlatform() ? shortcut.label.mac : shortcut.label.other;
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">,
  chord: ShortcutChord,
): boolean {
  if (event.repeat) return false;
  if (event.code !== chord.code) return false;
  if (Boolean(chord.shift) !== event.shiftKey) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;
  if (chord.metaOrCtrl) {
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else if (event.metaKey || event.ctrlKey) {
    return false;
  }
  return true;
}
