import { describe, expect, test } from "bun:test";
import { AFTER_KEY_EFFECTS_EXPRESSION } from "../src/cdp-driver";

/**
 * Runs the wait between typed keys on a fake page. Like a split one-time-code
 * field, the page reacted to the last key by moving focus in a task after its
 * next frame. `frameAfterMs` is when that frame comes, or null for a tab that
 * produces no frames.
 */
async function waitAfterKey(
  visibilityState: "visible" | "hidden",
  frameAfterMs: number | null,
): Promise<{ focusMoved: boolean; elapsedMs: number }> {
  const callbacks: Array<() => void> = [];
  const requestAnimationFrame = (callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  let focusMoved = false;
  // The page's own effect was scheduled during the key event, before the wait.
  requestAnimationFrame(() => setTimeout(() => (focusMoved = true), 0));
  const started = performance.now();
  const wait = new Function(
    "document",
    "requestAnimationFrame",
    `return ${AFTER_KEY_EFFECTS_EXPRESSION};`,
  )({ visibilityState }, requestAnimationFrame) as Promise<boolean>;
  if (frameAfterMs !== null) {
    setTimeout(() => {
      for (const callback of callbacks.splice(0)) callback();
    }, frameAfterMs);
  }
  await wait;
  return { focusMoved, elapsedMs: performance.now() - started };
}

describe("the wait between typed keys", () => {
  test("a visible tab waits for a late frame so the next key follows focus", async () => {
    const result = await waitAfterKey("visible", 150);
    expect(result.focusMoved).toBe(true);
  });

  test("a visible tab with a prompt frame continues right after it", async () => {
    const result = await waitAfterKey("visible", 5);
    expect(result.focusMoved).toBe(true);
    expect(result.elapsedMs).toBeLessThan(500);
  });

  test("a hidden tab that produces no frames waits only briefly", async () => {
    const result = await waitAfterKey("hidden", null);
    expect(result.focusMoved).toBe(false);
    expect(result.elapsedMs).toBeLessThan(500);
  });
});
