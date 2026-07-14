import {
  settlePendingSessionControl,
  applySessionTurnSettlement,
  applySessionTurnWorkerDeath,
  claimNextSessionExecution as claimNextSessionExecutionDb,
  countQueuedTurns,
  getSessionEvent,
  getSessionTurn,
  requireSession,
  settleSessionIdleWithParentOutbox,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { notifyParentOfChildTerminal } from "./parent-wake";
import { recordTurnsQueuedGauge } from "../observability-metrics";
import type {
  ActivityServices,
  ClaimNextSessionExecutionInput,
  SettleSessionControlInput,
  MarkSessionIdleInput,
  RecoverTurnAfterWorkerDeathInput,
  RecoverTurnAfterWorkerDeathResult,
  RunAgentTurnInput,
} from "./types";

export type SessionStateActivityOverrides = Partial<{
  settlePendingSessionControl: typeof settlePendingSessionControl;
  applySessionTurnSettlement: typeof applySessionTurnSettlement;
  applySessionTurnWorkerDeath: typeof applySessionTurnWorkerDeath;
  claimNextSessionExecution: typeof claimNextSessionExecutionDb;
  countQueuedTurns: typeof countQueuedTurns;
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
  const settlePendingSessionControlFn =
    overrides.settlePendingSessionControl ?? settlePendingSessionControl;
  const applySessionTurnSettlementFn =
    overrides.applySessionTurnSettlement ?? applySessionTurnSettlement;
  const applySessionTurnWorkerDeathFn =
    overrides.applySessionTurnWorkerDeath ?? applySessionTurnWorkerDeath;
  const claimNextSessionExecutionFn =
    overrides.claimNextSessionExecution ?? claimNextSessionExecutionDb;
  const countQueuedTurnsFn = overrides.countQueuedTurns ?? countQueuedTurns;
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
    const turnId = input.turnId;
    const trigger = await getSessionEventFn(db, input.workspaceId, input.triggerEventId);
    const result = await applySessionTurnSettlementFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId,
      triggerEventId: input.triggerEventId,
      attemptId: input.attemptId,
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

  async function settleSessionControl(input: SettleSessionControlInput): Promise<void> {
    const { db, bus, observability } = await services();
    const applied = await settlePendingSessionControlFn(
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
   * Recover the same current inference when its worker dies without completing
   * a graceful checkpoint (heartbeat timeout, SIGKILL, OOM, or node loss).
   * Durable conversation truth and the original trigger stay attached to the
   * same turn; recovery creates a new fenced attempt, never a prompt-queue row
   * or a synthetic resume message. Repeated worker deaths are bounded per turn.
   */
  async function recoverTurnAfterWorkerDeath(
    input: RecoverTurnAfterWorkerDeathInput,
  ): Promise<RecoverTurnAfterWorkerDeathResult> {
    const { settings, db, bus, observability, wakeSessionWorkflow } = await services();
    const turn = await getSessionTurnFn(db, input.workspaceId, input.turnId);
    if (!turn || (turn.status !== "running" && turn.status !== "requires_action")) {
      return { action: "stale" };
    }
    const result = await applySessionTurnWorkerDeathFn(db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      triggerEventId: input.triggerEventId,
      attemptId: input.attemptId,
      dispatchId: input.dispatchId,
      timeoutType: input.timeoutType,
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
    return { action: "recovering", redispatches: result.redispatches };
  }

  async function claimNextSessionExecution(input: ClaimNextSessionExecutionInput) {
    const { db, observability } = await services();
    const turn = await claimNextSessionExecutionFn(
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
    // system paused goal, goalless work finished, idle control settlement). Wake
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
    settleSessionControl,
    recoverTurnAfterWorkerDeath,
    claimNextSessionExecution,
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
