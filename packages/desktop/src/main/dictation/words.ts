// The words dictation shows outside the page: the small window at the bottom
// of the screen and its messages. English unless the app gives its own, so an
// app in another language passes `words` to `createDesktopDictation`.

import type { DesktopDictationPasteBlocker } from "../../contract";

export interface DictationWords {
  /** The dictation window's title, for window lists and screen readers. */
  title: string;
  starting: string;
  transcribing: string;
  /** The button that finishes a dictation and types the text. */
  finish: string;
  /** The button that cancels a dictation; Escape does the same. */
  cancel: string;
  /** The button that closes a message. */
  close: string;
  retry: string;
  /** Opens the system's settings to allow typing into other apps. */
  allow: string;
  /** Opens the app's window. */
  open: string;
  /** No signed-in page to record with. `{product}` is the app's name. */
  signIn: string;
  /** The page that was recording closed or went to another page. */
  pageClosed: string;
  /** The page didn't start recording in time. `{product}` is the app's name. */
  noStart: string;
  noSpeech: string;
  /** The text was only copied, as the person chose. */
  copiedOnly: string;
  /** The text was copied instead of typed; `{reason}` says why. */
  copied: string;
  /** Typing it into the app in front failed for another reason. */
  pasteFailed: string;
  /** Why the text can't be typed into other apps on this computer. */
  pasteBlocked: Record<DesktopDictationPasteBlocker, string>;
  /** The retry shortcut found no dictation to transcribe again. English when absent. */
  nothingToRetry?: string;
}

export const ENGLISH_DICTATION_WORDS: DictationWords = {
  title: "Dictation",
  starting: "Starting…",
  transcribing: "Transcribing…",
  finish: "Finish and type it",
  cancel: "Cancel (Esc)",
  close: "Close",
  retry: "Try again",
  allow: "Allow",
  open: "Open",
  signIn: "Open {product} and sign in to dictate.",
  pageClosed: "Dictation stopped because the page closed. Try again.",
  noStart: "{product} didn't start recording. Try again.",
  noSpeech: "Didn't catch any speech.",
  copiedOnly: "Copied.",
  copied: "Copied. {reason}",
  pasteFailed: "Couldn't type the text.",
  pasteBlocked: {
    accessibility: "Allow Accessibility so dictation can type into other apps.",
    xdotool: "Install xdotool so dictation can type into other apps.",
    wtype: "Install wtype or ydotool so dictation can type into other apps.",
    unsupported: "This computer can't type into other apps.",
  },
  nothingToRetry: "No recent dictation to transcribe again.",
};

/** `template` with each `{name}` replaced. */
export function fillDictationWords(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
