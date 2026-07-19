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
        tasksDispatchRate: undefined,
      }),
    ).toEqual({
      eligibleBacklog: 17,
      oldestBacklogAgeSeconds: 12.5,
      tasksAddRate: 4.5,
      tasksDispatchRate: 0,
    });
    expect(normalizeTurnTaskQueueStats({ approximateBacklogCount: 0 })).toEqual({
      eligibleBacklog: 0,
      oldestBacklogAgeSeconds: 0,
      tasksAddRate: 0,
      tasksDispatchRate: 0,
    });
    expect(() => normalizeTurnTaskQueueStats(undefined)).toThrow("omitted required stats");
    expect(() => normalizeTurnTaskQueueStats({ approximateBacklogCount: Number.NaN })).toThrow(
      "invalid approximateBacklogCount",
    );
    expect(() => normalizeTurnTaskQueueStats({ approximateBacklogCount: 1 })).toThrow(
      "omitted approximateBacklogAge",
    );
    expect(() =>
      normalizeTurnTaskQueueStats({
        approximateBacklogCount: 0,
        tasksDispatchRate: -1,
      }),
    ).toThrow("invalid tasksDispatchRate");
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
    expect(metrics).toMatch(/opengeni_turn_capacity_monitor_last_read_success\{[^}]*\} 1/);
    expect(metrics).toMatch(/opengeni_turn_capacity_monitor_fresh\{[^}]*\} 1/);
    expect(metrics).toMatch(
      /opengeni_turn_capacity_monitor_last_success_timestamp_seconds\{[^}]*\} \d+/,
    );
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
    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_turn_capacity_monitor_last_read_success\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_turn_capacity_monitor_fresh\{[^}]*\} 0/);
  });

  test("marks a previously successful backlog sample stale after a read failure", async () => {
    let clock = 1_000;
    let reads = 0;
    const observability = createObservability(testSettings(), { component: "worker" });
    observability.warn = () => undefined;
    const monitor = startTurnCapacityMonitor({
      observability,
      intervalMs: 10,
      now: () => clock,
      read: async () => {
        reads += 1;
        if (reads === 1) {
          return {
            eligibleBacklog: 9,
            oldestBacklogAgeSeconds: 4,
            tasksAddRate: 2,
            tasksDispatchRate: 1,
          };
        }
        throw new Error("stale");
      },
    });
    await Bun.sleep(5);
    clock += 40;
    await Bun.sleep(15);
    await monitor.close();

    const metrics = await observability.prometheusMetrics();
    // The last value remains diagnostic, but the explicit freshness contract
    // prevents autoscaling/alerts from treating it as current truth.
    expect(metrics).toMatch(/opengeni_turn_eligible_backlog\{[^}]*\} 9/);
    expect(metrics).toMatch(/opengeni_turn_capacity_monitor_last_read_success\{[^}]*\} 0/);
    expect(metrics).toMatch(/opengeni_turn_capacity_monitor_fresh\{[^}]*\} 0/);
    expect(metrics).toMatch(
      /opengeni_turn_capacity_monitor_last_success_age_seconds\{[^}]*\} 0\.04/,
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
