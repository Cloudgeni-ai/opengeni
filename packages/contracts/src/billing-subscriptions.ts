import * as primitives from "./primitives";
import { z } from "zod";
import { BillingPlanBalance, SubscriptionPlan } from "./subscription-plans";

export const BillingSubscriptionCatalog = z.object({
  accountId: primitives.uuid,
  revision: primitives.positiveInteger,
  plans: z.array(SubscriptionPlan.extend({ selfService: primitives.boolean })),
  plan: BillingPlanBalance.nullable(),
});
export type BillingSubscriptionCatalog = z.infer<typeof BillingSubscriptionCatalog>;

export const CreateSubscriptionCheckoutRequest = z.strictObject({
  accountId: primitives.optionalUuid,
  planKey: z.string().min(1).max(40),
  /** Stable across retries of the same action; use a fresh UUID for a new action. */
  idempotencyKey: primitives.uuid,
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CreateSubscriptionCheckoutRequest = z.infer<typeof CreateSubscriptionCheckoutRequest>;

export const CreateSubscriptionCheckoutResponse = z.object({
  checkoutSessionId: primitives.string,
  url: z.string().url(),
});
export type CreateSubscriptionCheckoutResponse = z.infer<typeof CreateSubscriptionCheckoutResponse>;

export const ChangeBillingSubscriptionRequest = z.strictObject({
  accountId: primitives.optionalUuid,
  planKey: z.string().min(1).max(40),
  idempotencyKey: primitives.uuid,
});
export type ChangeBillingSubscriptionRequest = z.infer<typeof ChangeBillingSubscriptionRequest>;

export const CancelBillingSubscriptionRequest = z.strictObject({
  accountId: primitives.optionalUuid,
  idempotencyKey: primitives.uuid,
});
export type CancelBillingSubscriptionRequest = z.infer<typeof CancelBillingSubscriptionRequest>;

export const BillingSubscriptionChange = z.object({
  subscriptionId: primitives.string,
  planKey: primitives.string,
  effectiveAt: primitives.dateTime,
  cancelAtPeriodEnd: primitives.boolean,
});
export type BillingSubscriptionChange = z.infer<typeof BillingSubscriptionChange>;
