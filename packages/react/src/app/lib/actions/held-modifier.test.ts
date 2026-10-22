import { describe, expect, test } from "bun:test";

import { createHeldModifierTracker } from "./held-modifier";

function harness(platform: "mac" | "other" = "mac") {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target = {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
  let pending: (() => void) | null = null;
  const timers = {
    setTimeout: ((callback: () => void) => {
      pending = callback;
      return 1;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {
      pending = null;
    }) as unknown as typeof clearTimeout,
  };
  const tracker = createHeldModifierTracker(target, platform, timers);
  let changes = 0;
  const unsubscribe = tracker.subscribe(() => changes++);
  const fire = (type: string, init: Partial<KeyboardEvent> = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(init as unknown as Event);
  };
  return {
    tracker,
    fire,
    elapse: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    changes: () => changes,
    unsubscribe,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

describe("held modifier", () => {
  test("shows after ⌘ is held alone, hides on release", () => {
    const h = harness();
    h.fire("keydown", { key: "Meta", metaKey: true });
    expect(h.tracker.held()).toBe(false);
    h.elapse();
    expect(h.tracker.held()).toBe(true);
    h.fire("keyup", { key: "Meta" });
    expect(h.tracker.held()).toBe(false);
    expect(h.changes()).toBe(2);
  });

  test("a quick ⌘ shortcut never shows the hint", () => {
    const h = harness();
    h.fire("keydown", { key: "Meta", metaKey: true });
    h.fire("keydown", { key: "c", code: "KeyC", metaKey: true });
    h.elapse();
    expect(h.tracker.held()).toBe(false);
  });

  test("another key or leaving the window hides it", () => {
    const h = harness();
    h.fire("keydown", { key: "Meta", metaKey: true });
    h.elapse();
    h.fire("keydown", { key: "1", code: "Digit1", metaKey: true });
    expect(h.tracker.held()).toBe(false);
    h.fire("keydown", { key: "Meta", metaKey: true });
    h.elapse();
    h.fire("blur");
    expect(h.tracker.held()).toBe(false);
  });

  test("⌘ with other modifiers is not the hint", () => {
    const h = harness();
    h.fire("keydown", { key: "Meta", metaKey: true, shiftKey: true });
    h.elapse();
    expect(h.tracker.held()).toBe(false);
  });

  test("Ctrl is the key on Windows and Linux", () => {
    const h = harness("other");
    h.fire("keydown", { key: "Meta", metaKey: true });
    h.elapse();
    expect(h.tracker.held()).toBe(false);
    h.fire("keydown", { key: "Control", ctrlKey: true });
    h.elapse();
    expect(h.tracker.held()).toBe(true);
  });

  test("stops listening when the last row goes away", () => {
    const h = harness();
    expect(h.listenerCount()).toBeGreaterThan(0);
    h.unsubscribe();
    expect(h.listenerCount()).toBe(0);
  });
});
