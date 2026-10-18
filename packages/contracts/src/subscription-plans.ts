import { z } from "zod";

/** Operator-managed catalog; monetary amounts are USD micro-units. */
export const SubscriptionPlan = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  label: z.string().trim().min(1).max(120),
  stripePriceId: z.string().trim().min(1).max(200).nullable(),
  /** Existing subscriptions only; checkout and plan changes use stripePriceId. */
  legacyStripePriceIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  monthlyPriceMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  monthlyCreditMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  seatLimit: z.number().int().positive().max(1_000_000).nullable(),
  freeCredit: z.boolean(),
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
  key: z.string(),
  label: z.string(),
  status: z.string(),
  creditGrantedMicros: z.number().int().nonnegative(),
  creditRemainingMicros: z.number().int().nonnegative(),
  /** Already unavailable, but not yet removed from the physical ledger. */
  creditPendingExpiryMicros: z.number().int().nonnegative().optional(),
  periodResetAt: z.string().nullable(),
  seatLimit: z.number().int().positive().nullable(),
  seatsUsed: z.number().int().nonnegative(),
  cancelAtPeriodEnd: z.boolean(),
});
export type BillingPlanBalance = z.infer<typeof BillingPlanBalance>;
