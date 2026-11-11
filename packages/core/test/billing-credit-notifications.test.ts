import { expect, test } from "bun:test";
import { billingCreditEmail } from "../src/billing-credit-notifications";
import { generalAvailableCreditMicros } from "../../db/src/credit-balances";

test("one billing action, truthful general/promotion distinction and escaped URL", () => {
  const result = billingCreditEmail({
    kind: "exhausted",
    details: { availableBalanceMicros: 0 },
    sender: "sender@example.test",
    email: "owner@example.test",
    billingUrl: 'https://app.test/billing?x="&y=<',
  });
  expect(result.text).toContain("$0.00");
  expect(result.text).toContain("may still be available");
  expect(result.html.match(/<a /g)).toHaveLength(1);
  expect(result.html).toContain("&quot;&amp;y=&lt;");
});

test("canonical general-only availability excludes promotions and held credit without hiding funded app-plan allowance behind API/fee debt", () => {
  const balance = {
    accountId: crypto.randomUUID(),
    balanceMicros: 90_000_000,
    generalBalanceMicros: 10_000_000,
    currency: "usd" as const,
    updatedAt: new Date().toISOString(),
    apiDebtMicros: 5_000_000,
    byokFeeDebtMicros: 2_000_000,
    heldGeneralCreditMicros: 3_000_000,
    promotionalCredits: [
      {
        grantId: crypto.randomUUID(),
        label: "Promo",
        eligibleModelIds: ["model"],
        remainingMicros: 80_000_000,
      },
    ],
  };
  expect(generalAvailableCreditMicros(balance)).toBe(14_000_000);
  expect(generalAvailableCreditMicros({ ...balance, generalBalanceMicros: -20_000_000 })).toBe(0);
});

test.each([
  ["topup_success", "Credits added: $25.00."],
  [
    "topup_failed",
    "Automatic top-ups are off. Review your card and settings before enabling them again.",
  ],
  [
    "cap_reached",
    "The next automatic top-up would exceed your monthly limit. No payment was started.",
  ],
] as const)(
  "%s communicates the outcome with one billing action and no invoice claim",
  (kind, expected) => {
    const result = billingCreditEmail({
      kind,
      details: { availableBalanceMicros: 30_000_000, amountMicros: 25_000_000 },
      sender: "sender@example.test",
      email: "owner@example.test",
      billingUrl: "https://app.test/billing",
    });
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain("invoice");
    expect(result.text).not.toContain("Charged");
    expect(result.text).not.toContain("Free-plan");
    expect(result.html.match(/<a /g)).toHaveLength(1);
    if (kind === "cap_reached") expect(result.text).not.toContain("$25.00");
    if (kind === "topup_failed") expect(result.text).toContain("Requested credits: $25.00.");
  },
);
