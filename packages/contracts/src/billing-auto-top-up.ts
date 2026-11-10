import { z } from "zod";
import * as primitives from "./primitives";

/** Integer USD micro-units, restricted to whole cents. No float currency math. */
const usdMicros = z.number().int().min(0).max(10_000_000_000).multipleOf(10_000);
export const BillingAutoTopUpSettings = z.object({
  accountId: primitives.uuid,
  enabled: z.boolean(),
  thresholdMicros: usdMicros,
  amountMicros: usdMicros,
  monthlyCapMicros: usdMicros,
  /** Includes pending reservations and tax. Refunds do not replenish this cap. */
  spentThisMonthMicros: z.number().int().nonnegative(),
  status: z.enum([
    "off",
    "ready",
    "payment_method_required",
    "payment_failed",
    "cap_reached",
    "processing",
  ]),
  paymentMethod: z.object({ brand: z.string(), last4: z.string() }).nullable(),
  failureReason: z.string().nullable().optional(),
});
export type BillingAutoTopUpSettings = z.infer<typeof BillingAutoTopUpSettings>;

export const UpdateBillingAutoTopUpRequest = z
  .strictObject({
    accountId: primitives.optionalUuid,
    /** Enabling expressly authorizes recurring off-session threshold charges, including tax,
     * up to monthlyCapMicros. Only the signed-in organization owner can consent. */
    enabled: z.boolean(),
    thresholdMicros: usdMicros.default(10_000_000),
    amountMicros: usdMicros.min(5_000_000).default(25_000_000),
    monthlyCapMicros: usdMicros.min(5_000_000).default(100_000_000),
    idempotencyKey: primitives.uuid,
  })
  .refine((value) => value.amountMicros <= value.monthlyCapMicros, {
    message: "The monthly cap must cover at least one top-up.",
    path: ["monthlyCapMicros"],
  });
export type UpdateBillingAutoTopUpRequest = z.infer<typeof UpdateBillingAutoTopUpRequest>;

export const CreateBillingAutoTopUpSetupSessionRequest = z.strictObject({
  accountId: primitives.optionalUuid,
  idempotencyKey: primitives.uuid,
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CreateBillingAutoTopUpSetupSessionRequest = z.infer<
  typeof CreateBillingAutoTopUpSetupSessionRequest
>;
export const CreateBillingAutoTopUpSetupSessionResponse = z.object({ url: z.string().url() });
export type CreateBillingAutoTopUpSetupSessionResponse = z.infer<
  typeof CreateBillingAutoTopUpSetupSessionResponse
>;
