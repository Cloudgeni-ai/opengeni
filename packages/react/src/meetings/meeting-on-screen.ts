/**
 * The meeting page on screen, as the app's ⌘K menu reaches it: which meeting
 * it shows and, when it takes questions, how to ask one ("Ask about this
 * meeting"). Kept per app request target (see `useUiEventTarget`), so two
 * embedded apps on one page never act on each other's meeting.
 */
import { useEffect, useSyncExternalStore } from "react";

export type MeetingOnScreen = {
  recordingId: string;
  /**
   * Asks a question about the meeting, as its Ask field does; with no question,
   * shows the Ask field with the cursor in it. Absent when the page takes no
   * questions (the host offers none, or the meeting is being recorded here).
   */
  ask: ((question: string | null) => void) | null;
};

type Entry = { page: MeetingOnScreen | null; listeners: Set<() => void> };

const entries = new WeakMap<EventTarget, Entry>();

function entry(target: EventTarget): Entry {
  let current = entries.get(target);
  if (!current) {
    current = { page: null, listeners: new Set() };
    entries.set(target, current);
  }
  return current;
}

function publish(target: EventTarget, page: MeetingOnScreen | null): void {
  const current = entry(target);
  current.page = page;
  for (const listener of current.listeners) listener();
}

/** The meeting page says it is on screen while mounted, and what it offers. */
export function useAnnounceMeetingOnScreen(
  target: EventTarget,
  recordingId: string,
  ask: MeetingOnScreen["ask"],
): void {
  const askable = ask !== null;
  useEffect(() => {
    const page: MeetingOnScreen = { recordingId, ask };
    publish(target, page);
    return () => {
      if (entry(target).page === page) publish(target, null);
    };
    // `ask` is read through a ref by the page; only whether it exists matters here.
  }, [target, recordingId, askable]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The meeting page on screen in this app, if any. */
export function useMeetingOnScreen(target: EventTarget): MeetingOnScreen | null {
  return useSyncExternalStore(
    (listener) => {
      const current = entry(target);
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    },
    () => entry(target).page,
    () => null,
  );
}
