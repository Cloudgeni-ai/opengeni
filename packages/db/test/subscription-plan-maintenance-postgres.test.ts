import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  completeSelfServiceOrganizationSetup,
  createDb,
  ensureManagedAccessForUser,
  getBillingBalance,
  grantPlanCreditPeriod,
  listSubscriptionPlanMaintenanceAccounts,
  maintainSubscriptionPlans,
  nestedPostgresSqlState,
  replacePlanCreditPeriod,
  subscriptionPlanMaintenanceDue,
  upsertOrganizationPlan,
  withRlsContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;
beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase(
    "subscription-plan-maintenance",
    "plan_maintenance_data",
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

async function account(eligible = false) {
  const userId = crypto.randomUUID();
  if (!eligible)
    return (
      await ensureManagedAccessForUser(client!.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Unenrolled owner",
      })
    ).defaultAccountId!;
  await shared!
    .admin`insert into auth_users(id,name,email,email_verified) values (${userId},'Trial owner',${`${userId}@example.test`},true)`;
  return (
    await completeSelfServiceOrganizationSetup(client!.db, {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Eligible trial organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "a".repeat(64),
      trialCreditsEnabled: true,
    })
  ).organizationId;
}

async function paid(
  accountId: string,
  planKey = "pro",
  status = "active",
  end = new Date(Date.now() + 3_600_000),
) {
  const periodStart = new Date(Date.now() - 60_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  await upsertOrganizationPlan(client!.db, {
    accountId,
    planKey,
    status: "active",
    stripeSubscriptionId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: end,
  });
  const period = await grantPlanCreditPeriod(client!.db, {
    accountId,
    planKey,
    periodStart,
    periodEnd: end,
    stripeSubscriptionId,
  });
  if (status !== "active")
    await upsertOrganizationPlan(client!.db, {
      accountId,
      planKey,
      status: status as "canceled",
      stripeSubscriptionId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: end,
    });
  return period;
}

async function endPeriod(accountId: string) {
  // Fixture-only clock travel: end a live receipt without waiting a real month.
  await shared!
    .admin`update plan_credit_periods set period_start = clock_timestamp() - interval '2 days', period_end = clock_timestamp() - interval '1 second'
    where account_id = ${accountId} and expired_at is null`;
  await shared!
    .admin`update organization_plans set current_period_start = clock_timestamp() - interval '2 days', current_period_end = clock_timestamp() - interval '1 second'
    where account_id = ${accountId}`;
}

async function state(accountId: string) {
  return await withRlsContext(
    client!.db,
    { accountId },
    async (tx) =>
      (
        await rawRows<{ plan_key: string; status: string }>(
          tx,
          sql`select plan_key,status from organization_plans where account_id = ${accountId}::uuid`,
        )
      )[0],
  );
}

test("monthly anniversaries retain the original UTC day/time across clamping, leap years and year boundaries", async () => {
  if (!shared || !client) return;
  const cases = [
    [
      "2025-01-31T10:20:30.123Z",
      "2025-02-28T10:20:30.122Z",
      "2025-01-31T10:20:30.123Z",
      "2025-02-28T10:20:30.123Z",
    ],
    [
      "2025-01-31T10:20:30.123Z",
      "2025-02-28T10:20:30.123Z",
      "2025-02-28T10:20:30.123Z",
      "2025-03-31T10:20:30.123Z",
    ],
    [
      "2025-01-31T10:20:30.123Z",
      "2025-03-30T12:00:00.000Z",
      "2025-02-28T10:20:30.123Z",
      "2025-03-31T10:20:30.123Z",
    ],
    [
      "2025-01-31T10:20:30.123Z",
      "2025-03-31T10:20:30.123Z",
      "2025-03-31T10:20:30.123Z",
      "2025-04-30T10:20:30.123Z",
    ],
    [
      "2024-01-31T23:59:59.999Z",
      "2024-02-29T23:59:59.999Z",
      "2024-02-29T23:59:59.999Z",
      "2024-03-31T23:59:59.999Z",
    ],
    [
      "2024-02-29T08:15:00.000Z",
      "2025-02-28T08:15:00.000Z",
      "2025-02-28T08:15:00.000Z",
      "2025-03-29T08:15:00.000Z",
    ],
    [
      "2025-12-30T02:30:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2025-12-30T02:30:00.000Z",
      "2026-01-30T02:30:00.000Z",
    ],
  ];
  await client.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('TimeZone', 'Pacific/Auckland', true)`);
    for (const [created, now, start, end] of cases) {
      const [boundary] = await rawRows<{ start: string; end: string }>(
        tx,
        sql`select to_char(period_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start,
          to_char(period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as end
          from opengeni_private.subscription_plan_free_anniversary(${created}::timestamptz, ${now}::timestamptz)`,
      );
      expect(boundary).toEqual({ start: start!, end: end! });
    }
  });
}, 180_000);

test("bounded production-owner inventory discovers unenrolled orgs and eligible receipts in a non-public schema without leaking capability", async () => {
  if (!shared || !client) return;
  expect(await subscriptionPlanMaintenanceDue(client.db)).toBe(false);
  const eligible = await account(true);
  const other = await account();
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db, 1)).toHaveLength(1);
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db)).toEqual(
    [eligible, other].sort(),
  );
  expect(await state(eligible)).toBeUndefined(); // inventory never enrolls
  await withRlsContext(client.db, { accountId: other }, async (tx) => {
    expect(await listSubscriptionPlanMaintenanceAccounts(tx, 100)).toContain(eligible);
    expect(
      await rawRows(
        tx,
        sql`select account_id from credit_ledger_entries where account_id = ${eligible}::uuid`,
      ),
    ).toEqual([]);
  });
  const [capabilities] =
    await shared.admin`select count(*)::int as n from opengeni_private.session_tenancy_fence_inventory_capabilities`;
  expect(capabilities!.n).toBe(0);
  const [owner] =
    await shared.admin`select rolsuper,rolbypassrls from pg_roles where rolname = ${shared.ownerRole}`;
  expect(owner).toEqual({ rolsuper: false, rolbypassrls: false });
  const policies =
    await shared.admin`select cmd, qual from pg_policies where schemaname = ${shared.schema} and policyname = 'subscription_plan_maintenance_inventory_read' order by tablename`;
  expect(policies).toHaveLength(4);
  expect(
    policies.every(
      (p) =>
        p.cmd === "SELECT" &&
        p.qual.includes("session_tenancy_fence_owner_policy_active") &&
        p.qual.includes(shared!.ownerRole),
    ),
  ).toBe(true);
  const options = {
    expectedRole: "opengeni_app",
    targetSchema: shared.schema,
    rlsStrategy: "force" as const,
  };
  const posture = await inspectRuntimeDatabasePosture(client.db, options);
  expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
  const inventory = posture.privateRoutines.find(
    (r) => r.name === "list_subscription_plan_maintenance_accounts(integer)",
  )!;
  expect(inventory).toMatchObject({
    owner: shared.ownerRole,
    securityDefiner: true,
    publicExecute: false,
    execute: true,
    configuration: ["search_path=pg_catalog"],
  });
  expect(
    evaluateRuntimeDatabasePosture(
      { ...posture, privateRoutines: posture.privateRoutines.filter((r) => r !== inventory) },
      options,
    ),
  ).toContain("subscription plan maintenance inventory is missing");
  expect(
    evaluateRuntimeDatabasePosture(
      {
        ...posture,
        privateRoutines: posture.privateRoutines.map((r) =>
          r === inventory ? { ...r, publicExecute: true } : r,
        ),
      },
      options,
    ),
  ).toContain("subscription plan maintenance inventory has unsafe capability posture");
  for (const bound of [0, 101, 1.5, Number.NaN])
    await expect(listSubscriptionPlanMaintenanceAccounts(client.db, bound)).rejects.toThrow(
      "batch size",
    );
  for (const bound of [0, 101, null]) {
    let error: unknown;
    try {
      await client.db.execute(
        sql`select * from opengeni_private.list_subscription_plan_maintenance_accounts(${bound}::integer)`,
      );
    } catch (failure) {
      error = failure;
    }
    expect(nestedPostgresSqlState(error)).toBe("22023");
  }
}, 180_000);

test("concurrent sweeps enroll every organization once but only trial orgs get a full current-anniversary grant", async () => {
  if (!shared || !client) return;
  const eligible = await account(true);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => maintainSubscriptionPlans(client!.db)),
  );
  expect(results.every((r) => r.failedAccounts === 0)).toBe(true);
  expect(await state(eligible)).toEqual({ plan_key: "free", status: "active" });
  const receipts =
    await shared.admin`select * from plan_credit_periods where account_id = ${eligible}`;
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  expect(Number(receipt.granted_micros)).toBe(10 * M);
  const [anniversary] = await shared.admin`select boundary.* from managed_accounts account,
    lateral opengeni_private.subscription_plan_free_anniversary(account.created_at, clock_timestamp()) boundary where account.id = ${eligible}`;
  expect(receipt.period_start.getTime()).toBe(anniversary!.period_start.getTime());
  expect(receipt.period_end.getTime()).toBe(anniversary!.period_end.getTime());
  expect(receipt.idempotency_key).toBe(
    `plan-credit:free:${eligible}:${new Date().toISOString().slice(0, 7)}`,
  );
  expect((await getBillingBalance(client.db, eligible)).balanceMicros).toBe(20 * M); // trial + current month
  expect(await maintainSubscriptionPlans(client.db)).toMatchObject({
    examinedAccounts: 0,
    grantedFreePeriods: 0,
    failedAccounts: 0,
  });
}, 180_000);

test("ended periods expire once for every plan without expiring purchased top-ups or scoped promotions", async () => {
  if (!shared || !client) return;
  for (const planKey of ["pro", "max", "enterprise"]) {
    const id = await account();
    const period = await paid(id, planKey);
    await applyCreditLedgerEntry(client.db, {
      accountId: id,
      type: "credit_topup",
      amountMicros: 50 * M,
      idempotencyKey: crypto.randomUUID(),
    });
    await applyCreditLedgerEntry(client.db, {
      accountId: id,
      type: "grant",
      eligibleModelIds: ["test-model"],
      amountMicros: 7 * M,
      idempotencyKey: crypto.randomUUID(),
    });
    await endPeriod(id);
    expect(await listSubscriptionPlanMaintenanceAccounts(client.db)).toContain(id);
    expect((await maintainSubscriptionPlans(client.db)).failedAccounts).toBe(0);
    expect(await getBillingBalance(client.db, id)).toMatchObject({
      balanceMicros: 57 * M,
      generalBalanceMicros: 50 * M,
    });
    await applyCreditLedgerEntry(client.db, {
      accountId: id,
      type: "credit_topup",
      amountMicros: M,
      idempotencyKey: crypto.randomUUID(),
    });
    await maintainSubscriptionPlans(client.db);
    expect((await getBillingBalance(client.db, id)).balanceMicros).toBe(58 * M);
    const [count] =
      await shared.admin`select count(*)::int n from credit_ledger_entries where idempotency_key = ${`plan-credit-expiry:${period.id}`}`;
    expect(count!.n).toBe(1);
    expect((await state(id))!.plan_key).toBe(planKey);
  }
}, 180_000);

test("ended terminal paid resumes Free; retrying/live paid and Enterprise are preserved; ineligible/embedder orgs get only a Free row", async () => {
  if (!shared || !client) return;
  const canceled = await account(true);
  await paid(canceled, "pro", "canceled");
  await endPeriod(canceled);
  const protectedAccounts: string[] = [];
  for (const status of ["active", "past_due", "paused", "trialing", "incomplete"]) {
    const id = await account(true);
    await paid(id, "pro", status);
    await endPeriod(id);
    protectedAccounts.push(id);
  }
  const liveCanceled = await account(true);
  await paid(liveCanceled, "max", "canceled");
  protectedAccounts.push(liveCanceled);
  const enterprise = await account(true);
  await upsertOrganizationPlan(client.db, {
    accountId: enterprise,
    planKey: "enterprise",
    status: "canceled",
  });
  protectedAccounts.push(enterprise);
  const terminalAccounts: string[] = [];
  for (const status of ["unpaid", "incomplete_expired"]) {
    const terminal = await account(true);
    await paid(terminal, "max", status);
    await endPeriod(terminal);
    terminalAccounts.push(terminal);
  }
  const ineligible = await account();
  const external = await bootstrapWorkspace(client.db, {
    accountExternalSource: "embedder-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Embedded",
    workspaceExternalSource: "embedder-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Embedded",
    subjectId: `external_user:${crypto.randomUUID()}`,
  });
  const externalId = external.workspaceGrants[0]!.accountId;
  await maintainSubscriptionPlans(client.db);
  expect(await state(canceled)).toEqual({ plan_key: "free", status: "active" });
  const [old] =
    await shared.admin`select expired_at from plan_credit_periods where account_id = ${canceled} and plan_key = 'pro'`;
  expect(old!.expired_at).not.toBeNull();
  for (const id of protectedAccounts) expect((await state(id))!.plan_key).not.toBe("free");
  for (const id of terminalAccounts) expect((await state(id))!.plan_key).toBe("free");
  expect(await state(ineligible)).toEqual({ plan_key: "free", status: "active" });
  expect(await state(externalId)).toEqual({ plan_key: "free", status: "active" });
  expect((await getBillingBalance(client.db, ineligible)).balanceMicros).toBe(0);
  expect((await getBillingBalance(client.db, externalId)).balanceMicros).toBe(0);
}, 180_000);

test("an expired current-anniversary Free receipt is not reissued, and a prior interval renews without rollover", async () => {
  if (!shared || !client) return;
  const id = await account(true);
  await maintainSubscriptionPlans(client.db);
  await endPeriod(id);
  await maintainSubscriptionPlans(client.db);
  expect((await getBillingBalance(client.db, id)).balanceMicros).toBe(10 * M); // trial only
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db)).not.toContain(id);
  const prior = await account(true);
  const month = new Date();
  const periodStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const periodEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  await upsertOrganizationPlan(client.db, {
    accountId: prior,
    planKey: "free",
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  await grantPlanCreditPeriod(client.db, {
    accountId: prior,
    planKey: "free",
    periodStart,
    periodEnd,
  });
  const result = await maintainSubscriptionPlans(client.db);
  expect(result.grantedFreePeriods).toBe(1);
  expect((await getBillingBalance(client.db, prior)).balanceMicros).toBe(20 * M);
  const [count] =
    await shared.admin`select count(*)::int n from plan_credit_periods where account_id = ${prior} and expired_at is null`;
  expect(count!.n).toBe(1);
}, 180_000);

test("a terminal paid plan returns to Free seats even if its current-anniversary Free receipt was already spent or expired", async () => {
  if (!shared || !client) return;
  const id = await account(true);
  await maintainSubscriptionPlans(client.db);
  const periodStart = new Date();
  const periodEnd = new Date(Date.now() + 3_600_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  await withRlsContext(client.db, { accountId: id }, async (tx) => {
    await upsertOrganizationPlan(tx, {
      accountId: id,
      planKey: "pro",
      status: "active",
      stripeSubscriptionId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    await replacePlanCreditPeriod(tx, {
      accountId: id,
      planKey: "pro",
      periodStart,
      periodEnd,
      stripeSubscriptionId,
    });
  });
  await upsertOrganizationPlan(client.db, {
    accountId: id,
    planKey: "pro",
    status: "canceled",
    stripeSubscriptionId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  await endPeriod(id);
  expect(await maintainSubscriptionPlans(client.db)).toMatchObject({
    enrolledFreeAccounts: 1,
    grantedFreePeriods: 0,
    expiredPeriods: 1,
    failedAccounts: 0,
  });
  expect(await state(id)).toEqual({ plan_key: "free", status: "active" });
  const [count] =
    await shared.admin`select count(*)::int as n from plan_credit_periods where account_id = ${id} and plan_key = 'free'`;
  expect(count!.n).toBe(1);
  expect((await getBillingBalance(client.db, id)).plan!.creditRemainingMicros).toBe(0);
  expect(await subscriptionPlanMaintenanceDue(client.db)).toBe(false);
}, 180_000);

test("a failed grant rolls back enrollment/expiry, then retries without duplicate receipts", async () => {
  if (!shared || !client) return;
  const id = await account(true);
  await paid(id, "pro", "canceled");
  await endPeriod(id);
  const neighbor = await account(true);
  // Test-only trigger forces a failure after the old period expired and the
  // new state was written, proving one-account transaction atomicity.
  await shared.admin.unsafe(
    `CREATE FUNCTION maintenance_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id = '${id}'::uuid AND NEW.type = 'plan_credit_grant' THEN RAISE EXCEPTION 'fixture grant failure'; END IF; RETURN NEW; END $$`,
  );
  await shared.admin`CREATE TRIGGER maintenance_test_fail BEFORE INSERT ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION maintenance_test_fail()`;
  try {
    const errors: unknown[] = [];
    expect(
      await maintainSubscriptionPlans(client.db, {
        onError: (error) => {
          errors.push(error);
        },
      }),
    ).toMatchObject({ failedAccounts: 1, grantedFreePeriods: 1, expiredPeriods: 0 });
    expect(await state(neighbor)).toEqual({ plan_key: "free", status: "active" });
    expect(errors).toHaveLength(1);
    expect(await state(id)).toEqual({ plan_key: "pro", status: "canceled" });
    const [period] =
      await shared.admin`select expired_at from plan_credit_periods where account_id = ${id}`;
    expect(period!.expired_at).toBeNull();
  } finally {
    await shared.admin`DROP TRIGGER maintenance_test_fail ON credit_ledger_entries`;
    await shared.admin`DROP FUNCTION maintenance_test_fail()`;
  }
  expect(await maintainSubscriptionPlans(client.db)).toMatchObject({
    failedAccounts: 0,
    grantedFreePeriods: 1,
    expiredPeriods: 1,
  });
  expect(await maintainSubscriptionPlans(client.db)).toMatchObject({ examinedAccounts: 0 });
}, 180_000);

test("tenant recheck waits for the organization fence before credit locking and preserves a concurrent paid assignment", async () => {
  if (!shared || !client) return;
  const id = await account(true);
  let sweeping: ReturnType<typeof maintainSubscriptionPlans> | undefined;
  await shared.admin.begin(async (holder) => {
    await holder`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${id}`}, 0))`;
    const [backend] = await holder`select pg_backend_pid() as pid`;
    sweeping = maintainSubscriptionPlans(client!.db);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const [blocked] = await shared!
        .admin`select exists(select 1 from pg_stat_activity where datname = current_database() and ${backend!.pid} = any(pg_blocking_pids(pid))) as waiting`;
      if (blocked!.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    const [credit] = await holder`select pg_try_advisory_xact_lock(hashtext(${id})) as available`;
    expect(credit!.available).toBe(true); // no inversion while waiting on org
    await holder`select set_config('opengeni.account_id', ${id}, true)`;
    await holder`select upsert_organization_plan(${id}::uuid, 'pro', 'active', ${`sub_${crypto.randomUUID()}`}, now(), now() + interval '1 month', false)`;
  });
  expect(await sweeping).toMatchObject({ failedAccounts: 0, grantedFreePeriods: 0 });
  expect(await state(id)).toEqual({ plan_key: "pro", status: "active" });
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db)).not.toContain(id);
}, 180_000);

test("bounded batches drain independently and neither GUCs nor a caller-opened capability expose other tenants", async () => {
  if (!shared || !client) return;
  const ids = await Promise.all(Array.from({ length: 3 }, () => account(true)));
  const other = await account();
  await withRlsContext(client.db, { accountId: other }, async (tx) => {
    await tx.execute(
      sql`select set_config('opengeni.session_tenancy_fence_inventory', '1', true), set_config('opengeni.subscription_plan_maintenance', '1', true)`,
    );
    expect(
      await rawRows(
        tx,
        sql`select * from credit_ledger_entries where account_id = ${ids[0]}::uuid`,
      ),
    ).toEqual([]);
    expect(
      await rawRows(tx, sql`select * from plan_credit_periods where account_id <> ${other}::uuid`),
    ).toEqual([]);
    // The established runtime can call the generic inventory opener, but the
    // new policy also requires current_user to be the exact migration owner.
    const [capability] = await rawRows<{ id: string }>(
      tx,
      sql`select opengeni_private.open_session_tenancy_fence_inventory(${shared!.schema}::regnamespace::oid) as id`,
    );
    try {
      expect(
        await rawRows(
          tx,
          sql`select * from credit_ledger_entries where account_id = ${ids[0]}::uuid`,
        ),
      ).toEqual([]);
      expect(
        await rawRows(
          tx,
          sql`select * from plan_credit_periods where account_id <> ${other}::uuid`,
        ),
      ).toEqual([]);
      expect(
        await rawRows(tx, sql`select * from organization_plans where account_id <> ${other}::uuid`),
      ).toEqual([]);
    } finally {
      await tx.execute(
        sql`select opengeni_private.close_session_tenancy_fence_inventory(${capability!.id}::uuid)`,
      );
    }
  });
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db, 1)).toHaveLength(1);
  let granted = 0;
  for (let index = 0; index < 4; index += 1) {
    const result = await maintainSubscriptionPlans(client.db, { batchSize: 1 });
    granted += result.grantedFreePeriods;
    expect(result).toMatchObject({
      examinedAccounts: 1,
      enrolledFreeAccounts: 1,
      failedAccounts: 0,
    });
  }
  expect(granted).toBe(3);
  expect(await subscriptionPlanMaintenanceDue(client.db)).toBe(false);
  for (const id of ids) expect((await state(id))!.plan_key).toBe("free");
  const [publicShape] =
    await shared.admin`select to_regclass('public.organization_plans')::text as relation`;
  expect(publicShape!.relation).toBeNull(); // nothing silently fell back to public
}, 180_000);

test("historical orgs receive only the current anchored interval, and a second org for the same human receives no funding", async () => {
  if (!shared || !client) return;
  const id = await account(true);
  await shared.admin`update managed_accounts set created_at = '2024-01-31T10:20:30.123Z'::timestamptz where id = ${id}`;
  const [trial] =
    await shared.admin`select source_id from credit_ledger_entries where account_id = ${id} and source_type = 'verified_signup_trial'`;
  const sibling = await bootstrapWorkspace(client.db, {
    accountExternalSource: "maintenance-same-human",
    accountExternalId: crypto.randomUUID(),
    accountName: "Another organization",
    workspaceExternalSource: "maintenance-same-human",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Another organization",
    subjectId: `user:${trial!.source_id}`,
  });
  const siblingId = sibling.workspaceGrants[0]!.accountId;
  expect(await maintainSubscriptionPlans(client.db)).toMatchObject({
    enrolledFreeAccounts: 2,
    grantedFreePeriods: 1,
    failedAccounts: 0,
  });
  const periods = await shared.admin`select * from plan_credit_periods where account_id = ${id}`;
  expect(periods).toHaveLength(1);
  const [anniversary] = await shared.admin`select boundary.* from managed_accounts account,
    lateral opengeni_private.subscription_plan_free_anniversary(account.created_at, clock_timestamp()) boundary where account.id = ${id}`;
  expect(periods[0]!.period_start.getTime()).toBe(anniversary!.period_start.getTime());
  expect(periods[0]!.period_end.getTime()).toBe(anniversary!.period_end.getTime());
  expect(await state(siblingId)).toEqual({ plan_key: "free", status: "active" });
  expect((await getBillingBalance(client.db, siblingId)).balanceMicros).toBe(0);
  expect(await maintainSubscriptionPlans(client.db)).toMatchObject({ examinedAccounts: 0 });
}, 180_000);
