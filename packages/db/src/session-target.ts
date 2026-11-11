import {
  nextSessionTargetContext,
  sessionTargetContext,
  SESSION_TARGET_CONTEXT_KEY,
  type SetSessionTargetRequest,
} from "@opengeni/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { withWorkspaceRls, withWorkspaceSessionActivityRls, type Database } from "./database";
import {
  assertAgentCommandAuthorityInTransaction,
  lockSessionEventWriteRows,
  type SessionCommandActor,
} from "./session-control";
import * as schema from "./schema";

export async function setSessionTargetContext(
  db: Database,
  input: {
    workspaceId: string;
    actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
    request: SetSessionTargetRequest;
    authorizeTarget(tx: Database, sessionId: string): Promise<void>;
  },
) {
  return await withWorkspaceSessionActivityRls(db, input.workspaceId, async (tx) => {
    await lockSessionEventWriteRows(tx, {
      workspaceId: input.workspaceId,
      controlLock: "share",
      sessionIds: [input.actor.sessionId],
      turnIds: [input.actor.turnId],
      attemptIds: [input.actor.attemptId],
    });
    await assertAgentCommandAuthorityInTransaction(tx, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      targetSessionId: input.actor.sessionId,
      action: "context",
    });
    if (input.request.sessionId === input.actor.sessionId)
      throw new Error("Use clear to return to the current conversation");
    if (input.request.sessionId) await input.authorizeTarget(tx, input.request.sessionId);
    const [row] = await tx
      .select({ metadata: schema.sessions.metadata })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.actor.sessionId),
        ),
      );
    if (!row) throw new Error("Calling session is unavailable");
    const current = sessionTargetContext(row.metadata);
    const next = nextSessionTargetContext(current, input.request);
    if (next !== current)
      await tx
        .update(schema.sessions)
        .set({
          metadata: { ...row.metadata, [SESSION_TARGET_CONTEXT_KEY]: next },
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.actor.sessionId),
          ),
        );
    return next;
  });
}

/** Locate only the exact consuming turn's outcome, never the session's latest unrelated result. */
export async function getSessionMessageOutcomeEvent(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  executionGeneration: number,
) {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const [event] = await tx
      .select({ sequence: schema.sessionEvents.sequence, type: schema.sessionEvents.type })
      .from(schema.sessionEvents)
      .innerJoin(
        schema.sessionTurns,
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.id, turnId),
          eq(schema.sessionTurns.executionGeneration, executionGeneration),
          inArray(schema.sessionTurns.status, ["completed", "failed", "cancelled", "superseded"]),
        ),
      )
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.sessionId, sessionId),
          eq(schema.sessionEvents.turnId, turnId),
          eq(schema.sessionEvents.turnGeneration, executionGeneration),
          inArray(schema.sessionEvents.type, [
            "turn.completed",
            "turn.failed",
            "turn.cancelled",
            "turn.superseded",
          ]),
        ),
      )
      .orderBy(desc(schema.sessionEvents.sequence))
      .limit(1);
    return event ?? null;
  });
}
