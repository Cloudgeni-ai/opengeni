import { describe, expect, mock, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  normalizeTurnTaskQueueStats,
  recordTurnTaskQueueStats,
  startTurnCapacityMonitor,
  type TurnTaskQueueReadOptions,
  type TurnTaskQueueStats,
} from "../src/observability-metrics";
import { deferred, flushTelemetry, telemetryClock } from "./fixtures/telemetry-clock";

const identity = { temporalNamespace: "test-namespace", taskQueue: "base-turns" };
const stats = {
  eligibleBacklog: 9,
  oldestBacklogAgeSeconds: 4,
  tasksAddRate: 2,
  tasksDispatchRate: 1,
};

function fixture() {
  const clock = telemetryClock();
  return {
    ...clock,
    monotonicNow: clock.now,
    observability: createObservability(testSettings(), { component: "worker-turn" }),
    identity,
    intervalMs: 1_000,
    readTimeoutMs: 500,
    closeTimeoutMs: 50,
  };
}

function gauge(metrics: string, name: string, value: number) {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${name}{`));
  expect(line).toContain('temporal_namespace="test-namespace"');
  expect(line).toContain('task_queue="base-turns"');
  expect(line).toEndWith(`} ${value}`);
}

describe("turn capacity metrics", () => {
  test("normalizes pinned SDK protobuf Long, fractional age/rates, and genuine zero", () => {
    expect(
      normalizeTurnTaskQueueStats({
        approximateBacklogCount: { toString: () => "17" },
        approximateBacklogAge: { seconds: { toString: () => "12" }, nanos: 500_000_000 },
        tasksAddRate: "4.5",
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
    expect(
      normalizeTurnTaskQueueStats({ approximateBacklogCount: "0", tasksAddRate: "1e2" })
        .tasksAddRate,
    ).toBe(100);
  });

  test("rejects absent/malformed/negative/nonfinite/unsafe statistics without coercing zero", () => {
    for (const value of [undefined, null])
      expect(() => normalizeTurnTaskQueueStats(value)).toThrow("omitted required stats");
    for (const value of [[], true, 1, "stats"]) {
      expect(() => normalizeTurnTaskQueueStats(value as never)).toThrow("malformed stats");
    }
    for (const value of [false, "", 0, [], "age"]) {
      expect(() =>
        normalizeTurnTaskQueueStats({
          approximateBacklogCount: 0,
          approximateBacklogAge: value as never,
        }),
      ).toThrow("invalid approximateBacklogAge");
    }
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "",
      " ",
      "-1",
      false,
      [],
      {},
      {
        toString: () => {
          throw Error("hostile");
        },
      },
    ]) {
      expect(() => normalizeTurnTaskQueueStats({ approximateBacklogCount: value })).toThrow(
        "invalid approximateBacklogCount",
      );
    }
    expect(() => normalizeTurnTaskQueueStats({ approximateBacklogCount: 1 })).toThrow(
      "omitted approximateBacklogAge",
    );
    for (const value of [-1, Infinity, "NaN", false]) {
      expect(() =>
        normalizeTurnTaskQueueStats({ approximateBacklogCount: 0, tasksAddRate: value }),
      ).toThrow("invalid tasksAddRate");
      expect(() =>
        normalizeTurnTaskQueueStats({ approximateBacklogCount: 0, tasksDispatchRate: value }),
      ).toThrow("invalid tasksDispatchRate");
    }
    for (const value of [-1, 0.5, Infinity]) {
      expect(() =>
        normalizeTurnTaskQueueStats({
          approximateBacklogCount: 1,
          approximateBacklogAge: { seconds: value },
        }),
      ).toThrow("invalid approximateBacklogAge.seconds");
      expect(() =>
        normalizeTurnTaskQueueStats({
          approximateBacklogCount: 1,
          approximateBacklogAge: { nanos: value },
        }),
      ).toThrow("invalid approximateBacklogAge.nanos");
    }
    expect(() =>
      normalizeTurnTaskQueueStats({
        approximateBacklogCount: 1,
        approximateBacklogAge: { nanos: 1_000_000_000 },
      }),
    ).toThrow("less than one second");
  });

  test("binds every queue gauge to identity without duplicate unlabelled series", async () => {
    const f = fixture();
    recordTurnTaskQueueStats(f.observability, stats, identity);
    const metrics = await f.observability.prometheusMetrics();
    gauge(metrics, "opengeni_turn_eligible_backlog", 9);
    gauge(metrics, "opengeni_turn_eligible_backlog_oldest_age_seconds", 4);
    gauge(metrics, "opengeni_turn_eligible_tasks_add_rate", 2);
    gauge(metrics, "opengeni_turn_eligible_tasks_dispatch_rate", 1);
    expect(
      metrics.split("\n").filter((line) => line.startsWith("opengeni_turn_eligible_backlog{")),
    ).toHaveLength(1);
    expect(() =>
      recordTurnTaskQueueStats(f.observability, { ...stats, tasksAddRate: NaN }, identity),
    ).toThrow();
    gauge(await f.observability.prometheusMetrics(), "opengeni_turn_eligible_backlog", 9);
  });

  test("starts an immediate bounded read, exposes no fake backlog before success", async () => {
    const f = fixture();
    const pending = deferred<TurnTaskQueueStats>();
    const read = mock((_options: TurnTaskQueueReadOptions) => pending.promise);
    const monitor = startTurnCapacityMonitor({ ...f, read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0].deadline).toBe(100_500);
    let metrics = await f.observability.prometheusMetrics();
    expect(metrics).not.toMatch(/^opengeni_turn_eligible_backlog\{/m);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 0);
    gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
    pending.resolve(stats);
    await flushTelemetry();
    metrics = await f.observability.prometheusMetrics();
    gauge(metrics, "opengeni_turn_eligible_backlog", 9);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 1);
    gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 1);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
    await monitor.close();
    expect(f.timers()).toBe(0);
  });

  test("invalidates immediately on error before the age limit, preserves last success", async () => {
    const f = fixture();
    const failure = deferred<TurnTaskQueueStats>();
    let reads = 0;
    const monitor = startTurnCapacityMonitor({
      ...f,
      read: () => (++reads === 1 ? Promise.resolve(stats) : failure.promise),
    });
    await flushTelemetry();
    f.advance(1_000);
    failure.reject(new Error("private server details"));
    await flushTelemetry();
    const metrics = await f.observability.prometheusMetrics();
    gauge(metrics, "opengeni_turn_eligible_backlog", 9);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 0);
    gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_age_seconds", 1);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
    await monitor.close();
  });

  test("contains synchronous throws and failing metrics/logger hooks, retries later", async () => {
    const f = fixture();
    const warn = mock(() => {
      throw Error("logger down");
    });
    f.observability.warn = warn;
    let reads = 0;
    const monitor = startTurnCapacityMonitor({
      ...f,
      read: () => {
        reads++;
        throw Error("secret-must-not-escape");
      },
    });
    await flushTelemetry();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-must-not-escape");
    f.observability.setGauge = () => {
      throw Error("registry down");
    };
    f.advance(1_000);
    await flushTelemetry();
    expect(reads).toBe(2);
    await monitor.close();
    expect(f.timers()).toBe(0);
  });

  test("times out/cancels without overlapping or resurrecting late success, then recovers", async () => {
    const f = fixture();
    const hung = deferred<TurnTaskQueueStats>();
    let reads = 0;
    let signal!: AbortSignal;
    const monitor = startTurnCapacityMonitor({
      ...f,
      read: (options) => {
        signal = options.signal;
        return ++reads === 1 ? hung.promise : Promise.resolve(stats);
      },
    });
    f.advance(500);
    expect(signal.aborted).toBe(true);
    f.advance(3_000);
    expect(reads).toBe(1);
    gauge(
      await f.observability.prometheusMetrics(),
      "opengeni_turn_capacity_monitor_last_success_age_seconds",
      3,
    );
    hung.resolve({ ...stats, eligibleBacklog: 888 });
    await flushTelemetry();
    expect(await f.observability.prometheusMetrics()).not.toMatch(
      /^opengeni_turn_eligible_backlog\{/m,
    );
    f.advance(500);
    await flushTelemetry();
    expect(reads).toBe(2);
    const metrics = await f.observability.prometheusMetrics();
    gauge(metrics, "opengeni_turn_eligible_backlog", 9);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 104);
    await monitor.close();
  });

  test("a slow but bounded success is accepted, and pending reads never overlap", async () => {
    const f = fixture();
    const pending = deferred<TurnTaskQueueStats>();
    const read = mock(() => pending.promise);
    const monitor = startTurnCapacityMonitor({ ...f, read, readTimeoutMs: 3_000 });
    f.advance(2_000);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(stats);
    await flushTelemetry();
    gauge(
      await f.observability.prometheusMetrics(),
      "opengeni_turn_capacity_monitor_last_success_timestamp_seconds",
      102,
    );
    await monitor.close();
  });

  test("close aborts immediately, is idempotent and bounded even if native settlement hangs", async () => {
    const f = fixture();
    const hung = deferred<TurnTaskQueueStats>();
    let signal!: AbortSignal;
    let reads = 0;
    const monitor = startTurnCapacityMonitor({
      ...f,
      read: (options) => {
        signal = options.signal;
        reads++;
        return hung.promise;
      },
    });
    const closing = monitor.close();
    expect(monitor.close()).toBe(closing);
    expect(signal.aborted).toBe(true);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    f.advance(49);
    await flushTelemetry();
    expect(closed).toBe(false);
    f.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(f.timers()).toBe(0);
    hung.resolve(stats);
    await flushTelemetry();
    f.advance(10_000);
    expect(reads).toBe(1);
    expect(await f.observability.prometheusMetrics()).not.toMatch(
      /^opengeni_turn_eligible_backlog\{/m,
    );
    gauge(await f.observability.prometheusMetrics(), "opengeni_turn_capacity_monitor_fresh", 0);
  });

  test("close cancels late failed reads without an unhandled rejection or a warning", async () => {
    const f = fixture();
    const hung = deferred<TurnTaskQueueStats>();
    const warn = mock(() => undefined);
    f.observability.warn = warn;
    const monitor = startTurnCapacityMonitor({ ...f, read: () => hung.promise });
    const closing = monitor.close();
    hung.reject(Error("cancelled"));
    await closing;
    expect(warn).not.toHaveBeenCalled();
    expect(f.timers()).toBe(0);
  });

  test("a timed-out read invalidates a recent successful observation immediately", async () => {
    const f = fixture();
    const hung = deferred<TurnTaskQueueStats>();
    let reads = 0;
    const monitor = startTurnCapacityMonitor({
      ...f,
      read: () => (++reads === 1 ? Promise.resolve(stats) : hung.promise),
    });
    await flushTelemetry();
    f.advance(1_500);
    const metrics = await f.observability.prometheusMetrics();
    gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 0);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
    hung.reject(Error("native cancellation settled"));
    await flushTelemetry();
    await monitor.close();
  });

  test("freshness ages out while a slow read is pending and preserves last-success age", async () => {
    const f = fixture();
    const hung = deferred<TurnTaskQueueStats>();
    let reads = 0;
    const monitor = startTurnCapacityMonitor({
      ...f,
      readTimeoutMs: 10_000,
      read: () => (++reads === 1 ? Promise.resolve(stats) : hung.promise),
    });
    await flushTelemetry();
    f.advance(5_000);
    const metrics = await f.observability.prometheusMetrics();
    expect(reads).toBe(2);
    gauge(metrics, "opengeni_turn_eligible_backlog", 9);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 1);
    gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_age_seconds", 5);
    gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
    hung.resolve(stats);
    await flushTelemetry();
    await monitor.close();
  });

  test("rejects an overage response even when its timeout callback has not run", async () => {
    const f = fixture();
    let clockJump = 0;
    let reads = 0;
    let signal!: AbortSignal;
    const late = deferred<TurnTaskQueueStats>();
    const monitor = startTurnCapacityMonitor({
      ...f,
      readTimeoutMs: 5_000,
      now: () => f.now() + clockJump,
      read: (options) => {
        signal = options.signal;
        return ++reads === 1 ? Promise.resolve(stats) : late.promise;
      },
    });
    try {
      await flushTelemetry();
      f.advance(1_000);
      expect(signal.aborted).toBe(false);
      clockJump = 5_001; // Move time without delivering any scheduled callback.
      late.resolve({ ...stats, eligibleBacklog: 888 });
      await flushTelemetry();
      const metrics = await f.observability.prometheusMetrics();
      gauge(metrics, "opengeni_turn_eligible_backlog", 9);
      gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 0);
      gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
      gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
      gauge(metrics, "opengeni_turn_capacity_monitor_last_success_age_seconds", 6.001);
    } finally {
      await monitor.close();
    }
  });

  test("accepts only responses strictly before the deadline boundary with timers withheld", async () => {
    for (const elapsed of [4_999, 5_000, 5_001]) {
      const f = fixture();
      let observedAt = f.now();
      const pending = deferred<TurnTaskQueueStats>();
      const monitor = startTurnCapacityMonitor({
        ...f,
        now: () => observedAt,
        readTimeoutMs: 5_000,
        read: () => pending.promise,
      });
      try {
        observedAt += elapsed;
        pending.resolve(stats);
        await flushTelemetry();
        const metrics = await f.observability.prometheusMetrics();
        gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", elapsed < 5_000 ? 1 : 0);
        gauge(metrics, "opengeni_turn_capacity_monitor_fresh", elapsed < 5_000 ? 1 : 0);
        if (elapsed < 5_000) {
          gauge(metrics, "opengeni_turn_eligible_backlog", 9);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 104.999);
        } else {
          expect(metrics).not.toMatch(/^opengeni_turn_eligible_backlog\{/m);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 0);
        }
      } finally {
        await monitor.close();
      }
    }
  });

  test("monotonic read age expires a response even when wall time has not reached its deadline", async () => {
    const f = fixture();
    let elapsedJump = 0;
    let reads = 0;
    const pending = deferred<TurnTaskQueueStats>();
    const monitor = startTurnCapacityMonitor({
      ...f,
      readTimeoutMs: 5_000,
      monotonicNow: () => f.now() + elapsedJump,
      read: () => (++reads === 1 ? Promise.resolve(stats) : pending.promise),
    });
    try {
      await flushTelemetry();
      f.advance(1_000);
      elapsedJump = 5_000; // Only elapsed time advances; neither timeout nor wall deadline fires.
      pending.resolve({ ...stats, eligibleBacklog: 888 });
      await flushTelemetry();
      const metrics = await f.observability.prometheusMetrics();
      gauge(metrics, "opengeni_turn_eligible_backlog", 9);
      gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
      gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
      gauge(metrics, "opengeni_turn_capacity_monitor_last_success_age_seconds", 1);
    } finally {
      await monitor.close();
    }
  });

  test("backward/nonfinite wall or elapsed clocks reject late settlement and recover only on a new read", async () => {
    for (const bad of [-1, Number.NaN, Infinity, -Infinity]) {
      for (const clockKind of ["wall", "monotonic"] as const) {
        const f = fixture();
        let jump = 0;
        let reads = 0;
        const pending = deferred<TurnTaskQueueStats>();
        const monitor = startTurnCapacityMonitor({
          ...f,
          readTimeoutMs: 5_000,
          now: () => f.now() + (clockKind === "wall" ? jump : 0),
          monotonicNow: () => f.now() + (clockKind === "monotonic" ? jump : 0),
          read: () =>
            ++reads === 1
              ? Promise.resolve(stats)
              : reads === 2
                ? pending.promise
                : Promise.resolve({ ...stats, eligibleBacklog: 10 }),
        });
        try {
          await flushTelemetry();
          f.advance(1_000);
          jump = bad;
          pending.resolve({ ...stats, eligibleBacklog: 888 });
          await flushTelemetry();
          const metrics = await f.observability.prometheusMetrics();
          gauge(metrics, "opengeni_turn_eligible_backlog", 9);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 0);
          gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 100);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_success_age_seconds", 1);
          expect(metrics).not.toMatch(
            /^opengeni_turn_capacity_monitor_.*\} (?:NaN|Nan|[+-]?Inf(?:inity)?)/m,
          );
          jump = 0;
          f.advance(1_000);
          await flushTelemetry();
          expect(reads).toBe(3);
          gauge(await f.observability.prometheusMetrics(), "opengeni_turn_eligible_backlog", 10);
          gauge(
            await f.observability.prometheusMetrics(),
            "opengeni_turn_capacity_monitor_fresh",
            1,
          );
        } finally {
          await monitor.close();
        }
      }
    }
  });

  test("invalid/throwing startup clocks never launch a native call or publish nonfinite status", async () => {
    const invalidClocks = [
      () => NaN,
      () => Infinity,
      () => -Infinity,
      () => -1,
      () => Number.MAX_SAFE_INTEGER + 1,
      () => {
        throw Error("clock unavailable");
      },
    ];
    for (const badClock of invalidClocks) {
      for (const clockKind of ["wall", "monotonic"] as const) {
        const f = fixture();
        let invalid = true;
        const clock = () => (invalid ? badClock() : f.now());
        const read = mock((_options: TurnTaskQueueReadOptions) => Promise.resolve(stats));
        const monitor = startTurnCapacityMonitor({
          ...f,
          read,
          ...(clockKind === "wall" ? { now: clock } : { monotonicNow: clock }),
        });
        try {
          await flushTelemetry();
          expect(read).not.toHaveBeenCalled();
          const metrics = await f.observability.prometheusMetrics();
          expect(metrics).not.toMatch(/^opengeni_turn_eligible_backlog\{/m);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_read_success", 0);
          gauge(metrics, "opengeni_turn_capacity_monitor_fresh", 0);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_success_timestamp_seconds", 0);
          gauge(metrics, "opengeni_turn_capacity_monitor_last_success_age_seconds", 0);
          invalid = false;
          f.advance(1_000);
          await flushTelemetry();
          expect(read).toHaveBeenCalledTimes(1);
          expect(Number.isFinite(read.mock.calls[0]?.[0]?.deadline)).toBe(true);
          gauge(
            await f.observability.prometheusMetrics(),
            "opengeni_turn_capacity_monitor_fresh",
            1,
          );
        } finally {
          await monitor.close();
        }
      }
    }
  });
});
