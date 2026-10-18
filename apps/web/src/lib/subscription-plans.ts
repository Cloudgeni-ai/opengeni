import type { BillingPlanBalance, BillingSubscriptionCatalog } from "@opengeni/sdk";
import { apiErrorFacts } from "@/lib/api-error";

export type CatalogPlan = BillingSubscriptionCatalog["plans"][number];
export type PlanAction = "checkout" | "upgrade" | "downgrade" | "cancel";

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
