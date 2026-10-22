/**
 * Whether ⌘ (Mac) or Ctrl (elsewhere) is being held on its own, so the page
 * can show which keys it unlocks: the pinned chats show ⌘1 to ⌘9.
 *
 * The hint waits a moment before appearing, so a quick ⌘C or ⌘K never flashes
 * it, and it goes away on release, on any other key, and when the window loses
 * focus (⌘Tab to another app releases the key where the page can't see it).
 */
import { useSyncExternalStore } from "react";

import type { ChordPlatform } from "./chords";

export const HELD_MODIFIER_DELAY_MS = 350;

type HeldModifierTracker = {
  subscribe(listener: () => void): () => void;
  held(): boolean;
};

/** One tracker per window and platform; every row reads the same state. */
export function createHeldModifierTracker(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  platform: ChordPlatform,
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis,
): HeldModifierTracker {
  const modifierKey = platform === "mac" ? "Meta" : "Control";
  const listeners = new Set<() => void>();
  let held = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: boolean) => {
    if (held === next) return;
    held = next;
    for (const listener of listeners) listener();
  };
  const reset = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    set(false);
  };
  const onKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    const alone =
      keyEvent.key === modifierKey &&
      !keyEvent.shiftKey &&
      !keyEvent.altKey &&
      (platform === "mac" ? !keyEvent.ctrlKey : !keyEvent.metaKey);
    if (!alone) {
      reset();
      return;
    }
    if (keyEvent.repeat || held || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      set(true);
    }, HELD_MODIFIER_DELAY_MS);
  };
  const onKeyUp = (event: Event) => {
    if ((event as KeyboardEvent).key === modifierKey) reset();
  };
  const onVisibility = () => reset();

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        target.addEventListener("keydown", onKeyDown, true);
        target.addEventListener("keyup", onKeyUp, true);
        target.addEventListener("blur", reset);
        target.addEventListener("visibilitychange", onVisibility);
        target.addEventListener("pointerdown", reset, true);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        target.removeEventListener("keydown", onKeyDown, true);
        target.removeEventListener("keyup", onKeyUp, true);
        target.removeEventListener("blur", reset);
        target.removeEventListener("visibilitychange", onVisibility);
        target.removeEventListener("pointerdown", reset, true);
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        held = false;
      };
    },
    held: () => held,
  };
}

const trackers = new Map<ChordPlatform, HeldModifierTracker>();

function windowTracker(platform: ChordPlatform): HeldModifierTracker | null {
  if (typeof window === "undefined") return null;
  let tracker = trackers.get(platform);
  if (!tracker) {
    tracker = createHeldModifierTracker(window, platform);
    trackers.set(platform, tracker);
  }
  return tracker;
}

const NEVER: HeldModifierTracker = { subscribe: () => () => {}, held: () => false };

/** True while ⌘ (Ctrl elsewhere) is held alone; `enabled: false` never listens. */
export function useHeldModifier(platform: ChordPlatform, enabled: boolean): boolean {
  const tracker = (enabled ? windowTracker(platform) : null) ?? NEVER;
  return useSyncExternalStore(tracker.subscribe, tracker.held, () => false);
}
