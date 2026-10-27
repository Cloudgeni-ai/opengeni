// Where dictation meets the operating system: watching modifier keys for a
// shortcut held on its own, and typing the text into the app in front by
// pasting it. The shared controller (./index.ts) does everything else.
//
// - macOS (./mac.ts): modifier keys through the window server's key state,
//   paste as Command-V, which needs the Accessibility permission.
// - Windows (./windows.ts): paste as Control-V; shortcuts are key combinations.
// - Linux (./linux.ts): paste as Control-V through xdotool on X11, wtype or
//   ydotool on Wayland; without them the text is only copied.

import type {
  DesktopAppShotModifier,
  DesktopDictationPermissionId,
  DesktopDictationShortcut,
  DesktopPlatform,
} from "../../contract";

/** A shortcut of modifier keys alone, which only a watcher can see. */
export type DictationModifierShortcut = Exclude<DesktopDictationShortcut, { kind: "accelerator" }>;

/** One shortcut to watch, by the profile it starts. */
export interface DictationModifierWatch {
  id: string;
  shortcut: DictationModifierShortcut;
}

export interface DictationModifierEvents {
  /** The shortcut's keys are all down, and no other modifier. */
  onDown(id: string): void;
  /**
   * The shortcut was let go. `clean` is false when another key was pressed
   * while it was held: it was part of a key combination, not the shortcut.
   */
  onUp(id: string, clean: boolean): void;
}

/** Typing into the app in front, readied while the speech is transcribed. */
export interface DictationPaste {
  /** Paste the clipboard where the person is typing. Throws when it couldn't. */
  paste(): Promise<void>;
  /** Not needed after all. */
  cancel(): void;
}

export class DictationPasteError extends Error {
  constructor(
    message: string,
    /** The permission that would let it paste, where the system asks for one. */
    readonly permission?: DesktopDictationPermissionId,
  ) {
    super(message);
  }
}

export interface DictationPlatform {
  readonly platform: DesktopPlatform;
  /** Modifier pairs it can watch for; empty when only key combinations work. */
  readonly modifierPairs: DesktopAppShotModifier[];
  /** Whether modifier keys held together on their own can be a shortcut. */
  readonly modifierChords: boolean;
  /** Each permission the system asks for, allowed or not; empty where none are asked. */
  permissions(): Promise<{ id: DesktopDictationPermissionId; granted: boolean }[]>;
  /** The system prompt, or the place in the system's settings to allow it. */
  requestPermission(id: DesktopDictationPermissionId): Promise<void>;
  /** Whether text can be pasted into other apps here, and if not, why in a sentence. */
  pasteSupport(): Promise<{ available: boolean; reason: string | null }>;
  /** Get ready to paste; the paste itself follows once the text is on the clipboard. */
  preparePaste(): DictationPaste;
  /**
   * Watch modifier-key shortcuts. Resolves with a stop function once it is
   * watching; `onFailure` when it stops by itself.
   */
  watchModifiers?(
    watches: readonly DictationModifierWatch[],
    events: DictationModifierEvents,
    onFailure: (error: Error) => void,
  ): Promise<() => void>;
}
