import type { SubscriptionPlan } from "@opengeni/contracts";
import { seatUpgradePlan } from "@opengeni/contracts/seat-upgrade";
import { selfServicePlan } from "./billing-subscriptions";
import { ApiHttpError } from "./http/api-error";

export const SEAT_LIMIT_FALLBACK_MESSAGE =
  "Organization seat limit reached. Upgrade your plan to add people.";
/** An invitee can't change the organization's plan. */
export const SEAT_LIMIT_INVITEE_MESSAGE =
  "This organization is full. Ask an organization owner to upgrade.";

export type SeatLimitFacts = { seatLimit: number; seatsUsed: number; planKey: string | null };

/** The facts the seat trigger raises in its P0S01 DETAIL, when present and well formed. */
export function seatLimitFacts(detail: string | null | undefined): SeatLimitFacts | null {
  if (!detail) return null;
  try {
    const value: unknown = JSON.parse(detail);
    if (!value || typeof value !== "object") return null;
    const { seatLimit, seatsUsed, planKey } = value as Record<string, unknown>;
    if (!Number.isSafeInteger(seatLimit) || !Number.isSafeInteger(seatsUsed)) return null;
    return {
      seatLimit: seatLimit as number,
      seatsUsed: seatsUsed as number,
      planKey: typeof planKey === "string" ? planKey : null,
    };
  } catch {
    return null;
  }
}

/**
 * A seat-limit refusal names its one fix: the plan that adds the seat
 * ("Upgrade to Pro" or "Upgrade to Max"), or Enterprise, which we assign.
 * Without a catalog to choose from it keeps the generic sentence.
 */
export function seatLimitHttpError(
  facts: SeatLimitFacts | null,
  plans: readonly SubscriptionPlan[] | null,
): ApiHttpError {
  const target =
    facts && plans
      ? seatUpgradePlan(
          plans.map((plan) => ({ ...plan, selfService: selfServicePlan(plan) })),
          facts.planKey,
          facts.seatsUsed + 1,
        )
      : null;
  return new ApiHttpError(402, {
    code: "seat_limit_reached",
    message: !target
      ? SEAT_LIMIT_FALLBACK_MESSAGE
      : target.key === "enterprise"
        ? `Talk to us about ${target.label} to add more people.`
        : `Upgrade to ${target.label} to add more people.`,
    retryable: false,
    outcomeUnknown: false,
    details: {
      ...(facts ? { seatLimit: facts.seatLimit, seatsUsed: facts.seatsUsed } : {}),
      ...(target ? { upgradePlan: target.key, upgradePlanLabel: target.label } : {}),
      action: { type: "upgrade", href: "/billing" },
    },
  });
}

/** The refusal an invitee sees: the organization is full and only an owner can fix it. */
export function seatLimitInviteeHttpError(): ApiHttpError {
  return new ApiHttpError(402, {
    code: "seat_limit_reached",
    message: SEAT_LIMIT_INVITEE_MESSAGE,
    retryable: false,
    outcomeUnknown: false,
    details: { askOwner: true },
  });
}
