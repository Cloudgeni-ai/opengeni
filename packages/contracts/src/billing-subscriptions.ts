import { z } from "zod";
import { BillingPlanBalance, SubscriptionPlan } from "./subscription-plans";

export const BillingSubscriptionCatalog = z.object({
  accountId: z.string().uuid(),
  revision: z.number().int().positive(),
  plans: z.array(SubscriptionPlan.extend({ selfService: z.boolean() })),
  plan: BillingPlanBalance.nullable(),
});
export type BillingSubscriptionCatalog = z.infer<typeof BillingSubscriptionCatalog>;

export const CreateSubscriptionCheckoutRequest = z.strictObject({
  accountId: z.string().uuid().optional(),
  planKey: z.string().min(1).max(40),
  /** Stable across retries of the same action; use a fresh UUID for a new action. */
  idempotencyKey: z.string().uuid(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CreateSubscriptionCheckoutRequest = z.infer<typeof CreateSubscriptionCheckoutRequest>;

export const CreateSubscriptionCheckoutResponse = z.object({
  checkoutSessionId: z.string(),
  url: z.string().url(),
});
export type CreateSubscriptionCheckoutResponse = z.infer<typeof CreateSubscriptionCheckoutResponse>;

export const ChangeBillingSubscriptionRequest = z.strictObject({
  accountId: z.string().uuid().optional(),
  planKey: z.string().min(1).max(40),
  idempotencyKey: z.string().uuid(),
});
export type ChangeBillingSubscriptionRequest = z.infer<typeof ChangeBillingSubscriptionRequest>;

export const CancelBillingSubscriptionRequest = z.strictObject({
  accountId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(),
});
export type CancelBillingSubscriptionRequest = z.infer<typeof CancelBillingSubscriptionRequest>;

export const BillingSubscriptionChange = z.object({
  subscriptionId: z.string(),
  planKey: z.string(),
  effectiveAt: z.string().datetime(),
  cancelAtPeriodEnd: z.boolean(),
});
export type BillingSubscriptionChange = z.infer<typeof BillingSubscriptionChange>;
