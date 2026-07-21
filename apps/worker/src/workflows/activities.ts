import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

type WorkflowControlActivities = Pick<
  typeof activities,
  | "dispatchScheduledTaskRun"
  | "enqueueGoalRetryWake"
  | "failSessionAttempt"
  | "getCodexCapacityWait"
  | "markSessionIdle"
  | "peekSessionWork"
  | "persistSessionAttemptQuiescence"
  | "reconcileCodexCapacityWait"
  | "recoverDispatch"
  | "settleSessionInterruptions"
>;

/**
 * Session/schedule workflow control activities are bounded, idempotent database
 * and provider-metadata operations. They must not inherit the agent turn's
 * 30-day attempt: Temporal cannot otherwise detect that the pod which accepted
 * a non-heartbeating control activity disappeared, leaving the workflow pinned
 * to a dead worker for the full 30 days. A bounded attempt plus an unbounded
 * Temporal retry keeps the durable workflow alive across rollout, node loss, or
 * transient database/network failure; retries re-run on a healthy control pod.
 */
export const activity = proxyActivities<WorkflowControlActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

/** Goal continuation is advisory at an idle boundary. A transient failure gets
 * a short retry window, then records an explicit delayed outbox wake instead
 * of relying on an unrelated future mutation. */
export const goalActivity = proxyActivities<Pick<typeof activities, "maybeContinueGoal">>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "5 seconds",
    maximumAttempts: 3,
  },
});

export function turnTaskQueue(baseTaskQueue: string): string {
  return `${baseTaskQueue}-turns`;
}

export function turnActivityForTaskQueue(baseTaskQueue: string, receiptGatedCancellation = true) {
  return proxyActivities<Pick<typeof activities, "runAgentTurn">>({
    taskQueue: turnTaskQueue(baseTaskQueue),
    // Agent segments legitimately run for days. A started turn heartbeats;
    // queued activities remain queued truthfully until a capped turn worker
    // accepts them and performs the atomic claim.
    startToCloseTimeout: "30 days",
    heartbeatTimeout: "2 minutes",
    // Pause/Steer first closes the exact attempt in Postgres, then asks
    // Temporal to deliver cancellation. The workflow must not wait for the
    // Temporal activity promise: a provider cleanup promise can outlive the
    // fenced activity body, and Temporal terminalization is not proof that
    // sandbox tools or processes are physically quiescent. The activity owns
    // that proof and writes an exact receipt after its hard tool fence; the
    // receipt transaction wakes the workflow to admit a replacement.
    cancellationType: receiptGatedCancellation
      ? ActivityCancellationType.TRY_CANCEL
      : ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
  });
}

export const documentActivity = proxyActivities<Pick<typeof activities, "indexDocument">>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

export function workflowFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
