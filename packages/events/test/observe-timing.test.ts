import { describe, expect, test } from "bun:test";
import { observeSince } from "../src/index";

// The append/publish timing seam behind `appendAndPublishEvents`'s optional
// observer (opengeni_session_event_append_seconds vs _publish_seconds). Tested at
// the `observeSince` helper directly: the wider suite installs a process-global
// `mock.module("@opengeni/events")` stub for `appendAndPublishEvents`, but it
// spreads the real module for every OTHER export, so `observeSince` stays real and
// this file passes regardless of test-file ordering.

describe("observeSince", () => {
  test("fires the callback with elapsed seconds and the event count", () => {
    const calls: Array<{ durationSeconds: number; count: number }> = [];
    const startedAt = performance.now();
    observeSince((info) => calls.push(info), startedAt, 7);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.count).toBe(7);
    expect(typeof calls[0]!.durationSeconds).toBe("number");
    expect(calls[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  test("clamps a would-be-negative elapsed to 0 (never a negative duration)", () => {
    let observed: number | null = null;
    // A startedAt in the FUTURE would make (now - startedAt) negative.
    observeSince((info) => (observed = info.durationSeconds), performance.now() + 10_000, 1);
    expect(observed).toBe(0);
  });

  test("is a no-op when no callback is supplied", () => {
    expect(() => observeSince(undefined, performance.now(), 3)).not.toThrow();
  });

  test("swallows a throwing callback so a metrics sink never breaks append/publish", () => {
    expect(() =>
      observeSince(
        () => {
          throw new Error("sink exploded");
        },
        performance.now(),
        1,
      ),
    ).not.toThrow();
  });
});
