import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  finishTurn,
  getSessionEvent,
  requireSession,
  setSessionStatus,
} from "@infra-agents/db";
import { appendAndPublishEvents } from "@infra-agents/events";
import type {
  ActivityServices,
  ClaimNextQueuedTurnInput,
  MarkSessionIdleInput,
  RunAgentSegmentInput,
} from "./types";

export function createSessionStateActivities(services: () => Promise<ActivityServices>) {
  async function failSession(input: RunAgentSegmentInput & { error?: string }): Promise<void> {
    const { db, bus } = await services();
    const session = await requireSession(db, input.sessionId);
    const trigger = await getSessionEvent(db, input.triggerEventId);
    const turnId = session.activeTurnId ?? null;
    await appendAndPublishEvents(db, bus, input.sessionId, [
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
      await finishTurn(db, turnId, "failed");
    }
    await setSessionStatus(db, input.sessionId, "failed", null);
  }

  async function interruptActiveTurn(input: RunAgentSegmentInput): Promise<void> {
    const { db, bus } = await services();
    const session = await requireSession(db, input.sessionId);
    if (!session.activeTurnId) {
      return;
    }
    const trigger = await getSessionEvent(db, input.triggerEventId);
    await appendAndPublishEvents(db, bus, input.sessionId, [
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
    await finishTurn(db, session.activeTurnId, "cancelled");
    await setSessionStatus(db, input.sessionId, "queued", null);
  }

  async function claimNextQueuedTurn(input: ClaimNextQueuedTurnInput) {
    const { db } = await services();
    return await claimNextQueuedTurnDb(db, input.sessionId, input.workflowId);
  }

  async function markSessionIdle(input: MarkSessionIdleInput): Promise<void> {
    const { db } = await services();
    const session = await requireSession(db, input.sessionId);
    if (session.status === "queued" || session.status === "running") {
      await setSessionStatus(db, input.sessionId, "idle", null);
    }
  }

  return {
    failSession,
    interruptActiveTurn,
    claimNextQueuedTurn,
    markSessionIdle,
  };
}
