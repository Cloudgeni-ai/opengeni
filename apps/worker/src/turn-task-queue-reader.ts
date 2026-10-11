import { Connection, type ConnectionOptions } from "@temporalio/client";
import {
  normalizeTurnTaskQueueStats,
  type TurnTaskQueueIdentity,
  type TurnTaskQueueReadOptions,
  type TurnTaskQueueStats,
} from "./observability-metrics";
import {
  telemetryInterval,
  telemetryScheduler,
  type TelemetryScheduler,
} from "./telemetry-scheduler";

/** Own diagnostic traffic separately from admission/signaling. SDK1.22's retry
 * interceptor does not cancel backoff or replacement calls, so each diagnostic
 * RPC is one native attempt; the monitor schedules any later observation.
 * Lazy construction avoids another startup/connect retry or an unbounded probe. */
export function createTurnTaskQueueStatsClient(
  connectionOptions: ConnectionOptions,
  input: { scheduler?: TelemetryScheduler; closeTimeoutMs?: number } = {},
): {
  read(
    options: TurnTaskQueueReadOptions,
    identity: TurnTaskQueueIdentity,
  ): Promise<TurnTaskQueueStats>;
  close(): Promise<void>;
} {
  const scheduler = input.scheduler ?? telemetryScheduler;
  const closeTimeoutMs = telemetryInterval(
    input.closeTimeoutMs ?? 1_000,
    "queue client closeTimeoutMs",
  );
  let connection: Connection | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const active = new Set<AbortController>();
  return {
    read: async ({ signal, deadline }, identity) => {
      signal.throwIfAborted();
      if (closed) throw new Error("turn task-queue diagnostic client is closed");
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      active.add(controller);
      try {
        connection ??= Connection.lazy({ ...connectionOptions, interceptors: [] });
        const stats = await createTurnTaskQueueStatsReader(
          connection,
          identity,
        )({
          signal: controller.signal,
          deadline,
        });
        controller.signal.throwIfAborted(); // Close/abort cannot resurrect a late result.
        return stats;
      } finally {
        active.delete(controller);
        signal.removeEventListener("abort", abort);
      }
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      for (const controller of active) controller.abort();
      const owned = connection;
      if (!owned) return (closing = Promise.resolve());
      closing = new Promise<void>((resolve) => {
        const cancelTimeout = scheduler.timeout(resolve, closeTimeoutMs);
        const settled = () => {
          cancelTimeout();
          resolve();
        };
        try {
          void owned.close().then(settled, settled);
        } catch {
          settled(); // Diagnostic close failure must not break worker cleanup.
        }
      });
      return closing;
    },
  };
}

/** Scope only this diagnostic RPC, never signal/start/admission traffic. Both
 * call-context APIs are public in the pinned Temporal TS SDK 1.22. The caller
 * must supply a retry-disabled connection (the owned client above does so). */
export function createTurnTaskQueueStatsReader(
  connection: Pick<Connection, "workflowService" | "withDeadline" | "withAbortSignal">,
  identity: TurnTaskQueueIdentity,
): (options: TurnTaskQueueReadOptions) => Promise<TurnTaskQueueStats> {
  return async ({ signal, deadline }) => {
    // SDK1.22 installs its cancel listener when creating the gRPC call; do not
    // launch a call with an already-aborted signal whose event has passed.
    signal.throwIfAborted();
    return connection.withAbortSignal(signal, () =>
      connection.withDeadline(deadline, async () => {
        signal.throwIfAborted();
        const response = await connection.workflowService.describeTaskQueue({
          namespace: identity.temporalNamespace,
          taskQueue: { name: identity.taskQueue },
          // TASK_QUEUE_TYPE_ACTIVITY, supported DEFAULT mode. This is the shared
          // turn-worker activity queue (also video/retries), not a turn count.
          taskQueueType: 2,
          reportStats: true,
        });
        return normalizeTurnTaskQueueStats(response.stats);
      }),
    );
  };
}
