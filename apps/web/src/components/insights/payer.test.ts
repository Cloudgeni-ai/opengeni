import { describe, expect, test } from "bun:test";

import { payerTotals, rowPayerLabel, usagePayer } from "./payer";

const row = (
  billing: "opengeni_credits" | "external",
  provider: string,
  values: Partial<{ calls: number; tokens: number; credit: number; est: number; known: number }>,
) => ({
  billing,
  provider,
  calls: values.calls ?? 1,
  totalTokens: values.tokens ?? 100,
  creditUsd: values.credit ?? 0,
  estimatedProviderUsd: values.est ?? 0,
  estimatedProviderCostKnownCalls: values.known ?? 0,
});

describe("usagePayer", () => {
  test("credits, connected plans and own keys", () => {
    expect(usagePayer("opengeni_credits", "openai")).toBe("opengeni_credits");
    expect(usagePayer("external", "codex-subscription")).toBe("subscription");
    expect(usagePayer("external", "supergrok-subscription")).toBe("subscription");
    expect(usagePayer("external", "workspace-claude-subscription")).toBe("subscription");
    expect(usagePayer("external", "organization-claude-subscription")).toBe("subscription");
    expect(usagePayer("external", "workspace-gateway")).toBe("own_key");
    expect(usagePayer("external", "anthropic")).toBe("own_key");
    expect(usagePayer("external", "workspace-anthropic")).toBe("own_key");
    expect(usagePayer("external", "constructor")).toBe("own_key");
    expect(rowPayerLabel("external", "codex-subscription")).toBe("ChatGPT plan");
    expect(rowPayerLabel("external", "workspace-claude-subscription")).toBe("Claude plan");
    expect(rowPayerLabel("external", "organization-claude-subscription")).toBe("Claude plan");
    expect(rowPayerLabel("external", "organization-openrouter")).toBe("Your API key");
    expect(rowPayerLabel("external", "toString")).toBe("Your API key");
  });
});

describe("payerTotals", () => {
  test("credits use the charge, other payers the list-price estimate", () => {
    const totals = payerTotals([
      row("external", "workspace-gateway", { calls: 2, tokens: 50, est: 0.4, known: 1 }),
      row("opengeni_credits", "openai", { calls: 3, tokens: 300, credit: 1.5, est: 1 }),
      row("external", "codex-subscription", { calls: 4, tokens: 400, est: 2, known: 4 }),
      row("opengeni_credits", "anthropic", { calls: 1, tokens: 10, credit: 0.5 }),
    ]);
    expect(totals).toEqual([
      {
        payer: "opengeni_credits",
        calls: 4,
        tokens: 310,
        amountUsd: 2,
        estimated: false,
        pricedCalls: 4,
      },
      {
        payer: "subscription",
        calls: 4,
        tokens: 400,
        amountUsd: 2,
        estimated: true,
        pricedCalls: 4,
      },
      { payer: "own_key", calls: 2, tokens: 50, amountUsd: 0.4, estimated: true, pricedCalls: 1 },
    ]);
  });

  test("payers without calls are left out", () => {
    expect(payerTotals([row("opengeni_credits", "openai", { calls: 0 })])).toEqual([]);
  });
});
