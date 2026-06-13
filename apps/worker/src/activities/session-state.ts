import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  countTurnSessionHistoryItems,
  finishTurn,
  getSession,
  getSessionEvent,
  getSessionGoal,
  getSessionTurn,
  incrementTurnWorkerDeathRedispatches,
  requeuePreemptedTurn,
  requireSession,
  setSessionStatus,
  wakeParentSessionForChildCompletion,
  type Database,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { appendAndPublishEvents } from "@opengeni/events";
import type { Settings } from "@opengeni/config";
import type { Session, SessionGoal } from "@opengeni/contracts";
import { WORKER_DEATH_RESUME_TEXT } from "./agent-turn";
import { isSteerInterrupt, pauseActiveGoalOnInterrupt } from "./goals";
import type {
  ActivityServices,
  ClaimNextQueuedTurnInput,
  MarkSessionIdleInput,
  RequeueTurnAfterWorkerDeathInput,
  RequeueTurnAfterWorkerDeathResult,
  RunAgentTurnInput,
  WakeSessionWorkflowSignal,
} from "./types";

// Crash-loop guard for worker-death re-dispatch: a turn that takes a worker
// down this many times in a row is assumed to be the cause, not the victim,
// and the session fails for real on the next death. A plain constant by
// design — this is a pathology bound, not a run-length limit.
export const WORKER_DEATH_MAX_REDISPATCHES = 3;

export function createSessionStateActivities(services: () => Promise<ActivityServices>) {
  async function failSession(input: RunAgentTurnInput & { error?: string }): Promise<void> {
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
    const turnId = session.activeTurnId ?? null;
    await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
      {
        type: "turn.failed",
        turnId,
        payload: {
          triggerEventId: input.triggerEventId,
          trigger: trigger?.payload ?? null,
          error: input.error ?? "Agent activity failed before it could report a terminal state.",
        },
      },
      {
        type: "session.status.changed",
        turnId,
        payload: { status: "failed" },
      },
    ]);
    if (turnId) {
      await finishTurn(db, input.workspaceId, turnId, "failed");
    }
    await setSessionStatus(db, input.workspaceId, input.sessionId, "failed", null);
    await notifyParentOfChildTerminal({ db, bus, settings, observability, wakeSessionWorkflow }, input.workspaceId, input.sessionId, "failed");
  }

  async function interruptActiveTurn(input: RunAgentTurnInput): Promise<void> {
    const { db, bus } = await services();
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
    // Pause an active goal before the early return below: an interrupt can
    // land after the turn already cleared activeTurnId, and skipping the pause
    // there would let the loop auto-continue the goal the user just stopped.
    // Steer interrupts are the exception: steering cancels the running turn
    // only to deliver the steered message next — redirection, not a stop —
    // so the goal loop stays active.
    if (!isSteerInterrupt(trigger)) {
      await pauseActiveGoalOnInterrupt(db, bus, input.workspaceId, input.sessionId);
    }
    if (!session.activeTurnId) {
      return;
    }
    await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
      {
        turnId: session.activeTurnId,
        type: "turn.cancelled",
        payload: { triggerEventId: input.triggerEventId, reason: trigger?.payload ?? null },
      },
      {
        turnId: session.activeTurnId,
        type: "session.status.changed",
        payload: { status: "queued" },
      },
    ]);
    await finishTurn(db, input.workspaceId, session.activeTurnId, "cancelled");
    await setSessionStatus(db, input.workspaceId, input.sessionId, "queued", null);
  }

  /**
   * Put a turn whose hosting worker died WITHOUT the graceful-preempt
   * checkpoint (heartbeat-timeout activity failure: SIGKILL, OOM, node loss)
   * back on the session queue, so the workflow re-dispatches it instead of
   * failing the session. The degraded-resume contract: conversation truth is
   * dual-written after every model response during the turn, so re-running
   * from the trigger event plus stored items loses at most the work since the
   * last reconcile. When the dead attempt persisted items for this turn, the
   * rerun enters through a synthesized `turn.preempted` resume notice (its
   * partial progress is already conversation truth; replaying the original
   * trigger would duplicate input the model has seen). When nothing was
   * persisted — checkpoint absent — the original trigger replays cleanly.
   * Approval reruns always replay their original trigger: the decision is
   * applied through the RunState resume path and a swapped trigger could
   * drop it. Re-dispatches are bounded per turn by
   * WORKER_DEATH_MAX_REDISPATCHES, persisted on the turn row.
   */
  async function requeueTurnAfterWorkerDeath(input: RequeueTurnAfterWorkerDeathInput): Promise<RequeueTurnAfterWorkerDeathResult> {
    const { settings, db, bus } = await services();
    const turn = await getSessionTurn(db, input.workspaceId, input.turnId);
    if (!turn || (turn.status !== "running" && turn.status !== "requires_action")) {
      // The timed-out attempt was a zombie that actually settled the turn
      // (completed/failed/cancelled it) after the server gave up on its
      // heartbeats. Whatever it recorded is the truth; nothing to redo.
      return { action: "stale" };
    }
    const redispatches = await incrementTurnWorkerDeathRedispatches(db, input.workspaceId, input.turnId);
    if (redispatches > WORKER_DEATH_MAX_REDISPATCHES) {
      return { action: "exceeded", redispatches: redispatches - 1 };
    }
    const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
    const approvalRerun = trigger?.type === "user.approvalDecision";
    // Legacy run-state mode has no crash checkpoint (the dying worker never
    // captured the blob), so it always replays the original trigger against
    // the previous RunState snapshot — the documented degraded resume.
    const resumeWithNotice = !approvalRerun
      && settings.sessionHistorySource === "items"
      && await countTurnSessionHistoryItems(db, input.workspaceId, input.turnId) > 0;
    const [preemptedEvent] = await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
      {
        turnId: turn.id,
        type: "turn.preempted",
        payload: {
          triggerEventId: input.triggerEventId,
          reason: "worker_death",
          redispatches,
          resumeWithNotice,
          ...(resumeWithNotice ? { text: WORKER_DEATH_RESUME_TEXT } : {}),
        },
      },
      {
        turnId: turn.id,
        type: "session.status.changed",
        payload: { status: "queued" },
      },
    ]);
    try {
      await requeuePreemptedTurn(db, input.workspaceId, turn.id, resumeWithNotice && preemptedEvent ? preemptedEvent.id : input.triggerEventId);
    } catch (requeueError) {
      // The zombie attempt can settle the turn between the status check above
      // and this requeue (it keeps executing until it notices the timeout).
      // A settled turn means its recorded outcome is the truth: report stale
      // so the workflow continues instead of failing the session over a lost
      // race. Anything else is a real persistence failure — rethrow.
      const current = await getSessionTurn(db, input.workspaceId, input.turnId);
      if (current && current.status !== "running" && current.status !== "requires_action") {
        return { action: "stale" };
      }
      throw requeueError;
    }
    await setSessionStatus(db, input.workspaceId, input.sessionId, "queued", null);
    return { action: "requeued", redispatches };
  }

  async function claimNextQueuedTurn(input: ClaimNextQueuedTurnInput) {
    const { db } = await services();
    return await claimNextQueuedTurnDb(db, input.workspaceId, input.sessionId, input.workflowId);
  }

  async function markSessionIdle(input: MarkSessionIdleInput): Promise<void> {
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    if (session.status === "queued" || session.status === "running") {
      await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
    }
    // The workflow reaches markSessionIdle exactly when it has decided to stop
    // for now (no queued turn, no goal continuation): the terminal-for-now
    // point for a spawned worker, whatever the cause (goal completed, agent or
    // system paused goal, goalless work finished, idle-interrupt stop). Wake
    // the parent here, deduped per idle episode so the manager is nudged once.
    await notifyParentOfChildTerminal({ db, bus, settings, observability, wakeSessionWorkflow }, input.workspaceId, input.sessionId, "idle");
  }

  return {
    failSession,
    interruptActiveTurn,
    requeueTurnAfterWorkerDeath,
    claimNextQueuedTurn,
    markSessionIdle,
  };
}

type NotifyServices = {
  db: Database;
  bus: EventBus;
  settings: Settings;
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
};

/**
 * Deliver exactly one completion wake to a spawned worker's parent (manager)
 * session when the worker reaches a terminal-for-now state. No-op for a
 * parentless session (direct API create / scheduled run). Idempotent per
 * terminal episode: the idempotency key is the child's current lastSequence,
 * which advances every time the child does work, so a retry of the same
 * terminal transition (activity retry, the workflow's idle re-check) is
 * deduped while a genuinely new idle-after-work episode notifies again. The
 * parent's queued turn is delivered by the DB wake; signalling the parent's
 * workflow (signalWithStart) ensures a parent whose workflow already completed
 * gets a fresh run to claim it. Failures here never fail the child: the wake
 * is a best-effort nudge layered on durable DB state.
 */
async function notifyParentOfChildTerminal(
  svc: NotifyServices,
  workspaceId: string,
  childSessionId: string,
  terminalStatus: "idle" | "failed",
): Promise<void> {
  try {
    const child = await getSession(svc.db, workspaceId, childSessionId);
    if (!child || !child.parentSessionId) {
      return;
    }
    const goal = await getSessionGoal(svc.db, workspaceId, childSessionId);
    // lastSequence after the terminal transition's events is the episode key.
    const clientEventId = `child-completion:${childSessionId}:${child.lastSequence}`;
    const result = await wakeParentSessionForChildCompletion(svc.db, {
      workspaceId,
      parentSessionId: child.parentSessionId,
      clientEventId,
      text: childCompletionWakeText(child, goal, terminalStatus),
      childCompletion: childCompletionPayload(child, goal, terminalStatus),
      reasoningEffortFallback: svc.settings.openaiReasoningEffort,
    });
    if (!result.delivered) {
      return;
    }
    await svc.bus.publish(workspaceId, child.parentSessionId, result.events);
    if (svc.wakeSessionWorkflow) {
      await svc.wakeSessionWorkflow({
        accountId: child.accountId,
        workspaceId,
        sessionId: child.parentSessionId,
        workflowId: result.temporalWorkflowId,
      });
    }
    svc.observability.info("Woke parent session on worker completion", {
      childSessionId,
      parentSessionId: child.parentSessionId,
      terminalStatus,
    });
  } catch (error) {
    // A parent-wake failure must never fail the child's terminal activity.
    svc.observability.error("Failed to wake parent session on worker completion", {
      childSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function childCompletionPayload(child: Session, goal: SessionGoal | null, terminalStatus: "idle" | "failed"): Record<string, unknown> {
  return {
    childSessionId: child.id,
    status: terminalStatus,
    ...(goal
      ? {
        goal: {
          status: goal.status,
          text: goal.text,
          ...(goal.evidence ? { evidence: goal.evidence } : {}),
          ...(goal.rationale ? { rationale: goal.rationale } : {}),
          ...(goal.pausedReason ? { pausedReason: goal.pausedReason } : {}),
        },
      }
      : {}),
  };
}

function childCompletionWakeText(child: Session, goal: SessionGoal | null, terminalStatus: "idle" | "failed"): string {
  const lines: string[] = [];
  if (terminalStatus === "failed") {
    lines.push(`A worker session you spawned has FAILED. Worker session id: ${child.id}.`);
  } else if (goal?.status === "completed") {
    lines.push(`A worker session you spawned has COMPLETED its goal. Worker session id: ${child.id}.`);
  } else if (goal?.status === "paused") {
    lines.push(`A worker session you spawned has PAUSED its goal and gone idle. Worker session id: ${child.id}.`);
  } else {
    lines.push(`A worker session you spawned has finished its work and gone idle. Worker session id: ${child.id}.`);
  }
  if (goal) {
    lines.push(`Worker goal: ${goal.text}`);
    if (goal.status === "completed" && goal.evidence) {
      lines.push(`Completion evidence: ${goal.evidence}`);
    }
    if (goal.status === "paused" && goal.rationale) {
      lines.push(`Pause rationale: ${goal.rationale}`);
    }
  }
  lines.push("Read the worker's session events/notebook output for its result, then continue. If your own goal was paused awaiting this worker, resume it now.");
  return lines.join("\n");
}
