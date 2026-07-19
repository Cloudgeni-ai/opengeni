import {
  settleSessionAttemptInterruptions,
  applySessionTurnSettlement,
  recoverSessionDispatch,
  peekSessionWork as peekSessionWorkDb,
  countQueuedTurns,
  getSessionEvent,
  getSessionTurnForAttempt,
  requireSession,
  appendSessionHistoryItems,
  registerPendingSessionToolCall,
  requestSessionTurnRecovery,
  settleSessionIdleWithParentOutbox,
} from "@opengeni/db";
import {
  appendOrConfirmAndPublishTurnEventsFenced,
  publishDurableSessionEvents,
} from "@opengeni/events";
import { deliverFailedChildTurnToParent, notifyParentOfChildIdle } from "./parent-wake";
import { recordTurnsQueuedGauge } from "../observability-metrics";
import { recordModelUsageAndDebitCredits } from "./model-usage";
import { persistPreparedContextCompaction } from "./context-compaction-persistence";
import { TurnAttemptFencedError } from "./turn-attempt-fenced";
import { parseTurnPersistenceHandoff } from "../turn-persistence-handoff";
import type {
  ActivityServices,
  PeekSessionWorkInput,
  FailSessionAttemptInput,
  SettleSessionInterruptionsInput,
  MarkSessionIdleInput,
  RecoverDispatchInput,
  RecoverDispatchResult,
  PersistTurnHandoffAndRecoverInput,
  PersistTurnHandoffAndRecoverResult,
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
  appendSessionHistoryItems: typeof appendSessionHistoryItems;
  registerPendingSessionToolCall: typeof registerPendingSessionToolCall;
  requestSessionTurnRecovery: typeof requestSessionTurnRecovery;
  appendOrConfirmAndPublishTurnEventsFenced: typeof appendOrConfirmAndPublishTurnEventsFenced;
  recordModelUsageAndDebitCredits: typeof recordModelUsageAndDebitCredits;
  persistPreparedContextCompaction: typeof persistPreparedContextCompaction;
  settleSessionIdleWithParentOutbox: typeof settleSessionIdleWithParentOutbox;
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
  const appendSessionHistoryItemsFn =
    overrides.appendSessionHistoryItems ?? appendSessionHistoryItems;
  const registerPendingSessionToolCallFn =
    overrides.registerPendingSessionToolCall ?? registerPendingSessionToolCall;
  const requestSessionTurnRecoveryFn =
    overrides.requestSessionTurnRecovery ?? requestSessionTurnRecovery;
  const appendOrConfirmAndPublishTurnEventsFencedFn =
    overrides.appendOrConfirmAndPublishTurnEventsFenced ??
    appendOrConfirmAndPublishTurnEventsFenced;
  const recordModelUsageAndDebitCreditsFn =
    overrides.recordModelUsageAndDebitCredits ?? recordModelUsageAndDebitCredits;
  const persistPreparedContextCompactionFn =
    overrides.persistPreparedContextCompaction ?? persistPreparedContextCompaction;
  const settleSessionIdleWithParentOutboxFn =
    overrides.settleSessionIdleWithParentOutbox ?? settleSessionIdleWithParentOutbox;
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

  /**
   * Retry only the exact receipt that failed at the turn worker's persistence
   * boundary, then checkpoint the same logical turn for a higher-generation
   * attempt. Tool receipts converge on (turn, callId), model receipts on their
   * exact producer/source identity, and compaction receipts on their persistence
   * key and replacement fingerprint. Activity retry, completion-response loss,
   * and old/new worker overlap therefore cannot duplicate an external effect.
   * No model or tool code is reachable from this activity.
   */
  async function persistTurnHandoffAndRecover(
    input: PersistTurnHandoffAndRecoverInput,
  ): Promise<PersistTurnHandoffAndRecoverResult> {
    const { db, bus, settings, observability } = await services();
    const handoff = parseTurnPersistenceHandoff(input.handoff);
    if (!handoff) {
      throw new Error("Invalid turn persistence handoff; persistence retry refused");
    }
    const obligation = handoff.obligation;
    if (obligation.kind === "pending_tool_call") {
      const registered = await registerPendingSessionToolCallFn(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: handoff.turnId,
        executionGeneration: handoff.executionGeneration,
        attemptId: input.attemptId,
        callId: obligation.callId,
        callType: obligation.callType,
        callItem: obligation.callItem,
      });
      if (!registered.accepted) {
        return { action: "stale" };
      }
    } else if (obligation.kind === "model_call") {
      const historyAccepted = await appendSessionHistoryItemsFn(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: handoff.turnId,
        expectedExecutionGeneration: handoff.executionGeneration,
        expectedAttemptId: input.attemptId,
        producerCodexCredentialId: obligation.history.producerCodexCredentialId,
        modelToolOutputTruncationTokens: obligation.history.modelToolOutputTruncationTokens,
        items: obligation.history.items,
      });
      if (!historyAccepted) return { action: "stale" };
      await recordModelUsageAndDebitCreditsFn(settings, db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: handoff.turnId,
        ...obligation.metering,
        observability,
      });
      const eventResult = await appendOrConfirmAndPublishTurnEventsFencedFn(
        db,
        bus,
        input.workspaceId,
        input.sessionId,
        handoff.turnId,
        handoff.executionGeneration,
        input.attemptId,
        [
          {
            ...obligation.event,
            occurredAt: new Date(obligation.event.occurredAt),
          },
        ],
      );
      if (!eventResult.accepted) return { action: "stale" };
    } else {
      if (obligation.metering) {
        await recordModelUsageAndDebitCreditsFn(settings, db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: handoff.turnId,
          ...obligation.metering,
          observability,
        });
      }
      if (obligation.event) {
        const eventResult = await appendOrConfirmAndPublishTurnEventsFencedFn(
          db,
          bus,
          input.workspaceId,
          input.sessionId,
          handoff.turnId,
          handoff.executionGeneration,
          input.attemptId,
          [
            {
              ...obligation.event,
              occurredAt: new Date(obligation.event.occurredAt),
            },
          ],
        );
        if (!eventResult.accepted) return { action: "stale" };
      }
      try {
        const compaction = await persistPreparedContextCompactionFn(
          db,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: handoff.turnId,
            executionGeneration: handoff.executionGeneration,
            attemptId: input.attemptId,
          },
          obligation.compaction,
        );
        await publishDurableSessionEventsFn(
          bus,
          input.workspaceId,
          input.sessionId,
          compaction.events,
        );
      } catch (error) {
        if (error instanceof TurnAttemptFencedError) return { action: "stale" };
        throw error;
      }
    }
    const recovery = await requestSessionTurnRecoveryFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: handoff.turnId,
      triggerEventId: handoff.triggerEventId,
      attemptId: input.attemptId,
      reason: `persistence_${obligation.kind}_${input.reason}`,
    });
    if (recovery.action === "stale") {
      return { action: "stale" };
    }
    await publishDurableSessionEventsFn(bus, input.workspaceId, input.sessionId, recovery.events);
    return { action: "recovering", turnId: handoff.turnId };
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
    persistTurnHandoffAndRecover,
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
