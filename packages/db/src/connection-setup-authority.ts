import { sql } from "drizzle-orm";
import { Permission } from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";

/** Callback authority for a server-signed API-key principal. No bearer is stored
 * in OAuth state. Organization keys remain shared-workspace-only; workspace keys
 * remain bound to their original workspace. Hold the row lock through commit. */
export async function lockConnectionSetupKey(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<Permission[] | null> {
  const match = /^api_key:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    input.subjectId,
  );
  if (!match) return null;
  return withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{ permissions: unknown }>(
        tx,
        sql`
      select k.permissions from api_keys k join workspaces w
        on w.id = ${input.workspaceId}::uuid and w.account_id = k.account_id
      where k.id = ${match[1]}::uuid and k.account_id = ${input.accountId}::uuid
        and k.revoked_at is null and (k.expires_at is null or k.expires_at > clock_timestamp())
        and get_workspace_kind(w.account_id, w.id) = 'shared'
        and ((k.workspace_id is null and k.credential_kind = 'organization')
          or k.workspace_id = w.id)
      for share of k`,
      );
      return row ? Permission.array().parse(row.permissions) : null;
    },
  );
}
