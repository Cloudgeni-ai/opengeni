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

export const PRODUCTION_TURN_HEARTBEAT_TIMEOUT = "2 minutes" as const;
export const TEST_ONLY_TURN_HEARTBEAT_TIMEOUT = "1 second" as const;

// Production never supplies an override. The accelerated value is reachable
// only from the non-production workflow bundle used by the real-Temporal
// integration tests; unknown values fail closed instead of changing runtime
// behavior accidentally.
export function resolveTurnHeartbeatTimeout(
  value: string | undefined,
): typeof PRODUCTION_TURN_HEARTBEAT_TIMEOUT | typeof TEST_ONLY_TURN_HEARTBEAT_TIMEOUT {
  if (value === undefined || value === PRODUCTION_TURN_HEARTBEAT_TIMEOUT) {
    return PRODUCTION_TURN_HEARTBEAT_TIMEOUT;
  }
  if (value === TEST_ONLY_TURN_HEARTBEAT_TIMEOUT) {
    return TEST_ONLY_TURN_HEARTBEAT_TIMEOUT;
  }
  throw new Error(`unsupported turn heartbeat timeout override: ${value}`);
}

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

export function turnActivityForTaskQueue(
  baseTaskQueue: string,
  options: { heartbeatTimeout?: string } = {},
) {
  return proxyActivities<Pick<typeof activities, "runAgentTurn">>({
    taskQueue: turnTaskQueue(baseTaskQueue),
    // Agent segments legitimately run for days. A started turn heartbeats;
    // queued activities remain queued truthfully until a capped turn worker
    // accepts them and performs the atomic claim.
    startToCloseTimeout: "30 days",
    heartbeatTimeout: resolveTurnHeartbeatTimeout(options.heartbeatTimeout),
    // Pause/Steer may complete the durable control transition immediately,
    // but the session workflow must remain open until the old turn activity is
    // physically gone. Leaving this implicit uses Temporal's try-cancel wire
    // default: the activity promise rejects as soon as cancellation is
    // requested and the workflow can close while the worker keeps streaming.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
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
