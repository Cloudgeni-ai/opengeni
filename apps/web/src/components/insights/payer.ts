/**
 * Who pays for a model call. Credits are what Opengeni charged; a
 * subscription or the customer's own API key is paid outside Opengeni, so
 * Insights shows its cost-equivalent at list price instead of a charge.
 */
export type UsagePayer = "opengeni_credits" | "subscription" | "own_key";

/** Providers whose calls run on a connected ChatGPT or SuperGrok plan. */
const SUBSCRIPTION_PROVIDERS: Readonly<Record<string, string>> = {
  "codex-subscription": "ChatGPT plan",
  "supergrok-subscription": "SuperGrok plan",
};

export const PAYER_ORDER: readonly UsagePayer[] = ["opengeni_credits", "subscription", "own_key"];

export function usagePayer(billing: "opengeni_credits" | "external", provider: string): UsagePayer {
  if (billing === "opengeni_credits") return "opengeni_credits";
  return provider in SUBSCRIPTION_PROVIDERS ? "subscription" : "own_key";
}

export function payerLabel(payer: UsagePayer): string {
  switch (payer) {
    case "opengeni_credits":
      return "Opengeni credits";
    case "subscription":
      return "Subscriptions";
    case "own_key":
      return "Your API keys";
  }
}

/** The payer for one model row: names the plan when it is a subscription. */
export function rowPayerLabel(billing: "opengeni_credits" | "external", provider: string): string {
  if (billing === "opengeni_credits") return "Opengeni credits";
  return SUBSCRIPTION_PROVIDERS[provider] ?? "Your API key";
}

/** One sentence on what the amount means for that payer. */
export function payerDescription(payer: UsagePayer): string {
  switch (payer) {
    case "opengeni_credits":
      return "Charged to your Opengeni credits.";
    case "subscription":
      return "Paid by a connected plan. List-price estimate, not charged.";
    case "own_key":
      return "Billed to your own provider account. List-price estimate, not charged.";
  }
}

type PayerSource = {
  billing: "opengeni_credits" | "external";
  provider: string;
  calls: number;
  totalTokens: number;
  creditUsd: number;
  estimatedProviderUsd: number;
  estimatedProviderCostKnownCalls: number;
};

export type PayerTotal = {
  payer: UsagePayer;
  calls: number;
  tokens: number;
  /** Charged credits, or the list-price estimate for a subscription or own key. */
  amountUsd: number;
  /** True when the amount is a list-price estimate rather than a charge. */
  estimated: boolean;
  /** Calls the amount covers; an estimate leaves out calls without captured pricing. */
  pricedCalls: number;
};

/** Model rows summed by payer, in display order, payers without calls left out. */
export function payerTotals(rows: readonly PayerSource[]): PayerTotal[] {
  const totals = new Map<UsagePayer, PayerTotal>();
  for (const row of rows) {
    const payer = usagePayer(row.billing, row.provider);
    const total = totals.get(payer) ?? {
      payer,
      calls: 0,
      tokens: 0,
      amountUsd: 0,
      estimated: payer !== "opengeni_credits",
      pricedCalls: 0,
    };
    total.calls += row.calls;
    total.tokens += row.totalTokens;
    if (payer === "opengeni_credits") {
      total.amountUsd += row.creditUsd;
      total.pricedCalls += row.calls;
    } else {
      total.amountUsd += row.estimatedProviderUsd;
      total.pricedCalls += row.estimatedProviderCostKnownCalls;
    }
    totals.set(payer, total);
  }
  return PAYER_ORDER.flatMap((payer) => {
    const total = totals.get(payer);
    return total && total.calls > 0 ? [total] : [];
  });
}
