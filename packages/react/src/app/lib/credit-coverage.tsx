import { modelDisplayName } from "@opengeni/sdk/model-display";
import { formatMoneyMicros } from "./format";
import type { BillingSummary } from "../types";

/**
 * Short, readable list of models: "GPT-6 Sol, GPT-6 Luna and 3 more". Labels
 * come from the caller (catalog rows) or the shared display-name table.
 */
export function modelListSummary(
  labels: readonly string[],
  { limit = 2 }: { limit?: number } = {},
): string {
  if (labels.length === 0) return "";
  if (labels.length <= limit + 1) {
    if (labels.length === 1) return labels[0]!;
    return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
  }
  return `${labels.slice(0, limit).join(", ")} and ${labels.length - limit} more`;
}

/** The models a scoped credit grant pays for, by display name. */
export function coveredModelsSummary(eligibleModelIds: readonly string[]): string {
  return modelListSummary(eligibleModelIds.map((id) => modelDisplayName(id)));
}

/**
 * Splits a balance into credit any credits-billed model can spend and credit
 * only some models can spend. The total alone overstates what an uncovered
 * model can use, so compact rows show both parts. Null without scoped credit.
 */
export function creditBalanceSplit(
  balance: BillingSummary["balance"],
): { generalMicros: number; scopedMicros: number } | null {
  const scopedMicros = (balance.promotionalCredits ?? []).reduce(
    (total, grant) => total + Math.max(0, grant.remainingMicros),
    0,
  );
  if (scopedMicros <= 0) return null;
  const general = balance.generalBalanceMicros ?? balance.balanceMicros - scopedMicros;
  return { generalMicros: Math.max(0, general), scopedMicros };
}

/** "$0.00 for any model · $100.00 for selected models", or null without scoped credit. */
export function creditBalanceSplitLabel(balance: BillingSummary["balance"]): string | null {
  const split = creditBalanceSplit(balance);
  if (!split) return null;
  return `${formatMoneyMicros(split.generalMicros, balance.currency)} for any model · ${formatMoneyMicros(split.scopedMicros, balance.currency)} for selected models`;
}
