import type { Connection } from "@temporalio/client";
import {
  normalizeTurnTaskQueueStats,
  type TurnTaskQueueIdentity,
  type TurnTaskQueueReadOptions,
  type TurnTaskQueueStats,
} from "./observability-metrics";

/** Scope only this diagnostic RPC, never signal/start/admission traffic. Both
 * call-context APIs are public in the pinned Temporal TS SDK 1.22. */
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
