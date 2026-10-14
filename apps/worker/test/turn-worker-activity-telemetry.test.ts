import { describe, expect, spyOn, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { GracefulShutdownPeriodExpiredError, NativeConnection, Worker } from "@temporalio/worker";
import { createOpenGeniWorker } from "../src";
import { TurnLifecycleMetrics } from "../src/observability-metrics";
import { createWorkerHttpHandler } from "../src/http";
import { createWorkerServiceLifecycle } from "../src/worker-service-lifecycle";
import {
  TURN_WORKER_ACTIVITY_METRICS as names,
  closeWorkerHttpAfterActivityExecution,
  withTurnWorkerActivityTelemetry,
} from "../src/turn-worker-activity-telemetry";
import { deferred, flushTelemetry, telemetryClock } from "./fixtures/telemetry-clock";

function fixture(podUid = "pod-uid-1") {
  const clock = telemetryClock();
  const observability = createObservability(testSettings(), { component: "worker-turn" });
  const execution = deferred<void>();
  let nonlocal = 0;
  let local = 0;
  let total = 0;
  let shutdowns = 0;
  let runs = 0;
  let unsubscriptions = 0;
  let statusFails = false;
  let observationClock: (() => number) | undefined;
  let observer: { next(value: number): void; error(error: unknown): void } | undefined;
  const sdkWorker = {
    getStatus: () => {
      if (statusFails) throw Error("SDK status failed");
      return {
        numInFlightNonLocalActivities: nonlocal,
        numInFlightLocalActivities: local,
        numInFlightActivities: total,
      };
    },
    numInFlightActivities$: {
      subscribe(next: NonNullable<typeof observer>) {
        observer = next;
        observer.next(total); // SDK BehaviorSubject initial delivery.
        return {
          unsubscribe() {
            unsubscriptions++;
          },
        };
      },
    },
    run: () => {
      if (++runs > 1) return Promise.reject(Error("SDK worker already started"));
      return execution.promise;
    },
    shutdown: () => {
      shutdowns++;
    },
  };
  const bridge = withTurnWorkerActivityTelemetry(sdkWorker, {
    ...clock,
    now: () => (observationClock ? observationClock() : clock.now()),
    observability,
    podUid,
    identity: { temporalNamespace: "actual-namespace", taskQueue: "actual-turn-queue" },
    intervalMs: 1_000,
  });
  return {
    ...clock,
    ...bridge,
    observability,
    execution,
    shutdowns: () => shutdowns,
    runs: () => runs,
    unsubscriptions: () => unsubscriptions,
    failStatus: (fail: boolean) => {
      statusFails = fail;
    },
    setClock: (read: () => number) => {
      observationClock = read;
    },
    corrupt: (count: number) => {
      nonlocal = count;
    },
    startNonlocal() {
      total++;
      observer?.next(total); // Exact SDK1.22 ordering: aggregate BEFORE breakdown.
      nonlocal++;
    },
    startLocal() {
      total++;
      observer?.next(total);
      local++;
    },
    settleNonlocal() {
      nonlocal--;
      total--;
      observer?.next(total);
    },
    settleLocal() {
      local--;
      total--;
      observer?.next(total);
    },
    lateNotify: () => observer?.next(total),
    failSubscription: () => observer?.error(Error("stream failed")),
  };
}

function metricValue(metrics: string, name: string): number {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${name}{`));
  expect(line).toContain('temporal_namespace="actual-namespace"');
  expect(line).toContain('task_queue="actual-turn-queue"');
  expect(line).toContain("worker_pod_uid=");
  return Number(line?.split("} ")[1]);
}

async function value(f: ReturnType<typeof fixture>, name: string): Promise<number> {
  return metricValue(await f.observability.prometheusMetrics(), name);
}

describe("SDK all-activity occupancy bridge", () => {
  test("worker factory binds occupancy and collector identity to actual SDK options, not display settings", async () => {
    const observability = createObservability(testSettings(), { component: "worker-turn" });
    const connect = spyOn(NativeConnection, "connect").mockResolvedValue({
      close: async () => {},
    } as NativeConnection);
    const create = spyOn(Worker, "create").mockResolvedValue({
      options: { namespace: "sdk-actual-namespace", taskQueue: "sdk-actual-queue" },
      getStatus: () => ({
        numInFlightNonLocalActivities: 0,
        numInFlightLocalActivities: 0,
        numInFlightActivities: 0,
      }),
      numInFlightActivities$: { subscribe: () => ({ unsubscribe() {} }) },
      run: async () => {},
      shutdown: () => {},
    } as unknown as Worker);
    try {
      const bundle = await createOpenGeniWorker({
        role: "turn",
        settings: testSettings(),
        activities: { noop: async () => {} },
        activityDependencies: { observability },
      });
      expect(bundle.turnQueueIdentity).toEqual({
        temporalNamespace: "sdk-actual-namespace",
        taskQueue: "sdk-actual-queue",
      });
      const occupancy = (await observability.prometheusMetrics())
        .split("\n")
        .find((line) => line.startsWith(`${names.inflight}{`));
      expect(occupancy).toContain('temporal_namespace="sdk-actual-namespace"');
      expect(occupancy).toContain('task_queue="sdk-actual-queue"');
      await bundle.worker.run();
      expect(bundle.activityTelemetry?.isSettled()).toBe(true);
    } finally {
      create.mockRestore();
      connect.mockRestore();
    }
  });

  test("initializes true idle zero, queue/physical UID labels and producer timestamp", async () => {
    const f = fixture();
    expect(await value(f, names.inflight)).toBe(0);
    expect(await value(f, names.valid)).toBe(1);
    expect(await value(f, names.timestamp)).toBe(100);
    expect(await f.observability.prometheusMetrics()).toContain('worker_pod_uid="pod-uid-1"');
    f.activityTelemetry.closeIfNeverRun();
    await f.activityTelemetry.settled;
    expect(f.unsubscriptions()).toBe(1);
    expect(f.timers()).toBe(0);
    await flushTelemetry(); // Initial deferred subscriber callback is fenced.
  });

  test("reads after SDK aggregate-before-breakdown transition, excludes local execution", async () => {
    const f = fixture();
    const running = f.worker.run();
    f.startNonlocal();
    f.startLocal();
    await flushTelemetry();
    expect(await value(f, names.inflight)).toBe(1);
    expect(await value(f, names.valid)).toBe(1);
    f.settleNonlocal();
    await flushTelemetry();
    expect(await value(f, names.inflight)).toBe(0);
    f.settleLocal();
    f.execution.resolve();
    await running;
    await f.activityTelemetry.settled;
  });

  test("counts mixed preclaim/video/cleanup execution independently of agent-only occupancy", async () => {
    const f = fixture();
    const running = f.worker.run();
    // One preclaim, one video, one cleanup/agent finalizer: all SDK executions,
    // but only the claimed agent activity owns the legacy agent gauge.
    const agentMetrics = new TurnLifecycleMetrics(f.observability, { now: f.now });
    agentMetrics.start({ attemptId: "one-claimed-agent" });
    f.startNonlocal();
    f.startNonlocal();
    f.startNonlocal();
    await flushTelemetry();
    expect(await value(f, names.inflight)).toBe(3);
    const legacy = (await f.observability.prometheusMetrics())
      .split("\n")
      .find((line) => line.startsWith("opengeni_turns_inflight{"));
    expect(legacy).toEndWith("} 1");
    f.settleNonlocal();
    f.settleNonlocal();
    f.settleNonlocal();
    f.execution.resolve();
    await running;
    agentMetrics.stop();
  });

  test("drain and cancellation intent retain unresolved work, freshness and subscription", async () => {
    const f = fixture();
    const running = f.worker.run();
    f.startNonlocal();
    await flushTelemetry();
    f.worker.shutdown(); // Cancellation intent is not SDK execution completion.
    f.activityTelemetry.closeIfNeverRun(); // Cannot detach a previously started worker.
    f.advance(5_000);
    expect(f.shutdowns()).toBe(1);
    expect(f.unsubscriptions()).toBe(0);
    expect(await value(f, names.inflight)).toBe(1);
    expect(await value(f, names.timestamp)).toBe(105);
    f.settleNonlocal();
    await flushTelemetry();
    expect(await value(f, names.inflight)).toBe(0);
    expect(f.unsubscriptions()).toBe(0); // Worker execution itself has not settled.
    f.execution.resolve();
    await running;
    expect(f.unsubscriptions()).toBe(1);
    expect(f.timers()).toBe(0);
  });

  test("forced Worker.run rejection is not activity settlement; late cleanup detaches once", async () => {
    const f = fixture();
    const running = f.worker.run();
    f.startNonlocal();
    await flushTelemetry();
    f.execution.reject(new GracefulShutdownPeriodExpiredError("fixture shutdown period expired"));
    await expect(running).rejects.toBeInstanceOf(GracefulShutdownPeriodExpiredError);
    expect(f.activityTelemetry.isSettled()).toBe(false);
    f.advance(4_000);
    expect(await value(f, names.inflight)).toBe(1);
    expect(await value(f, names.timestamp)).toBe(104);
    expect(f.unsubscriptions()).toBe(0);
    f.settleNonlocal();
    await flushTelemetry();
    await f.activityTelemetry.settled;
    expect(await value(f, names.inflight)).toBe(0);
    expect(f.unsubscriptions()).toBe(1);
    expect(f.timers()).toBe(0);
    f.lateNotify();
    f.failSubscription();
    f.advance(10_000);
    await flushTelemetry();
    expect(await value(f, names.timestamp)).toBe(104);
    expect(await value(f, names.valid)).toBe(1);
    expect(f.unsubscriptions()).toBe(1);
  });

  test("failed status invalidates latest read without zeroing occupancy or advancing timestamp", async () => {
    const f = fixture();
    const running = f.worker.run();
    f.startNonlocal();
    await flushTelemetry();
    f.failStatus(true);
    f.advance(1_000);
    expect(await value(f, names.valid)).toBe(0);
    expect(await value(f, names.inflight)).toBe(1);
    expect(await value(f, names.timestamp)).toBe(100);
    f.execution.reject(Error("failed worker"));
    await expect(running).rejects.toThrow();
    expect(f.unsubscriptions()).toBe(0); // Unknown execution state is not idle.
    f.failStatus(false);
    f.settleNonlocal();
    await flushTelemetry();
    expect(await value(f, names.valid)).toBe(1);
    expect(await value(f, names.timestamp)).toBe(101);
    expect(f.unsubscriptions()).toBe(1);
  });

  test("invalid negative, nonfinite or inconsistent SDK counts never fabricate idle", async () => {
    for (const count of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, 1]) {
      const f = fixture();
      f.corrupt(count);
      f.advance(1_000);
      expect(await value(f, names.valid)).toBe(0);
      expect(await value(f, names.timestamp)).toBe(100);
      f.corrupt(0);
      f.activityTelemetry.closeIfNeverRun();
      expect(f.unsubscriptions()).toBe(1);
      await flushTelemetry();
    }
  });

  test("metric-update errors and subscription errors do not crash worker or cleanup", async () => {
    const f = fixture();
    const running = f.worker.run();
    f.failSubscription();
    expect(await value(f, names.valid)).toBe(0);
    f.advance(1_000);
    expect(await value(f, names.valid)).toBe(1);
    const set = f.observability.setGauge.bind(f.observability);
    f.observability.setGauge = (input) => {
      if (input.name === names.inflight) throw Error("metric unavailable");
      set(input);
    };
    f.startNonlocal();
    await flushTelemetry();
    expect(await value(f, names.valid)).toBe(0);
    expect(await value(f, names.timestamp)).toBe(101);
    f.observability.setGauge = () => {
      throw Error("all metrics unavailable");
    };
    f.worker.shutdown();
    f.settleNonlocal();
    f.execution.resolve();
    await running;
    await f.activityTelemetry.settled;
    expect(f.unsubscriptions()).toBe(1);
    expect(f.timers()).toBe(0);
  });

  test("backward/nonfinite/throwing observation clocks invalidate without replacing the last successful tuple", async () => {
    const invalidClocks = [
      () => 99_999,
      () => NaN,
      () => Infinity,
      () => -Infinity,
      () => -1,
      () => Number.MAX_SAFE_INTEGER + 1,
      () => {
        throw Error("clock unavailable");
      },
    ];
    for (const clock of invalidClocks) {
      const f = fixture();
      const running = f.worker.run();
      f.startNonlocal();
      await flushTelemetry();
      f.setClock(clock);
      f.startNonlocal();
      await flushTelemetry();
      const invalidMetrics = await f.observability.prometheusMetrics();
      expect(metricValue(invalidMetrics, names.valid)).toBe(0);
      expect(metricValue(invalidMetrics, names.inflight)).toBe(1);
      expect(metricValue(invalidMetrics, names.timestamp)).toBe(100);
      f.setClock(f.now);
      f.advance(1_000);
      const recoveredMetrics = await f.observability.prometheusMetrics();
      expect(metricValue(recoveredMetrics, names.valid)).toBe(1);
      expect(metricValue(recoveredMetrics, names.inflight)).toBe(2);
      expect(metricValue(recoveredMetrics, names.timestamp)).toBe(101);
      f.settleNonlocal();
      f.settleNonlocal();
      f.execution.resolve();
      await running;
      expect(f.unsubscriptions()).toBe(1);
    }
  });

  test("missing Kubernetes UID never invents a physical pod identity", async () => {
    const f = fixture("");
    expect(await f.observability.prometheusMetrics()).toContain('worker_pod_uid=""');
    f.activityTelemetry.closeIfNeverRun();
    await flushTelemetry();
  });

  test("repeated run calls share the active owner and cannot detach an idle but still-polling worker", async () => {
    const f = fixture();
    const first = f.worker.run();
    expect(f.worker.run()).toBe(first);
    expect(f.runs()).toBe(1);
    expect(f.unsubscriptions()).toBe(0);
    f.startNonlocal();
    await flushTelemetry();
    expect(await value(f, names.inflight)).toBe(1);
    f.settleNonlocal();
    f.execution.resolve();
    await first;
    expect(f.unsubscriptions()).toBe(1);
    expect(f.worker.run()).toBe(first);
  });

  test("cleanup before run cannot later resurrect polling or observation", async () => {
    const f = fixture();
    f.activityTelemetry.closeIfNeverRun();
    await expect(f.worker.run()).rejects.toThrow("closed turn worker");
    expect(f.runs()).toBe(0);
    f.advance(5_000);
    f.lateNotify();
    f.failSubscription();
    await flushTelemetry();
    expect(await value(f, names.valid)).toBe(1);
    expect(await value(f, names.timestamp)).toBe(100);
    expect(f.unsubscriptions()).toBe(1);
  });

  test("cleanup with temporarily unknown SDK status still forbids a later run", async () => {
    const f = fixture();
    f.failStatus(true);
    f.activityTelemetry.closeIfNeverRun();
    await expect(f.worker.run()).rejects.toThrow("closed turn worker");
    expect(f.runs()).toBe(0);
    expect(f.unsubscriptions()).toBe(0);
    f.failStatus(false);
    f.advance(1_000);
    await f.activityTelemetry.settled;
    expect(f.unsubscriptions()).toBe(1);
  });

  test("failed service closes other resources but keeps real HTTP metrics until unresolved activity settles", async () => {
    const f = fixture();
    let resourceCloses = 0;
    let httpCloses = 0;
    let lifecycle!: ReturnType<typeof createWorkerServiceLifecycle>;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createWorkerHttpHandler({
        settings: testSettings(),
        observability: f.observability,
        checks: { db: () => {}, nats: () => {}, temporal: () => {} },
        lifecycle: { role: "turn", state: () => lifecycle.state() },
      }),
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    lifecycle = createWorkerServiceLifecycle({
      role: "turn",
      worker: f.worker,
      observability: f.observability,
      closeOwnedResources: async () => {
        resourceCloses++;
        closeWorkerHttpAfterActivityExecution(f.activityTelemetry, () => {
          httpCloses++;
          return server.stop(true);
        });
      },
    });
    try {
      const running = lifecycle.run();
      f.startNonlocal();
      await flushTelemetry();
      lifecycle.drain();
      expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
      expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
      f.execution.reject(new GracefulShutdownPeriodExpiredError("fixture shutdown period expired"));
      await expect(running).rejects.toBeInstanceOf(GracefulShutdownPeriodExpiredError);
      await lifecycle.close();
      expect(resourceCloses).toBe(1);
      expect(httpCloses).toBe(0);
      expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
      const response = await fetch(`${baseUrl}/metrics`);
      expect(response.status).toBe(200);
      const occupancy = (await response.text())
        .split("\n")
        .find((line) => line.startsWith(`${names.inflight}{`));
      expect(occupancy).toEndWith("} 1");
      f.settleNonlocal();
      await flushTelemetry();
      await f.activityTelemetry.settled;
      expect(httpCloses).toBe(1);
      expect(f.unsubscriptions()).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
});
