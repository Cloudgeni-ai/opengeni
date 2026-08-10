import { describe, expect, test } from "bun:test";
import { TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS } from "@opengeni/core";
import type { Context } from "@temporalio/activity";
import { NUMERIC_PERFORMANCE_BUDGETS } from "../../../scripts/workbench-acceptance-contract";
import { startActivityHeartbeat } from "../src/activities/streaming";
import { turnCancellationHeartbeatThrottleOptions } from "../src";

describe("session control cancellation latency contract", () => {
  test("keeps cancellation observation well inside the unchanged four-second live gate", () => {
    const budget = NUMERIC_PERFORMANCE_BUDGETS["performance.control-cancellation"];
    expect(budget).toMatchObject({
      statistic: "worst",
      direction: "maximum",
      limit: 4_000,
    });
    expect(TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS).toBe(500);
    expect(TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS * 8).toBeLessThanOrEqual(budget!.limit);
  });

  test("uses the same bound for the SDK throttle and local activity heartbeat", () => {
    expect(turnCancellationHeartbeatThrottleOptions()).toEqual({
      maxHeartbeatThrottleInterval: TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS,
      defaultHeartbeatThrottleInterval: TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS,
    });

    const scheduled: number[] = [];
    const timer = { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    const result = startActivityHeartbeat(
      { heartbeat: () => undefined } as unknown as Context,
      { phase: "running" },
      ((_callback: TimerHandler, interval?: number) => {
        scheduled.push(interval ?? 0);
        return timer;
      }) as typeof setInterval,
    );

    expect(result).toBe(timer);
    expect(scheduled).toEqual([TURN_ACTIVITY_CANCELLATION_HEARTBEAT_INTERVAL_MS]);
  });
});
