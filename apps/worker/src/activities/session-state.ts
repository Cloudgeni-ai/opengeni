import {
  applySessionControlInterrupt,
  applySessionOnlySettlement,
  applySessionTurnSettlement,
  applySessionTurnWorkerDeath,
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  countQueuedTurns,
  countTurnSessionHistoryItems,
  getSessionEvent,
  getSessionTurn,
  requireSession,
  settleSessionIdleWithParentOutbox,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
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

export type SessionStateActivityOverrides = Partial<{
  applySessionControlInterrupt: typeof applySessionControlInterrupt;
  applySessionOnlySettlement: typeof applySessionOnlySettlement;
  applySessionTurnSettlement: typeof applySessionTurnSettlement;
  applySessionTurnWorkerDeath: typeof applySessionTurnWorkerDeath;
  claimNextQueuedTurn: typeof claimNextQueuedTurnDb;
  countQueuedTurns: typeof countQueuedTurns;
  countTurnSessionHistoryItems: typeof countTurnSessionHistoryItems;
  getSessionEvent: typeof getSessionEvent;
  getSessionTurn: typeof getSessionTurn;
  requireSession: typeof requireSession;
  settleSessionIdleWithParentOutbox: typeof settleSessionIdleWithParentOutbox;
  publishDurableSessionEvents: typeof publishDurableSessionEvents;
  notifyParentOfChildTerminal: typeof notifyParentOfChildTerminal;
  recordTurnsQueuedGauge: typeof recordTurnsQueuedGauge;
}>;

// Crash-loop guard for worker-death re-dispatch: a turn that takes a worker
// down this many times in a row is assumed to be the cause, not the victim,
// and the session fails for real on the next death. A plain constant by
// design — this is a pathology bound, not a run-length limit.
export const WORKER_DEATH_MAX_REDISPATCHES = 3;

export function createSessionStateActivities(
  services: () => Promise<ActivityServices>,
  overrides: SessionStateActivityOverrides = {},
) {
  const applySessionControlInterruptFn =
    overrides.applySessionControlInterrupt ?? applySessionControlInterrupt;
  const applySessionOnlySettlementFn =
    overrides.applySessionOnlySettlement ?? applySessionOnlySettlement;
  const applySessionTurnSettlementFn =
    overrides.applySessionTurnSettlement ?? applySessionTurnSettlement;
  const applySessionTurnWorkerDeathFn =
    overrides.applySessionTurnWorkerDeath ?? applySessionTurnWorkerDeath;
  const claimNextQueuedTurnFn = overrides.claimNextQueuedTurn ?? claimNextQueuedTurnDb;
  const countQueuedTurnsFn = overrides.countQueuedTurns ?? countQueuedTurns;
  const countTurnSessionHistoryItemsFn =
    overrides.countTurnSessionHistoryItems ?? countTurnSessionHistoryItems;
  const getSessionEventFn = overrides.getSessionEvent ?? getSessionEvent;
  const getSessionTurnFn = overrides.getSessionTurn ?? getSessionTurn;
  const requireSessionFn = overrides.requireSession ?? requireSession;
  const settleSessionIdleWithParentOutboxFn =
    overrides.settleSessionIdleWithParentOutbox ?? settleSessionIdleWithParentOutbox;
  const publishDurableSessionEventsFn =
    overrides.publishDurableSessionEvents ?? publishDurableSessionEvents;
  const notifyParentOfChildTerminalFn =
    overrides.notifyParentOfChildTerminal ?? notifyParentOfChildTerminal;
  const recordTurnsQueuedGaugeFn = overrides.recordTurnsQueuedGauge ?? recordTurnsQueuedGauge;

  async function failSession(input: RunAgentTurnInput & { error?: string }): Promise<void> {
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const session = await requireSessionFn(db, input.workspaceId, input.sessionId);
    if (session.status === "failed") {
      return;
    }
    const turnId = input.turnId ?? session.activeTurnId;
    const trigger = await getSessionEventFn(db, input.workspaceId, input.triggerEventId);
    if (!turnId) {
      // Rolling-history/pre-claim compatibility: a legacy workflow can fail
      // before any turn owns the session. There is no turn CAS to coordinate;
      // append the session-only terminal audit and transition the session.
      const settled = await applySessionOnlySettlementFn(db, input.workspaceId, {
        sessionId: input.sessionId,
        status: "failed",
        events: [
          {
            type: "turn.failed",
            payload: {
              triggerEventId: input.triggerEventId,
              trigger: trigger?.payload ?? null,
              error:
                input.error ?? "Agent activity failed before it could report a terminal state.",
            },
          },
          { type: "session.status.changed", payload: { status: "failed" } },
        ],
      });
      if (settled.action === "stale") {
        return;
      }
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, settled.events);
      await notifyParentOfChildTerminalFn(
        { db, bus, settings, observability, wakeSessionWorkflow },
        input.workspaceId,
        input.sessionId,
        "failed",
      );
      return;
    }
    const result = await applySessionTurnSettlementFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId,
      triggerEventId: input.triggerEventId,
      dispatchId: input.dispatchId ?? "legacy-unregistered",
      allowLegacyUnregistered: true,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        {
          type: "turn.failed",
          payload: {
            triggerEventId: input.triggerEventId,
            trigger: trigger?.payload ?? null,
            error: input.error ?? "Agent activity failed before it could report a terminal state.",
          },
        },
        { type: "session.status.changed", payload: { status: "failed" } },
      ],
    });
    if (result.action === "stale") {
      return;
    }
    await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, result.events);
    await notifyParentOfChildTerminalFn(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      "failed",
    );
  }

  async function interruptActiveTurn(input: RunAgentTurnInput): Promise<void> {
    const { db, bus, observability } = await services();
    const applied = await applySessionControlInterruptFn(
      db,
      input.workspaceId,
      input.sessionId,
      input.triggerEventId,
    );
    if (applied.events.length > 0) {
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, applied.events);
    }
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
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
    const { settings, db, bus, observability, wakeSessionWorkflow } = await services();
    const turn = await getSessionTurnFn(db, input.workspaceId, input.turnId);
    if (!turn || (turn.status !== "running" && turn.status !== "requires_action")) {
      return { action: "stale" };
    }
    const trigger = await getSessionEventFn(db, input.workspaceId, input.triggerEventId);
    const approvalRerun = trigger?.type === "user.approvalDecision";
    // Legacy run-state mode has no crash checkpoint (the dying worker never
    // captured the blob), so it always replays the original trigger against
    // the previous RunState snapshot — the documented degraded resume.
    const resumeWithNotice =
      !approvalRerun &&
      settings.sessionHistorySource === "items" &&
      (await countTurnSessionHistoryItemsFn(db, input.workspaceId, input.turnId)) > 0;
    const result = await applySessionTurnWorkerDeathFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      triggerEventId: input.triggerEventId,
      dispatchId: input.dispatchId,
      timeoutType: input.timeoutType,
      resumeWithNotice,
      ...(resumeWithNotice ? { text: WORKER_DEATH_RESUME_TEXT } : {}),
      maxRedispatches: WORKER_DEATH_MAX_REDISPATCHES,
    });
    if (result.action === "stale") {
      return { action: "stale" };
    }
    await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, result.events);
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
    if (result.action === "exceeded") {
      await notifyParentOfChildTerminalFn(
        { db, bus, settings, observability, wakeSessionWorkflow },
        input.workspaceId,
        input.sessionId,
        "failed",
        `turn:${input.turnId}`,
      );
      return { action: "exceeded", redispatches: result.redispatches };
    }
    return { action: "requeued", redispatches: result.redispatches };
  }

  async function claimNextQueuedTurn(input: ClaimNextQueuedTurnInput) {
    const { db, observability } = await services();
    const turn = await claimNextQueuedTurnFn(
      db,
      input.workspaceId,
      input.sessionId,
      input.workflowId,
    );
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
    return turn;
  }

  async function markSessionIdle(input: MarkSessionIdleInput): Promise<void> {
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const settled = await settleSessionIdleWithParentOutboxFn(
      db,
      input.workspaceId,
      input.sessionId,
    );
    if (settled.events.length > 0) {
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, settled.events);
    }
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
    if (settled.action === "stale") {
      return;
    }
    // The workflow reaches markSessionIdle exactly when it has decided to stop
    // for now (no queued turn, no goal continuation): the terminal-for-now
    // point for a spawned worker, whatever the cause (goal completed, agent or
    // system paused goal, goalless work finished, idle-interrupt stop). Wake
    // the parent here, deduped per idle episode so the manager is nudged once.
    await notifyParentOfChildTerminalFn(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      "idle",
      settled.episodeKey,
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
  countQueuedTurnsFn: typeof countQueuedTurns,
  recordTurnsQueuedGaugeFn: typeof recordTurnsQueuedGauge,
): Promise<void> {
  try {
    recordTurnsQueuedGaugeFn(observability, await countQueuedTurnsFn(db));
  } catch {
    // Best-effort telemetry; session state transitions remain authoritative.
  }
}
