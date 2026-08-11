import { eq, sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";
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
  const [row] = await db
    .select({ revision: schema.workspaceInteractionRevisions.revision })
    .from(schema.workspaceInteractionRevisions)
    .where(eq(schema.workspaceInteractionRevisions.workspaceId, workspaceId))
    .limit(1);
  return row?.revision ?? 0;
}
