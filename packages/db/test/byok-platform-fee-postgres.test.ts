import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyCreditDebitAfterUse,
  applyCreditLedgerEntry,
  completeSelfServiceOrganizationSetup,
  createDb,
  ensureManagedAccessForUser,
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
const fee = (accountId: string, amountMicros: number, origin: "app" | "api", key?: string) =>
  applyCreditDebitAfterUse(client!.db, {
    accountId,
    type: "byok_platform_fee",
    amountMicros,
    sourceType: "model_response",
    sourceId: key ?? crypto.randomUUID(),
    idempotencyKey: key ? `credit:byok_platform_fee:${key}` : crypto.randomUUID(),
    usageOrigin: origin,
    byokPlatformFee: true,
  });
// Fee reads also walk the ledger for paid credits.
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

test("an own-key fee must be a general byok_platform_fee debit", async () => {
  if (!client || !shared) return;
  const accountId = await account("free");
  await expect(
    applyCreditDebitAfterUse(client.db, {
      accountId,
      type: "model_usage_debit",
      amountMicros: M,
      sourceType: "model_response",
      sourceId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      byokPlatformFee: true,
    }),
  ).rejects.toThrow("byok_platform_fee");
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

test("fee debt a paid plan absorbs when its period opens is repaid once", async () => {
  if (!client || !shared) return;
  const userId = crypto.randomUUID();
  const accountId = (await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Plan owner",
  }))!.defaultAccountId!;
  await fee(accountId, 2 * M, "app");
  expect((await balanceOf(accountId)).byokFeeDebtMicros).toBe(2 * M);
  // Subscribing to Pro: the new period's credit opens net of the debt.
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
  expect(Number(period!.openingDebt)).toBe(2 * M);
  const balance = await balanceOf(accountId);
  expect(balance.byokFeeDebtMicros).toBeUndefined();
  expect(balance.creditsMicros).toBe(0);
  expect(balance.plan!.creditRemainingMicros).toBe(Number(period!.granted) - 2 * M);
  expect(spendableCreditMicros(balance, undefined, "api")).toBe(0);
  expect(spendableCreditMicros(balance, undefined, "app")).toBe(Number(period!.granted) - 2 * M);
  // A later top-up is all paid credit; nothing is repaid twice.
  await credit(accountId, "credit_topup", 10 * M);
  expect((await balanceOf(accountId)).paidCreditsMicros).toBe(10 * M);
  expect(await spendable(accountId, "api")).toBe(10 * M);
}, 180_000);
