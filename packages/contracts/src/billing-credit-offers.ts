import { z } from "zod";
import * as primitives from "./primitives";

/**
 * A custom credit offer an operator assigned to an organization
 * (docs/custom-credit-offers.md). `available`: it can be activated now.
 * `active`: activated and not yet expired. `ended`: expired or withdrawn after
 * activation. `lapsed`: the activation deadline passed first. `withdrawn`:
 * withdrawn before activation.
 */
export const CreditOfferStatus = z.enum(["available", "active", "ended", "lapsed", "withdrawn"]);
export type CreditOfferStatus = z.infer<typeof CreditOfferStatus>;

export const CreditOffer = z.object({
  id: primitives.uuid,
  accountId: primitives.uuid,
  label: z.string().min(1).max(120),
  amountMicros: primitives.positiveInteger,
  eligibleModelIds: z.array(z.string().min(1)).min(1).max(40),
  validDays: primitives.positiveInteger,
  activateBy: z.string().nullable(),
  status: CreditOfferStatus,
  activatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type CreditOffer = z.infer<typeof CreditOffer>;

export const ListCreditOffersResponse = z.object({
  offers: z.array(CreditOffer),
  /** False while only operators can activate offers on this deployment. */
  selfServeActivation: z.boolean(),
});
export type ListCreditOffersResponse = z.infer<typeof ListCreditOffersResponse>;

export const ActivateCreditOfferRequest = z.strictObject({
  accountId: primitives.optionalUuid,
});
export type ActivateCreditOfferRequest = z.infer<typeof ActivateCreditOfferRequest>;
