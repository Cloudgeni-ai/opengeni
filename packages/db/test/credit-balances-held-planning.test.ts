import { expect, test } from "bun:test";
import type { BillingBalance } from "@opengeni/contracts";
import {
  planCreditDebit,
  planPostUseCreditAllocations,
  spendableCreditMicros,
  validFundingAdmittedAt,
} from "../src/credit-balances";

// Settlement planning never reaches a grant whose balance read marks it held.
// The PostgreSQL suites prove when settlement reads funding as held.
const M = 1_000_000;
function balance(held: boolean): BillingBalance {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    balanceMicros: 13 * M,
    generalBalanceMicros: 3 * M,
    currency: "usd",
    updatedAt: new Date(0).toISOString(),
    heldCreditMicros: held ? 10 * M : 0,
    promotionalCredits: [
      {
        grantId: "00000000-0000-4000-8000-000000000002",
        label: "Free",
        eligibleModelIds: ["gpt-6-luna"],
        remainingMicros: 10 * M,
        planCredit: true,
        held,
      },
    ],
  } as BillingBalance;
}

test("held grants are neither spendable nor allocated by prepaid or post-use planning", () => {
  expect(spendableCreditMicros(balance(true), "gpt-6-luna")).toBe(3 * M);
  expect(planCreditDebit(balance(true), 5 * M, "gpt-6-luna")).toEqual({
    debitedMicros: 3 * M,
    allocations: [],
  });
  expect(planPostUseCreditAllocations(balance(true), 5 * M, "gpt-6-luna")).toEqual([]);

  // Not held (eligible, released, or admitted before the hold): the grant pays first.
  const grantEntryId = balance(false).promotionalCredits![0]!.grantId;
  expect(planCreditDebit(balance(false), 5 * M, "gpt-6-luna")).toEqual({
    debitedMicros: 5 * M,
    allocations: [{ grantEntryId, amountMicros: 5 * M }],
  });
  expect(planPostUseCreditAllocations(balance(false), 12 * M, "gpt-6-luna")).toEqual([
    { grantEntryId, amountMicros: 10 * M },
  ]);
});

test("only a database-clock UTC admission time is accepted", () => {
  expect(validFundingAdmittedAt("2026-10-29T10:35:00.123456Z")).toBe("2026-10-29T10:35:00.123456Z");
  expect(validFundingAdmittedAt("2026-10-29T10:35:00Z")).toBe("2026-10-29T10:35:00Z");
  for (const value of [
    undefined,
    null,
    "",
    "2026-10-29 10:35:00",
    "2026-10-29T10:35:00+02:00",
    "2026-13-45T99:99:99.000000Z",
    "now",
  ]) {
    expect(validFundingAdmittedAt(value)).toBeNull();
  }
});
