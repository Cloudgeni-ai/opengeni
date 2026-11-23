import { describe, expect, test } from "bun:test";
import { createPhaseTimer } from "../src/activities/agent-turn/phase-timer";

describe("phase timer", () => {
  test("records each phase since the previous mark and the total", () => {
    const clock = [10, 12.4, 15, 4_015.6];
    const timer = createPhaseTimer(() => clock.shift()!);
    timer.mark("reconcileMs");
    timer.mark("checkpointMs");
    timer.mark("settleMs");
    expect(timer.phases()).toEqual({ reconcileMs: 2, checkpointMs: 3, settleMs: 4_001 });
    expect(timer.totalMs()).toBe(4_006);
  });
});
