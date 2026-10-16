import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  completeSelfServiceOrganizationSetup,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUser,
  expirePlanCreditPeriod,
  freePlanCreditEligible,
  getBillingBalance,
  grantPlanCreditPeriod,
  nestedPostgresSqlState,
  readSubscriptionPlanCatalog,
  replacePlanCreditPeriod,
  upsertOrganizationPlan,
  withRlsContext,
  type DbClient,
  type PlanCreditPeriodInput,
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
  shared = await acquireRestrictedRuntimeTestDatabase("subscription-plans");
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

async function account() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Plan owner",
  });
  return { accountId: access.defaultAccountId!, subject: `user:${userId}` };
}
async function activate(accountId: string, planKey = "pro", duration = 3_600_000) {
  const input: PlanCreditPeriodInput = {
    accountId,
    planKey,
    periodStart: new Date(Date.now() - 1000),
    periodEnd: new Date(Date.now() + duration),
    ...(planKey === "free" ? {} : { stripeSubscriptionId: `sub_${crypto.randomUUID()}` }),
  };
  await sync(input);
  return input;
}
async function sync(input: PlanCreditPeriodInput) {
  await upsertOrganizationPlan(client!.db, {
    ...input,
    status: "active",
    currentPeriodStart: input.periodStart,
    currentPeriodEnd: input.periodEnd,
  });
}
const topup = (accountId: string, amountMicros: number) =>
  applyCreditLedgerEntry(client!.db, {
    accountId,
    type: "credit_topup",
    amountMicros,
    idempotencyKey: crypto.randomUUID(),
  });
const debit = (accountId: string, amountMicros: number, type = "future_resource_debit") =>
  applyCreditDebitAfterUse(client!.db, {
    accountId,
    type,
    amountMicros,
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
async function expectState(action: () => Promise<unknown>, state: string) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

test("ships inert defaults and preserves legacy organizations, with least-privilege runtime posture", async () => {
  if (!client || !shared) return;
  const { plans } = await readSubscriptionPlanCatalog(client.db);
  expect(
    plans.map(({ key, monthlyPriceMicros, monthlyCreditMicros, seatLimit }) => [
      key,
      monthlyPriceMicros,
      monthlyCreditMicros,
      seatLimit,
    ]),
  ).toEqual([
    ["free", 0, 10 * M, 5],
    ["pro", 20 * M, 200 * M, 10],
    ["max", 200 * M, 2000 * M, null],
    ["enterprise", null, 0, null],
  ]);
  const { accountId } = await account();
  expect((await topup(accountId, 25 * M)).plan).toBeNull();
  await debit(accountId, 30 * M);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(-5 * M);
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: shared.schema,
  };
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
  await expectState(
    () =>
      withRlsContext(client!.db, { accountId }, (tx) =>
        tx.execute(sql`delete from organization_plans where account_id = ${accountId}::uuid`),
      ),
    "42501",
  );
}, 180_000);

test("grants general plan credit once under concurrent retries, and rejects changed terms", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const input = await activate(accountId);
  const periods = await Promise.all(
    Array.from({ length: 8 }, () => grantPlanCreditPeriod(client!.db, input)),
  );
  expect(new Set(periods.map((p) => p.id)).size).toBe(1);
  const balance = await getBillingBalance(client.db, accountId);
  expect(balance).toMatchObject({
    balanceMicros: 200 * M,
    generalBalanceMicros: 200 * M,
    promotionalCredits: [],
    plan: {
      key: "pro",
      label: "Pro",
      creditGrantedMicros: 200 * M,
      creditRemainingMicros: 200 * M,
      seatLimit: 10,
      seatsUsed: 1,
    },
  });
  const [grant] =
    await shared.admin`select workspace_id, eligible_model_ids, type from credit_ledger_entries where id = ${periods[0]!.grant_entry_id}`;
  expect(grant).toEqual({
    workspace_id: null,
    eligible_model_ids: null,
    type: "plan_credit_grant",
  });
  await expectState(
    () =>
      grantPlanCreditPeriod(client!.db, {
        ...input,
        periodEnd: new Date(input.periodEnd.getTime() + 1000),
      }),
    "23505",
  );
  await expectState(
    () => expirePlanCreditPeriod(client!.db, { accountId, periodId: periods[0]!.id }),
    "55000",
  );
}, 180_000);

test("spends plan before promotional and top-up credit; refunds reduce usage and expiry preserves other funding", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const input = await activate(accountId);
  const period = await grantPlanCreditPeriod(client.db, input);
  await topup(accountId, 50 * M);
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "grant",
    amountMicros: 100 * M,
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(
    (
      await applyCreditDebitUpToBalance(client.db, {
        accountId,
        type: "model_usage_debit",
        requestedAmountMicros: 150 * M,
        modelId: "model-a",
        idempotencyKey: crypto.randomUUID(),
      })
    ).grantDebitedMicros,
  ).toBe(0);
  expect(
    (await getBillingBalance(client.db, accountId)).promotionalCredits[0]?.remainingMicros,
  ).toBe(100 * M);
  const videoSource = crypto.randomUUID();
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "video_generation_debit",
    amountMicros: 40 * M,
    sourceType: "video_generation_operation",
    sourceId: videoSource,
    idempotencyKey: crypto.randomUUID(),
  });
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "video_generation_refund",
    amountMicros: 10 * M,
    sourceType: "video_generation_operation",
    sourceId: videoSource,
    idempotencyKey: crypto.randomUUID(),
  });
  expect((await getBillingBalance(client.db, accountId)).plan?.creditRemainingMicros).toBe(20 * M);
  const expired = await expirePlanCreditPeriod(client.db, {
    accountId,
    periodId: period.id,
    force: true,
  });
  expect(expired.usage_at_expiry_micros).toBe(180 * M);
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: 150 * M,
    generalBalanceMicros: 50 * M,
    promotionalCredits: [{ remainingMicros: 100 * M }],
    plan: { creditRemainingMicros: 0 },
  });
  expect(
    await expirePlanCreditPeriod(client.db, { accountId, periodId: period.id, force: true }),
  ).toEqual(expired);
  const [expiry] =
    await shared.admin`select workspace_id, amount_micros from credit_ledger_entries where id = ${expired.expiry_entry_id}`;
  expect(expiry).toEqual({ workspace_id: null, amount_micros: String(-20 * M) });
}, 180_000);

test("a request exhausts the plan mid-charge before using promotional credit, then top-ups", async () => {
  if (!client) return;
  const { accountId } = await account();
  await grantPlanCreditPeriod(client.db, await activate(accountId));
  await topup(accountId, 50 * M);
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "grant",
    amountMicros: 100 * M,
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros: 180 * M,
    usage: "model-a",
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  const mixed = await applyCreditDebitUpToBalance(client.db, {
    accountId,
    type: "model_usage_debit",
    requestedAmountMicros: 80 * M,
    modelId: "model-a",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(mixed.grantDebitedMicros).toBe(60 * M);
  expect(mixed.balance).toMatchObject({
    balanceMicros: 90 * M,
    generalBalanceMicros: 50 * M,
    plan: { creditRemainingMicros: 0 },
    promotionalCredits: [{ remainingMicros: 40 * M }],
  });
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros: 60 * M,
    usage: "model-a",
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: 30 * M,
    generalBalanceMicros: 30 * M,
    promotionalCredits: [],
    plan: { creditRemainingMicros: 0 },
  });
}, 180_000);

test("funding and Stripe adjustments are not usage; unknown usage types and backdated settlements are", async () => {
  if (!client) return;
  const { accountId } = await account();
  const input = await activate(accountId);
  await grantPlanCreditPeriod(client.db, input);
  for (const type of [
    "credit_topup",
    "grant",
    "manual_credit_grant",
    "credit_refund",
    "credit_dispute_hold",
    "credit_dispute_release",
  ]) {
    await applyCreditLedgerEntry(client.db, {
      accountId,
      type,
      amountMicros: type === "credit_refund" || type === "credit_dispute_hold" ? -M : M,
      idempotencyKey: crypto.randomUUID(),
    });
  }
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    amountMicros: 7 * M,
    type: "new_resource",
    sourceType: "test",
    sourceId: "backdated",
    idempotencyKey: crypto.randomUUID(),
    occurredAt: new Date("2000-01-01"),
  });
  expect((await getBillingBalance(client.db, accountId)).plan?.creditRemainingMicros).toBe(193 * M);
}, 180_000);

test("expiry never makes an exhausted or negative balance more negative", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const period = await grantPlanCreditPeriod(client.db, await activate(accountId));
  await debit(accountId, 250 * M);
  await expirePlanCreditPeriod(client.db, { accountId, periodId: period.id, force: true });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(-50 * M);
  await topup(accountId, 75 * M);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(25 * M);
}, 180_000);

test("opening debt is already consumed plan credit and cannot expire a later purchased top-up", async () => {
  if (!client) return;
  const { accountId } = await account();
  await debit(accountId, 100 * M);
  const period = await grantPlanCreditPeriod(client.db, await activate(accountId));
  expect(period.opening_debt_micros).toBe(100 * M);
  expect((await getBillingBalance(client.db, accountId)).plan?.creditRemainingMicros).toBe(100 * M);
  await topup(accountId, 100 * M);
  await expirePlanCreditPeriod(client.db, { accountId, periodId: period.id, force: true });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(100 * M);
}, 180_000);

test("a refund of a pre-plan or prior-period video debit cannot inflate the new plan's expiry", async () => {
  if (!client) return;
  const { accountId } = await account();
  const sourceId = crypto.randomUUID();
  await topup(accountId, 100 * M);
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "video_generation_debit",
    amountMicros: 40 * M,
    sourceType: "video_generation_operation",
    sourceId,
    idempotencyKey: crypto.randomUUID(),
  });
  const period = await grantPlanCreditPeriod(client.db, await activate(accountId));
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "video_generation_refund",
    amountMicros: 40 * M,
    sourceType: "video_generation_operation",
    sourceId,
    idempotencyKey: crypto.randomUUID(),
  });
  await debit(accountId, 50 * M);
  expect((await getBillingBalance(client.db, accountId)).plan?.creditRemainingMicros).toBe(150 * M);
  await expirePlanCreditPeriod(client.db, { accountId, periodId: period.id, force: true });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(100 * M);
}, 180_000);

test("ended plan credit is unavailable before maintenance and ledger writers expire it before settlement", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const period = await grantPlanCreditPeriod(client.db, await activate(accountId, "pro", 100));
  await topup(accountId, 100 * M);
  await Bun.sleep(120);
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: 100 * M,
    generalBalanceMicros: 100 * M,
    plan: { creditRemainingMicros: 0, creditPendingExpiryMicros: 200 * M },
  });
  const [physical] =
    await shared.admin`select expired_at from plan_credit_periods where id=${period.id}`;
  expect(physical!.expired_at).toBeNull();
  await debit(accountId, 150 * M);
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: -50 * M,
    generalBalanceMicros: -50 * M,
    plan: { creditPendingExpiryMicros: 0 },
  });
  await topup(accountId, 75 * M);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(25 * M);
}, 180_000);

test("late video refunds preserve purchased funding but never roll expired plan funding into the new period", async () => {
  if (!client) return;
  for (const cost of [40 * M, 250 * M]) {
    const { accountId } = await account();
    const old = await grantPlanCreditPeriod(client.db, await activate(accountId));
    await topup(accountId, 100 * M);
    const sourceId = crypto.randomUUID();
    await applyCreditDebitAfterUse(client.db, {
      accountId,
      type: "video_generation_debit",
      amountMicros: cost,
      sourceType: "video_generation_operation",
      sourceId,
      idempotencyKey: crypto.randomUUID(),
    });
    await expirePlanCreditPeriod(client.db, { accountId, periodId: old.id, force: true });
    await grantPlanCreditPeriod(client.db, await activate(accountId, "max"));
    const refundKey = crypto.randomUUID();
    const refund = {
      accountId,
      type: "video_generation_refund",
      amountMicros: cost,
      sourceType: "video_generation_operation",
      sourceId,
      idempotencyKey: refundKey,
    };
    await applyCreditLedgerEntry(client.db, refund);
    await applyCreditLedgerEntry(client.db, refund);
    expect(await getBillingBalance(client.db, accountId)).toMatchObject({
      balanceMicros: 2100 * M,
      plan: { creditRemainingMicros: 2000 * M },
    });
  }
}, 180_000);

test("a state sync before invoice payment keeps spending the already-granted allowance first", async () => {
  if (!client) return;
  const { accountId } = await account();
  await grantPlanCreditPeriod(client.db, await activate(accountId));
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "grant",
    amountMicros: 100 * M,
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  const unpaid = await activate(accountId, "max");
  await upsertOrganizationPlan(client.db, {
    ...unpaid,
    status: "past_due",
    currentPeriodStart: unpaid.periodStart,
    currentPeriodEnd: unpaid.periodEnd,
  });
  const charged = await applyCreditDebitUpToBalance(client.db, {
    accountId,
    type: "model_usage_debit",
    requestedAmountMicros: 50 * M,
    modelId: "model-a",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(charged.grantDebitedMicros).toBe(0);
  expect(charged.balance.plan).toMatchObject({
    key: "max",
    status: "past_due",
    creditGrantedMicros: 200 * M,
    creditRemainingMicros: 150 * M,
  });
}, 180_000);

test("renewal expires the prior period without rollover; late ended grants expire immediately", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const input = await activate(accountId, "pro", 100);
  await grantPlanCreditPeriod(client.db, input);
  await topup(accountId, 30 * M);
  await debit(accountId, 50 * M);
  await Bun.sleep(120);
  const next = { ...input, periodStart: new Date(), periodEnd: new Date(Date.now() + 3_600_000) };
  await sync(next);
  await grantPlanCreditPeriod(client.db, next);
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: 230 * M,
    plan: { creditRemainingMicros: 200 * M },
  });
  const other = await account();
  const late = {
    ...input,
    accountId: other.accountId,
    stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
    periodStart: new Date(Date.now() - 7200000),
    periodEnd: new Date(Date.now() - 3600000),
  };
  await sync(late);
  expect((await grantPlanCreditPeriod(client.db, late)).expired_at).not.toBeNull();
  expect((await getBillingBalance(client.db, other.accountId)).balanceMicros).toBe(0);
}, 180_000);

test("upgrade atomically expires old credit and grants the full new allowance; old and new retries are inert", async () => {
  if (!client) return;
  const { accountId } = await account();
  const input = await activate(accountId);
  const old = await grantPlanCreditPeriod(client.db, input);
  await topup(accountId, 30 * M);
  await debit(accountId, 50 * M);
  const upgraded = {
    ...input,
    planKey: "max",
    periodStart: new Date(),
    periodEnd: new Date(Date.now() + 7200000),
  };
  await sync(upgraded);
  await expectState(() => grantPlanCreditPeriod(client!.db, upgraded), "55000");
  const result = await replacePlanCreditPeriod(client.db, upgraded);
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: 2030 * M,
    plan: { key: "max", creditRemainingMicros: 2000 * M },
  });
  expect((await grantPlanCreditPeriod(client.db, input)).id).toBe(old.id);
  expect(await replacePlanCreditPeriod(client.db, upgraded)).toEqual(result);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(2030 * M);
  await expect(
    withRlsContext(client.db, { accountId }, async (tx) => {
      const invalid = { ...upgraded, planKey: "missing", periodStart: new Date(Date.now() + 1) };
      await replacePlanCreditPeriod(tx, invalid);
    }),
  ).rejects.toBeDefined();
  expect((await getBillingBalance(client.db, accountId)).plan?.creditRemainingMicros).toBe(
    2000 * M,
  );
}, 180_000);

test("a post-use debit queued before expiry cannot slip into the expired period", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const period = await grantPlanCreditPeriod(client.db, await activate(accountId));
  await topup(accountId, 100 * M);
  let queued: Promise<unknown> | undefined;
  await withRlsContext(client.db, { accountId }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${accountId}))`);
    queued = debit(accountId, 50 * M);
    // Observe the real advisory wait, not a timer-based guess.
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await rawRows<{ waiting: number }>(
        tx,
        sql`select count(*)::int waiting from pg_locks where locktype='advisory' and not granted and objid::bigint = (hashtext(${accountId})::bigint & 4294967295)`,
      );
      if (row!.waiting > 0) break;
      if (attempt === 199) throw new Error("Debit did not acquire the account lock");
      await Bun.sleep(5);
    }
    expect(
      (await expirePlanCreditPeriod(tx, { accountId, periodId: period.id, force: true }))
        .usage_at_expiry_micros,
    ).toBe(0);
  });
  await queued;
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(50 * M);
}, 180_000);

test("only the organization that actually received the verified signup trial is Free-eligible", async () => {
  if (!client || !shared) return;
  const userId = crypto.randomUUID();
  await shared.admin`insert into auth_users(id,name,email,email_verified) values (${userId},'Free owner',${`${userId}@example.test`},true)`;
  const setup = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Free organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
    trialCreditsEnabled: true,
  });
  expect(await freePlanCreditEligible(client.db, setup.organizationId)).toBe(true);
  const input = await activate(setup.organizationId, "free");
  const first = await grantPlanCreditPeriod(client.db, input);
  expect(first.granted_micros).toBe(10 * M);
  expect((await grantPlanCreditPeriod(client.db, input)).id).toBe(first.id);
  const other = await account();
  expect(await freePlanCreditEligible(client.db, other.accountId)).toBe(false);
  const ineligible = await activate(other.accountId, "free");
  await expectState(() => grantPlanCreditPeriod(client!.db, ineligible), "42501");
  await expectState(
    () =>
      withRlsContext(client!.db, { accountId: other.accountId }, (tx) =>
        tx.execute(sql`select free_plan_credit_eligible(${setup.organizationId}::uuid)`),
      ),
    "42501",
  );
  // Free allowance never stacks on top of the paid plan on conversion. The
  // separate verified-signup promotion remains untouched (plan-first spending).
  const beforeUpgrade = await getBillingBalance(client.db, setup.organizationId);
  const paid = await activate(setup.organizationId, "pro");
  paid.periodStart = new Date();
  await sync(paid);
  const replacement = await replacePlanCreditPeriod(client.db, paid);
  expect(replacement.granted_micros).toBe(200 * M);
  expect(await getBillingBalance(client.db, setup.organizationId)).toMatchObject({
    balanceMicros: beforeUpgrade.balanceMicros + 190 * M,
    plan: { key: "pro", creditGrantedMicros: 200 * M, creditRemainingMicros: 200 * M },
    promotionalCredits: beforeUpgrade.promotionalCredits,
  });
}, 180_000);

test("pre-existing general debt cannot make a prepaid plan spend promotional funds repeatedly", async () => {
  if (!client) return;
  const { accountId } = await account();
  await debit(accountId, 250 * M);
  await grantPlanCreditPeriod(client.db, await activate(accountId));
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "grant",
    amountMicros: 100 * M,
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  const spend = () =>
    applyCreditDebitUpToBalance(client!.db, {
      accountId,
      type: "model_usage_debit",
      requestedAmountMicros: 100 * M,
      modelId: "model-a",
      idempotencyKey: crypto.randomUUID(),
    });
  expect((await spend()).grantDebitedMicros).toBe(100 * M);
  expect((await spend()).debitedMicros).toBe(0);
  expect((await getBillingBalance(client.db, accountId)).generalBalanceMicros).toBe(-50 * M);
}, 180_000);

const invite = (accountId: string, actorSubjectId: string, targetSubjectId: string | null = null) =>
  createOrganizationInvitation(client!.db, {
    organizationId: accountId,
    actorSubjectId,
    operationId: crypto.randomUUID(),
    targetSubjectId,
    targetEmail: `${crypto.randomUUID()}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });

test("seat enforcement serializes concurrent invitations and converts a reservation at the cap", async () => {
  if (!client || !shared) return;
  const { accountId, subject } = await account();
  await activate(accountId, "free");
  const target = `user:${crypto.randomUUID()}`;
  const reserved = await invite(accountId, subject, target);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => invite(accountId, subject)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  expect(
    results
      .filter((r) => r.status === "rejected")
      .every((r) => nestedPostgresSqlState((r as PromiseRejectedResult).reason) === "P0S01"),
  ).toBe(true);
  expect((await getBillingBalance(client.db, accountId)).plan?.seatsUsed).toBe(5);
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: target,
    operationId: crypto.randomUUID(),
    invitationId: reserved.id,
    expectedRevision: reserved.revision,
  });
  expect((await getBillingBalance(client.db, accountId)).plan?.seatsUsed).toBe(5);
}, 180_000);

async function provision(accountId: string, subjectId: string, status = "provisioning") {
  return await shared!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true),set_config('opengeni.account_id',${accountId},true)`;
    await tx`insert into organization_memberships(account_id,subject_id,role,status) values (${accountId},${subjectId},'member',${status})`;
  });
}

test("seat caps cover provisioning/reactivation, exclude external/service identities, and keep over-limit organizations intact", async () => {
  if (!client || !shared) return;
  const { accountId, subject } = await account();
  for (let i = 0; i < 5; i++) await provision(accountId, `user:${crypto.randomUUID()}`);
  await activate(accountId, "free");
  const reservedSubject = `user:${crypto.randomUUID()}`;
  await provision(accountId, reservedSubject, "suspended");
  await provision(accountId, `external_user:${crypto.randomUUID()}`);
  await provision(accountId, `service:${crypto.randomUUID()}`);
  expect((await getBillingBalance(client.db, accountId)).plan?.seatsUsed).toBe(6);
  await expectState(() => invite(accountId, subject), "P0S01");
  await expectState(() => provision(accountId, `user:${crypto.randomUUID()}`), "P0S01");
  await expectState(async () => {
    await shared!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true),set_config('opengeni.account_id',${accountId},true)`;
      await tx`update organization_memberships set status='provisioning' where account_id=${accountId} and subject_id=${reservedSubject}`;
    });
  }, "P0S01");
  await upsertOrganizationPlan(client.db, { accountId, planKey: "max", status: "active" });
  await invite(accountId, subject);
  expect((await getBillingBalance(client.db, accountId)).plan).toMatchObject({
    seatLimit: null,
    seatsUsed: 7,
  });
}, 180_000);

test("expired invitations do not consume seats and organizations without plans remain uncapped", async () => {
  if (!client || !shared) return;
  const { accountId, subject } = await account();
  const old = await invite(accountId, subject);
  await shared.admin`update organization_membership_invitations set expires_at=clock_timestamp()-interval '1 second' where id=${old.id}`;
  await activate(accountId, "free");
  await Promise.all(Array.from({ length: 4 }, () => invite(accountId, subject)));
  expect((await getBillingBalance(client.db, accountId)).plan?.seatsUsed).toBe(5);
  const other = await account();
  await Promise.all(Array.from({ length: 12 }, () => invite(other.accountId, other.subject)));
  expect((await getBillingBalance(client.db, other.accountId)).plan).toBeNull();
}, 180_000);

test("catalog is owner-only, revisioned and immutable; changing credits only changes future grants", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const input = await activate(accountId);
  const period = await grantPlanCreditPeriod(client.db, input);
  const initial = await readSubscriptionPlanCatalog(client.db);
  const updated = initial.plans.map((p) =>
    p.key === "pro" ? { ...p, monthlyCreditMicros: 300 * M, seatLimit: 11 } : p,
  );
  await expectState(
    () =>
      client!.db.execute(
        sql`select set_subscription_plan_catalog(${JSON.stringify(updated)}::jsonb,'runtime','Forbidden setter')`,
      ),
    "42501",
  );
  await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(updated)}::jsonb,'test operator','Change future grant and current seat terms')`;
  expect((await readSubscriptionPlanCatalog(client.db)).revision).toBeGreaterThan(initial.revision);
  expect((await getBillingBalance(client.db, accountId)).plan).toMatchObject({
    creditGrantedMicros: 200 * M,
    seatLimit: 11,
  });
  expect((await grantPlanCreditPeriod(client.db, input)).id).toBe(period.id);
  await expect(
    (async () =>
      await shared!
        .admin`update opengeni_private.subscription_plan_catalog_revisions set reason='rewrite history'`)(),
  ).rejects.toBeDefined();
  await expect(
    (async () =>
      await shared!
        .admin`select set_subscription_plan_catalog(${shared!.admin.json(updated.filter((p) => p.key !== "pro"))}::jsonb,'operator','Cannot drop an existing plan')`)(),
  ).rejects.toBeDefined();
  await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(initial.plans)}::jsonb,'test operator','Restore default catalog after test')`;
}, 180_000);

test("expiry does not consume scoped promotional funding when general credit already owes debt", async () => {
  if (!client) return;
  const { accountId } = await account();
  await debit(accountId, 250 * M);
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "grant",
    amountMicros: 100 * M,
    eligibleModelIds: ["model-a"],
    idempotencyKey: crypto.randomUUID(),
  });
  const period = await grantPlanCreditPeriod(client.db, await activate(accountId));
  await expirePlanCreditPeriod(client.db, { accountId, periodId: period.id, force: true });
  expect(await getBillingBalance(client.db, accountId)).toMatchObject({
    balanceMicros: 50 * M,
    generalBalanceMicros: -50 * M,
    promotionalCredits: [{ remainingMicros: 100 * M }],
  });
}, 180_000);
