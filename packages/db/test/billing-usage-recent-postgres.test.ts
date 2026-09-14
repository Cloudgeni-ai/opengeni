import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  createDb,
  createWorkspace,
  ensureManagedAccessForUser,
  listUsageEvents,
  withRlsContext,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("billing-usage-recent");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL is required for billing usage plan regression");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("recent billing usage under application-role RLS", () => {
  test("reads the latest 100 without sorting the account history, with and without a workspace filter", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const access = await ensureManagedAccessForUser(client.db, {
      userId: `usage-plan-${suffix}`,
      email: `usage-plan-${suffix}@example.test`,
      name: "Usage plan fixture",
    });
    const grant = access.workspaceGrants[0]!;
    const second = await createWorkspace(client.db, {
      accountId: grant.accountId,
      name: "Other usage workspace",
    });
    // Interleave workspaces and event types, with timestamp ties resolved by
    // recorded_at. The metric indexes cannot supply this ordering.
    await shared.admin`
      insert into usage_events (
        account_id, workspace_id, event_type, quantity, unit,
        idempotency_key, occurred_at, recorded_at
      )
      select ${grant.accountId},
        case when n % 2 = 0 then ${grant.workspaceId}::uuid else ${second.id}::uuid end,
        case when n % 3 = 0 then 'model.cost' else 'model.tokens' end,
        n, 'count', ${suffix} || ':' || n::text,
        '2026-01-01'::timestamptz + (n / 4) * interval '1 second',
        '2026-01-01'::timestamptz + n * interval '1 second'
      from generate_series(1, 20000) fixture(n)`;
    await shared.admin`analyze usage_events`;

    for (const workspaceId of [undefined, grant.workspaceId!] as const) {
      const rows = await listUsageEvents(client.db, {
        accountId: grant.accountId,
        ...(workspaceId ? { workspaceId } : {}),
        limit: 100,
      });
      expect(rows).toHaveLength(100);
      expect(rows.map((row) => row.quantity)).toEqual(
        Array.from({ length: 100 }, (_, index) => 20000 - index * (workspaceId ? 2 : 1)),
      );
      expect(rows.every((row) => row.accountId === grant.accountId)).toBe(true);
      if (workspaceId) expect(rows.every((row) => row.workspaceId === workspaceId)).toBe(true);

      const plan = await withRlsContext(
        client.db,
        { accountId: grant.accountId, workspaceId: workspaceId ?? null },
        async (db) => {
          const [row] = await db.execute(sql`
            explain (analyze, buffers, format json)
            select * from usage_events
            where account_id = ${grant.accountId}::uuid
              ${workspaceId ? sql`and workspace_id = ${workspaceId}::uuid` : sql``}
            order by occurred_at desc, recorded_at desc
            limit 100
          `);
          return JSON.stringify(row?.["QUERY PLAN"]);
        },
      );
      expect(plan).toContain(
        workspaceId ? "usage_events_workspace_recent_idx" : "usage_events_account_recent_idx",
      );
      expect(plan).not.toContain('"Node Type":"Sort"');
      expect(plan).not.toContain('"Node Type":"Incremental Sort"');
    }
    // The account key remains an RLS boundary, not just a performance hint.
    const hidden = await withRlsContext(
      client.db,
      { accountId: crypto.randomUUID(), workspaceId: null },
      async (db) =>
        await db.execute(
          sql`select id from usage_events where account_id = ${grant.accountId}::uuid`,
        ),
    );
    expect(hidden).toHaveLength(0);
  }, 60_000);
});
