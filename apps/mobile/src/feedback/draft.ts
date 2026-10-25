import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { Dimensions } from "react-native";
import { captureScreen } from "react-native-view-shot";
import { feedbackScreen } from "./recent-errors";

export type FeedbackImage = Readonly<{
  /** Stable within the draft, so one image can be removed without disturbing the rest. */
  key: string;
  uri: string;
  width: number;
  height: number;
  contentType: "image/jpeg" | "image/png";
}>;

/** The report being written: how it was opened, the screen it is about and its images. */
export type FeedbackDraft = Readonly<{
  key: number;
  trigger: "menu" | "shake";
  screen: string | null;
  images: readonly FeedbackImage[];
}>;

let draft: FeedbackDraft | null = null;
let opening = false;
let nextKey = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export const feedbackDraftStore = {
  get: (): FeedbackDraft | null => draft,
  /** True while a report is open or its screenshot is being taken. */
  busy: (): boolean => opening || draft !== null,
  removeImage(key: string): void {
    if (!draft) return;
    draft = { ...draft, images: draft.images.filter((image) => image.key !== key) };
    emit();
  },
  close(): void {
    if (!draft && !opening) return;
    draft = null;
    opening = false;
    emit();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useFeedbackDraft(): FeedbackDraft | null {
  return useSyncExternalStore(feedbackDraftStore.subscribe, feedbackDraftStore.get, () => null);
}

// Screenshots are scaled to the screen's point size: sharp enough to read, small to send.
async function captureCurrentScreen(): Promise<FeedbackImage | null> {
  const { width, height } = Dimensions.get("window");
  try {
    const uri = await captureScreen({ format: "jpg", quality: 0.75, result: "tmpfile", width });
    return { key: `screen:${uri}`, uri, width, height, contentType: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Opens Send feedback. From a shake it first takes a screenshot of the screen in
 * view, so the person can see it and remove it before sending.
 */
export async function startFeedback(trigger: "menu" | "shake"): Promise<void> {
  if (opening || draft) return;
  opening = true;
  const screen = feedbackScreen();
  const screenshot = trigger === "shake" ? await captureCurrentScreen() : null;
  opening = false;
  draft = { key: nextKey++, trigger, screen, images: screenshot ? [screenshot] : [] };
  emit();
  router.push("/feedback");
}
