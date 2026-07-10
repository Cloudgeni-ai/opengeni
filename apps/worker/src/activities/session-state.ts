import {
  applySessionControlInterrupt,
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  countQueuedTurns,
  countTurnSessionHistoryItems,
  finishTurn,
  getSessionEvent,
  getSessionTurn,
  requeueTurnAfterWorkerDeathAtomically,
  requireSession,
  settleSessionIdleWithParentOutbox,
  setSessionStatus,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { WORKER_DEATH_RESUME_TEXT } from "./agent-turn";
import { notifyParentOfChildTerminal } from "./parent-wake";
import { recordTurnsQueuedGauge } from "../observability-metrics";
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
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    // Already terminal: runAgentTurn settled this turn as failed (status failed,
    // activeTurnId cleared, turn finished) and already woke any parent, then the
    // workflow still routed here because the activity's finally threw after the
    // failed return. Re-failing would append a second turn.failed/status.changed
    // and a second parent wake (a different lastSequence dodges the idle dedupe).
    // The session is already where this activity would put it, so stop.
    if (session.status === "failed") {
      return;
    }
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
    await notifyParentOfChildTerminal(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      "failed",
    );
  }

  async function interruptActiveTurn(input: RunAgentTurnInput): Promise<void> {
    const { db, bus, observability } = await services();
    const applied = await applySessionControlInterrupt(
      db,
      input.workspaceId,
      input.sessionId,
      input.triggerEventId,
    );
    if (applied.events.length > 0) {
      await bus.publish(input.workspaceId, input.sessionId, applied.events);
    }
    await refreshQueuedTurnsGauge(db, observability);
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
  async function requeueTurnAfterWorkerDeath(
    input: RequeueTurnAfterWorkerDeathInput,
  ): Promise<RequeueTurnAfterWorkerDeathResult> {
    const { settings, db, bus, observability } = await services();
    const turn = await getSessionTurn(db, input.workspaceId, input.turnId);
    // Reaching this activity PROVES the session workflow classified the turn's
    // failure as a WORKER DEATH (heartbeat / schedule-to-start timeout): a
    // deliberate user interrupt never gets here — it resolves the workflow's
    // interrupt branch and runs interruptActiveTurn instead. So the only ways
    // the turn is already terminal here are:
    //   • completed / failed — the zombie genuinely finished (or errored) the
    //     work after the server gave up on its heartbeats. That outcome is the
    //     truth; nothing to redo.
    //   • cancelled — the zombie's OWN CancelledFailure cleanup (agent-turn's
    //     generic-cancel catch) marked it as it died. That IS the death, not a
    //     real settle. Requeue it, or the turn — and any goal awaiting it — is
    //     orphaned until a human intervenes (the 76e2f2ee/Vern 16h stall).
    const deathArtifactCancel =
      turn?.status === "cancelled" && turn.cancelledBy === "worker_death_dispatch";
    if (
      !turn ||
      (turn.status !== "running" && turn.status !== "requires_action" && !deathArtifactCancel)
    ) {
      return { action: "stale" };
    }
    const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
    const approvalRerun = trigger?.type === "user.approvalDecision";
    // Legacy run-state mode has no crash checkpoint (the dying worker never
    // captured the blob), so it always replays the original trigger against
    // the previous RunState snapshot — the documented degraded resume.
    const resumeWithNotice =
      !approvalRerun &&
      settings.sessionHistorySource === "items" &&
      (await countTurnSessionHistoryItems(db, input.workspaceId, input.turnId)) > 0;
    const settlement = await requeueTurnAfterWorkerDeathAtomically(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      originalTriggerEventId: input.triggerEventId,
      resumeWithNotice,
      maxRedispatches: WORKER_DEATH_MAX_REDISPATCHES,
      preemptedPayload: {
        triggerEventId: input.triggerEventId,
        reason: "worker_death",
        resumeWithNotice,
        ...(resumeWithNotice ? { text: WORKER_DEATH_RESUME_TEXT } : {}),
      },
    });
    if (settlement.events.length > 0) {
      await bus.publish(input.workspaceId, input.sessionId, settlement.events);
    }
    if (settlement.action !== "requeued") return settlement;
    await refreshQueuedTurnsGauge(db, observability);
    return { action: "requeued", redispatches: settlement.redispatches };
  }

  async function claimNextQueuedTurn(input: ClaimNextQueuedTurnInput) {
    const { db, observability } = await services();
    const turn = await claimNextQueuedTurnDb(
      db,
      input.workspaceId,
      input.sessionId,
      input.workflowId,
    );
    await refreshQueuedTurnsGauge(db, observability);
    return turn;
  }

  async function markSessionIdle(input: MarkSessionIdleInput): Promise<void> {
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    const episodeKey = String(session.lastSequence);
    await settleSessionIdleWithParentOutbox(db, input.workspaceId, input.sessionId, episodeKey);
    await refreshQueuedTurnsGauge(db, observability);
    // The workflow reaches markSessionIdle exactly when it has decided to stop
    // for now (no queued turn, no goal continuation): the terminal-for-now
    // point for a spawned worker, whatever the cause (goal completed, agent or
    // system paused goal, goalless work finished, idle-interrupt stop). Wake
    // the parent here, deduped per idle episode so the manager is nudged once.
    await notifyParentOfChildTerminal(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      "idle",
      episodeKey,
    );
  }

  return {
    failSession,
    interruptActiveTurn,
    requeueTurnAfterWorkerDeath,
    claimNextQueuedTurn,
    markSessionIdle,
  };
}

async function refreshQueuedTurnsGauge(
  db: ActivityServices["db"],
  observability: ActivityServices["observability"],
): Promise<void> {
  try {
    recordTurnsQueuedGauge(observability, await countQueuedTurns(db));
  } catch {
    // Best-effort telemetry; session state transitions remain authoritative.
  }
}
