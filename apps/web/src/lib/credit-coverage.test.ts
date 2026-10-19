import { expect, test } from "bun:test";
import type { BillingSummary } from "@/types";
import { creditBalanceSplit, creditBalanceSplitLabel, modelListSummary } from "./credit-coverage";

function balance(overrides: Partial<BillingSummary["balance"]>): BillingSummary["balance"] {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    balanceMicros: 0,
    currency: "usd",
    updatedAt: "2026-10-18T12:00:00Z",
    ...overrides,
  };
}

test("model lists stay short and name the rest by count", () => {
  expect(modelListSummary([])).toBe("");
  expect(modelListSummary(["GPT-6 Sol"])).toBe("GPT-6 Sol");
  expect(modelListSummary(["GPT-6 Sol", "GPT-6 Luna"])).toBe("GPT-6 Sol and GPT-6 Luna");
  expect(modelListSummary(["A", "B", "C"])).toBe("A, B and C");
  expect(modelListSummary(["A", "B", "C", "D", "E"])).toBe("A, B and 3 more");
});

test("a drained general balance beside scoped credit is not shown as one total", () => {
  // The incident shape: general credit spent, $110 left only for some models.
  const drained = balance({
    balanceMicros: 110_000_000,
    generalBalanceMicros: 0,
    promotionalCredits: [
      {
        grantId: "00000000-0000-4000-8000-000000000002",
        label: "Signup trial",
        remainingMicros: 10_000_000,
        eligibleModelIds: ["gpt-6-luna"],
      },
      {
        grantId: "00000000-0000-4000-8000-000000000003",
        label: "Credit gift",
        remainingMicros: 100_000_000,
        eligibleModelIds: ["gpt-6-luna", "gpt-6-sol"],
      },
    ],
  });
  expect(creditBalanceSplit(drained)).toEqual({ generalMicros: 0, scopedMicros: 110_000_000 });
  expect(creditBalanceSplitLabel(drained)).toBe(
    "$0.00 for any model · $110.00 for selected models",
  );
});

test("negative general balances read as none for any model", () => {
  const owed = balance({
    balanceMicros: 5_000_000,
    generalBalanceMicros: -5_000_000,
    promotionalCredits: [
      {
        grantId: "00000000-0000-4000-8000-000000000002",
        label: "Coupon",
        remainingMicros: 10_000_000,
        eligibleModelIds: ["gpt-6-luna"],
      },
    ],
  });
  expect(creditBalanceSplit(owed)).toEqual({ generalMicros: 0, scopedMicros: 10_000_000 });
});

test("balances without remaining scoped credit keep their single total", () => {
  expect(creditBalanceSplitLabel(balance({ balanceMicros: 12_400_000 }))).toBeNull();
  expect(
    creditBalanceSplitLabel(
      balance({
        balanceMicros: 12_400_000,
        generalBalanceMicros: 12_400_000,
        promotionalCredits: [
          {
            grantId: "00000000-0000-4000-8000-000000000002",
            label: "Spent coupon",
            remainingMicros: 0,
            eligibleModelIds: ["gpt-6-luna"],
          },
        ],
      }),
    ),
  ).toBeNull();
});
