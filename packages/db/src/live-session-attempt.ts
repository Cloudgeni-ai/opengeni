import { and, eq, inArray, sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";
import { getExternalLinkTurnAuthorization } from "./external-link-work";
import { initiatorFromStorage } from "./turn-initiator";

/** Shared physical-attempt fence. Does not mutate goal/execution snapshots. */
export async function getLiveSessionAttemptTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
  attemptId: string,
) {
  return withWorkspaceRls(db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ turn: schema.sessionTurns })
      .from(schema.sessionTurnAttempts)
      .innerJoin(
        schema.sessionTurns,
        and(
          eq(schema.sessionTurns.workspaceId, schema.sessionTurnAttempts.workspaceId),
          eq(schema.sessionTurns.id, schema.sessionTurnAttempts.turnId),
        ),
      )
      .innerJoin(
        schema.sessions,
        and(
          eq(schema.sessions.workspaceId, schema.sessionTurnAttempts.workspaceId),
          eq(schema.sessions.id, schema.sessionTurnAttempts.sessionId),
        ),
      )
      .where(
        and(
          eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
          eq(schema.sessionTurnAttempts.sessionId, sessionId),
          eq(schema.sessionTurnAttempts.id, attemptId),
          inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
          eq(schema.sessionTurns.activeAttemptId, attemptId),
          eq(schema.sessions.activeTurnId, schema.sessionTurns.id),
          inArray(schema.sessionTurns.status, [
            "running",
            "requires_action",
            "recovering",
            "waiting_capacity",
          ]),
          sql`not exists (
          select 1 from ${schema.sessionAttemptInterruptions} interruption
          where interruption.workspace_id = ${workspaceId}
            and interruption.attempt_id = ${attemptId}
            and interruption.state in ('pending', 'delivered', 'acknowledged')
        )`,
        ),
      )
      .limit(1);
    if (!row) return null;
    const linked = await getExternalLinkTurnAuthorization(
      tx,
      { accountId: row.turn.accountId, workspaceId },
      row.turn.id,
    );
    if (linked && !linked.authorized) return null;
    return row.turn;
  });
}

/** Host credential reads need provenance and live authority, not a runnable
 * execution projection or a write to the turn's frozen goal snapshot. */
export async function getHostMcpLiveAttempt(
  db: Database,
  workspaceId: string,
  sessionId: string,
  attemptId: string,
) {
  const row = await getLiveSessionAttemptTurn(db, workspaceId, sessionId, attemptId);
  if (!row) return null;
  return {
    ...row,
    initiator: initiatorFromStorage(
      row.initiatorKind,
      row.initiatorSubjectId,
      row.initiatorContext ?? {},
    ),
    initiatorContext: row.initiatorContext ?? {},
  };
}
