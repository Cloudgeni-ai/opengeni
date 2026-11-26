import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

// Contract (1578): list_subscription_plan_maintenance_accounts returns exactly
// what 1494's definition returns, for every plan state, signup cutoff and
// bound, and no longer pays a per-account nested loop when nothing is due
// (the worker's every-minute case). 1494's body is installed beside it under
// another name and both run on the same data.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const DRIZZLE = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const ACCOUNTS = 2_000;
const LEDGER_NOISE = 150_000;

setDefaultTimeout(300_000);

let shared: SharedTestDatabase | null = null;

/** 1494's definition, renamed, for the schema the shared database migrated into. */
async function install1494Copy(admin: SharedTestDatabase["admin"]) {
  const source = await readFile(join(DRIZZLE, "1494_card_verification_gate.sql"), "utf8");
  const start = source.indexOf(
    "CREATE OR REPLACE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)",
  );
  const end = source.indexOf("$create$, data_schema);", start);
  if (start < 0 || end < 0) throw new Error("1494's inventory definition was not found");
  const [schemaRow] = await admin<{ schema: string }[]>`select current_schema() as schema`;
  const schema = schemaRow!.schema;
  const body = source
    .slice(start, end)
    .replace(
      "opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)",
      "opengeni_private.list_subscription_plan_maintenance_accounts_1494(p_limit integer)",
    )
    .replaceAll("%1$I", `"${schema.replaceAll('"', '""')}"`);
  await admin.unsafe(body);
}

type Sql = SharedTestDatabase["admin"];

/** Both definitions at each bound; returns how many accounts the largest listed. */
async function expectSameAtEveryBound(admin: Sql, label: string): Promise<number> {
  let largest = 0;
  for (const bound of [1, 7, 50, 100]) {
    const [row] = await admin<{ before: string[]; after: string[] }[]>`
      select
        array(select account_id::text from opengeni_private.list_subscription_plan_maintenance_accounts_1494(${bound}::integer)) as before,
        array(select account_id::text from opengeni_private.list_subscription_plan_maintenance_accounts(${bound}::integer)) as after`;
    expect({ label, bound, accounts: row!.after }).toEqual({
      label,
      bound,
      accounts: row!.before,
    });
    largest = Math.max(largest, row!.after.length);
  }
  return largest;
}

/**
 * Median call time on one connection. With `nestedLoops`, hash and merge
 * joins are off: the plan production chose for 1494 under `ORDER BY ... LIMIT`
 * (a nested-loop anti join re-scanning materialized live periods for every
 * account), which the planner picks or not depending on its estimates.
 */
async function medianCallMs(admin: Sql, name: string, nestedLoops: boolean): Promise<number> {
  const connection = await admin.reserve();
  try {
    if (nestedLoops) {
      await connection`set enable_hashjoin = off`;
      await connection`set enable_mergejoin = off`;
    }
    // A pooled connection may hold plpgsql plans cached under other settings.
    await connection`discard plans`;
    const times: number[] = [];
    // plpgsql switches to a generic plan after five calls; measure both.
    for (let call = 0; call < 9; call += 1) {
      const started = performance.now();
      await connection.unsafe(`select count(*) from opengeni_private.${name}(50)`);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)]!;
  } finally {
    await connection`reset enable_hashjoin`;
    await connection`reset enable_mergejoin`;
    await connection`discard plans`;
    connection.release();
  }
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-1578-plan-maintenance");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL fixture is unavailable");
    return;
  }
  const admin = shared.admin;
  await install1494Copy(admin);
  // A production-shaped steady state with nothing due: Free organizations
  // with a verified signup trial and this anniversary's receipt (most still
  // live), some without a trial, some on Pro, and a ledger much larger than
  // the trial grants.
  await admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into auth_users (id, name, email, email_verified, created_at)
      select 'plan-owner-' || i, 'Owner ' || i, 'plan-owner-' || i || '@example.test', true,
        now() - (i * interval '7 hours')
      from generate_series(1, ${ACCOUNTS}) i`;
    await tx`
      insert into managed_accounts (name, created_at)
      select 'plan-org-' || i, now() - ((i * 7) % 900) * interval '1 day' - interval '3 hours'
      from generate_series(1, ${ACCOUNTS}) i`;
    await tx`
      create temp table plan_orgs on commit drop as
      select account.id, row_number() over (order by account.name) as i, account.created_at
      from managed_accounts account where account.name like 'plan-org-%'`;
    await tx`
      insert into organization_plans (account_id, plan_key, status, stripe_subscription_id,
        current_period_start, current_period_end)
      select id, case when i % 20 = 0 then 'pro' else 'free' end, 'active',
        case when i % 20 = 0 then 'sub_' || i end,
        case when i % 20 = 0 then now() - interval '10 days' end,
        case when i % 20 = 0 then now() + interval '20 days' end
      from plan_orgs`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, source_type, source_id, idempotency_key)
      select id, 'grant', 10000000, 'verified_signup_trial', 'plan-owner-' || i,
        'verified-signup-trial:v1:plan-owner-' || i
      from plan_orgs where i % 10 <> 9`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
      select org.id, 'model_usage_debit', -1 - (n % 1000), 'app', 'plan-noise-' || n
      from generate_series(1, ${LEDGER_NOISE}) n
      join plan_orgs org on org.i = 1 + (n % ${ACCOUNTS})`;
    await tx`
      insert into credit_ledger_entries (id, account_id, type, amount_micros, idempotency_key)
      select gen_random_uuid(), id, 'plan_credit_grant', 1000000, 'plan-grant-' || id
      from plan_orgs where i % 10 <> 9 and i % 20 <> 0`;
    await tx`
      insert into plan_credit_periods (account_id, plan_key, catalog_revision, period_start, period_end,
        granted_micros, opening_debt_micros, grant_entry_id, idempotency_key,
        expired_at, expiry_entry_id, usage_at_expiry_micros)
      select org.id, 'free',
        (select min(revision) from opengeni_private.subscription_plan_catalog_revisions),
        anniversary.period_start, anniversary.period_end, 1000000, 0, grant_entry.id,
        'plan-credit:free:' || org.id::text || ':' || to_char(anniversary.period_start at time zone 'UTC', 'YYYY-MM'),
        case when org.i % 10 < 3 then now() - interval '1 minute' end,
        case when org.i % 10 < 3 then grant_entry.id end,
        case when org.i % 10 < 3 then 0 end
      from plan_orgs org
      cross join lateral opengeni_private.subscription_plan_free_anniversary(org.created_at,
        greatest(org.created_at, now())) anniversary
      join credit_ledger_entries grant_entry on grant_entry.idempotency_key = 'plan-grant-' || org.id
      where anniversary.period_end > now() + interval '1 hour'`;
  });
  await admin`analyze`;
}, 900_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

test("nothing due: the same empty result, without the old per-account nested loop", async () => {
  if (!shared) return;
  expect(await expectSameAtEveryBound(shared.admin, "steady")).toBe(0);
  const timings: Record<string, number> = {};
  for (const nestedLoops of [false, true]) {
    for (const name of [
      "list_subscription_plan_maintenance_accounts_1494",
      "list_subscription_plan_maintenance_accounts",
    ]) {
      timings[`${name}${nestedLoops ? " (nested loops)" : ""}`] = await medianCallMs(
        shared.admin,
        name,
        nestedLoops,
      );
    }
  }
  console.info(
    `[plan maintenance inventory] ${ACCOUNTS} accounts, ${LEDGER_NOISE} ledger rows, median of 9 (ms): ` +
      JSON.stringify(timings, (_, value: unknown) =>
        typeof value === "number" ? Math.round(value * 10) / 10 : value,
      ),
  );
  // 1578 has no join between accounts and live periods to go wrong: with the
  // nested loops production chose it stays several times faster than 1494,
  // and it is never much slower than its own default plan.
  const before = timings["list_subscription_plan_maintenance_accounts_1494 (nested loops)"]!;
  const after = timings["list_subscription_plan_maintenance_accounts (nested loops)"]!;
  expect(after * 3).toBeLessThan(before);
  expect(after).toBeLessThan(timings["list_subscription_plan_maintenance_accounts"]! * 3 + 20);
});

test("every plan state, cutoff and bound lists the same accounts as 1494", async () => {
  if (!shared) return;
  const admin = shared.admin;
  const listed: Record<string, number> = {};
  const step = async (label: string, change: (tx: Sql) => Promise<unknown>) => {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await change(tx as unknown as Sql);
    });
    listed[label] = await expectSameAtEveryBound(admin, label);
  };
  // Live periods that have ended (the first branch).
  await step(
    "ended periods",
    (tx) => tx`
    update plan_credit_periods set period_end = now() - interval '1 hour'
    where id in (select id from plan_credit_periods where expired_at is null
      and period_start < now() - interval '2 hours' order by account_id limit 40)`,
  );
  // Trial organizations whose receipt for this anniversary is missing.
  await step(
    "missing receipts",
    (tx) => tx`
    delete from plan_credit_periods where id in (select id from plan_credit_periods
      where expired_at is not null order by account_id desc limit 300)`,
  );
  // Paid plans that ended, and organizations without a plan.
  await step("ended paid plans and no plan", async (tx) => {
    await tx`
      update organization_plans set status = case when account_id::text < '8' then 'unpaid' else 'canceled' end,
        current_period_start = now() - interval '40 days', current_period_end = now() - interval '1 day'
      where account_id in (select account_id from organization_plans where plan_key = 'pro'
        order by account_id limit 25)`;
    await tx`
      update organization_plans set status = 'incomplete_expired'
      where account_id in (select account_id from organization_plans where plan_key = 'pro'
        and status = 'active' order by account_id desc limit 5)`;
    await tx`
      delete from organization_plans where account_id in (select account_id from organization_plans
        where plan_key = 'free' order by account_id desc limit 15)`;
  });
  // Live periods for some of those, and every remaining live period ended.
  await step(
    "all live periods ended",
    (tx) => tx`
    update plan_credit_periods set period_end = greatest(period_start + interval '1 minute', now() - interval '1 minute')
    where expired_at is null and period_start < now() - interval '2 minutes'`,
  );
  // Promotion holds, enforced and not.
  await step(
    "holds without enforcement",
    (tx) => tx`
    insert into promotion_decisions (account_id, decision, revision, actor)
    select account_id, 'held', 1, 'test' from organization_plans where plan_key = 'free'
    order by account_id limit 200
    on conflict (account_id) do update set decision = 'held'`,
  );
  await step(
    "holds enforced",
    (tx) => tx`
    insert into promotion_enforcement (singleton, enabled) values (true, true)
    on conflict (singleton) do update set enabled = true`,
  );
  // Signup cutoffs: one that excludes the older trial owners, then none.
  const [schemaRow] = await admin<{ schema: string }[]>`select current_schema() as schema`;
  const schema = schemaRow!.schema;
  await step(
    "signup cutoff",
    (tx) => tx`
    insert into opengeni_private.free_credit_signup_cutoff_revisions (data_schema, revision, not_before, operator, reason)
    values (${schema}, 1000001, now() - interval '200 days', 'test', 'plan maintenance comparison')`,
  );
  await step(
    "signup cutoff cleared",
    (tx) => tx`
    insert into opengeni_private.free_credit_signup_cutoff_revisions (data_schema, revision, not_before, operator, reason)
    values (${schema}, 1000002, null, 'test', 'plan maintenance comparison')`,
  );
  // Most states list accounts, and a full batch at the largest bound.
  expect(Object.values(listed).filter((count) => count > 0).length).toBeGreaterThanOrEqual(6);
  expect(Math.max(...Object.values(listed))).toBe(100);
});
