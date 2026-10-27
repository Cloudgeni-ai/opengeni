import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  ensureManagedAccessForUser,
  createDb,
  expirePlanCreditPeriod,
  getBillingBalance,
  getSpendableCreditBalance,
  freePlanCreditEligible,
  withAccountRls,
  nestedPostgresSqlState,
  grantPlanCreditPeriod,
  replacePlanCreditPeriod,
  spendableCreditMicros,
  upsertOrganizationPlan,
  type DbClient,
  type PlanCreditPeriodInput,
} from "../src";

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;
beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("free-plan-credits");
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

async function owner(scoped = true) {
  // This suite exercises preserved legacy trial balances alongside new monthly
  // grants. New signups now have only a zero-value eligibility receipt (0845).
  const user = crypto.randomUUID();
  await shared!
    .admin`insert into auth_users(id,name,email,email_verified) values (${user},'Free owner',${`${user}@example.test`},true)`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId: user,
    email: `${user}@example.test`,
    name: "Legacy trial owner",
  });
  const accountId = access.defaultAccountId!;
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    type: "grant",
    amountMicros: 10 * M,
    sourceType: "verified_signup_trial",
    sourceId: user,
    idempotencyKey: `verified-signup-trial:v1:${user}`,
    ...(scoped ? { eligibleModelIds: ["model-a"] } : {}),
  });
  return accountId;
}
async function state(
  accountId: string,
  planKey = "free",
  periodEnd = new Date(Date.now() + 3_600_000),
) {
  const input: PlanCreditPeriodInput = {
    accountId,
    planKey,
    periodStart: new Date(Date.now() - 1000),
    periodEnd,
    ...(planKey === "free" ? {} : { stripeSubscriptionId: `sub_${crypto.randomUUID()}` }),
  };
  await upsertOrganizationPlan(client!.db, {
    ...input,
    status: "active",
    currentPeriodStart: input.periodStart,
    currentPeriodEnd: input.periodEnd,
  });
  return input;
}
const charge = (
  accountId: string,
  amountMicros: number,
  modelId?: string,
  key = crypto.randomUUID(),
) =>
  applyCreditDebitUpToBalance(client!.db, {
    accountId,
    requestedAmountMicros: amountMicros,
    ...(modelId ? { modelId } : {}),
    type: "model_debit",
    idempotencyKey: key,
  });
const ledger = (
  accountId: string,
  amountMicros: number,
  type = "credit_topup",
  sourceId?: string,
) =>
  applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros,
    type,
    sourceType: "test",
    sourceId: sourceId ?? null,
    idempotencyKey: crypto.randomUUID(),
  });

test("Free is allocated first only for covered models; concurrency and replay cannot double spend", async () => {
  if (!client || !shared) return;
  const id = await owner();
  const input = await state(id);
  const grants = await Promise.all(
    Array.from({ length: 4 }, () => grantPlanCreditPeriod(client!.db, input)),
  );
  expect(new Set(grants.map((g) => g.id)).size).toBe(1);
  let balance = await getBillingBalance(client.db, id);
  expect(balance.generalBalanceMicros).toBe(0);
  expect(balance.plan).toMatchObject({ creditScoped: true, creditRemainingMicros: 10 * M });
  expect(spendableCreditMicros(balance, "claude-opus")).toBe(0);
  expect(spendableCreditMicros(balance)).toBe(0);
  expect((await charge(id, M, "claude-opus")).debitedMicros).toBe(0);
  const first = await charge(id, 6 * M, "model-a");
  expect(first.balance.plan?.creditRemainingMicros).toBe(4 * M);
  expect(first.balance.promotionalCredits?.find((g) => !g.planCredit)?.remainingMicros).toBe(
    10 * M,
  );
  const keys = Array.from({ length: 4 }, () => crypto.randomUUID());
  const results = await Promise.all(keys.map((key) => charge(id, 4 * M, "model-a", key)));
  expect(results.reduce((sum, r) => sum + r.debitedMicros, 0)).toBe(14 * M);
  for (const key of keys) expect((await charge(id, 4 * M, "model-a", key)).debitedMicros).toBe(0);
  balance = await getBillingBalance(client.db, id);
  expect(balance.balanceMicros).toBe(0);
  expect(balance.plan?.creditRemainingMicros).toBe(0);
}, 180_000);

test("Free does not absorb opening debt, uncovered post-use debt, disputes or reversals", async () => {
  if (!client) return;
  const id = await owner();
  await ledger(id, -3 * M, "credit_dispute_hold");
  const grant = await grantPlanCreditPeriod(client.db, await state(id));
  expect(grant.opening_debt_micros).toBe(0);
  await applyCreditDebitAfterUse(client.db, {
    accountId: id,
    type: "model_debit",
    amountMicros: 2 * M,
    usage: "claude-opus",
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  await applyCreditDebitAfterUse(client.db, {
    accountId: id,
    type: "model_debit",
    amountMicros: 4 * M,
    usage: "model-a",
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  let balance = await getBillingBalance(client.db, id);
  expect(balance).toMatchObject({
    generalBalanceMicros: -5 * M,
    plan: { creditRemainingMicros: 6 * M },
  });
  expect(spendableCreditMicros(balance, "claude-opus")).toBe(0);
  await ledger(id, 3 * M, "credit_dispute_release");
  await ledger(id, 7 * M);
  await ledger(id, -M, "credit_refund");
  await expirePlanCreditPeriod(client.db, { accountId: id, periodId: grant.id, force: true });
  balance = await getBillingBalance(client.db, id);
  expect(balance.generalBalanceMicros).toBe(4 * M);
  expect(balance.promotionalCredits?.map((g) => g.remainingMicros)).toEqual([10 * M]);
  expect(balance.balanceMicros).toBe(14 * M);
}, 180_000);

test("pending and settled expiry agree, preserve debt and promotions, and never refill on replay", async () => {
  if (!client || !shared) return;
  const id = await owner();
  const input = await state(id);
  const grant = await grantPlanCreditPeriod(client.db, input);
  await charge(id, 3 * M, "model-a");
  await ledger(id, -5 * M, "credit_dispute_hold");
  // Fixture clock cutover, after all charges, without waiting a wall-clock month.
  await shared.admin`update plan_credit_periods set period_end = clock_timestamp() where id = ${grant.id}`;
  const pending = await getBillingBalance(client.db, id);
  expect(pending).toMatchObject({
    balanceMicros: 5 * M,
    generalBalanceMicros: -5 * M,
    plan: { creditRemainingMicros: 0, creditPendingExpiryMicros: 7 * M },
  });
  expect(pending.promotionalCredits?.map((g) => g.remainingMicros)).toEqual([10 * M]);
  const expired = await expirePlanCreditPeriod(client.db, { accountId: id, periodId: grant.id });
  expect(expired.usage_at_expiry_micros).toBe(3 * M);
  expect((await getBillingBalance(client.db, id)).balanceMicros).toBe(pending.balanceMicros);
  await ledger(id, 20 * M);
  await expirePlanCreditPeriod(client.db, { accountId: id, periodId: grant.id });
  expect((await getBillingBalance(client.db, id)).balanceMicros).toBe(25 * M);
}, 180_000);

test("Free upgrades to Pro or Max replace allowance; paid models stay general and downgrade is scoped", async () => {
  if (!client) return;
  for (const [key, amount] of [
    ["pro", 200],
    ["max", 2000],
  ] as const) {
    const id = await owner();
    const free = await state(id);
    await grantPlanCreditPeriod(client.db, free);
    await charge(id, 2 * M, "model-a");
    const paid = await state(id, key);
    const replacement = await replacePlanCreditPeriod(client.db, paid);
    expect((await replacePlanCreditPeriod(client.db, paid)).id).toBe(replacement.id);
    let balance = await getBillingBalance(client.db, id);
    expect(balance).toMatchObject({
      generalBalanceMicros: amount * M,
      balanceMicros: (amount + 10) * M,
      plan: { creditScoped: false, creditRemainingMicros: amount * M },
    });
    expect((await charge(id, M, "claude-opus")).debitedMicros).toBe(M);
    await expirePlanCreditPeriod(client.db, {
      accountId: id,
      periodId: replacement.id,
      force: true,
    });
    await upsertOrganizationPlan(client.db, {
      ...free,
      status: "active",
      currentPeriodStart: free.periodStart,
      currentPeriodEnd: free.periodEnd,
    });
    // Downgrade inside the original Free month replays its expired receipt.
    const replay = await grantPlanCreditPeriod(client.db, free);
    expect(replay.expired_at).not.toBeNull();
    balance = await getBillingBalance(client.db, id);
    expect(balance.generalBalanceMicros).toBe(0);
    expect(balance.balanceMicros).toBe(10 * M);
  }
  // A paid-only account returning to Free gets a fresh scoped grant.
  const id = await owner();
  const paid = await grantPlanCreditPeriod(client.db, await state(id, "pro"));
  await expirePlanCreditPeriod(client.db, { accountId: id, periodId: paid.id, force: true });
  await grantPlanCreditPeriod(client.db, await state(id));
  expect((await getBillingBalance(client.db, id)).plan?.creditScoped).toBe(true);
}, 180_000);

test("video refunds during and after a scoped period remain purchased general funds", async () => {
  if (!client) return;
  const id = await owner();
  const period = await grantPlanCreditPeriod(client.db, await state(id));
  await ledger(id, 10 * M);
  const source = crypto.randomUUID();
  await ledger(id, -6 * M, "video_generation_debit", source);
  await ledger(id, 2 * M, "video_generation_refund", source);
  expect((await getBillingBalance(client.db, id)).plan?.creditRemainingMicros).toBe(10 * M);
  await expirePlanCreditPeriod(client.db, { accountId: id, periodId: period.id, force: true });
  await ledger(id, 4 * M, "video_generation_refund", source);
  expect((await getBillingBalance(client.db, id)).generalBalanceMicros).toBe(10 * M);
}, 180_000);

test("missing scope refuses new Free funding, legacy receipts stay general, live policy follows signup overrides", async () => {
  if (!client || !shared) return;
  const id = await owner(false);
  const input = await state(id);
  let missingPolicy: unknown;
  try {
    await grantPlanCreditPeriod(client.db, input);
  } catch (error) {
    missingPolicy = error;
  }
  expect(nestedPostgresSqlState(missingPolicy)).toBe("55000");
  // Legacy in-period fixture: a pre-migration grant and period, never rewritten.
  const [grant] =
    await shared.admin`insert into credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
    values (${id},'plan_credit_grant',10000000,${crypto.randomUUID()}) returning id`;
  const [period] =
    await shared.admin`insert into plan_credit_periods(account_id,plan_key,catalog_revision,period_start,period_end,
    granted_micros,opening_debt_micros,grant_entry_id,idempotency_key)
    values (${id},'free',1,${input.periodStart},${input.periodEnd},10000000,0,${grant!.id},${crypto.randomUUID()}) returning id`;
  expect((await getBillingBalance(client.db, id)).plan?.creditScoped).toBe(false);
  expect((await charge(id, M, "claude-opus")).debitedMicros).toBe(M);
  await expirePlanCreditPeriod(client.db, { accountId: id, periodId: period!.id, force: true });
  expect((await getBillingBalance(client.db, id)).generalBalanceMicros).toBe(10 * M); // legacy signup
  const scopedId = await owner();
  await grantPlanCreditPeriod(client.db, await state(scopedId));
  const [revision] =
    await shared.admin`select set_credit_promotion_policy(${shared.admin.json({ defaultModelIds: ["coupon-model"], signupModelIds: ["model-b"] })}::jsonb,'test','Free and signup live policy') as revision`;
  const balance = await getBillingBalance(client.db, scopedId);
  expect(balance.creditPolicyRevision).toBe(Number(revision!.revision));
  expect(balance.promotionalCredits?.every((g) => g.eligibleModelIds.join() === "model-b")).toBe(
    true,
  );
  expect((await charge(scopedId, M, "model-a")).debitedMicros).toBe(0);
  expect((await charge(scopedId, M, "model-b")).balance.plan?.creditRemainingMicros).toBe(9 * M);
  // An already admitted call can settle against its old policy revision (0).
  expect(
    (
      await applyCreditDebitUpToBalance(client.db, {
        accountId: scopedId,
        requestedAmountMicros: M,
        modelId: "model-a",
        creditPolicyRevision: 0,
        type: "model_debit",
        idempotencyKey: crypto.randomUUID(),
      })
    ).debitedMicros,
  ).toBe(M);
}, 180_000);

test("promotion holds preserve paid funding, historical receipts and in-flight settlement", async () => {
  if (!client || !shared) return;
  const id = await owner();
  const input = await state(id);
  const grant = await grantPlanCreditPeriod(client.db, input);
  await ledger(id, 3 * M);
  await shared.admin`select opengeni_private.set_promotion_enforcement(true,'test','test activation',true)`;
  try {
    await shared.admin`select opengeni_private.set_promotion_decision(${id}::uuid,'held','test','farm', '{}'::jsonb,'operator:test',0)`;
    const history =
      await shared.admin`select data_schema from opengeni_private.promotion_decision_history where account_id=${id}::uuid`;
    expect(history[0]!.data_schema).toBe(shared.schema);
    const gross = await getBillingBalance(client.db, id);
    expect(gross.balanceMicros).toBe(23 * M);
    expect(gross.heldCreditMicros).toBe(20 * M);
    expect((await getSpendableCreditBalance(client.db, id, "model-b")).balanceMicros).toBe(3 * M);
    expect(await freePlanCreditEligible(client.db, id)).toBe(false);
    // Exact replay returns the immutable receipt; it never restores eligibility.
    expect((await grantPlanCreditPeriod(client.db, input)).id).toBe(grant.id);
    // Accounting for an already-dispatched call still uses the admitted funds.
    expect((await charge(id, M, "model-b")).debitedMicros).toBe(M);
    expect((await getBillingBalance(client.db, id)).heldCreditMicros).toBe(19 * M);
    await expect(
      Promise.resolve(
        client.db.execute(
          (await import("drizzle-orm"))
            .sql`select opengeni_private.set_promotion_decision(${id}::uuid,'eligible','x','x','{}'::jsonb,'forged',1)`,
        ),
      ),
    ).rejects.toThrow();
    await shared.admin`select opengeni_private.set_promotion_decision(${id}::uuid,'eligible','test','review','{}'::jsonb,'operator:test',1)`;
    expect((await getSpendableCreditBalance(client.db, id, "model-b")).balanceMicros).toBe(22 * M);
    const paid = await owner();
    const paidInput = await state(paid, "pro");
    await grantPlanCreditPeriod(client.db, paidInput);
    await shared.admin`select opengeni_private.set_promotion_decision(${paid}::uuid,'denied','test','farm','{}'::jsonb,'operator:test',0)`;
    const paidBalance = await getBillingBalance(client.db, paid);
    expect(paidBalance.heldCreditMicros).toBe(10 * M);
    expect(spendableCreditMicros(paidBalance, "model-b")).toBe(
      paidBalance.plan!.creditRemainingMicros,
    );
  } finally {
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);

test("new grants and renewals are blocked transactionally; tenant reads cannot inspect or release other holds", async () => {
  if (!client || !shared) return;
  const id = await owner();
  const other = await owner();
  const input = await state(id);
  await shared.admin`select opengeni_private.set_promotion_decision(${id}::uuid,'held','test','farm','{}'::jsonb,'operator:test',0)`;
  // Shadow decisions have no money effect until rollout activation.
  expect((await getBillingBalance(client.db, id)).promotionDecision).toBe("eligible");
  await shared.admin`select opengeni_private.set_promotion_enforcement(true,'test','test activation',true)`;
  try {
    await expect(grantPlanCreditPeriod(client.db, input)).rejects.toThrow();
    const { sql } = await import("drizzle-orm");
    const rows = await withAccountRls(
      client.db,
      other,
      async (tx) =>
        await tx.execute(
          sql`select account_id from promotion_decisions where account_id=${id}::uuid`,
        ),
    );
    expect(rows.length).toBe(0);
    await expect(
      Promise.resolve(client.db.execute(sql`update promotion_enforcement set enabled=false`)),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        client.db.execute(sql`select * from opengeni_private.promotion_decision_history`),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        shared.admin`select opengeni_private.set_promotion_decision(${id}::uuid,'eligible','test','review','{}'::jsonb,'operator:test',0)`,
      ),
    ).rejects.toThrow();
  } finally {
    await shared.admin`update promotion_enforcement set enabled=false`;
  }
}, 180_000);
