import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  proxyActivities,
  type ActivityOptions,
} from "@temporalio/workflow";
import type * as activities from "../activities";

type WorkflowControlActivities = Pick<
  typeof activities,
  | "enqueueGoalRetryWake"
  | "expireSessionHumanInput"
  | "expireSessionInteractionIntervention"
  | "expireScheduledRunHumanWait"
  | "failSessionAttempt"
  | "getCodexCapacityWait"
  | "markSessionIdle"
  | "persistSessionAttemptQuiescence"
  | "reconcileSessionAttemptQuiescence"
  | "reconcileSettledSessionAttempt"
  | "reconcileCodexCapacityWait"
  | "recoverDispatch"
  | "recoverEscapedMcpTimeout"
  | "settleSessionInterruptions"
  | "settleSessionInputWait"
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

/**
 * The session peek is the advisory read every session run makes before it
 * dispatches a turn, so a queued prompt waits on it. It normally completes in
 * milliseconds. Temporal records an activity attempt as started when it hands
 * the task to a poller; if that attempt is lost (or wedges without a result),
 * only its start-to-close timeout schedules the retry. Under the two-minute
 * control bound a single lost attempt held a fresh prompt for two minutes on
 * the control queue, where no turn-queue backlog shows it. The peek is
 * idempotent, so a short bound plus the same unbounded retry turns that loss
 * into seconds. An attempt that outlives the bound is abandoned, not cancelled;
 * its result is discarded and the retry observes current state.
 */
export const SESSION_PEEK_ACTIVITY_OPTIONS = {
  startToCloseTimeout: 15_000,
  retry: {
    initialInterval: 1_000,
    backoffCoefficient: 2,
    maximumInterval: 30_000,
  },
} as const satisfies ActivityOptions;

export const sessionPeekActivity = proxyActivities<Pick<typeof activities, "peekSessionWork">>(
  SESSION_PEEK_ACTIVITY_OPTIONS,
);

/** One schedule occurrence is bounded. Transient control-plane failures get a
 * short retry window, but a revoked binding or other permanent task error must
 * not leave a Temporal activity retrying forever; the next scheduled occurrence
 * is an independent workflow and will re-evaluate current state. */
export const scheduledTaskActivity = proxyActivities<
  Pick<typeof activities, "dispatchScheduledTaskRun">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 5,
  },
});

/** Goal continuation evaluates a durable Postgres obligation at an idle
 * boundary. A transient failure gets a short retry window, then records an
 * explicit delayed outbox wake instead of relying on an unrelated mutation or
 * keeping workflow history alive with polling. */
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

export function turnActivityForTaskQueue(baseTaskQueue: string) {
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
    cancellationType: ActivityCancellationType.TRY_CANCEL,
    retry: { maximumAttempts: 1 },
  });
}

export function videoGenerationActivityForTaskQueue(baseTaskQueue: string) {
  return proxyActivities<Pick<typeof activities, "reconcileVideoGenerationOperation">>({
    taskQueue: turnTaskQueue(baseTaskQueue),
    startToCloseTimeout: "20 minutes",
    retry: {
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumInterval: "30 seconds",
      maximumAttempts: 3,
    },
  });
}

export const documentActivity = proxyActivities<Pick<typeof activities, "indexDocument">>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * Turn failures whose fixed, secret-free message tells the person what is
 * wrong. Any other cause stays behind the generic Temporal message, as it may
 * carry provider or infrastructure detail.
 */
const DIAGNOSABLE_TURN_FAILURE_TYPES = new Set([
  "TurnExecutionPolicyDefinitionMismatchError",
  // The chat's model was retired or removed from the catalog after it was chosen.
  "TurnExecutionPolicyModelUnavailableError",
]);

export function workflowFailureMessage(error: unknown): string {
  if (
    error instanceof ActivityFailure &&
    error.activityType === "runAgentTurn" &&
    error.cause instanceof ApplicationFailure &&
    DIAGNOSABLE_TURN_FAILURE_TYPES.has(error.cause.type ?? "")
  ) {
    return error.cause.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
