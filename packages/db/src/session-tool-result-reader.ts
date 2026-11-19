import { and, eq } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * Whether `tool_result_read` is in the session's first-request tool list
 * (migration 1502): true for sessions created since, false for earlier ones,
 * whose tool list must stay as their earlier requests sent it.
 */
export async function sessionListsToolResultReader(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ value: schema.sessions.toolResultReaderListed })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    return row?.value === true;
  });
}
