import { expect, test } from "bun:test";
import {
  billingCreditEmail,
  billingCreditEnvironmentLabel,
} from "../src/billing-credit-notifications";
import { generalAvailableCreditMicros } from "../../db/src/credit-balances";

test("unusual spend names the organization, non-production host and top workspaces, escaped", () => {
  const dev = crypto.randomUUID();
  const result = billingCreditEmail({
    kind: "unusual_spend",
    details: {
      availableBalanceMicros: 29_210_986,
      lastHourSpendMicros: 17_248_466,
      spendWindowHours: 1,
      topWorkspaces: [
        { workspaceId: dev, name: "Dev <script>", spendMicros: 17_202_074 },
        { workspaceId: null, name: null, spendMicros: 46_392 },
      ],
    },
    sender: "sender@example.test",
    email: "owner@example.test",
    billingUrl: "https://staging.app.test/billing",
    organizationName: "Pronta\r\nBcc: x@evil.test",
    environmentLabel: billingCreditEnvironmentLabel("azure-managed", "https://staging.app.test"),
    workspaceUrl: (id) =>
      `https://staging.app.test/w/p/organization?section=billing&workspace=${id}`,
  });
  expect(result.subject).toBe(
    "[staging.app.test] Unusual credit spending in Pronta Bcc: x@evil.test",
  );
  expect(result.subject).not.toMatch(/[\r\n]/);
  expect(result.text).toContain("Sent from staging.app.test, not production.");
  expect(result.text).toContain(
    "Top workspaces in the last hour:\n- Dev <script>: $17.20\n- Other usage: $0.05",
  );
  expect(result.html).not.toContain("<script>");
  expect(result.html).toContain(
    `<a href="https://staging.app.test/w/p/organization?section=billing&amp;workspace=${dev}">Dev &lt;script&gt;</a>: $17.20`,
  );
  expect(result.html).toContain("<li>Other usage: $0.05</li>");
});

test.each([
  ["low_balance", "General credits are low in Cloudgeni"],
  ["exhausted", "General credits are exhausted in Cloudgeni"],
  ["unusual_spend", "Unusual credit spending in Cloudgeni"],
  ["topup_success", "Credits were topped up in Cloudgeni"],
  ["topup_failed", "Credit top-up failed in Cloudgeni"],
  ["cap_reached", "Automatic top-up cap reached in Cloudgeni"],
] as const)("%s names the organization and production adds no label", (kind, subject) => {
  const result = billingCreditEmail({
    kind,
    details: { availableBalanceMicros: 1_000_000 },
    sender: "sender@example.test",
    email: "owner@example.test",
    billingUrl: "https://app.test/billing",
    organizationName: "Cloudgeni",
    environmentLabel: billingCreditEnvironmentLabel("production", "https://app.test"),
  });
  expect(result.subject).toBe(subject);
  expect(result.text.startsWith(`${subject}.\n`)).toBe(true);
  expect(result.text).not.toContain("Sent from");
  expect(result.text).not.toContain("Top workspaces");
});

test("a missing organization name falls back to generic copy", () => {
  const result = billingCreditEmail({
    kind: "exhausted",
    details: { availableBalanceMicros: 0 },
    sender: "sender@example.test",
    email: "owner@example.test",
    billingUrl: "https://app.test/billing",
    organizationName: " \n ",
  });
  expect(result.subject).toBe("General credits are exhausted in your organization");
});

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
