import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import { lockTurnAttemptWriteFenceTx } from "./session-attempt-fence";

export type ConnectedSecretOwner = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type ConnectedSecretTarget = {
  controlWorkspaceId: string;
  enrollmentId: string;
  connectionInstanceId: string;
  scope: string;
};

/** Record cleanup ownership before the first byte can reach a machine. */
export async function registerConnectedSecretScope(
  db: Database,
  owner: ConnectedSecretOwner,
  target: ConnectedSecretTarget,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(target.scope)) throw new Error("Invalid secret file scope");
  return await withRlsContext(db, owner, async (scoped) =>
    scoped.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const fence = await lockTurnAttemptWriteFenceTx(tx, owner);
      if (!fence.allowed || fence.attempt.accountId !== owner.accountId) {
        throw new Error("Secret file registration requires a live attempt");
      }
      const [row] = await rawRows<{ id: string }>(
        tx,
        sql`
      select opengeni_private.register_connected_secret_scope(
        ${owner.accountId}::uuid, ${owner.workspaceId}::uuid, ${owner.sessionId}::uuid,
        ${owner.turnId}::uuid, ${owner.attemptId}::uuid, ${owner.executionGeneration},
        ${target.controlWorkspaceId}::uuid, ${target.enrollmentId}::uuid,
        ${target.connectionInstanceId}, ${target.scope}) as id`,
      );
      if (!row?.id) throw new Error("Secret file cleanup registration was not retained");
      return row.id;
    }),
  );
}

/** Closure intent is durable even when the native removal times out or is offline. */
export async function requestConnectedSecretScopeClose(
  db: Database,
  owner: Pick<ConnectedSecretOwner, "accountId" | "workspaceId">,
  id: string,
): Promise<void> {
  await withRlsContext(db, owner, async (tx) => {
    await rawRows(
      tx,
      sql`select opengeni_private.update_connected_secret_scope(${id}::uuid, null::uuid, 'close', 0)`,
    );
  });
}

/** Positive native acknowledgement is the only completion proof. */
export async function completeConnectedSecretScope(
  db: Database,
  owner: Pick<ConnectedSecretOwner, "accountId" | "workspaceId">,
  id: string,
  claimId: string | null = null,
): Promise<void> {
  await withRlsContext(db, owner, async (tx) => {
    await rawRows(
      tx,
      sql`select opengeni_private.update_connected_secret_scope(${id}::uuid, ${claimId}::uuid, 'complete', 0)`,
    );
  });
}

export type ConnectedSecretScopeClaim = ConnectedSecretTarget & {
  id: string;
  accountId: string;
  workspaceId: string;
  pubkey: string;
  claimId: string;
  attempts: number;
};

export async function claimConnectedSecretScopes(
  db: Database,
  input: {
    claimId: string;
    limit: number;
    claimTtlMs: number;
  },
): Promise<ConnectedSecretScopeClaim[]> {
  return await rawRows<ConnectedSecretScopeClaim>(
    db,
    sql`
    select id, account_id as "accountId", workspace_id as "workspaceId",
      control_workspace_id as "controlWorkspaceId", enrollment_id as "enrollmentId",
      pubkey, scope, claim_id as "claimId", attempts,
      connection_instance_id as "connectionInstanceId"
    from opengeni_private.claim_connected_secret_scopes(
      ${input.claimId}::uuid, ${input.limit}, ${input.claimTtlMs})`,
  );
}

export async function deferConnectedSecretScope(
  db: Database,
  claim: ConnectedSecretScopeClaim,
  retryAfterMs: number,
): Promise<void> {
  await rawRows(
    db,
    sql`select opengeni_private.update_connected_secret_scope(
    ${claim.id}::uuid, ${claim.claimId}::uuid, 'retry', ${retryAfterMs})`,
  );
}
