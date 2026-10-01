import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import { integrationOauthPendingStates } from "./schema";

type PendingStateScope = {
  accountId: string;
  workspaceId: string | null;
  actorSubjectId?: string;
};

async function scoped<T>(
  db: Database,
  input: PendingStateScope,
  use: (db: Database) => Promise<T>,
) {
  return withRlsContext(db, input, async (tx) => {
    if (input.workspaceId === null) {
      if (!input.actorSubjectId) throw new Error("Organization OAuth requires an administrator");
      await setSubjectRlsContext(tx, input.actorSubjectId);
      await tx.execute(
        sql`select get_organization_administration_overview(${input.accountId}::uuid, ${input.actorSubjectId})`,
      );
    }
    return use(tx);
  });
}

function workspaceFilter(workspaceId: string | null) {
  return workspaceId === null
    ? isNull(integrationOauthPendingStates.workspaceId)
    : eq(integrationOauthPendingStates.workspaceId, workspaceId);
}

export async function storeIntegrationOAuthPendingState(
  db: Database,
  input: PendingStateScope & {
    id: string;
    stateEncrypted: string;
    expiresAt: Date;
  },
): Promise<void> {
  await scoped(db, input, async (scopedDb) => {
    // A bounded per-workspace sweep prevents abandoned browser grants from
    // accumulating without adding a process-local timer to API instances.
    await scopedDb.execute(sql`delete from integration_oauth_pending_states
      where id in (
        select id from integration_oauth_pending_states
        where account_id = ${input.accountId}::uuid
          and workspace_id is not distinct from ${input.workspaceId}::uuid
          and expires_at <= clock_timestamp()
        order by expires_at, id limit 128
      )`);
    await scopedDb.insert(integrationOauthPendingStates).values({
      id: input.id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      stateEncrypted: input.stateEncrypted,
      expiresAt: input.expiresAt,
    });
  });
}

export async function loadIntegrationOAuthPendingState(
  db: Database,
  input: PendingStateScope & { id: string },
): Promise<string | null> {
  return scoped(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ stateEncrypted: integrationOauthPendingStates.stateEncrypted })
      .from(integrationOauthPendingStates)
      .where(
        and(
          eq(integrationOauthPendingStates.id, input.id),
          eq(integrationOauthPendingStates.accountId, input.accountId),
          workspaceFilter(input.workspaceId),
          gt(integrationOauthPendingStates.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1);
    return row?.stateEncrypted ?? null;
  });
}

/** Consume only the exact actor-validated encrypted attempt; concurrent exchanges cannot replay it. */
export async function consumeIntegrationOAuthPendingState(
  db: Database,
  input: PendingStateScope & { id: string; stateEncrypted: string },
): Promise<boolean> {
  return scoped(db, input, async (tx) => {
    const rows = await tx
      .delete(integrationOauthPendingStates)
      .where(
        and(
          eq(integrationOauthPendingStates.id, input.id),
          eq(integrationOauthPendingStates.accountId, input.accountId),
          workspaceFilter(input.workspaceId),
          eq(integrationOauthPendingStates.stateEncrypted, input.stateEncrypted),
          gt(integrationOauthPendingStates.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: integrationOauthPendingStates.id });
    return rows.length === 1;
  });
}
