import { and, eq, sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import * as schema from "./schema";

/**
 * A control-worker absence proof, never a user-facing existence oracle.
 * Workspaces are unfiltered routing metadata. Sessions are FORCE-RLS: only a
 * verified tenant scope with no actor visibility restriction can prove absence.
 * A wrong account or a human/agent-scoped read stays unavailable. Database errors
 * propagate; a failed read is never deletion evidence.
 */
export async function isSessionDefinitivelyDeleted(
  db: Database,
  workspaceId: string,
  sessionId: string,
  expectedAccountId?: string,
): Promise<boolean> {
  const [workspace] = await db
    .select({ accountId: schema.workspaces.accountId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) return true;
  if (expectedAccountId && expectedAccountId !== workspace.accountId) return false;
  return withRlsContext(db, { accountId: workspace.accountId, workspaceId }, async (scoped) => {
    const [scope] = await rawRows<{ subject: string | null }>(
      scoped,
      sql`select nullif(current_setting('opengeni.subject_id', true), '') as subject`,
    );
    if (!scope || scope.subject !== null) return false;
    const [session] = await scoped
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    return !session;
  });
}
