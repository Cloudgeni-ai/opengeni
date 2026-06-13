import type { Settings } from "@opengeni/config";
import type { ScheduledTaskTriggerType } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { OpenGeniRuntime } from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";

// Signal (start-if-needed) a session's Temporal workflow so a queued turn it
// cannot otherwise observe gets claimed. Used to wake a PARENT session's
// workflow when a spawned worker completes: the parent may have idled and let
// its workflow run complete, so a plain signal would not start one — this must
// signalWithStart. Injected (not built from the worker's NativeConnection)
// because the worker package owns only the worker runtime, not a client; an
// undefined signaler degrades to "DB wake recorded, no workflow nudge" (the
// turn is still claimed on the parent's next natural wake).
export type WakeSessionWorkflowSignal = (input: { accountId: string; workspaceId: string; sessionId: string; workflowId: string }) => Promise<void>;

export type ActivityServices = {
  settings: Settings;
  db: Database;
  bus: EventBus;
  runtime: OpenGeniRuntime;
  objectStorage: ObjectStorage | null;
  documentServices: DocumentServices;
  observability: Observability;
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
};

export type ActivityDependencies = Partial<ActivityServices>;

export type RunAgentTurnInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
  turnId?: string;
};

export type RequeueTurnAfterWorkerDeathInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  // The trigger the dead attempt was actually running (for an approval rerun
  // this is the approval-decision event, not the turn row's original trigger).
  triggerEventId: string;
  workflowId: string;
  turnId: string;
};

export type RequeueTurnAfterWorkerDeathResult =
  // The turn is back on the queue; the session workflow's next claim
  // re-dispatches it on a healthy worker. `redispatches` is the total number
  // of worker-death re-dispatches this turn has now consumed.
  | { action: "requeued"; redispatches: number }
  // The turn is no longer running/requires_action: the timed-out attempt was
  // a zombie that actually settled the turn after the server gave up on its
  // heartbeats. Nothing to redo; the workflow just continues its loop.
  | { action: "stale" }
  // The per-turn crash-loop guard tripped; the workflow must fail the
  // session for real. `redispatches` is the count already consumed (== the
  // ceiling), so the failed attempt was worker death number redispatches + 1.
  | { action: "exceeded"; redispatches: number };

export type ClaimNextQueuedTurnInput = {
  workspaceId: string;
  sessionId: string;
  workflowId: string;
};

export type MarkSessionIdleInput = {
  workspaceId: string;
  sessionId: string;
};

export type MaybeContinueGoalInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
};

export type MaybeContinueGoalResult = {
  action: "none" | "queue" | "continue" | "paused";
};

export type PauseGoalForInterruptInput = {
  workspaceId: string;
  sessionId: string;
  // The `user.interrupt` event that triggered the pause, when there is one.
  // A steer-tagged interrupt (reason "steer") must NOT pause the goal:
  // steering redirects the work, it does not stop it.
  triggerEventId?: string;
};

export type DispatchScheduledTaskRunInput = {
  workspaceId: string;
  taskId: string;
  triggerType: ScheduledTaskTriggerType;
  agentRunUsageIdempotencyKey?: string;
};

export type DispatchScheduledTaskRunResult = {
  action: "start" | "signal";
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  workflowId: string;
};

export type IndexDocumentInput = {
  accountId: string;
  workspaceId: string;
  documentId: string;
};

export type RunAgentTurnResult = {
  // "preempted": the worker hosting this turn shut down gracefully mid-turn;
  // the activity checkpointed conversation truth, re-queued the turn, and the
  // session workflow re-dispatches it on a healthy worker.
  status: "idle" | "requires_action" | "failed" | "cancelled" | "preempted";
  // Provider backpressure pacing: when set on an idle result, the session
  // workflow holds the loop this long before admitting the next turn (an
  // active goal's continuation would otherwise immediately re-hit the limit).
  continueDelayMs?: number;
};
