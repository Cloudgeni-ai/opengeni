import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { rawRows, withAccountRls, type Database } from "./database";

/** Buckets idle this long are full again; they are removed now and then. */
const IDLE_ROW_MS = 24 * 60 * 60_000;

/**
 * One token bucket per connected agent and budget, in Postgres so every API
 * process counts the same calls (docs/mcp-surfaces.md). Returns 0 when the
 * call is admitted (and counted), otherwise the seconds until it would be.
 * One conditional UPSERT refills and takes a token atomically, so concurrent
 * calls on several processes never overspend. Rows live in the
 * organization's account context; the key is hashed and nothing else is
 * stored.
 */
export async function admitMcpConnectionRateLimit(
  db: Database,
  input: {
    accountId: string;
    budget: string;
    key: string;
    capacity: number;
    refillPerSecond: number;
  },
): Promise<number> {
  if (
    !Number.isFinite(input.capacity) ||
    !Number.isFinite(input.refillPerSecond) ||
    input.capacity < 1 ||
    input.refillPerSecond <= 0
  ) {
    throw new Error("Invalid MCP rate limit");
  }
  const scopeHash = createHash("sha256")
    .update(JSON.stringify(["mcp-connection", input.budget, input.key]))
    .digest("hex");
  const capacity = input.capacity;
  const rate = input.refillPerSecond;
  return await withAccountRls(db, input.accountId, async (scoped) => {
    const refilled = (table: string) =>
      sql.raw(`least(${capacity}::double precision, ${table}.tokens
        + greatest(0, extract(epoch from clock_timestamp() - ${table}.updated_at))
          * ${rate}::double precision)`);
    const rows = await rawRows<{ admitted: boolean; retry_after: number }>(
      scoped,
      sql`
      with admitted as (
        insert into mcp_connection_rate_limits (account_id, scope_hash, tokens, updated_at)
        values (${input.accountId}::uuid, ${scopeHash}, ${capacity - 1}::double precision, clock_timestamp())
        on conflict (account_id, scope_hash) do update set
          tokens = ${refilled("mcp_connection_rate_limits")} - 1,
          updated_at = clock_timestamp()
        where ${refilled("mcp_connection_rate_limits")} >= 1
        returning scope_hash
      ) select exists(select 1 from admitted) as admitted,
        coalesce((select greatest(1, ceil((1 - ${refilled("current")}) / ${rate}::double precision))
          from mcp_connection_rate_limits current
          where current.account_id = ${input.accountId}::uuid and current.scope_hash = ${scopeHash}),
          1)::integer as retry_after`,
    );
    if (Math.random() < 0.01) {
      await scoped
        .execute(
          sql`delete from mcp_connection_rate_limits
            where account_id = ${input.accountId}::uuid
              and updated_at < clock_timestamp() - ${IDLE_ROW_MS} * interval '1 millisecond'`,
        )
        .catch(() => undefined);
    }
    if (rows[0]?.admitted) return 0;
    return Math.max(1, Number(rows[0]?.retry_after ?? 1));
  });
}
