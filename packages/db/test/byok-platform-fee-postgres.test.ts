import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  applyByokPlatformFeeDebit,
  applyCreditDebitAfterUse,
  applyCreditLedgerEntry,
  completeSelfServiceOrganizationSetup,
  createDb,
  ensureManagedAccessForUser,
  expirePlanCreditPeriod,
  getBillingBalance,
  getByokFeeSpendableBalance,
  grantPlanCreditPeriod,
  spendableCreditMicros,
  upsertOrganizationPlan,
  type DbClient,
} from "../src";

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("byok-platform-fee");
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

async function account(planKey: "free" | "pro") {
  const userId = crypto.randomUUID();
  let accountId: string;
  if (planKey === "free") {
    // A self-service organization: eligible for Free monthly and signup credit.
    await shared!.admin`insert into auth_users(id,name,email,email_verified)
      values (${userId},'Free owner',${`${userId}@example.test`},true)`;
    ({ organizationId: accountId } = await completeSelfServiceOrganizationSetup(client!.db, {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Free owner",
      operationId: crypto.randomUUID(),
      requestFingerprint: "a".repeat(64),
      trialCreditsEnabled: true,
      trialCreditModelIds: ["model-a"],
    }));
  } else {
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Plan owner",
    });
    accountId = access.defaultAccountId!;
  }
  const periodStart = new Date(Date.now() - 1000);
  const periodEnd = new Date(Date.now() + 3_600_000);
  const stripeSubscriptionId = planKey === "pro" ? `sub_${crypto.randomUUID()}` : null;
  await upsertOrganizationPlan(client!.db, {
    accountId,
    planKey,
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
  });
  await grantPlanCreditPeriod(client!.db, {
    accountId,
    planKey,
    periodStart,
    periodEnd,
    stripeSubscriptionId,
  });
  return accountId;
}
const credit = (accountId: string, type: string, amountMicros: number) =>
  applyCreditLedgerEntry(client!.db, {
    accountId,
    type,
    amountMicros,
    idempotencyKey: crypto.randomUUID(),
  });
const fee = (
  accountId: string,
  amountMicros: number,
  origin: "app" | "api",
  key?: string,
  db: DbClient["db"] = client!.db,
) =>
  applyByokPlatformFeeDebit(db, {
    accountId,
    amountMicros,
    sourceType: "model_response",
    sourceId: key ?? crypto.randomUUID(),
    idempotencyKey: key ? `credit:byok_platform_fee:${key}` : crypto.randomUUID(),
    usageOrigin: origin,
  });
// Fee reads also report paid credits.
const balanceOf = (accountId: string) =>
  getBillingBalance(client!.db, accountId, undefined, undefined, false, true);
const usage = (accountId: string, amountMicros: number, origin: "app" | "api") =>
  applyCreditDebitAfterUse(client!.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros,
    sourceType: "model_response",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    usageOrigin: origin,
  });
const spendable = async (accountId: string, origin: "app" | "api") =>
  (await getByokFeeSpendableBalance(client!.db, accountId, origin)).balanceMicros;
async function feeRows(accountId: string) {
  return await shared!.admin<{ amount: string; metadata: Record<string, number> }[]>`
    select amount_micros::text amount, metadata from credit_ledger_entries
    where account_id = ${accountId} and type = 'byok_platform_fee' order by created_at`;
}

test("Free plan, signup and promotional credit never pay the own-key fee; topped-up credit does", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "grant", 25 * M); // signup or legacy promotional credit
  const start = await balanceOf(accountId);
  expect(start.balanceMicros).toBeGreaterThan(25 * M);
  expect(start.paidPlanCreditMicros).toBe(0);
  expect(start.paidCreditsMicros).toBe(0);
  expect(start.byokPlatformFeeMonthMicros).toBeUndefined();
  expect(await spendable(accountId, "app")).toBe(0);
  expect(await spendable(accountId, "api")).toBe(0);

  await credit(accountId, "credit_topup", 5 * M);
  expect(await spendable(accountId, "app")).toBe(5 * M);
  expect(await spendable(accountId, "api")).toBe(5 * M);

  const planBefore = start.plan?.creditRemainingMicros ?? 0;
  await fee(accountId, 2 * M, "app");
  const after = await balanceOf(accountId);
  // The Free plan's credit is untouched; the fee came from paid-for credits.
  expect(after.plan?.creditRemainingMicros ?? 0).toBe(planBefore);
  expect(after.paidCreditsMicros).toBe(3 * M);
  // The billing page shows this month's fees on their own line.
  expect(after.byokPlatformFeeMonthMicros).toBe(2 * M);
  expect(await spendable(accountId, "app")).toBe(3 * M);
  const [row] = await feeRows(accountId);
  expect(row!.metadata.planPaidMicros).toBe(0);
  expect(row!.metadata.creditPaidMicros).toBe(2 * M);
}, 180_000);

test("a paid plan's credit pays app fees first; API fees come from credits only", async () => {
  if (!client || !shared) return;
  const accountId = await account("pro");
  await credit(accountId, "credit_topup", 30 * M);
  const start = await balanceOf(accountId);
  const plan = start.plan!.creditRemainingMicros;
  expect(plan).toBeGreaterThan(0);
  expect(start.paidPlanCreditMicros).toBe(plan);
  expect(await spendable(accountId, "app")).toBe(plan + 30 * M);
  expect(await spendable(accountId, "api")).toBe(30 * M);

  await fee(accountId, 3 * M, "app");
  let balance = await balanceOf(accountId);
  expect(balance.plan!.creditRemainingMicros).toBe(plan - 3 * M);
  expect(balance.creditsMicros).toBe(30 * M);

  await fee(accountId, 2 * M, "api");
  balance = await balanceOf(accountId);
  expect(balance.plan!.creditRemainingMicros).toBe(plan - 3 * M);
  expect(balance.creditsMicros).toBe(28 * M);
  expect(await spendable(accountId, "api")).toBe(28 * M);

  // A fee larger than the remaining plan credit spills into paid credits.
  await fee(accountId, plan - 3 * M + 4 * M, "app");
  balance = await balanceOf(accountId);
  expect(balance.plan!.creditRemainingMicros).toBe(0);
  expect(balance.creditsMicros).toBe(24 * M);
  expect(balance.paidCreditsMicros).toBe(24 * M);

  const rows = await feeRows(accountId);
  expect(rows.map((row) => [row.metadata.planPaidMicros, row.metadata.creditPaidMicros])).toEqual([
    [3 * M, 0],
    [0, 2 * M],
    [plan - 3 * M, 4 * M],
  ]);
}, 180_000);

test("paid funding already spent on fees is not reused, and a retried fee debits once", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "grant", 100 * M);
  await credit(accountId, "manual_credit_grant", 10 * M);
  expect(await spendable(accountId, "api")).toBe(10 * M);

  const key = crypto.randomUUID();
  await fee(accountId, 4 * M, "api", key);
  await fee(accountId, 4 * M, "api", key);
  expect(await feeRows(accountId)).toHaveLength(1);
  // 100 promotional + 6 paid remain as credits, but only the 6 paid pay fees.
  expect(await spendable(accountId, "api")).toBe(6 * M);

  await credit(accountId, "credit_refund", -6 * M);
  expect(await spendable(accountId, "app")).toBe(0);
}, 180_000);

test("parallel fees past paid credit become debt the next top-up repays, never promotional credit", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "grant", 25 * M); // unscoped promotional credit
  await credit(accountId, "credit_topup", 1);
  const start = await balanceOf(accountId);
  expect(start.paidCreditsMicros).toBe(1);
  // Five calls admitted on the same 1 micro of paid credit settle at once.
  await Promise.all(Array.from({ length: 5 }, () => fee(accountId, M, "app")));
  const after = await balanceOf(accountId);
  expect(after.paidCreditsMicros).toBe(0);
  expect(after.byokFeeDebtMicros).toBe(5 * M - 1);
  expect(await spendable(accountId, "app")).toBe(0);
  // The promotional credit still pays for app and API work in full; only
  // the 1 micro of paid credit went to fees.
  expect(spendableCreditMicros(after, undefined, "app")).toBe(
    spendableCreditMicros(start, undefined, "app") - 1,
  );
  expect(spendableCreditMicros(after, undefined, "api")).toBe(25 * M);
  const rows = await feeRows(accountId);
  expect(rows.reduce((sum, row) => sum + row.metadata.creditPaidMicros!, 0)).toBe(1);
  expect(rows.reduce((sum, row) => sum + row.metadata.unfundedMicros!, 0)).toBe(5 * M - 1);
  // A top-up repays the fee debt before it pays new fees.
  await credit(accountId, "credit_topup", 10 * M);
  const repaid = await balanceOf(accountId);
  expect(repaid.byokFeeDebtMicros).toBeUndefined();
  expect(repaid.paidCreditsMicros).toBe(5 * M + 1);
}, 180_000);

test("an own-key fee settles only through applyByokPlatformFeeDebit", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await expect(
    applyCreditDebitAfterUse(client.db, {
      accountId,
      type: "byok_platform_fee",
      amountMicros: M,
      sourceType: "model_response",
      sourceId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toThrow("applyByokPlatformFeeDebit");
}, 180_000);

test("spent paid credit stays spent: a later promotional grant never pays the fee", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 10 * M);
  await usage(accountId, 10 * M, "api");
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(0);
  // A free coupon with no offer scope is an unscoped grant.
  await credit(accountId, "grant", 10 * M);
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(10 * M);
  expect(balance.paidCreditsMicros).toBe(0);
  expect(await spendable(accountId, "api")).toBe(0);
  await fee(accountId, 2 * M, "api");
  const [row] = await feeRows(accountId);
  expect(row!.metadata.creditPaidMicros).toBe(0);
  expect(row!.metadata.unfundedMicros).toBe(2 * M);
  // The coupon still pays for ordinary API use, never the fee debt.
  const after = await balanceOf(accountId);
  expect(after.byokFeeDebtMicros).toBe(2 * M);
  expect(spendableCreditMicros(after, undefined, "api")).toBe(10 * M);
}, 180_000);

test("ordinary spending draws promotional credit before paid credit", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "grant", 10 * M);
  await credit(accountId, "credit_topup", 10 * M);
  await usage(accountId, 12 * M, "api");
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(8 * M);
  expect(balance.paidCreditsMicros).toBe(8 * M);
}, 180_000);

test("fee debt is never repaid by plan credit, only by the next top-up", async () => {
  if (!client || !shared) return;
  const userId = crypto.randomUUID();
  const accountId = (await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Plan owner",
  }))!.defaultAccountId!;
  await fee(accountId, 2 * M, "app");
  expect((await balanceOf(accountId)).byokFeeDebtMicros).toBe(2 * M);
  // Subscribing to Pro: the new period opens in full; the fee debt waits for paid-for credit.
  const periodStart = new Date(Date.now() - 500);
  const periodEnd = new Date(Date.now() + 3_600_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  await upsertOrganizationPlan(client.db, {
    accountId,
    planKey: "pro",
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    stripeSubscriptionId,
  });
  await grantPlanCreditPeriod(client.db, {
    accountId,
    planKey: "pro",
    periodStart,
    periodEnd,
    stripeSubscriptionId,
  });
  const [period] = await shared.admin<{ openingDebt: string; granted: string }[]>`
    select opening_debt_micros::text "openingDebt", granted_micros::text granted
    from plan_credit_periods where account_id = ${accountId}::uuid and plan_key = 'pro'`;
  expect(Number(period!.openingDebt)).toBe(0);
  const granted = Number(period!.granted);
  const balance = await balanceOf(accountId);
  expect(balance.byokFeeDebtMicros).toBe(2 * M);
  expect(balance.creditsMicros).toBe(-2 * M);
  expect(balance.plan!.creditRemainingMicros).toBe(granted);
  expect(spendableCreditMicros(balance, undefined, "api")).toBe(0);
  expect(spendableCreditMicros(balance, undefined, "app")).toBe(granted);
  // The next top-up repays the fee debt first, once.
  await credit(accountId, "credit_topup", 10 * M);
  const repaid = await balanceOf(accountId);
  expect(repaid.byokFeeDebtMicros).toBeUndefined();
  expect(repaid.paidCreditsMicros).toBe(8 * M);
  expect(await spendable(accountId, "api")).toBe(8 * M);
  await credit(accountId, "credit_topup", 1 * M);
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(9 * M);
}, 180_000);

/** The account's open plan period. */
async function openPeriod(accountId: string) {
  const [row] = await shared!.admin<{ id: string; openingDebt: string; granted: string }[]>`
    select id, opening_debt_micros::text "openingDebt", granted_micros::text granted
    from plan_credit_periods where account_id = ${accountId}::uuid and expired_at is null`;
  return { id: row!.id, openingDebt: Number(row!.openingDebt), granted: Number(row!.granted) };
}
/** Expire the open Pro period and open the next one. */
async function renew(accountId: string) {
  await expirePlanCreditPeriod(client!.db, {
    accountId,
    periodId: (await openPeriod(accountId)).id,
    force: true,
  });
  const periodStart = new Date(Date.now() - 500);
  const periodEnd = new Date(Date.now() + 3_600_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  await upsertOrganizationPlan(client!.db, {
    accountId,
    planKey: "pro",
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    stripeSubscriptionId,
  });
  await grantPlanCreditPeriod(client!.db, {
    accountId,
    planKey: "pro",
    periodStart,
    periodEnd,
    stripeSubscriptionId,
  });
  return await openPeriod(accountId);
}

test("app and database agree on debt after an API own-key fee: renewal never re-deducts it", async () => {
  if (!client || !shared) return;
  // Reviewer's blocker probe: $5 top-up spent on an API own-key fee, then
  // app use $2 past the plan.
  const accountId = await account("pro");
  const plan = (await openPeriod(accountId)).granted;
  await credit(accountId, "credit_topup", 5 * M);
  expect((await fee(accountId, 5 * M, "api")).creditPaidMicros).toBe(5 * M);
  await usage(accountId, plan + 2 * M, "app");
  const owing = await balanceOf(accountId);
  expect(owing.creditsMicros).toBe(-2 * M);
  // A fee paid in full is not debt (probe E): the $2 is an app overdraft.
  expect(owing.apiDebtMicros).toBeUndefined();
  expect(owing.byokFeeDebtMicros).toBeUndefined();
  expect(spendableCreditMicros(owing, undefined, "app")).toBe(0);
  // The next period nets it once, and the app agrees with the database.
  let next = await renew(accountId);
  expect(next.openingDebt).toBe(2 * M);
  let balance = await balanceOf(accountId);
  expect(balance.plan!.creditRemainingMicros).toBe(plan - 2 * M);
  expect(balance.creditsMicros).toBe(0);
  expect(spendableCreditMicros(balance, undefined, "app")).toBe(plan - 2 * M);
  // Never again: the following period opens in full.
  next = await renew(accountId);
  expect(next.openingDebt).toBe(0);
  balance = await balanceOf(accountId);
  expect(balance.plan!.creditRemainingMicros).toBe(plan);
  expect(spendableCreditMicros(balance, undefined, "app")).toBe(plan);
  expect(spendableCreditMicros(balance, undefined, "api")).toBe(0);
}, 180_000);

test("unpaid fee debt stays out of plan credit at renewal; paid fees never do", async () => {
  if (!client || !shared) return;
  const accountId = await account("pro");
  const plan = (await openPeriod(accountId)).granted;
  // $3 of API fees with no paid credit: fee debt. Then $1 past the plan in app use.
  expect((await fee(accountId, 3 * M, "api")).unfundedMicros).toBe(3 * M);
  await usage(accountId, plan + 1 * M, "app");
  const owing = await balanceOf(accountId);
  expect(owing.creditsMicros).toBe(-4 * M);
  expect(owing.byokFeeDebtMicros).toBe(3 * M);
  // The fee debt waits for a top-up; only the app overdraft is netted.
  const next = await renew(accountId);
  expect(next.openingDebt).toBe(1 * M);
  const balance = await balanceOf(accountId);
  expect(balance.plan!.creditRemainingMicros).toBe(plan - 1 * M);
  expect(balance.creditsMicros).toBe(-3 * M);
  expect(balance.byokFeeDebtMicros).toBe(3 * M);
  expect(spendableCreditMicros(balance, undefined, "app")).toBe(plan - 1 * M);
}, 180_000);

test("app spending a paid plan covers never spends paid credit (probe A)", async () => {
  if (!client || !shared) return;
  const accountId = await account("pro");
  const plan = (await openPeriod(accountId)).granted;
  await credit(accountId, "grant", 5 * M); // unscoped promotional credit
  await credit(accountId, "credit_topup", 10 * M);
  // $10 of app use beyond the plan: the promotional $5 goes first.
  await usage(accountId, plan + 10 * M, "app");
  const before = await balanceOf(accountId);
  expect(before.plan!.creditRemainingMicros).toBe(0);
  expect(before.creditsMicros).toBe(5 * M);
  expect(before.paidCreditsMicros).toBe(5 * M);
  expect(await spendable(accountId, "app")).toBe(5 * M);
  const funding = await fee(accountId, 3 * M, "app");
  expect(funding).toMatchObject({ planPaidMicros: 0, creditPaidMicros: 3 * M, unfundedMicros: 0 });
  const after = await balanceOf(accountId);
  expect(after.byokFeeDebtMicros).toBeUndefined();
  expect(after.paidCreditsMicros).toBe(2 * M);
  expect(spendableCreditMicros(after, undefined, "app")).toBe(2 * M);
  expect(spendableCreditMicros(after, undefined, "api")).toBe(2 * M);
}, 180_000);

test("a plan that is not active never pays a fee, and the fee is charged once (probe B)", async () => {
  if (!client || !shared) return;
  const accountId = await account("pro");
  const period = await shared.admin<{ start: Date; end: Date; sub: string }[]>`
    select period_start start, period_end "end", stripe_subscription_id sub
    from plan_credit_periods where account_id = ${accountId}::uuid and expired_at is null`;
  // Past due in the middle of a paid period.
  await upsertOrganizationPlan(client.db, {
    accountId,
    planKey: "pro",
    status: "past_due",
    currentPeriodStart: new Date(period[0]!.start),
    currentPeriodEnd: new Date(period[0]!.end),
    stripeSubscriptionId: period[0]!.sub,
  });
  await credit(accountId, "credit_topup", 10 * M);
  const before = await balanceOf(accountId);
  expect(before.paidPlanCreditMicros).toBe(0);
  const plan = before.plan!.creditRemainingMicros;
  expect(plan).toBeGreaterThan(0);
  expect(before.paidCreditsMicros).toBe(10 * M);
  expect(await fee(accountId, 3 * M, "app")).toMatchObject({
    planPaidMicros: 0,
    creditPaidMicros: 3 * M,
  });
  const after = await balanceOf(accountId);
  // Charged once: to paid credits, not also to the plan.
  expect(after.plan!.creditRemainingMicros).toBe(plan);
  expect(after.creditsMicros).toBe(7 * M);
  expect(after.paidCreditsMicros).toBe(7 * M);
}, 180_000);

test("a refunded usage debit the plan covered leaves paid credit whole (probe D)", async () => {
  if (!client || !shared) return;
  const accountId = await account("pro");
  await credit(accountId, "credit_topup", 10 * M);
  const sourceId = crypto.randomUUID();
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "video_generation_debit",
    amountMicros: 4 * M,
    sourceType: "video_generation_operation",
    sourceId,
    idempotencyKey: crypto.randomUUID(),
    usageOrigin: "app",
  });
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "video_generation_refund",
    amountMicros: 4 * M,
    sourceType: "video_generation_operation",
    sourceId,
    idempotencyKey: crypto.randomUUID(),
  });
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(10 * M);
  expect(balance.paidCreditsMicros).toBe(10 * M);
}, 180_000);

test("a refunded usage debit that drew paid credit returns it as paid credit", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "grant", 2 * M); // unscoped promotional credit
  await credit(accountId, "credit_topup", 10 * M);
  const sourceId = crypto.randomUUID();
  // $5 of API use: the promotional $2, then $3 of paid credit.
  await applyCreditDebitAfterUse(client.db, {
    accountId,
    type: "video_generation_debit",
    amountMicros: 5 * M,
    sourceType: "video_generation_operation",
    sourceId,
    idempotencyKey: crypto.randomUUID(),
    usageOrigin: "api",
  });
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(7 * M);
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "video_generation_refund",
    amountMicros: 5 * M,
    sourceType: "video_generation_operation",
    sourceId,
    idempotencyKey: crypto.randomUUID(),
  });
  // Never more paid credit than was paid for.
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(12 * M);
  expect(balance.paidCreditsMicros).toBeLessThanOrEqual(10 * M);
  expect(balance.paidCreditsMicros).toBeGreaterThanOrEqual(7 * M);
}, 180_000);

test("a coupon's discount on a top-up is promotional credit, never paid credit", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  // $20 of credit for $10: half of it was the coupon's discount.
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "credit_topup",
    amountMicros: 20 * M,
    idempotencyKey: crypto.randomUUID(),
    metadata: { stripeAmountTotalCents: 1000, stripeDiscountCents: 1000 },
  });
  const start = await balanceOf(accountId);
  expect(start.creditsMicros).toBe(20 * M);
  expect(start.paidCreditsMicros).toBe(10 * M);
  expect(await spendable(accountId, "api")).toBe(10 * M);
  // Ordinary spending draws the discount first.
  await usage(accountId, 5 * M, "api");
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(10 * M);
  await usage(accountId, 10 * M, "api");
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(5 * M);
}, 180_000);

test("a top-up repays fee debt before API debt", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  expect((await fee(accountId, 3 * M, "api")).unfundedMicros).toBe(3 * M);
  await usage(accountId, 2 * M, "api");
  const owing = await balanceOf(accountId);
  expect(owing.byokFeeDebtMicros).toBe(3 * M);
  expect(owing.apiDebtMicros).toBe(2 * M);
  await credit(accountId, "credit_topup", 4 * M);
  const after = await balanceOf(accountId);
  expect(after.byokFeeDebtMicros).toBeUndefined();
  expect(after.apiDebtMicros).toBe(1 * M);
  expect(after.paidCreditsMicros).toBe(0);
}, 180_000);

test("repaid fee debt stays repaid: a later clawback is never fee debt", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 10 * M);
  expect((await fee(accountId, 12 * M, "api")).unfundedMicros).toBe(2 * M);
  await credit(accountId, "credit_topup", 5 * M);
  expect((await balanceOf(accountId)).byokFeeDebtMicros).toBeUndefined();
  // The second top-up is refunded through Stripe after it repaid the debt.
  await credit(accountId, "credit_refund", -5 * M);
  await credit(accountId, "grant", 1 * M); // promotional credit
  const after = await balanceOf(accountId);
  expect(after.creditsMicros).toBe(-1 * M);
  expect(after.byokFeeDebtMicros).toBeUndefined();
  expect(after.paidCreditsMicros).toBe(0);
}, 180_000);

test("rows an older release writes during the rollout never zero paid credit (probe H)", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 3 * M); // with a receipt
  // The previous release writes a top-up and an unscoped grant, no receipts.
  await shared.admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
    values (${accountId}::uuid, 'credit_topup', ${5 * M}, ${crypto.randomUUID()})`;
  await shared.admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
    values (${accountId}::uuid, 'grant', ${2 * M}, ${crypto.randomUUID()})`;
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(10 * M);
  // At most the $2 grant is unpaid.
  expect(balance.paidCreditsMicros).toBe(8 * M);
  // The next receipt keeps it.
  expect((await fee(accountId, 1 * M, "api")).creditPaidMicros).toBe(1 * M);
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(7 * M);
  // Spending still draws the unpaid $2 first.
  await usage(accountId, 3 * M, "api");
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(6 * M);
}, 180_000);

test("the balance read never touches an ordinary debit's metadata", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 10 * M);
  // Receipt-shaped keys on a debit would fail the read if it parsed them.
  const junk = {
    paidCreditMicros: "x",
    paidFundingBeforeMicros: "x",
    paidCreditsBeforeMicros: "x",
    feeDebtRepaidMicros: "x",
    unfundedMicros: "x",
  };
  await shared.admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, source_type, source_id,
      usage_origin, idempotency_key, metadata)
    values (${accountId}::uuid, 'model_usage_debit', ${-1 * M}, 'model_response', ${crypto.randomUUID()},
      'api', ${crypto.randomUUID()}, ${shared.admin.json(junk)})`;
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(9 * M);
  expect(balance.paidCreditsMicros).toBe(9 * M);
  expect(await spendable(accountId, "api")).toBe(9 * M);
}, 180_000);

/**
 * Ledger rows the work reads, from this transaction's statistics: rows
 * sequential scans return plus index entries index scans read. `indexed`
 * turns sequential scans off, so a small test ledger is read the way a large
 * one is.
 */
async function ledgerRowsRead(work: (db: DbClient["db"]) => Promise<unknown>, indexed = false) {
  return await client!.db.transaction(async (tx) => {
    const db = tx as unknown as DbClient["db"];
    if (indexed) await tx.execute(sql`set local enable_seqscan = off`);
    const count = async () => {
      const [row] = (await tx.execute(sql`
        select sum(pg_stat_get_xact_tuples_returned(c.oid))::text n from pg_class c
        where c.oid = 'credit_ledger_entries'::regclass or c.oid in (
          select indexrelid from pg_index where indrelid = 'credit_ledger_entries'::regclass)`)) as unknown as {
        n: string;
      }[];
      return Number(row!.n);
    };
    const before = await count();
    await work(db);
    return (await count()) - before;
  });
}

test("paid credit and fee debt are read from the latest receipt, not from every fee", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 10 * M);
  expect((await fee(accountId, 12 * M, "api")).unfundedMicros).toBe(2 * M);
  await credit(accountId, "credit_topup", 100 * M);
  // An own-key-only account: every response writes just a fee row.
  const fees = 200;
  for (let i = 0; i < fees; i += 1) await fee(accountId, 1_000, i % 2 ? "app" : "api");
  // One pass over the ledger for the balance; the paid-credit figures come
  // from the latest receipt alone, whatever the number of fees before it.
  const rows = fees + 3;
  // Fresh statistics: the planner can't estimate the receipt filter, and
  // with them it used to read and sort every receipt to find the latest.
  await shared.admin`analyze credit_ledger_entries`;
  for (const read of [
    (db: DbClient["db"]) => getByokFeeSpendableBalance(db, accountId, "api"),
    (db: DbClient["db"]) => getBillingBalance(db, accountId),
  ]) {
    const tuples = await ledgerRowsRead(read, true);
    expect(tuples).toBeGreaterThanOrEqual(rows);
    expect(tuples).toBeLessThan(rows + 10);
  }
  const balance = await balanceOf(accountId);
  expect(balance.paidCreditsMicros).toBe(98 * M - fees * 1_000);
  expect(balance.byokFeeDebtMicros).toBeUndefined();
  expect(balance.byokPlatformFeeMonthMicros).toBe(12 * M + fees * 1_000);
}, 180_000);

test("a receipt's running totals equal a full recount of the ledger", async () => {
  if (!client || !shared) return;
  const accountId = await account("pro");
  await credit(accountId, "credit_topup", 3 * M);
  await credit(accountId, "grant", 2 * M);
  await fee(accountId, 4 * M, "api"); // $1 unfunded
  await applyCreditLedgerEntry(client.db, {
    accountId,
    type: "credit_topup",
    amountMicros: 10 * M,
    idempotencyKey: crypto.randomUUID(),
    metadata: { stripeAmountTotalCents: 500, stripeDiscountCents: 500 },
  });
  await usage(accountId, 6 * M, "api");
  await credit(accountId, "credit_refund", -1 * M);
  await fee(accountId, 2 * M, "app");
  // An older release's rows after the latest receipt, then a receipt folding them in.
  await shared.admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
    values (${accountId}::uuid, 'credit_topup', ${4 * M}, ${crypto.randomUUID()}),
      (${accountId}::uuid, 'grant', ${1 * M}, ${crypto.randomUUID()})`;
  const before = await balanceOf(accountId);
  await fee(accountId, 1 * M, "api");
  const [latest] = await shared.admin<{ chain: Record<string, number | string | null> }[]>`
    select metadata->'paidCreditTotals' chain from credit_ledger_entries
    where account_id = ${accountId} and type = 'byok_platform_fee'
    order by created_at desc limit 1`;
  const [recount] = await shared.admin<Record<string, string>[]>`
    select
      count(*) filter (where metadata ? 'paidCreditTotals')::text n,
      coalesce(sum(case
        when metadata ? 'paidCreditMicros' then (metadata->>'paidCreditMicros')::bigint
        when type = 'byok_platform_fee' then -coalesce((metadata->>'creditPaidMicros')::bigint, 0)
        when type in ('credit_topup', 'manual_credit_grant', 'credit_dispute_release') then amount_micros
        else 0 end), 0)::text "paidPart",
      coalesce(sum((metadata->>'feeDebtRepaidMicros')::bigint), 0)::text repaid,
      coalesce(sum((metadata->>'unfundedMicros')::bigint) filter (where type = 'byok_platform_fee'), 0)::text unfunded,
      min((metadata->>'paidCreditsBeforeMicros')::bigint + coalesce((metadata->>'paidRestoredMicros')::bigint, 0)
        - (metadata->>'paidFundingBeforeMicros')::bigint)::text "markFloor",
      coalesce(sum(-amount_micros) filter (where type = 'byok_platform_fee'), 0)::text fees
    from credit_ledger_entries
    where account_id = ${accountId}
      and (amount_micros > 0 or type in ('credit_refund', 'credit_dispute_hold', 'byok_platform_fee'))`;
  const chain = latest!.chain;
  expect(chain.n).toBe(Number(recount!.n));
  expect(chain.paidPart).toBe(Number(recount!.paidPart));
  expect(chain.repaid).toBe(Number(recount!.repaid));
  expect(chain.unfunded).toBe(Number(recount!.unfunded));
  expect(chain.markFloor).toBe(Number(recount!.markFloor));
  expect(chain.feesInMonth).toBe(Number(recount!.fees));
  // Paid inflows: $3, $5 of the coupon top-up, and the older release's $4.
  expect(chain.paidInflow).toBe(12 * M);
  // The older release's $4 top-up repaid the $1 of fee debt first.
  expect(before.byokFeeDebtMicros).toBeUndefined();
  const after = await balanceOf(accountId);
  expect(after.byokFeeDebtMicros).toBeUndefined();
  expect(after.paidCreditsMicros).toBe(before.paidCreditsMicros! - 1 * M);
}, 180_000);

test("a database clock that steps back never hides a receipt from the running totals", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 10 * M);
  await fee(accountId, 1 * M, "api");
  // The fee was stamped by a host whose clock ran ten minutes ahead; the
  // writes below use the normal clock again.
  await shared.admin`
    update credit_ledger_entries set created_at = created_at + interval '10 minutes'
    where account_id = ${accountId} and type = 'byok_platform_fee'`;
  await credit(accountId, "credit_topup", 5 * M);
  await credit(accountId, "grant", 2 * M);
  await fee(accountId, 2 * M, "api");
  const balance = await balanceOf(accountId);
  expect(balance.creditsMicros).toBe(14 * M);
  // $15 topped up less $3 of fees; the $2 grant is unpaid.
  expect(balance.paidCreditsMicros).toBe(12 * M);
  expect(balance.byokPlatformFeeMonthMicros).toBe(3 * M);
  const [latest] = await shared.admin<{ chain: Record<string, number | string | null> }[]>`
    select metadata->'paidCreditTotals' chain from credit_ledger_entries
    where account_id = ${accountId} and metadata ? 'paidCreditTotals'
    order by created_at desc, (metadata->'paidCreditTotals'->'n') desc limit 1`;
  expect(latest!.chain.n).toBe(5);
  expect(latest!.chain.paidPart).toBe(12 * M);
  expect(latest!.chain.paidInflow).toBe(15 * M);
  expect(latest!.chain.feesInMonth).toBe(3 * M);
  // Every receipt is stamped after the one before it.
  const [order] = await shared.admin<{ ordered: boolean }[]>`
    select bool_and(created_at > previous) ordered from (
      select created_at, lag(created_at) over (order by (metadata->'paidCreditTotals'->>'n')::int) previous
      from credit_ledger_entries where account_id = ${accountId} and metadata ? 'paidCreditTotals') receipts
    where previous is not null`;
  expect(order!.ordered).toBe(true);
}, 180_000);

test("fee reads and settlement read the ledger once, even after an unfunded fee", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await credit(accountId, "credit_topup", 10 * M);
  // An unfunded fee, repaid by the next top-up.
  expect((await fee(accountId, 12 * M, "api")).unfundedMicros).toBe(2 * M);
  await credit(accountId, "credit_topup", 1_000 * M);
  const rows = 3_000;
  await shared.admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, source_type, source_id,
      usage_origin, idempotency_key)
    select ${accountId}::uuid, 'model_usage_debit', -1, 'model_response', gen_random_uuid()::text,
      'api', gen_random_uuid()::text
    from generate_series(1, ${rows})`;
  const plain = await ledgerRowsRead((db) => getBillingBalance(db, accountId));
  const feeRead = await ledgerRowsRead((db) => getByokFeeSpendableBalance(db, accountId, "api"));
  const settle = await ledgerRowsRead((db) => fee(accountId, M, "api", undefined, db));
  expect(plain).toBeGreaterThanOrEqual(rows);
  // No second pass over the ledger for paid credit, and no trailing balance read.
  expect(feeRead).toBeLessThan(plain + rows / 2);
  expect(settle).toBeLessThan(plain + rows / 2);
}, 180_000);
