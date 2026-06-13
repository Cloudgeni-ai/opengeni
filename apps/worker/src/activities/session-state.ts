import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  countTurnSessionHistoryItems,
  finishTurn,
  getSessionEvent,
  getSessionTurn,
  incrementTurnWorkerDeathRedispatches,
  requeuePreemptedTurn,
  requireSession,
  setSessionStatus,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { WORKER_DEATH_RESUME_TEXT } from "./agent-turn";
import { isSteerInterrupt, pauseActiveGoalOnInterrupt } from "./goals";
import type {
  ActivityServices,
  ClaimNextQueuedTurnInput,
  MarkSessionIdleInput,
  RequeueTurnAfterWorkerDeathInput,
  RequeueTurnAfterWorkerDeathResult,
  RunAgentTurnInput,
} from "./types";

// Crash-loop guard for worker-death re-dispatch: a turn that takes a worker
// down this many times in a row is assumed to be the cause, not the victim,
// and the session fails for real on the next death. A plain constant by
// design — this is a pathology bound, not a run-length limit.
export const WORKER_DEATH_MAX_REDISPATCHES = 3;

export function createSessionStateActivities(services: () => Promise<ActivityServices>) {
  async function failSession(input: RunAgentTurnInput & { error?: string }): Promise<void> {
    const { db, bus } = await services();
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
    const { db } = await services();
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    if (session.status === "queued" || session.status === "running") {
      await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
    }
  }

  return {
    failSession,
    interruptActiveTurn,
    requeueTurnAfterWorkerDeath,
    claimNextQueuedTurn,
    markSessionIdle,
  };
}
