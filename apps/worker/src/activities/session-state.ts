import {
  advanceAskUserReminder,
  getDurableWait,
  resolveAskUserWait,
  resolvePassiveDurableWait,
  settleSessionAttemptInterruptions,
  applySessionTurnSettlement,
  recoverSessionDispatch,
  peekSessionWork as peekSessionWorkDb,
  countQueuedTurns,
  getSessionEvent,
  getSessionTurnForAttempt,
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
  ReconcileDurableWaitTimerInput,
  ReconcileDurableWaitTimerResult,
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
  publishDurableSessionEvents: typeof publishDurableSessionEvents;
  deliverFailedChildTurnToParent: typeof deliverFailedChildTurnToParent;
  notifyParentOfChildIdle: typeof notifyParentOfChildIdle;
  recordTurnsQueuedGauge: typeof recordTurnsQueuedGauge;
  advanceAskUserReminder: typeof advanceAskUserReminder;
  getDurableWait: typeof getDurableWait;
  resolveAskUserWait: typeof resolveAskUserWait;
  resolvePassiveDurableWait: typeof resolvePassiveDurableWait;
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
  const publishDurableSessionEventsFn =
    overrides.publishDurableSessionEvents ?? publishDurableSessionEvents;
  const deliverFailedChildTurnToParentFn =
    overrides.deliverFailedChildTurnToParent ?? deliverFailedChildTurnToParent;
  const notifyParentOfChildIdleFn = overrides.notifyParentOfChildIdle ?? notifyParentOfChildIdle;
  const recordTurnsQueuedGaugeFn = overrides.recordTurnsQueuedGauge ?? recordTurnsQueuedGauge;
  const advanceAskUserReminderFn = overrides.advanceAskUserReminder ?? advanceAskUserReminder;
  const getDurableWaitFn = overrides.getDurableWait ?? getDurableWait;
  const resolveAskUserWaitFn = overrides.resolveAskUserWait ?? resolveAskUserWait;
  const resolvePassiveDurableWaitFn =
    overrides.resolvePassiveDurableWait ?? resolvePassiveDurableWait;

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
   * Durable conversation truth and the original trigger stay attached to the
   * same turn; recovery creates a new fenced attempt, never a prompt-queue row
   * or a synthetic resume message. Repeated worker deaths are bounded per turn.
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

  /** Re-read and reconcile one Temporal timer edge against PostgreSQL truth. */
  async function reconcileDurableWaitTimer(
    input: ReconcileDurableWaitTimerInput,
  ): Promise<ReconcileDurableWaitTimerResult> {
    const { db, bus, wakeSessionWorkflow } = await services();
    const current = await getDurableWaitFn(db, input.workspaceId, input.sessionId, input.waitId);
    if (!current || current.state !== "waiting") return { action: "stale" };

    if (input.cause === "reminder") {
      if (current.kind !== "ask_user") return { action: "stale" };
      const result = await advanceAskUserReminderFn(db, input);
      if (result.action !== "reminded") return { action: "stale" };
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, [result.event]);
      return {
        action: "reminded",
        ref: {
          waitId: result.wait.id,
          kind: result.wait.kind,
          wakeAt: result.wait.wakeAt,
          nextReminderAt: result.wait.nextReminderAt,
          reminderSequence: result.wait.reminderSequence,
        },
      };
    }

    if (current.kind === "ask_user") {
      const result = await resolveAskUserWaitFn(db, { ...input, outcome: "timed_out" });
      if (result.action === "conflict") return { action: "stale" };
      await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, result.events);
      if (wakeSessionWorkflow && result.workflowWakeRevision !== null) {
        await wakeSessionWorkflow({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          workflowId: result.temporalWorkflowId,
          wakeRevision: result.workflowWakeRevision,
        });
      }
      return { action: "resolved" };
    }
    if (current.kind !== "until" && current.kind !== "event") {
      return { action: "stale" };
    }
    const result = await resolvePassiveDurableWaitFn(db, {
      ...input,
      outcome: current.kind === "until" ? "time_reached" : "timed_out",
    });
    if (result.delivery.reason === "session_cancelled") return { action: "resolved" };
    await publishDurableSessionEventsFn(
      bus,
      input.workspaceId,
      input.sessionId,
      result.delivery.events,
    );
    if (
      wakeSessionWorkflow &&
      result.delivery.temporalWorkflowId &&
      result.delivery.workflowWakeRevision !== null
    ) {
      await wakeSessionWorkflow({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        workflowId: result.delivery.temporalWorkflowId,
        wakeRevision: result.delivery.workflowWakeRevision,
      });
    }
    return { action: "resolved" };
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
    reconcileDurableWaitTimer,
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
