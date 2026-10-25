import * as primitives from "./primitives";
import { z } from "zod";

/** Operator-managed catalog; monetary amounts are USD micro-units. */
export const SubscriptionPlan = z.strictObject({
  key: primitives.string.regex(/^[a-z][a-z0-9_-]{0,39}$/),
  label: primitives.string.trim().min(1).max(120),
  stripePriceId: primitives.string.trim().min(1).max(200).nullable(),
  /** Existing subscriptions only; checkout and plan changes use stripePriceId. */
  legacyStripePriceIds: z.array(primitives.string.trim().min(1).max(200)).max(100).optional(),
  monthlyPriceMicros: primitives.nonnegativeInteger.max(Number.MAX_SAFE_INTEGER).nullable(),
  monthlyCreditMicros: primitives.nonnegativeInteger.max(Number.MAX_SAFE_INTEGER),
  seatLimit: z.number().int().positive().max(1_000_000).nullable(),
  freeCredit: primitives.boolean,
});
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

export const SubscriptionPlanCatalog = z
  .array(SubscriptionPlan)
  .min(1)
  .max(100)
  .superRefine((plans, context) => {
    if (new Set(plans.map((plan) => plan.key)).size !== plans.length) {
      context.addIssue({ code: "custom", message: "Plan keys must be unique" });
    }
    const prices = plans.flatMap((plan) => [
      ...(plan.stripePriceId ? [plan.stripePriceId] : []),
      ...(plan.legacyStripePriceIds ?? []),
    ]);
    if (new Set(prices).size !== prices.length) {
      context.addIssue({ code: "custom", message: "Stripe price IDs must be unique" });
    }
  });
export type SubscriptionPlanCatalog = z.infer<typeof SubscriptionPlanCatalog>;

export const BillingPlanBalance = z.object({
  key: primitives.string,
  label: primitives.string,
  status: primitives.string,
  creditGrantedMicros: primitives.nonnegativeInteger,
  creditRemainingMicros: primitives.nonnegativeInteger,
  /** Already unavailable, but not yet removed from the physical ledger. */
  creditPendingExpiryMicros: z.number().int().nonnegative().optional(),
  /** The granted period is model-scoped, rather than part of general credit. */
  creditScoped: primitives.optionalBoolean,
  periodResetAt: primitives.nullableString,
  seatLimit: z.number().int().positive().nullable(),
  seatsUsed: primitives.nonnegativeInteger,
  cancelAtPeriodEnd: primitives.boolean,
});
export type BillingPlanBalance = z.infer<typeof BillingPlanBalance>;
