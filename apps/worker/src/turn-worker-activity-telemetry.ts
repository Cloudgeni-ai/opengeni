import type { Observability } from "@opengeni/observability";
import type { Worker, WorkerStatus } from "@temporalio/worker";
import { turnTaskQueueMetricLabels, type TurnTaskQueueIdentity } from "./observability-metrics";
import {
  createTelemetryClock,
  telemetryInterval,
  telemetryScheduler,
  type TelemetryScheduler,
} from "./telemetry-scheduler";
import type { WorkerRunTarget } from "./worker-service-lifecycle";

export const TURN_WORKER_ACTIVITY_METRICS = {
  inflight: "opengeni_turn_worker_activities_inflight",
  timestamp: "opengeni_turn_worker_activities_last_observed_timestamp_seconds",
  valid: "opengeni_turn_worker_activities_last_read_success",
} as const;

export type TurnWorkerActivityTelemetry = {
  /** Settles only when Worker.run AND all SDK activity execution have settled. */
  settled: Promise<void>;
  isSettled(): boolean;
  closeIfNeverRun(): void;
};

/** Preserve scraping after an SDK force-failure without blocking resource close
 * or extending the host shutdown/containment budgets. */
export function closeWorkerHttpAfterActivityExecution(
  telemetry: TurnWorkerActivityTelemetry | undefined,
  close: () => void | Promise<void>,
): void {
  telemetry?.closeIfNeverRun();
  if (!telemetry || telemetry.isSettled()) {
    try {
      void Promise.resolve(close()).catch(() => undefined);
    } catch {
      /* Preserve other resource cleanup. */
    }
  } else {
    void telemetry.settled.then(close).catch(() => undefined);
  }
}

type SdkActivityWorker = Pick<Worker, "run" | "shutdown"> & {
  getStatus(): Pick<
    WorkerStatus,
    "numInFlightNonLocalActivities" | "numInFlightLocalActivities" | "numInFlightActivities"
  >;
  numInFlightActivities$: {
    subscribe(observer: { next(value: number): void; error(error: unknown): void }): {
      unsubscribe(): void;
    };
  };
};

/** Only public SDK1.22 hooks. Never count agent claims/slots, poll reservations,
 * heartbeat activity counts, or cancellation intent as executing occupancy.
 * Requires a fresh metric registry/schema and one SDK turn-worker owner per
 * registry + namespace + queue + physical UID. This bridge does not aggregate
 * multiple workers or migrate legacy pre-registered unlabelled gauges. */
export function withTurnWorkerActivityTelemetry(
  sdkWorker: SdkActivityWorker,
  input: {
    observability: Observability;
    identity: TurnTaskQueueIdentity;
    podUid: string;
    intervalMs?: number;
    now?: () => number;
    scheduler?: TelemetryScheduler;
  },
): { worker: WorkerRunTarget; activityTelemetry: TurnWorkerActivityTelemetry } {
  const scheduler = input.scheduler ?? telemetryScheduler;
  const intervalMs = telemetryInterval(input.intervalMs ?? 15_000, "activity telemetry intervalMs");
  const clock = createTelemetryClock(input.now ?? Date.now);
  const labels = { ...turnTaskQueueMetricLabels(input.identity), worker_pod_uid: input.podUid };
  let runStarted = false;
  let runSettled = false;
  let runPromise: Promise<void> | undefined;
  let disposed = false;
  let queued = false;
  let subscription: { unsubscribe(): void } | undefined;
  let stopTimer: (() => void) | undefined;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const set = (name: string, help: string, value: number) =>
    input.observability.setGauge({ name, help, labels, value });
  const invalidate = () => {
    if (disposed) return;
    try {
      set(
        TURN_WORKER_ACTIVITY_METRICS.valid,
        "Whether the latest SDK activity occupancy observation succeeded.",
        0,
      );
    } catch {
      /* Metrics cannot fail an activity or the worker. Age also fences failed exporters. */
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopTimer?.();
    try {
      subscription?.unsubscribe();
    } catch {
      /* Host lifecycle remains unchanged. */
    }
    resolveSettled();
  };
  const sample = () => {
    if (disposed) return;
    let idle = false;
    try {
      const status = sdkWorker.getStatus();
      const count = status.numInFlightNonLocalActivities;
      const local = status.numInFlightLocalActivities;
      const total = status.numInFlightActivities;
      if (
        ![count, local, total].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        count + local !== total
      ) {
        throw new Error("invalid SDK executing activity state");
      }
      idle = total === 0;
      const observedAt = clock.read();
      if (observedAt === null) throw new Error("invalid activity observation clock");
      // Publish validity last; a partial or failed metric update cannot license
      // combining a new timestamp with old occupancy. Never invent idle zero.
      set(
        TURN_WORKER_ACTIVITY_METRICS.valid,
        "Whether the latest SDK activity occupancy observation succeeded.",
        0,
      );
      set(
        TURN_WORKER_ACTIVITY_METRICS.inflight,
        "SDK executing non-local activities on this turn worker, including preclaim, video and cancellation-unresolved execution.",
        count,
      );
      set(
        TURN_WORKER_ACTIVITY_METRICS.timestamp,
        "Unix timestamp of the latest successful SDK activity occupancy observation.",
        observedAt / 1_000,
      );
      set(
        TURN_WORKER_ACTIVITY_METRICS.valid,
        "Whether the latest SDK activity occupancy observation succeeded.",
        1,
      );
    } catch {
      invalidate();
    }
    // SDK force-shutdown rejection alone is not activity quiescence. Counters remain
    // live until the underlying JS promises settle, including after run rejects.
    if (runSettled && idle) dispose();
  };
  const scheduleSample = () => {
    if (disposed || queued) return;
    queued = true;
    // SDK increments its aggregate observable BEFORE its local/nonlocal
    // breakdown. Read after that synchronous transition, not inside it.
    scheduler.defer(() => {
      queued = false;
      sample();
    });
  };
  try {
    subscription = sdkWorker.numInFlightActivities$.subscribe({
      next: scheduleSample,
      error: invalidate,
    });
  } catch {
    invalidate();
  }
  stopTimer = scheduler.interval(sample, intervalMs);
  sample(); // INITIALIZED workers expose true idle zero before the first poll.
  const activityTelemetry: TurnWorkerActivityTelemetry = {
    settled,
    isSettled: () => disposed,
    closeIfNeverRun: () => {
      if (!runStarted) {
        runSettled = true;
        sample();
      }
    },
  };
  return {
    activityTelemetry,
    worker: {
      shutdown: () => sdkWorker.shutdown(), // Drain never unregisters observation.
      run: () => {
        if (!runPromise && runSettled)
          return Promise.reject(new Error("cannot run a closed turn worker"));
        // A second SDK run rejects immediately while the first may still poll.
        // Keep one execution owner so that rejection cannot detach telemetry.
        runPromise ??= (async () => {
          runStarted = true;
          try {
            await sdkWorker.run();
          } finally {
            runSettled = true;
            sample();
          }
        })();
        return runPromise;
      },
    },
  };
}
