import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalizeConfiguredModelId } from "@opengeni/config";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  getBillingBalance,
  grantPlanCreditPeriod,
  upsertOrganizationPlan,
  type DbClient,
} from "@opengeni/db";
import { normalizeModelCallUsage } from "@opengeni/runtime";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  settleModelUsage,
  type ModelUsageSettlementInput,
} from "../src/billing/model-usage-settlement";

// Model usage is charged its full price after use, like every other
// Opengeni-funded resource: a response that costs more than what is left
// takes the balance below zero instead of leaving the rest unbilled.

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("model-usage-full-debit");
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

const settings = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "none",
  modelPricingJson: JSON.stringify({
    "priced-model": {
      inputMicrosPerMillionTokens: 2_000_000,
      outputMicrosPerMillionTokens: 8_000_000,
    },
  }),
});
const MODEL = canonicalizeConfiguredModelId(settings, "priced-model");

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `full-debit-account-${suffix}`,
    accountName: "Full debit account",
    workspaceExternalSource: "test",
    workspaceExternalId: `full-debit-workspace-${suffix}`,
    workspaceName: "Full debit workspace",
    subjectId: `full-debit-subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

const credit = (accountId: string, amountMicros: number, eligibleModelIds?: string[]) =>
  applyCreditLedgerEntry(client!.db, {
    accountId,
    type: eligibleModelIds ? "grant" : "credit_topup",
    amountMicros,
    idempotencyKey: crypto.randomUUID(),
    ...(eligibleModelIds ? { eligibleModelIds } : {}),
  });

/** One response: 1M input and 500k output tokens, priced at about $6. */
async function settle(
  scope: { accountId: string; workspaceId: string },
  overrides: Partial<ModelUsageSettlementInput> = {},
) {
  const debits: Array<{ debitedMicros: number; grantDebitedMicros: number }> = [];
  const billing = await settleModelUsage(settings, client!.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    model: "priced-model",
    chargesOpenGeniCredits: true,
    countsTowardTokenCap: true,
    normalizedUsage: normalizeModelCallUsage({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
    }),
    sourceId: `response-${crypto.randomUUID()}`,
    onCreditsDebited: ({ debitedMicros, grantDebitedMicros }) =>
      debits.push({ debitedMicros, grantDebitedMicros }),
    ...overrides,
  });
  return { billing, debits };
}

async function modelDebits(accountId: string) {
  return (
    await shared!.admin`select -amount_micros as amount, usage_origin from credit_ledger_entries
      where account_id = ${accountId}::uuid and type = 'model_usage_debit' order by created_at, id`
  ).map((row) => ({ amount: Number(row.amount), origin: row.usage_origin as string }));
}

test("a response costing more than the balance is charged in full and leaves it negative; a replay charges nothing", async () => {
  if (!client || !shared) return;
  const scope = await workspace();
  await credit(scope.accountId, 1 * M);
  const sourceId = `response-${crypto.randomUUID()}`;
  const { billing, debits } = await settle(scope, { sourceId });
  const cost = billing.pricedCostMicros;
  expect(cost).toBeGreaterThan(1 * M);
  expect(debits).toEqual([{ debitedMicros: cost, grantDebitedMicros: 0 }]);
  expect((await getBillingBalance(client.db, scope.accountId)).balanceMicros).toBe(1 * M - cost);
  expect(await modelDebits(scope.accountId)).toEqual([{ amount: cost, origin: "app" }]);

  // Retrying the same response, even after a top-up, never charges it again.
  await credit(scope.accountId, 10 * M);
  const replay = await settle(scope, { sourceId });
  expect(replay.billing.pricedCostMicros).toBe(cost);
  expect(replay.debits).toEqual([{ debitedMicros: 0, grantDebitedMicros: 0 }]);
  expect((await getBillingBalance(client.db, scope.accountId)).balanceMicros).toBe(11 * M - cost);
  expect(await modelDebits(scope.accountId)).toHaveLength(1);
}, 180_000);

test("a response settled as a zero-cost or capped receipt by an earlier release is never charged on replay", async () => {
  if (!client || !shared) return;
  const scope = await workspace();
  const sourceId = `response-${crypto.randomUUID()}`;
  const { billing } = await settle(await workspace(), { sourceId: `price-${sourceId}` });
  const cost = billing.pricedCostMicros;
  // What the earlier release wrote: the debit capped at the then-empty
  // eligible balance, with the full price kept as requestedAmountMicros.
  for (const [suffix, debited] of [
    ["zero", 0],
    ["capped", 1_000],
  ] as const) {
    await shared.admin`insert into credit_ledger_entries
      (account_id, workspace_id, type, amount_micros, source_type, source_id, usage_origin,
        idempotency_key, metadata)
      values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, 'model_usage_debit',
        ${-debited}, 'model_response', ${`${sourceId}-${suffix}`}, 'app',
        ${`credit:model_usage_debit:${sourceId}-${suffix}`},
        ${shared.admin.json({ requestedAmountMicros: cost, debitedMicros: debited })})`;
  }
  await credit(scope.accountId, 10 * M);
  for (const suffix of ["zero", "capped"]) {
    const replay = await settle(scope, { sourceId: `${sourceId}-${suffix}` });
    expect(replay.debits).toEqual([{ debitedMicros: 0, grantDebitedMicros: 0 }]);
  }
  expect((await getBillingBalance(client.db, scope.accountId)).balanceMicros).toBe(10 * M - 1_000);
}, 180_000);

test("API-origin model usage is charged in full to credits and never spends plan credit", async () => {
  if (!client || !shared) return;
  const scope = await workspace();
  const period = {
    accountId: scope.accountId,
    planKey: "pro" as const,
    periodStart: new Date(Date.now() - 1000),
    periodEnd: new Date(Date.now() + 3_600_000),
    stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
  };
  await upsertOrganizationPlan(client.db, {
    ...period,
    status: "active",
    currentPeriodStart: period.periodStart,
    currentPeriodEnd: period.periodEnd,
  });
  await grantPlanCreditPeriod(client.db, period);
  await credit(scope.accountId, 1 * M);
  const before = await getBillingBalance(client.db, scope.accountId);
  expect(before.creditsMicros).toBe(1 * M);
  const planRemaining = before.plan!.creditRemainingMicros;
  expect(planRemaining).toBeGreaterThan(10 * M);

  const { billing, debits } = await settle(scope, { billingOrigin: "api" });
  const cost = billing.pricedCostMicros;
  expect(debits).toEqual([{ debitedMicros: cost, grantDebitedMicros: 0 }]);
  const after = await getBillingBalance(client.db, scope.accountId);
  expect(after.creditsMicros).toBe(1 * M - cost);
  expect(after.plan?.creditRemainingMicros).toBe(planRemaining);
  expect(await modelDebits(scope.accountId)).toEqual([{ amount: cost, origin: "api" }]);
}, 180_000);

test("promotional credit for the model pays first; only general credit goes negative", async () => {
  if (!client || !shared) return;
  const scope = await workspace();
  await credit(scope.accountId, 2 * M, [MODEL]);
  await credit(scope.accountId, 3 * M, ["another-model"]);
  await credit(scope.accountId, 1 * M);
  const { billing, debits } = await settle(scope);
  const cost = billing.pricedCostMicros;
  expect(cost).toBeGreaterThan(3 * M);
  expect(debits).toEqual([{ debitedMicros: cost, grantDebitedMicros: 2 * M }]);
  const balance = await getBillingBalance(client.db, scope.accountId);
  const remaining = Object.fromEntries(
    (balance.promotionalCredits ?? []).map((grant) => [
      grant.eligibleModelIds.join(","),
      grant.remainingMicros,
    ]),
  );
  // The covering grant is spent to zero (and drops out); the other is untouched.
  expect(remaining).toEqual({ "another-model": 3 * M });
  expect(balance.generalBalanceMicros).toBe(1 * M - (cost - 2 * M));
  expect(balance.balanceMicros).toBe(6 * M - cost);
}, 180_000);
