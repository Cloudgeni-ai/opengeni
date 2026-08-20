import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { assertRuntimeDatabasePosture, createDb, nestedPostgresSqlState } from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0303-session-tenancy-product-activation");
  if (!shared && requireRealDatabase) throw new Error("migration 0303 requires PostgreSQL");
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

async function account(): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('0303 activation') returning id`;
  return row!.id;
}

async function activate(accountId: string, inventory = "0".repeat(64)) {
  return await shared!.admin<
    Array<{ accountId: string; activationVersion: number; replay: boolean }>
  >`
    select account_id as "accountId", activation_version as "activationVersion", replay
    from activate_session_tenancy_product(
      ${accountId}::uuid, ${inventory}, ${"1".repeat(64)}, 'database-test',
      ${shared!.admin.array(["opengeni_app"])}::text[]
    )`;
}

describe("migration 0303 session tenancy product activation", () => {
  test("enumerates every nonquiescent authority lane without stale auto-cancellation", async () => {
    const migration = await readFile(
      new URL("../drizzle/0303_session_tenancy_product_activation.sql", import.meta.url),
      "utf8",
    );
    for (const blocker of [
      "nonterminal_turn",
      "nonterminal_attempt",
      "unsettled_interruption",
      "pending_system_update",
      "pending_human_input",
      "pending_tool_receipt",
      "run_state",
      "active_goal",
      "capacity_waiter",
      "active_realtime",
      "active_scheduled_task",
      "workspace_mutation_admission",
      "retained_process",
      "active_viewer",
      "shared_sandbox_group",
    ]) {
      expect(migration).toContain(`blocker := '${blocker}'`);
    }
    expect(migration).not.toContain("cancel_reason = 'authority_changed'");
    expect(migration).not.toContain("INSERT INTO workflow_wake_outbox");
  });

  test("requires an exact application-role drain", async () => {
    if (!shared) return;
    const accountId = await account();
    const app = postgres(shared.appUrl, { max: 1 });
    await app`select 1`;
    let failure: unknown;
    try {
      await activate(accountId);
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("55000");
    await app.end();
    let liveAppSessions = 1;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [drain] = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and usename = 'opengeni_app'`;
      liveAppSessions = drain?.count ?? 1;
      if (liveAppSessions === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(liveAppSessions).toBe(0);
    expect(Array.from(await activate(accountId))).toEqual([
      { accountId, activationVersion: 1, replay: false },
    ]);
  });

  test("concurrent identical requests converge and changed evidence conflicts", async () => {
    if (!shared) return;
    const accountId = await account();
    const results = await Promise.all([activate(accountId), activate(accountId)]);
    expect(
      results
        .flat()
        .map((row) => row.replay)
        .sort(),
    ).toEqual([false, true]);
    let failure: unknown;
    try {
      await activate(accountId, "2".repeat(64));
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("23505");
  });

  test("exposes only value-free activation predicates to the runtime role", async () => {
    if (!shared) return;
    const accountId = await account();
    await activate(accountId);
    const runtime = createDb(shared.appUrl, { max: 1 });
    await expect(
      assertRuntimeDatabasePosture(runtime.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
      }),
    ).rejects.toThrow(/session-tenancy product activation is durable/);
    await expect(
      assertRuntimeDatabasePosture(runtime.db, {
        rlsStrategy: "force",
        expectedRole: "opengeni_app",
        targetSchema: "public",
        organizationTenancyCanonicalActivationEnabled: true,
      }),
    ).resolves.toBeDefined();
    await runtime.close();
    const app = postgres(shared.appUrl, { max: 1 });
    try {
      const [any] = await app<{ activated: boolean }[]>`
        select session_tenancy_any_product_activation() as activated`;
      const [exact] = await app<{ activated: boolean }[]>`
        select session_tenancy_product_activated(${accountId}::uuid, 1) as activated`;
      expect(any?.activated).toBe(true);
      expect(exact?.activated).toBe(false);
      const [scopedExact] = await app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
        return await transaction<{ activated: boolean }[]>`
          select session_tenancy_product_activated(${accountId}::uuid, 1) as activated`;
      });
      expect(scopedExact?.activated).toBe(true);
      expect(Array.from(await app`select * from session_tenancy_activations`)).toEqual([]);
    } finally {
      await app.end();
    }
  });
});
