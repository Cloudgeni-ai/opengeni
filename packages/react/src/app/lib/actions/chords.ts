/**
 * Keyboard chords: matching, platform notation and desktop accelerators.
 *
 * A chord always has ⌘ (Mac) or Ctrl (Windows and Linux) unless it is a
 * navigation chord with ⌥/Alt, so it never fights with typing. Chords match on
 * `KeyboardEvent.code`, which names the physical key, so they work on every
 * keyboard layout. Punctuation also matches the character typed, because many
 * layouts put it elsewhere: "/" is ⇧7 on Nordic and German keyboards.
 */

export type ChordPlatform = "mac" | "other";
export type ActionSurface = "web" | "desktop";

export type Chord = {
  /** `KeyboardEvent.code`, e.g. `"KeyO"`, `"Comma"`, `"ArrowDown"`, `"Digit1"`. */
  code: string;
  /** ⌘ on Mac, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  /** ⌥ on Mac, Alt elsewhere. */
  alt?: boolean;
  /** The Control key itself on Mac (⌃). Ignored elsewhere, where `mod` is Ctrl. */
  control?: boolean;
  /** Only on this surface (browsers reserve some keys). */
  only?: ActionSurface;
  /** Only on this platform. */
  platform?: ChordPlatform;
};

export function currentPlatform(): ChordPlatform {
  if (typeof navigator === "undefined") return "other";
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "mac" : "other";
}

/** The chords that apply on this surface and platform, in priority order. */
export function applicableChords(
  chords: readonly Chord[] | undefined,
  surface: ActionSurface,
  platform: ChordPlatform,
): Chord[] {
  return (chords ?? []).filter(
    (chord) =>
      (!chord.only || chord.only === surface) && (!chord.platform || chord.platform === platform),
  );
}

export function matchesChord(
  event: Pick<
    KeyboardEvent,
    "code" | "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat" | "isComposing"
  >,
  chord: Chord,
  platform: ChordPlatform,
): boolean {
  if (event.repeat || event.isComposing) return false;
  if (event.code === chord.code) {
    if (Boolean(chord.shift) !== event.shiftKey) return false;
  } else {
    // The character on another key: whatever Shift it took to type it is part
    // of typing the character, so only a chord without Shift can match this way.
    const character = PUNCTUATION[chord.code];
    if (!character || chord.shift || event.key !== character) return false;
  }
  if (Boolean(chord.alt) !== event.altKey) return false;
  if (platform === "mac") {
    if (Boolean(chord.mod) !== event.metaKey) return false;
    if (Boolean(chord.control) !== event.ctrlKey) return false;
  } else {
    if (Boolean(chord.mod) !== event.ctrlKey) return false;
    if (event.metaKey) return false;
  }
  return true;
}

const PUNCTUATION: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const KEY_NAMES: Record<string, { mac: string; other: string; accelerator: string }> = {
  Comma: { mac: ",", other: ",", accelerator: "," },
  Period: { mac: ".", other: ".", accelerator: "." },
  Slash: { mac: "/", other: "/", accelerator: "/" },
  Backslash: { mac: "\\", other: "\\", accelerator: "\\" },
  BracketLeft: { mac: "[", other: "[", accelerator: "[" },
  BracketRight: { mac: "]", other: "]", accelerator: "]" },
  Semicolon: { mac: ";", other: ";", accelerator: ";" },
  Quote: { mac: "'", other: "'", accelerator: "'" },
  Minus: { mac: "-", other: "-", accelerator: "-" },
  Equal: { mac: "=", other: "=", accelerator: "=" },
  Backquote: { mac: "`", other: "`", accelerator: "`" },
  ArrowUp: { mac: "↑", other: "↑", accelerator: "Up" },
  ArrowDown: { mac: "↓", other: "↓", accelerator: "Down" },
  ArrowLeft: { mac: "←", other: "←", accelerator: "Left" },
  ArrowRight: { mac: "→", other: "→", accelerator: "Right" },
  Enter: { mac: "↩", other: "Enter", accelerator: "Return" },
  Escape: { mac: "Esc", other: "Esc", accelerator: "Escape" },
  Tab: { mac: "⇥", other: "Tab", accelerator: "Tab" },
  Space: { mac: "Space", other: "Space", accelerator: "Space" },
  Backspace: { mac: "⌫", other: "Backspace", accelerator: "Backspace" },
};

function keyName(code: string, platform: ChordPlatform | "accelerator"): string {
  const known = KEY_NAMES[code];
  if (known) return known[platform];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F[0-9]{1,2}$/.test(code)) return code;
  return code;
}

/** The chord as keycaps, in the platform's own notation: `["⌘", "⇧", "O"]` or `["Ctrl", "Shift", "O"]`. */
export function chordKeys(chord: Chord, platform: ChordPlatform): string[] {
  if (platform === "mac") {
    // Apple's order: Control, Option, Shift, Command.
    return [
      ...(chord.control ? ["⌃"] : []),
      ...(chord.alt ? ["⌥"] : []),
      ...(chord.shift ? ["⇧"] : []),
      ...(chord.mod ? ["⌘"] : []),
      keyName(chord.code, "mac"),
    ];
  }
  return [
    ...(chord.mod ? ["Ctrl"] : []),
    ...(chord.alt ? ["Alt"] : []),
    ...(chord.shift ? ["Shift"] : []),
    keyName(chord.code, "other"),
  ];
}

/** One string for tooltips and `title`s: `⌘⇧O` on Mac, `Ctrl+Shift+O` elsewhere. */
export function chordLabel(chord: Chord, platform: ChordPlatform): string {
  const keys = chordKeys(chord, platform);
  return platform === "mac" ? keys.join("") : keys.join("+");
}

/** The `aria-keyshortcuts` value for a chord. */
export function chordAriaKeys(chord: Chord, platform: ChordPlatform): string {
  const key = keyName(chord.code, "accelerator");
  const named =
    key === "Up" || key === "Down" || key === "Left" || key === "Right" ? `Arrow${key}` : key;
  return [
    ...(chord.control && platform === "mac" ? ["Control"] : []),
    ...(chord.mod ? [platform === "mac" ? "Meta" : "Control"] : []),
    ...(chord.alt ? ["Alt"] : []),
    ...(chord.shift ? ["Shift"] : []),
    named,
  ].join("+");
}

/** An Electron accelerator for the desktop menu bar. */
export function chordAccelerator(chord: Chord): string {
  return [
    ...(chord.control ? ["Ctrl"] : []),
    ...(chord.mod ? ["CmdOrCtrl"] : []),
    ...(chord.alt ? ["Alt"] : []),
    ...(chord.shift ? ["Shift"] : []),
    keyName(chord.code, "accelerator"),
  ].join("+");
}

/** True when typing into this element would insert text (so bare keys belong to it). */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(
      target.type,
    );
  }
  return false;
}
