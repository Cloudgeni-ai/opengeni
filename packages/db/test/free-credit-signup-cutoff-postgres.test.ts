import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  applyCreditDebitUpToBalance,
  completeSelfServiceOrganizationSetup,
  createDb,
  freePlanCreditEligible,
  getBillingBalance,
  getSpendableCreditBalance,
  grantPlanCreditPeriod,
  listSubscriptionPlanMaintenanceAccounts,
  maintainSubscriptionPlans,
  nestedPostgresSqlState,
  readSubscriptionPlanCatalog,
  replacePlanCreditPeriod,
  type DbClient,
} from "../src";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

// Migration 1119: a revision-fenced cutoff on the signup receipt owner's
// auth_users.created_at gates NEW Free periods only.
let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;
const DAY = 86_400_000;
beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase(
    "free-credit-signup-cutoff",
    "free_cutoff_data",
  );
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

/** A verified owner whose user row was created `age` ago (or at a Date); the organization is created now. */
async function owner(age: number | Date = 0) {
  const userId = crypto.randomUUID();
  const createdAt = age instanceof Date ? age : new Date(Date.now() - age);
  await shared!.admin`insert into auth_users(id,name,email,email_verified,created_at,updated_at)
    values (${userId},'Signup owner',${`${userId}@example.test`},true,${createdAt},${createdAt})`;
  const setup = await completeSelfServiceOrganizationSetup(client!.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Cutoff organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
    trialCreditsEnabled: true,
    trialCreditModelIds: ["model-a"],
  });
  return setup.organizationId;
}

async function revision() {
  const [row] = await shared!.admin`select coalesce(max(revision),0)::int as revision
    from opengeni_private.free_credit_signup_cutoff_revisions where data_schema = ${shared!.schema}`;
  return row!.revision as number;
}

async function setCutoff(notBefore: Date | null, expected?: number) {
  const [row] = await shared!.admin`select opengeni_private.set_free_credit_signup_cutoff(
    ${notBefore}::timestamptz, 'operator:test', 'signup cutoff test', ${expected ?? (await revision())}::bigint) as result`;
  return row!.result as { revision: number; notBefore: string | null; previousRevision: number };
}

async function freePeriods(accountId: string) {
  return await shared!.admin`select id, granted_micros::int as granted, expired_at
    from plan_credit_periods where account_id = ${accountId} and plan_key = 'free'`;
}

async function sqlState(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return nestedPostgresSqlState(error) ?? (error as { code?: string }).code ?? "error";
  }
  return null;
}

async function setFreeCredit(enabled: boolean, monthlyCreditMicros: number) {
  const catalog = await readSubscriptionPlanCatalog(client!.db);
  const plans = catalog.plans.map((plan) =>
    plan.key === "free" ? { ...plan, freeCredit: enabled, monthlyCreditMicros } : plan,
  );
  await shared!
    .admin`select set_subscription_plan_catalog(${shared!.admin.json(plans)}, 'cutoff-test', 'Toggle Free credit for cutoff test')`;
}

test("with no cutoff, eligibility and Free enrollment are unchanged for old and new owners", async () => {
  if (!shared || !client) return;
  expect(await revision()).toBe(0);
  const old = await owner(30 * DAY);
  const fresh = await owner();
  expect(await freePlanCreditEligible(client.db, old)).toBe(true);
  expect(await freePlanCreditEligible(client.db, fresh)).toBe(true);
  await maintainSubscriptionPlans(client.db);
  for (const id of [old, fresh]) {
    const periods = await freePeriods(id);
    expect(periods).toHaveLength(1);
    expect(periods[0]!.granted).toBe(10 * M);
  }
  // An explicit NULL revision is also "no cutoff".
  await setCutoff(null);
  const later = await owner(30 * DAY);
  expect(await freePlanCreditEligible(client.db, later)).toBe(true);
}, 180_000);

test("pre-cutoff owners get no new Free period and are not listed; post-cutoff owners are eligible, listed and granted", async () => {
  if (!shared || !client) return;
  // The old owner creates their organization now: only the user's signup time counts.
  const old = await owner(2 * DAY);
  const result = await setCutoff(new Date(Date.now() - DAY));
  expect(result.revision).toBe(result.previousRevision + 1);
  const fresh = await owner();
  expect(await freePlanCreditEligible(client.db, old)).toBe(false);
  expect(await freePlanCreditEligible(client.db, fresh)).toBe(true);

  const sweep = await maintainSubscriptionPlans(client.db);
  expect(sweep.failedAccounts).toBe(0);
  // Both are enrolled on Free (seat-cap row); only the post-cutoff owner is funded.
  expect(await freePeriods(old)).toHaveLength(0);
  expect(await freePeriods(fresh)).toHaveLength(1);
  expect((await getBillingBalance(client.db, fresh)).plan?.creditRemainingMicros).toBe(10 * M);
  // The Free enrollment branch no longer lists the pre-cutoff account.
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db, 100)).not.toContain(old);

  // Neither direct issuance path bypasses the cutoff.
  const [plan] = await shared.admin`select current_period_start, current_period_end
    from organization_plans where account_id = ${old}`;
  const input = {
    accountId: old,
    planKey: "free",
    periodStart: plan!.current_period_start as Date,
    periodEnd: plan!.current_period_end as Date,
  };
  expect(await sqlState(() => grantPlanCreditPeriod(client!.db, input))).toBe("42501");
  expect(await sqlState(() => replacePlanCreditPeriod(client!.db, input))).toBe("42501");
  expect(await freePeriods(old)).toHaveLength(0);

  // Clearing the cutoff restores the previous behavior on the next sweep.
  await setCutoff(null);
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db, 100)).toContain(old);
  await maintainSubscriptionPlans(client.db);
  expect(await freePeriods(old)).toHaveLength(1);
}, 180_000);

test("an owner created exactly at the cutoff is eligible; one created just before is not", async () => {
  if (!shared || !client) return;
  const cutoff = new Date(Date.now() - DAY);
  await setCutoff(cutoff);
  try {
    const atCutoff = await owner(cutoff);
    const justBefore = await owner(new Date(cutoff.getTime() - 1));
    expect(await freePlanCreditEligible(client.db, atCutoff)).toBe(true);
    expect(await freePlanCreditEligible(client.db, justBefore)).toBe(false);
    // The sweep enrolls both (seat-cap row) but funds only the owner at the cutoff.
    await maintainSubscriptionPlans(client.db);
    expect(await freePeriods(atCutoff)).toHaveLength(1);
    expect(await freePeriods(justBefore)).toHaveLength(0);
    expect(await listSubscriptionPlanMaintenanceAccounts(client.db, 100)).not.toContain(justBefore);
  } finally {
    await setCutoff(null);
  }
}, 180_000);

test("a post-cutoff owner who got nothing while Free was off is granted once Free is back on", async () => {
  if (!shared || !client) return;
  const original = (await readSubscriptionPlanCatalog(client.db)).plans.find(
    (p) => p.key === "free",
  )!;
  await setFreeCredit(false, 0);
  try {
    await setCutoff(new Date(Date.now() - DAY));
    const old = await owner(2 * DAY);
    const fresh = await owner();
    await maintainSubscriptionPlans(client.db);
    expect(await freePeriods(fresh)).toHaveLength(0);
    expect(await freePeriods(old)).toHaveLength(0);
    // Catalog on: the post-cutoff owner is swept and funded; the old owner is not.
    await setFreeCredit(true, original.monthlyCreditMicros);
    const listed = await listSubscriptionPlanMaintenanceAccounts(client.db, 100);
    expect(listed).toContain(fresh);
    expect(listed).not.toContain(old);
    await maintainSubscriptionPlans(client.db);
    expect((await freePeriods(fresh)).map((p) => p.granted)).toEqual([
      original.monthlyCreditMicros,
    ]);
    expect(await freePeriods(old)).toHaveLength(0);
  } finally {
    await setFreeCredit(original.freeCredit, original.monthlyCreditMicros);
    await setCutoff(null);
  }
}, 180_000);

test("an existing in-period grant stays untouched and spendable after a later cutoff", async () => {
  if (!shared || !client) return;
  expect(
    (
      await shared.admin`select not_before from opengeni_private.free_credit_signup_cutoff_revisions
    where data_schema = ${shared.schema} order by revision desc limit 1`
    )[0]!.not_before,
  ).toBeNull();
  const old = await owner(2 * DAY);
  await maintainSubscriptionPlans(client.db);
  const [period] = await freePeriods(old);
  expect(period!.granted).toBe(10 * M);
  await setCutoff(new Date(Date.now() - DAY));
  expect(await freePlanCreditEligible(client.db, old)).toBe(false);
  expect((await getSpendableCreditBalance(client.db, old, "model-a")).balanceMicros).toBe(10 * M);
  const charge = await applyCreditDebitUpToBalance(client.db, {
    accountId: old,
    requestedAmountMicros: 3 * M,
    modelId: "model-a",
    type: "model_debit",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(charge.debitedMicros).toBe(3 * M);
  await maintainSubscriptionPlans(client.db);
  const after = await freePeriods(old);
  expect(after).toHaveLength(1);
  expect(after[0]!.id).toBe(period!.id);
  expect(after[0]!.expired_at).toBeNull();
  expect((await getBillingBalance(client.db, old)).plan?.creditRemainingMicros).toBe(7 * M);
  // An exact replay returns the original receipt instead of failing.
  const [plan] = await shared.admin`select current_period_start, current_period_end
    from organization_plans where account_id = ${old}`;
  const replay = await grantPlanCreditPeriod(client.db, {
    accountId: old,
    planKey: "free",
    periodStart: plan!.current_period_start as Date,
    periodEnd: plan!.current_period_end as Date,
  });
  expect(replay.id).toBe(period!.id);
  await setCutoff(null);
}, 180_000);

test("the setter is owner-only, revision-fenced and audited; runtime roles cannot read or call it", async () => {
  if (!shared || !client) return;
  const current = await revision();
  expect(await sqlState(() => setCutoff(new Date(), current + 1))).toBe("40001");
  expect(await sqlState(() => setCutoff(new Date(), Math.max(0, current - 1)))).toBe("40001");
  expect(
    await sqlState(
      () =>
        shared!
          .admin`select opengeni_private.set_free_credit_signup_cutoff(now(), 'operator:test', 'signup cutoff test', null)`,
    ),
  ).toBe("22023");
  expect(
    await sqlState(
      () =>
        shared!
          .admin`select opengeni_private.set_free_credit_signup_cutoff(now(), 'operator:test', 'short', ${current}::bigint)`,
    ),
  ).toBe("23514");
  expect(await revision()).toBe(current);
  expect(
    await sqlState(() =>
      Promise.resolve(
        client!.db.execute(
          sql`select opengeni_private.set_free_credit_signup_cutoff(now(), 'operator:forged', 'Runtime role attempt', ${current}::bigint)`,
        ),
      ),
    ),
  ).toBe("42501");
  expect(
    await sqlState(() =>
      Promise.resolve(
        client!.db.execute(sql`select * from opengeni_private.free_credit_signup_cutoff_revisions`),
      ),
    ),
  ).toBe("42501");
  const notBefore = new Date("2026-10-29T15:08:00.000Z");
  const written = await setCutoff(notBefore, current);
  expect(written).toMatchObject({ revision: current + 1, previousRevision: current });
  expect(new Date(written.notBefore!).getTime()).toBe(notBefore.getTime());
  const history =
    await shared.admin`select revision::int, not_before, operator, reason, database_role
    from opengeni_private.free_credit_signup_cutoff_revisions where data_schema = ${shared.schema} order by revision`;
  expect(history.map((row) => row.revision)).toEqual(
    Array.from({ length: current + 1 }, (_, index) => index + 1),
  );
  expect(history.at(-1)).toMatchObject({
    operator: "operator:test",
    reason: "signup cutoff test",
  });
  await setCutoff(null, current + 1);

  const options = {
    expectedRole: "opengeni_app",
    targetSchema: shared.schema,
    rlsStrategy: "force" as const,
  };
  const posture = await inspectRuntimeDatabasePosture(client.db, options);
  expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
  const routines = await shared.admin`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as runtime_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'opengeni_private' and p.proname in ('set_free_credit_signup_cutoff', 'list_subscription_plan_maintenance_accounts'))
      or (n.nspname = ${shared.schema} and p.proname = 'free_plan_credit_eligible')
    order by p.proname`;
  expect(routines.map((r) => [r.proname, r.prosecdef, r.runtime_execute, r.proconfig])).toEqual([
    [
      "free_plan_credit_eligible",
      true,
      true,
      [`search_path=pg_catalog, ${shared.schema}, opengeni_private, pg_temp`],
    ],
    ["list_subscription_plan_maintenance_accounts", true, true, ["search_path=pg_catalog"]],
    [
      "set_free_credit_signup_cutoff",
      true,
      false,
      [`search_path=pg_catalog, ${shared.schema}, opengeni_private, pg_temp`],
    ],
  ]);
}, 180_000);
