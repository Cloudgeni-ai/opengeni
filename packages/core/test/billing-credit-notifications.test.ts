import { expect, test } from "bun:test";
import {
  billingCreditEmail,
  billingCreditEnvironmentLabel,
} from "../src/billing-credit-notifications";
import { generalAvailableCreditMicros } from "../../db/src/credit-balances";

test("unusual spend names the organization, non-production host and top spend groups, escaped", () => {
  const dev = crypto.randomUUID();
  const personal = crypto.randomUUID();
  const result = billingCreditEmail({
    kind: "unusual_spend",
    details: { availableBalanceMicros: 29_210_986, lastHourSpendMicros: 17_248_466 },
    spend: {
      windowHours: 1,
      workspaces: [
        { kind: "workspace", workspaceId: dev, name: "Dev <script>", spendMicros: 17_202_074 },
        { kind: "personal", workspaceId: personal, name: "Ada", spendMicros: 30_000 },
        { kind: "other", workspaceId: null, name: null, spendMicros: 16_392 },
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
  expect(result.text).toContain("Sent from staging.app.test.");
  expect(result.text).toContain(
    "Top spending in the last hour:\n- Dev <script>: $17.20\n- Personal workspaces: $0.03\n- Other usage: $0.02",
  );
  expect(result.html).not.toContain("<script>");
  expect(result.html).toContain(
    `<a href="https://staging.app.test/w/p/organization?section=billing&amp;workspace=${dev}">Dev &lt;script&gt;</a>: $17.20`,
  );
  // Personal workspaces are neither named nor linked.
  expect(result.html).not.toContain(personal);
  expect(result.html).toContain("<li>Personal workspaces: $0.03</li>");
  expect(result.html).toContain("<li>Other usage: $0.02</li>");
});

test("names truncate on whole visible characters and keep joined emoji", () => {
  const family = "👩‍👩‍👧";
  const result = billingCreditEmail({
    kind: "low_balance",
    details: { availableBalanceMicros: 0 },
    sender: "sender@example.test",
    email: "owner@example.test",
    billingUrl: "https://app.test/billing",
    organizationName: `${family}\u202E${family.repeat(100)}`,
    spend: {
      windowHours: 24,
      workspaces: [{ kind: "workspace", workspaceId: null, name: "x", spendMicros: 1 }],
    },
  });
  expect(result.subject.startsWith(`General credits are low in ${family} ${family}`)).toBe(true);
  expect(result.subject).not.toContain("\u202E");
  // The cut lands between whole family emoji, never inside one.
  expect(result.subject.endsWith(`${family}…`)).toBe(true);
  // 79 kept characters (78 whole emoji and a space), then the ellipsis.
  expect(result.subject.split(family)).toHaveLength(79);
  expect(result.text).toContain("Top spending in the last 24 hours:\n- x: $0.00");
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
  expect(result.text).not.toContain("Top spending");
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
