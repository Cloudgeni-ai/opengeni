import { describe, expect, test } from "bun:test";
import {
  continuationHoldMs,
  deferredResultMayContinue,
  humanInputDeadlineWaitMs,
} from "../src/workflows/session";

// P3 all-capped infinite-loop bugfix (fix #6). session.ts must treat a rotation
// all-capped idle (`idleUntilReset`) as a MANDATORY hold: a 0/elapsed continueDelayMs
// can never skip the wait and re-enter the tight re-dispatch loop (invariant 4: NO
// THRASH). A NORMAL continueDelayMs:0 (a rotation candidate is ready) still re-dispatches
// immediately — the two cases must stay distinct.
const FLOOR = 60_000; // ROTATION_IDLE_FLOOR_MS

describe("structured human-input deadline waits", () => {
  test("holds until a future durable deadline and fires immediately after expiry", () => {
    const now = Date.parse("2026-07-21T12:00:00.000Z");
    expect(humanInputDeadlineWaitMs("2026-07-21T12:01:00.000Z", now)).toBe(60_000);
    expect(humanInputDeadlineWaitMs("2026-07-21T11:59:00.000Z", now)).toBe(0);
    expect(humanInputDeadlineWaitMs("invalid", now)).toBe(0);
  });
});

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

describe("deferredResultMayContinue — failed recovery converges until a real wake", () => {
  test("four unchanged deferred results cannot continue against unchanged durable state", () => {
    const entryWakeups = 17;
    for (let failure = 0; failure < 4; failure += 1) {
      expect(deferredResultMayContinue(entryWakeups, entryWakeups)).toBe(false);
    }
  });

  test("a newly committed non-control wake allows one later retry", () => {
    expect(deferredResultMayContinue(17, 18)).toBe(true);
  });
});
