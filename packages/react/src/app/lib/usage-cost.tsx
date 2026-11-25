/**
 * What usage cost, as Insights > Usage shows it ("spend"). Shared by the Usage
 * page and the agent page so both count and format money the same way.
 */

type PayerAmounts = { chargedMicros: number; listMicros: number; calls?: number };

export type UsageCostMeasures = {
  chargedMicros: number;
  listMicros: number;
  byPayer?:
    | Partial<Record<"opengeni_credits" | "subscription" | "own_key", PayerAmounts>>
    | undefined;
};

/**
 * What the usage cost. Credits count what was charged; plans and your own keys
 * count their list-price estimate, since nothing was charged here.
 */
export function usageCostMicros(measures: UsageCostMeasures): number {
  const payers = measures.byPayer;
  if (payers) {
    const credits = payers.opengeni_credits;
    const external = (payers.subscription?.listMicros ?? 0) + (payers.own_key?.listMicros ?? 0);
    return (credits?.chargedMicros ?? 0) + external;
  }
  return Math.max(measures.chargedMicros, measures.listMicros);
}

export function usageUsd(micros: number): number {
  return micros / 1_000_000;
}

export function formatUsageMoney(micros: number, options: { compact?: boolean } = {}): string {
  const value = usageUsd(micros);
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.0001) return "<$0.0001";
  if (options.compact && abs >= 10_000) {
    return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
  }
  const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: abs >= 1000 ? 0 : digits,
    maximumFractionDigits: abs >= 1000 ? 0 : digits,
  })}`;
}
