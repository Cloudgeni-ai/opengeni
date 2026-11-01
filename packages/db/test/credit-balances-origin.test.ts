import { expect, test } from "bun:test";
import type { BillingBalance } from "@opengeni/contracts";
import {
  apiSpendableCreditMicros,
  chargeBillingOrigin,
  VOICE_CREDIT_USAGE,
  planCreditDebit,
  planPostUseCreditAllocations,
  spendableCreditMicros,
} from "../src/credit-balances";
import { withBillingOriginOverride } from "../src/credit-debit-attribution";

const M = 1_000_000;
// $100 general: $80 of this month's plan credit plus $20 of credits, and a
// $30 promotional grant for model-a.
const balance = {
  accountId: "00000000-0000-4000-8000-000000000001",
  currency: "usd",
  updatedAt: new Date(0).toISOString(),
  balanceMicros: 130 * M,
  generalBalanceMicros: 100 * M,
  creditsMicros: 20 * M,
  promotionalCredits: [
    {
      grantId: "00000000-0000-4000-8000-000000000002",
      label: "Promotional credits",
      eligibleModelIds: ["model-a"],
      remainingMicros: 30 * M,
    },
  ],
} as BillingBalance;

test("API work can spend credits only", () => {
  expect(spendableCreditMicros(balance, "model-a")).toBe(130 * M);
  expect(spendableCreditMicros(balance, "model-a", "app")).toBe(130 * M);
  expect(spendableCreditMicros(balance, "model-a", "api")).toBe(20 * M);
  expect(apiSpendableCreditMicros({ ...balance, creditsMicros: -5 * M })).toBe(0);
});

test("API debits are capped at credits and never allocate promotional grants", () => {
  expect(planCreditDebit(balance, 50 * M, "model-a", "api")).toEqual({
    debitedMicros: 20 * M,
    allocations: [],
  });
  expect(planCreditDebit(balance, 50 * M, "model-a").debitedMicros).toBe(50 * M);
  expect(planPostUseCreditAllocations(balance, 50 * M, "model-a", "api")).toEqual([]);
});

test("the charge origin is explicit, else the trusted scope's, else app", async () => {
  expect(chargeBillingOrigin()).toBe("app");
  expect(chargeBillingOrigin("api")).toBe("api");
  expect(await withBillingOriginOverride("api", async () => chargeBillingOrigin())).toBe("api");
  expect(await withBillingOriginOverride("api", async () => chargeBillingOrigin("app"))).toBe(
    "app",
  );
});

test("the Free plan's monthly credit pays for app tools, not for other models or API work", () => {
  // $10 of scoped Free plan credit and nothing else.
  const free = {
    ...balance,
    balanceMicros: 10 * M,
    generalBalanceMicros: 0,
    creditsMicros: 0,
    promotionalCredits: [
      {
        grantId: "00000000-0000-4000-8000-000000000003",
        label: "Monthly plan credit",
        eligibleModelIds: ["model-a"],
        remainingMicros: 10 * M,
        planCredit: true,
      },
    ],
  } as BillingBalance;
  // Search, sandbox time, video (no model) and voice.
  expect(spendableCreditMicros(free, undefined)).toBe(10 * M);
  expect(spendableCreditMicros(free, VOICE_CREDIT_USAGE)).toBe(10 * M);
  expect(planCreditDebit(free, 2 * M).allocations).toEqual([
    { grantEntryId: "00000000-0000-4000-8000-000000000003", amountMicros: 2 * M },
  ]);
  // Its model scope still holds for models, and API work never spends it.
  expect(spendableCreditMicros(free, "model-a")).toBe(10 * M);
  expect(spendableCreditMicros(free, "model-b")).toBe(0);
  expect(spendableCreditMicros(free, undefined, "api")).toBe(0);
  // A promotional offer for a model is still for that model only.
  expect(spendableCreditMicros(balance, undefined)).toBe(100 * M);
});
