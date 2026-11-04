import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/**
 * The ids of an organization's shared workspaces (Personal workspaces
 * excluded), for checking the workspaces someone picked for something the
 * organization shares, such as where its Skills or Knowledge work.
 */
export async function listSharedWorkspaceIdsForAccount(
  db: Database,
  accountId: string,
): Promise<string[]> {
  const rows = await withRlsContext(
    db,
    { accountId, workspaceId: null },
    async (scoped) =>
      await rawRows<{ workspace_id: string }>(
        scoped,
        sql`SELECT workspace_id FROM list_organization_workspace_ids(${accountId}::uuid)`,
      ),
  );
  return rows.map((row) => row.workspace_id);
}
