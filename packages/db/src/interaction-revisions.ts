import { eq, sql } from "drizzle-orm";
import { rawRows, type Database, withRlsContext } from "./database";
import * as schema from "./schema";

export async function advanceWorkspaceInteractionRevision(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<number> {
  const rows = await rawRows<{ revision: number | string }>(
    db,
    sql`
      insert into workspace_interaction_revisions
        (workspace_id, account_id, revision, updated_at)
      values (${workspaceId}, ${accountId}, 1, now())
      on conflict (workspace_id) do update set
        revision = workspace_interaction_revisions.revision + 1,
        updated_at = now()
      where workspace_interaction_revisions.account_id = excluded.account_id
      returning revision
    `,
  );
  const revision = Number(rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Workspace interaction revision could not be advanced");
  }
  return revision;
}

export async function readWorkspaceInteractionRevision(
  db: Database,
  workspaceId: string,
): Promise<number> {
  return (await readWorkspaceInteractionRevisionState(db, workspaceId)).revision;
}

export type WorkspaceInteractionRevisionState = {
  revision: number;
  updatedAt: Date | null;
};

/** Read the latest cursor while already inside the workspace RLS boundary. */
export async function readWorkspaceInteractionRevisionState(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceInteractionRevisionState> {
  const [row] = await db
    .select({
      revision: schema.workspaceInteractionRevisions.revision,
      updatedAt: schema.workspaceInteractionRevisions.updatedAt,
    })
    .from(schema.workspaceInteractionRevisions)
    .where(eq(schema.workspaceInteractionRevisions.workspaceId, workspaceId))
    .limit(1);
  return row
    ? { revision: row.revision, updatedAt: row.updatedAt }
    : { revision: 0, updatedAt: null };
}

/** Standalone tenant-scoped cursor read used by the workspace SSE projection. */
export async function getWorkspaceInteractionRevisionState(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<WorkspaceInteractionRevisionState> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => await readWorkspaceInteractionRevisionState(scopedDb, input.workspaceId),
  );
}
