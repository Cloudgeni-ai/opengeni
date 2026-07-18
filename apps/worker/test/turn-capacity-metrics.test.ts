import { describe, expect, mock, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  normalizeTurnTaskQueueStats,
  recordTurnTaskQueueStats,
  startTurnCapacityMonitor,
} from "../src/observability-metrics";

describe("turn capacity metrics", () => {
  test("normalizes Temporal Long-like queue statistics", () => {
    expect(
      normalizeTurnTaskQueueStats({
        approximateBacklogCount: { toString: () => "17" },
        approximateBacklogAge: {
          seconds: { toString: () => "12" },
          nanos: 500_000_000,
        },
        tasksAddRate: "4.5",
        tasksDispatchRate: Number.NaN,
      }),
    ).toEqual({
      eligibleBacklog: 17,
      oldestBacklogAgeSeconds: 12.5,
      tasksAddRate: 4.5,
      tasksDispatchRate: 0,
    });
    expect(normalizeTurnTaskQueueStats(undefined)).toEqual({
      eligibleBacklog: 0,
      oldestBacklogAgeSeconds: 0,
      tasksAddRate: 0,
      tasksDispatchRate: 0,
    });
  });

  test("records Temporal eligible backlog and normalizes invalid values", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });

    recordTurnTaskQueueStats(observability, {
      eligibleBacklog: 7,
      oldestBacklogAgeSeconds: 12.5,
      tasksAddRate: Number.NaN,
      tasksDispatchRate: -3,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turn_eligible_backlog\{[^}]*\} 7/);
    expect(metrics).toMatch(/opengeni_turn_eligible_backlog_oldest_age_seconds\{[^}]*\} 12\.5/);
    expect(metrics).toMatch(/opengeni_turn_eligible_tasks_add_rate\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_turn_eligible_tasks_dispatch_rate\{[^}]*\} 0/);
  });

  test("refreshes immediately, never overlaps reads, and drains on close", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const first = deferred<{
      eligibleBacklog: number;
      oldestBacklogAgeSeconds: number;
      tasksAddRate: number;
      tasksDispatchRate: number;
    }>();
    const read = mock(() => first.promise);
    const monitor = startTurnCapacityMonitor({ observability, read, intervalMs: 2 });

    await Bun.sleep(10);
    expect(read).toHaveBeenCalledTimes(1);
    const closing = monitor.close();
    first.resolve({
      eligibleBacklog: 3,
      oldestBacklogAgeSeconds: 1,
      tasksAddRate: 2,
      tasksDispatchRate: 1,
    });
    await closing;
    await Bun.sleep(5);
    expect(read).toHaveBeenCalledTimes(1);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turn_eligible_backlog\{[^}]*\} 3/);
  });

  test("contains read failures and logs one bounded warning", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const warn = mock(() => undefined);
    observability.warn = warn;
    const monitor = startTurnCapacityMonitor({
      observability,
      read: async () => {
        throw new Error("Temporal unavailable");
      },
      intervalMs: 60_000,
    });

    await monitor.close();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: "Temporal unavailable" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
