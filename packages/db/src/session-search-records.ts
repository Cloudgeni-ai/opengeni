import { and, eq } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * Whether the session's hosted web-search records reach the model as runtime
 * input in the user role rather than as an assistant message (docs/web-search.md).
 */
export async function sessionSearchRecordsAsInput(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ value: schema.sessions.searchRecordsAsInput })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    return row?.value === true;
  });
}

/**
 * Move the session to runtime-input search records for good. The caller does
 * so only while the session's history projects the same in both forms.
 */
export async function adoptSessionSearchRecordsAsInput(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.sessions)
      .set({ searchRecordsAsInput: true })
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.id, sessionId),
          eq(schema.sessions.searchRecordsAsInput, false),
        ),
      );
  });
}
