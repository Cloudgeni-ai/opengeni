import { z } from "zod";
import * as primitives from "./primitives";

/** Turn failure and API refusal code: starting a sandbox needs a verified card. */
export const SANDBOX_CARD_REQUIRED_CODE = "sandbox_card_required";

/**
 * An organization's card verification (docs/signup-abuse-protection.md, "Card
 * verification"). `required`: the gate is on and this unpaid organization
 * needs a verified card before it starts a sandbox or gets Free credit.
 * `canVerify`: the caller is the organization's owner, who alone adds its card.
 */
export const BillingCardVerificationStatus = z.object({
  accountId: primitives.uuid,
  required: z.boolean(),
  verified: z.boolean(),
  canVerify: z.boolean(),
  card: z.object({ brand: z.string(), last4: z.string().regex(/^[0-9]{4}$/u) }).nullable(),
});
export type BillingCardVerificationStatus = z.infer<typeof BillingCardVerificationStatus>;

export const CreateBillingCardVerificationSessionRequest = z.strictObject({
  accountId: primitives.optionalUuid,
  idempotencyKey: primitives.uuid,
  /** Stripe replaces `{CHECKOUT_SESSION_ID}` in it with the session id. */
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CreateBillingCardVerificationSessionRequest = z.infer<
  typeof CreateBillingCardVerificationSessionRequest
>;
export const CreateBillingCardVerificationSessionResponse = z.object({ url: z.string().url() });
export type CreateBillingCardVerificationSessionResponse = z.infer<
  typeof CreateBillingCardVerificationSessionResponse
>;

export const ConfirmBillingCardVerificationRequest = z.strictObject({
  accountId: primitives.optionalUuid,
  checkoutSessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/u),
});
export type ConfirmBillingCardVerificationRequest = z.infer<
  typeof ConfirmBillingCardVerificationRequest
>;
