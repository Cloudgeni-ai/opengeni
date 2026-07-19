import { describe, expect, test } from "bun:test";
import { continuationHoldMs, durableWaitTimerPlan } from "../src/workflows/session";

// P3 all-capped infinite-loop bugfix (fix #6). session.ts must treat a rotation
// all-capped idle (`idleUntilReset`) as a MANDATORY hold: a 0/elapsed continueDelayMs
// can never skip the wait and re-enter the tight re-dispatch loop (invariant 4: NO
// THRASH). A NORMAL continueDelayMs:0 (a rotation candidate is ready) still re-dispatches
// immediately — the two cases must stay distinct.
const FLOOR = 60_000; // ROTATION_IDLE_FLOOR_MS

describe("continuationHoldMs — the all-capped idle is a real wait", () => {
  test("(f) an all-capped idle with continueDelayMs:0 STILL holds the floor (a 0 cannot skip the hold)", () => {
    expect(
      continuationHoldMs({ status: "idle", continueDelayMs: 0, idleUntilReset: true }, FLOOR),
    ).toBe(FLOOR);
  });

  test("(f) an all-capped idle with an undefined delay holds the floor", () => {
    expect(continuationHoldMs({ status: "idle", idleUntilReset: true }, FLOOR)).toBe(FLOOR);
  });

  test("(f) an all-capped idle with a positive delay holds exactly that delay", () => {
    expect(
      continuationHoldMs(
        { status: "idle", continueDelayMs: 5 * 60_000, idleUntilReset: true },
        FLOOR,
      ),
    ).toBe(5 * 60_000);
  });

  test("a NORMAL continueDelayMs:0 (rotation candidate ready) does NOT hold — re-dispatch now", () => {
    expect(continuationHoldMs({ status: "idle", continueDelayMs: 0 }, FLOOR)).toBe(0);
    expect(continuationHoldMs({ status: "idle" }, FLOOR)).toBe(0);
  });

  test("a normal backpressure delay holds exactly that long", () => {
    expect(continuationHoldMs({ status: "idle", continueDelayMs: 60_000 }, FLOOR)).toBe(60_000);
  });

  test("same-turn provider recovery honors the interruptible backpressure delay", () => {
    expect(continuationHoldMs({ status: "recovering", continueDelayMs: 60_000 }, FLOOR)).toBe(
      60_000,
    );
  });

  test("a non-idle, non-recovering result never holds", () => {
    expect(
      continuationHoldMs({ status: "failed", continueDelayMs: 99, idleUntilReset: true }, FLOOR),
    ).toBe(0);
    expect(continuationHoldMs({ status: "requires_action" }, FLOOR)).toBe(0);
  });
});

describe("durableWaitTimerPlan — restart-safe wait reconstruction", () => {
  const now = Date.parse("2026-07-11T12:00:00.000Z");

  test("ask_user defaults to an indefinite signal wait", () => {
    expect(
      durableWaitTimerPlan({ kind: "ask_user", wakeAt: null, nextReminderAt: null }, now),
    ).toEqual({ cause: "signal", delayMs: null });
  });

  test("an ask_user reminder wins before its timeout", () => {
    expect(
      durableWaitTimerPlan(
        {
          kind: "ask_user",
          nextReminderAt: "2026-07-11T12:01:00.000Z",
          wakeAt: "2026-07-11T12:05:00.000Z",
        },
        now,
      ),
    ).toEqual({ cause: "reminder", delayMs: 60_000 });
  });

  test("a timeout wins when no earlier reminder remains", () => {
    expect(
      durableWaitTimerPlan(
        {
          kind: "ask_user",
          nextReminderAt: null,
          wakeAt: "2026-07-11T12:05:00.000Z",
        },
        now,
      ),
    ).toEqual({ cause: "deadline", delayMs: 300_000 });
  });

  test("restart after a passive deadline reconciles immediately", () => {
    expect(
      durableWaitTimerPlan(
        {
          kind: "event",
          nextReminderAt: null,
          wakeAt: "2026-07-11T11:59:59.000Z",
        },
        now,
      ),
    ).toEqual({ cause: "deadline", delayMs: 0 });
  });

  test("event and background-job waits without deadlines remain signal-driven", () => {
    expect(
      durableWaitTimerPlan({ kind: "event", nextReminderAt: null, wakeAt: null }, now),
    ).toEqual({ cause: "signal", delayMs: null });
    expect(
      durableWaitTimerPlan({ kind: "background_job", nextReminderAt: null, wakeAt: null }, now),
    ).toEqual({ cause: "signal", delayMs: null });
  });
});
