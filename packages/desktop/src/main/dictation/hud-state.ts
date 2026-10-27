/** What the dictation window shows. */
export type DictationHudState =
  | { kind: "hidden" }
  | { kind: "starting"; label: string | null }
  | {
      kind: "recording";
      /** Epoch milliseconds. */
      startedAt: number;
      /** The microphone's level from 0 to 1, when it is metered. */
      level: number | null;
      label: string | null;
      /** Held down: letting go stops it, so there is no stop button. */
      hold: boolean;
    }
  | { kind: "transcribing"; label: string | null }
  | {
      kind: "notice";
      tone: "info" | "success" | "error";
      message: string;
      actions: DictationHudAction[];
    };

/** A button in the dictation window. */
export type DictationHudAction = "stop" | "cancel" | "retry" | "dismiss" | "allow" | "open";

export const DICTATION_HUD_ACTIONS: readonly DictationHudAction[] = [
  "stop",
  "cancel",
  "retry",
  "dismiss",
  "allow",
  "open",
];
