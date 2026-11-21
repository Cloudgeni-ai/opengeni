import {
  CURRENT_FIRST_REQUEST_TOOLS_REVISION,
  rarelyUsedRuntimeToolsSearchable,
} from "@opengeni/contracts";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * The session's first-request tools revision, recorded on its first turn
 * attempt and never changed after (migration 1513). A session that has no
 * revision yet gets the current one when no other attempt of it ever ran, so
 * no model request was sent before; otherwise (an attempt ran on a release
 * that did not record it) it keeps 0, the tools those requests carried.
 * Call it before the attempt's first model request.
 */
export async function settleSessionFirstRequestToolsRevision(
  db: Database,
  input: { workspaceId: string; sessionId: string; attemptId: string },
): Promise<number> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const session = and(
      eq(schema.sessions.workspaceId, input.workspaceId),
      eq(schema.sessions.id, input.sessionId),
    );
    const [row] = await scopedDb
      .select({ revision: schema.sessions.firstRequestToolsRevision })
      .from(schema.sessions)
      .where(session)
      .limit(1);
    if (!row) return 0;
    if (row.revision !== null) return row.revision;
    const [earlierAttempt] = await scopedDb
      .select({ present: sql<number>`1` })
      .from(schema.sessionTurnAttempts)
      .where(
        and(
          eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
          eq(schema.sessionTurnAttempts.sessionId, input.sessionId),
          ne(schema.sessionTurnAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    const revision = earlierAttempt ? 0 : CURRENT_FIRST_REQUEST_TOOLS_REVISION;
    const [updated] = await scopedDb
      .update(schema.sessions)
      .set({ firstRequestToolsRevision: revision })
      .where(and(session, isNull(schema.sessions.firstRequestToolsRevision)))
      .returning({ revision: schema.sessions.firstRequestToolsRevision });
    if (updated) return updated.revision ?? revision;
    // Another writer recorded it first; its value stands.
    const [current] = await scopedDb
      .select({ revision: schema.sessions.firstRequestToolsRevision })
      .from(schema.sessions)
      .where(session)
      .limit(1);
    return current?.revision ?? revision;
  });
}

/**
 * The given sessions whose requests find `list_models` and `privacy_facts`
 * through tool search (revision 1 or later). A session with no revision yet
 * counts: its first attempt will record the current revision.
 */
export async function sessionsWithSearchableRarelyUsedTools(
  db: Database,
  workspaceId: string,
  sessionIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        id: schema.sessions.id,
        revision: schema.sessions.firstRequestToolsRevision,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), inArray(schema.sessions.id, ids)));
    return new Set(
      rows
        .filter((row) =>
          rarelyUsedRuntimeToolsSearchable(row.revision ?? CURRENT_FIRST_REQUEST_TOOLS_REVISION),
        )
        .map((row) => row.id),
    );
  });
}
