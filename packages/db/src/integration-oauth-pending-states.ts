import { and, eq, gt, sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import { integrationOauthPendingStates } from "./schema";

type PendingStateScope = {
  accountId: string;
  workspaceId: string;
};

export async function storeIntegrationOAuthPendingState(
  db: Database,
  input: PendingStateScope & {
    id: string;
    stateEncrypted: string;
    expiresAt: Date;
  },
): Promise<void> {
  await withRlsContext(db, input, async (scopedDb) => {
    // A bounded per-workspace sweep prevents abandoned browser grants from
    // accumulating without adding a process-local timer to API instances.
    await scopedDb.execute(sql`delete from integration_oauth_pending_states
      where id in (
        select id from integration_oauth_pending_states
        where account_id = ${input.accountId}::uuid
          and workspace_id = ${input.workspaceId}::uuid
          and expires_at <= clock_timestamp()
        order by expires_at, id limit 128
      )`);
    await scopedDb.insert(integrationOauthPendingStates).values(input);
  });
}

export async function loadIntegrationOAuthPendingState(
  db: Database,
  input: PendingStateScope & { id: string },
): Promise<string | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ stateEncrypted: integrationOauthPendingStates.stateEncrypted })
      .from(integrationOauthPendingStates)
      .where(
        and(
          eq(integrationOauthPendingStates.id, input.id),
          eq(integrationOauthPendingStates.accountId, input.accountId),
          eq(integrationOauthPendingStates.workspaceId, input.workspaceId),
          gt(integrationOauthPendingStates.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1);
    return row?.stateEncrypted ?? null;
  });
}
