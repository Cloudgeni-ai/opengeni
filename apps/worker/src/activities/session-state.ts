import {
  settleSessionAttemptInterruptions,
  applySessionTurnSettlement,
  recoverSessionDispatch,
  peekSessionWork as peekSessionWorkDb,
  countQueuedTurns,
  getSessionEvent,
  getSessionTurnForAttempt,
  markSessionAttemptQuiesced,
  requireSession,
  settleSessionIdleWithParentOutbox,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { deliverFailedChildTurnToParent, notifyParentOfChildIdle } from "./parent-wake";
import { recordTurnsQueuedGauge } from "../observability-metrics";
import type {
  ActivityServices,
  PeekSessionWorkInput,
  FailSessionAttemptInput,
  SettleSessionInterruptionsInput,
  MarkSessionIdleInput,
  RecoverDispatchInput,
  RecoverDispatchResult,
} from "./types";

export type SessionStateActivityOverrides = Partial<{
  settleSessionAttemptInterruptions: typeof settleSessionAttemptInterruptions;
  applySessionTurnSettlement: typeof applySessionTurnSettlement;
  recoverSessionDispatch: typeof recoverSessionDispatch;
  peekSessionWork: typeof peekSessionWorkDb;
  countQueuedTurns: typeof countQueuedTurns;
  getSessionEvent: typeof getSessionEvent;
  getSessionTurnForAttempt: typeof getSessionTurnForAttempt;
  requireSession: typeof requireSession;
  settleSessionIdleWithParentOutbox: typeof settleSessionIdleWithParentOutbox;
  markSessionAttemptQuiesced: typeof markSessionAttemptQuiesced;
  publishDurableSessionEvents: typeof publishDurableSessionEvents;
  deliverFailedChildTurnToParent: typeof deliverFailedChildTurnToParent;
  notifyParentOfChildIdle: typeof notifyParentOfChildIdle;
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
  const settleSessionAttemptInterruptionsFn =
    overrides.settleSessionAttemptInterruptions ?? settleSessionAttemptInterruptions;
  const applySessionTurnSettlementFn =
    overrides.applySessionTurnSettlement ?? applySessionTurnSettlement;
  const recoverSessionDispatchFn = overrides.recoverSessionDispatch ?? recoverSessionDispatch;
  const peekSessionWorkFn = overrides.peekSessionWork ?? peekSessionWorkDb;
  const countQueuedTurnsFn = overrides.countQueuedTurns ?? countQueuedTurns;
  const getSessionEventFn = overrides.getSessionEvent ?? getSessionEvent;
  const getSessionTurnForAttemptFn = overrides.getSessionTurnForAttempt ?? getSessionTurnForAttempt;
  const requireSessionFn = overrides.requireSession ?? requireSession;
  const settleSessionIdleWithParentOutboxFn =
    overrides.settleSessionIdleWithParentOutbox ?? settleSessionIdleWithParentOutbox;
  const markSessionAttemptQuiescedFn =
    overrides.markSessionAttemptQuiesced ?? markSessionAttemptQuiesced;
  const publishDurableSessionEventsFn =
    overrides.publishDurableSessionEvents ?? publishDurableSessionEvents;
  const deliverFailedChildTurnToParentFn =
    overrides.deliverFailedChildTurnToParent ?? deliverFailedChildTurnToParent;
  const notifyParentOfChildIdleFn = overrides.notifyParentOfChildIdle ?? notifyParentOfChildIdle;
  const recordTurnsQueuedGaugeFn = overrides.recordTurnsQueuedGauge ?? recordTurnsQueuedGauge;

  async function failSessionAttempt(input: FailSessionAttemptInput): Promise<void> {
    const { db, bus, settings, observability, wakeSessionWorkflow } = await services();
    const session = await requireSessionFn(db, input.workspaceId, input.sessionId);
    if (session.status === "failed") {
      return;
    }
    const turn = await getSessionTurnForAttemptFn(
      db,
      input.workspaceId,
      input.sessionId,
      input.attemptId,
    );
    if (!turn) return;
    const trigger = await getSessionEventFn(db, input.workspaceId, turn.triggerEventId);
    const result = await applySessionTurnSettlementFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: input.attemptId,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [
        {
          type: "turn.failed",
          payload: {
            triggerEventId: turn.triggerEventId,
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
    await deliverFailedChildTurnToParentFn(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      turn.id,
    );
  }

  async function settleSessionInterruptions(
    input: SettleSessionInterruptionsInput,
  ): Promise<{ action: "paused" | "continue" | "stale" }> {
    const { db, bus, observability } = await services();
    if (input.phase === "attempt_quiesced") {
      const events = await markSessionAttemptQuiescedFn(db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        temporalWorkflowId: input.workflowId,
      });
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, events);
      return { action: "stale" };
    }
    const applied = await settleSessionAttemptInterruptionsFn(
      db,
      input.workspaceId,
      input.sessionId,
      input.attemptId,
    );
    if (applied.events.length > 0) {
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, applied.events);
    }
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
    return { action: applied.action };
  }

  /**
   * Recover the same current inference when its worker dies without completing
   * a graceful checkpoint (heartbeat timeout, SIGKILL, OOM, or node loss).
   * Before provider acceptance/progress, durable conversation truth and the
   * original trigger stay attached to the same turn; recovery creates a new
   * fenced attempt, never a prompt-queue row or synthetic resume message.
   * An accepted/acceptance-unknown no-replay marker instead settles failed/idle
   * atomically here and never redispatches the turn, even when its final
   * conversation checkpoint remained incomplete.
   */
  async function recoverDispatch(input: RecoverDispatchInput): Promise<RecoverDispatchResult> {
    const { settings, db, bus, observability, wakeSessionWorkflow } = await services();
    const result = await recoverSessionDispatchFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      timeoutType: input.timeoutType,
      maxRedispatches: WORKER_DEATH_MAX_REDISPATCHES,
    });
    if (result.action === "stale" || result.action === "unclaimed") {
      return { action: result.action };
    }
    await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, result.events);
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
    if (result.action === "exceeded") {
      await deliverFailedChildTurnToParentFn(
        { db, bus, settings, observability, wakeSessionWorkflow },
        input.workspaceId,
        input.sessionId,
        result.turnId,
      );
      return {
        action: "exceeded",
        turnId: result.turnId,
        redispatches: result.redispatches,
      };
    }
    if (result.action === "settled_no_replay") {
      return {
        action: "settled_no_replay",
        turnId: result.turnId,
        reason: result.reason,
        checkpointSucceeded: result.checkpointSucceeded,
      };
    }
    return {
      action: "recovering",
      turnId: result.turnId,
      redispatches: result.redispatches,
    };
  }

  async function peekSessionWork(input: PeekSessionWorkInput) {
    const { db, observability } = await services();
    const peek = await peekSessionWorkFn(db, input.workspaceId, input.sessionId);
    await refreshQueuedTurnsGauge(db, observability, countQueuedTurnsFn, recordTurnsQueuedGaugeFn);
    return peek;
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
    // system paused goal, goalless work finished, idle control settlement). Wake
    // the parent here, deduped per idle episode so the manager is nudged once.
    await notifyParentOfChildIdleFn(
      { db, bus, settings, observability, wakeSessionWorkflow },
      input.workspaceId,
      input.sessionId,
      settled.episodeKey,
    );
  }

  return {
    failSessionAttempt,
    settleSessionInterruptions,
    recoverDispatch,
    peekSessionWork,
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
