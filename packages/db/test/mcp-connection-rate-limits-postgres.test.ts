import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  admitMcpConnectionRateLimit,
  createDb,
  ensureManagedAccessForUser,
  withRlsContext,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
// Two pools stand in for two API processes.
let first: DbClient | null = null;
let second: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("mcp-connection-rate-limits");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL is required for the shared MCP rate limit test");
    }
    return;
  }
  first = createDb(shared.appUrl, { max: 4 });
  second = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await first?.close();
  await second?.close();
  await shared?.release();
}, 180_000);

describe("shared MCP connection rate limits", () => {
  test("two API processes spend one budget, never more, and the account is an RLS boundary", async () => {
    if (!shared || !first || !second) return;
    const suffix = crypto.randomUUID();
    const access = await ensureManagedAccessForUser(first.db, {
      userId: `mcp-rate-${suffix}`,
      email: `mcp-rate-${suffix}@example.test`,
      name: "MCP rate fixture",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const bucket = {
      accountId,
      budget: "call",
      key: `connection:${suffix}`,
      capacity: 5,
      // Slow enough that nothing refills during the test.
      refillPerSecond: 1 / 3_600,
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        admitMcpConnectionRateLimit((index % 2 === 0 ? first : second)!.db, bucket),
      ),
    );
    expect(results.filter((wait) => wait === 0)).toHaveLength(5);
    for (const wait of results.filter((value) => value > 0)) {
      expect(wait).toBeGreaterThanOrEqual(1);
    }
    // Another budget and another key start full.
    expect(await admitMcpConnectionRateLimit(second.db, { ...bucket, budget: "delegate" })).toBe(0);
    expect(await admitMcpConnectionRateLimit(first.db, { ...bucket, key: "other" })).toBe(0);

    // It refills with time.
    await shared.admin`
      update mcp_connection_rate_limits
      set updated_at = updated_at - interval '2 hours'
      where account_id = ${accountId}::uuid`;
    expect(await admitMcpConnectionRateLimit(first.db, bucket)).toBe(0);

    // Rows are content-free and invisible outside their account.
    const hidden = await withRlsContext(
      first.db,
      { accountId: crypto.randomUUID(), workspaceId: null },
      async (db) => await db.execute(sql`select scope_hash from mcp_connection_rate_limits`),
    );
    expect(hidden).toHaveLength(0);
    const stored = await shared.admin<{ scope_hash: string }[]>`
      select scope_hash from mcp_connection_rate_limits where account_id = ${accountId}::uuid`;
    expect(stored.length).toBe(3);
    expect(stored.every((row) => /^[0-9a-f]{64}$/u.test(row.scope_hash))).toBe(true);
  }, 60_000);
});
