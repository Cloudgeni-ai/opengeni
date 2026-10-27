// How the desktop app's global shortcuts are named and recorded, shared by
// the dictation and app-shot settings.
import type {
  DesktopDictationModifier,
  DesktopDictationShortcut,
  DesktopPlatform,
} from "@opengeni/sdk/desktop-bridge";

const MODIFIER_NAMES: Record<DesktopDictationModifier, { mac: string; other: string }> = {
  command: { mac: "⌘ Command", other: "Windows" },
  option: { mac: "⌥ Option", other: "Alt" },
  control: { mac: "⌃ Control", other: "Ctrl" },
  shift: { mac: "⇧ Shift", other: "Shift" },
  fn: { mac: "Fn", other: "Fn" },
};

const MAC_KEYS: Record<string, string> = {
  Command: "⌘",
  Cmd: "⌘",
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
  Control: "⌃",
  Ctrl: "⌃",
  Option: "⌥",
  Alt: "⌥",
  Shift: "⇧",
};

/** "⌥ Option" on a Mac, "Alt" elsewhere. */
export function modifierName(modifier: DesktopDictationModifier, platform: DesktopPlatform): string {
  const name = MODIFIER_NAMES[modifier];
  return platform === "macos" ? name.mac : name.other;
}

/**
 * A shortcut as people read it: "⌘⇧2" or "Ctrl+Shift+2" for a key
 * combination, "Both ⌥ Option keys" for a pair, "⌃ Control + Fn" for
 * modifier keys held together.
 */
export function desktopShortcutLabel(
  shortcut: DesktopDictationShortcut,
  platform: DesktopPlatform,
): string {
  if (shortcut.kind === "modifierPair") {
    return `Both ${modifierName(shortcut.modifier, platform)} keys`;
  }
  if (shortcut.kind === "modifierChord") {
    return shortcut.modifiers.map((modifier) => modifierName(modifier, platform)).join(" + ");
  }
  const parts = shortcut.accelerator.split("+");
  if (platform === "macos") return parts.map((part) => MAC_KEYS[part] ?? part).join("");
  return parts
    .map((part) =>
      part === "CommandOrControl" || part === "CmdOrCtrl" || part === "Control" ? "Ctrl" : part,
    )
    .join("+");
}

/**
 * The key combination a keydown makes, in Electron's accelerator syntax, or
 * null while only modifiers are held or none is (a shortcut needs one).
 */
export function acceleratorFromKey(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: DesktopPlatform,
): string | null {
  const key = acceleratorKey(event.code);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push(platform === "macos" ? "Command" : "Super");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  // Shift alone would take an ordinary character from every app.
  if (modifiers.length === 0 || (modifiers.length === 1 && event.shiftKey)) return null;
  return [...modifiers, key].join("+");
}

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
};

function acceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/u.exec(code);
  if (digit) return digit[1]!;
  if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

/** The same physical keys, so two shortcuts never fight over one press. */
export function sameDesktopShortcut(
  a: DesktopDictationShortcut,
  b: DesktopDictationShortcut,
): boolean {
  if (a.kind === "accelerator" && b.kind === "accelerator") {
    return a.accelerator.toLowerCase() === b.accelerator.toLowerCase();
  }
  if (a.kind === "modifierPair" && b.kind === "modifierPair") return a.modifier === b.modifier;
  if (a.kind === "modifierChord" && b.kind === "modifierChord") {
    return [...a.modifiers].sort().join("+") === [...b.modifiers].sort().join("+");
  }
  return false;
}
