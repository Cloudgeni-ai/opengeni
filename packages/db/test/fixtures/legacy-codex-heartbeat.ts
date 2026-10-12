/** TEST ONLY: historical Codex regression fixture, snapshot 8c43a921512078d302f671ae590d43645669f88d. Never import from production. */
import { sql } from "drizzle-orm";

import { rawRows, type Database } from "../../src/database";

export async function heartbeatSubscriptionCredentialLeaseUntil(
  db: Database,
  tableName: "codex_credential_leases" | "xai_credential_leases" | "claude_credential_leases",
  input: {
    workspaceId: string;
    turnId: string;
    holderId: string;
    generation: number;
    ttlMs: number;
    now?: Date;
  },
): Promise<Date | null> {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)
    throw new Error("Subscription credential lease TTL must be positive");
  const table = sql.identifier(tableName);
  const identity = sql`account_id = current_setting('opengeni.account_id')::uuid
    and workspace_id = ${input.workspaceId}::uuid and turn_id = ${input.turnId}::uuid
    and holder_id = ${input.holderId} and generation = ${input.generation}`;
  // A volatile WHERE expression can run before UPDATE waits on an unchanged
  // locked tuple. Lock first, THEN evaluate execution-time database expiry.
  const [locked] = await rawRows<{ id: string }>(
    db,
    sql`select id from ${table} where ${identity} for update`,
  );
  if (!locked) return null;
  const now = input.now ? sql`${input.now}::timestamptz` : sql`clock_timestamp()`;
  const [renewed] = await rawRows<{ leased_until: Date | string }>(
    db,
    sql`
    update ${table}
    set leased_until = ${now} + (${input.ttlMs} * interval '1 millisecond'), updated_at = ${now}
    where id = ${locked.id}::uuid and ${identity} and leased_until > ${now}
    returning leased_until
  `,
  );
  return renewed ? new Date(renewed.leased_until) : null;
}
