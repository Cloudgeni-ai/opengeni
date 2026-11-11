import type { BillingPlanBalance, BillingSubscriptionCatalog } from "@opengeni/sdk";
import { seatUpgradePlan } from "@opengeni/contracts/seat-upgrade";
import { apiErrorFacts } from "../../ui/api-error";

export type CatalogPlan = BillingSubscriptionCatalog["plans"][number];
export type PlanAction = "checkout" | "upgrade" | "downgrade" | "cancel";
/** The one plan that adds the seats a refused invitation needs. */
export type SeatUpgrade = { key: string; label: string };

export function subscriptionAction(
  current: BillingPlanBalance,
  plans: CatalogPlan[],
  target: CatalogPlan,
): PlanAction | null {
  if (current.key === target.key || current.key === "enterprise" || current.cancelAtPeriodEnd)
    return null;
  if (current.status !== "active") return null;
  if (target.key === "free") return current.key === "free" ? null : "cancel";
  if (!target.selfService || target.monthlyPriceMicros === null) return null;
  if (current.key === "free") return "checkout";
  const price = plans.find((plan) => plan.key === current.key)?.monthlyPriceMicros;
  if (price === undefined || price === null || price === target.monthlyPriceMicros) return null;
  return target.monthlyPriceMicros > price ? "upgrade" : "downgrade";
}

export function planDate(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function planSeats(plan: BillingPlanBalance): string {
  return plan.seatLimit === null
    ? `${plan.seatsUsed} seats used · Unlimited`
    : `${plan.seatsUsed} / ${plan.seatLimit} seats used`;
}

/** True when the plan has no seat left for another invitation. */
export function planSeatsFull(plan: BillingPlanBalance | null | undefined): boolean {
  return plan != null && plan.seatLimit !== null && plan.seatsUsed >= plan.seatLimit;
}

/** The plan that gives room for `additionalSeats` more people, from the live catalog. */
export function seatUpgradeFor(
  plan: BillingPlanBalance | null | undefined,
  plans: readonly CatalogPlan[] | null | undefined,
  additionalSeats = 1,
): SeatUpgrade | null {
  if (!plan || !plans?.length) return null;
  const target = seatUpgradePlan(plans, plan.key, plan.seatsUsed + Math.max(1, additionalSeats));
  return target ? { key: target.key, label: target.label } : null;
}

/** The plan a seat-limit refusal names in its details, when the server sent one. */
export function seatUpgradeFromError(error: unknown): SeatUpgrade | null {
  const details =
    error && typeof error === "object" && "details" in error
      ? (error as { details?: unknown }).details
      : null;
  if (!details || typeof details !== "object") return null;
  const { upgradePlan, upgradePlanLabel } = details as Record<string, unknown>;
  if (typeof upgradePlan !== "string" || typeof upgradePlanLabel !== "string") return null;
  const key = upgradePlan.trim();
  const label = upgradePlanLabel.trim();
  return key && label ? { key, label } : null;
}

export function isSeatLimitError(
  error: unknown,
  plan?: Pick<BillingPlanBalance, "seatsUsed" | "seatLimit"> | null,
): boolean {
  const facts = apiErrorFacts(error);
  if (facts.status !== 402) return false;
  let code = facts.code;
  // Older membership servers used a flat body; current SDK errors expose code.
  const body = error && typeof error === "object" && "body" in error ? error.body : null;
  try {
    if (typeof body === "string") {
      const decoded = JSON.parse(body);
      const bodyCode =
        typeof decoded?.error === "string"
          ? decoded.error
          : (decoded?.error?.code ?? decoded?.code);
      if (typeof bodyCode === "string") code ??= bodyCode;
    }
  } catch {
    // A status-only refusal can still be explained by the known seat usage.
  }
  if (code === "seat_limit_reached") return true;
  return (
    (code === undefined || code === "payment_required") &&
    plan != null &&
    plan.seatLimit !== null &&
    plan.seatsUsed >= plan.seatLimit
  );
}
