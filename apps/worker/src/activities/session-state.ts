import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  finishTurn,
  getSessionEvent,
  requireSession,
  setSessionStatus,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { pauseActiveGoalOnInterrupt } from "./goals";
import type {
  ActivityServices,
  ClaimNextQueuedTurnInput,
  MarkSessionIdleInput,
  RunAgentTurnInput,
} from "./types";

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
    // Pause an active goal before the early return below: an interrupt can
    // land after the turn already cleared activeTurnId, and skipping the pause
    // there would let the loop auto-continue the goal the user just stopped.
    await pauseActiveGoalOnInterrupt(db, bus, input.workspaceId, input.sessionId);
    if (!session.activeTurnId) {
      return;
    }
    const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
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
    claimNextQueuedTurn,
    markSessionIdle,
  };
}
