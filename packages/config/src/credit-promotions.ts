import { PromotionalCreditScope } from "@opengeni/contracts";
import { z } from "zod";

const ModelIds = PromotionalCreditScope.shape.eligibleModelIds.transform((ids) => [
  ...new Set(ids),
]);

/** Operator configuration only. Keys are Stripe coupon IDs, never customer account IDs. */
export const CreditPromotionPolicy = z
  .object({
    defaultModelIds: ModelIds.optional(),
    signupModelIds: ModelIds.optional(),
    offers: z
      .record(
        z.string().min(1),
        z
          .object({
            label: PromotionalCreditScope.shape.label,
            eligibleModelIds: ModelIds.optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const [id, offer] of Object.entries(policy.offers)) {
      if (!offer.eligibleModelIds && !policy.defaultModelIds) {
        ctx.addIssue({
          code: "custom",
          path: ["offers", id],
          message: "Offer requires eligibleModelIds or defaultModelIds",
        });
      }
    }
  });

export const EnvCreditPromotionPolicy = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  CreditPromotionPolicy.default({ offers: {} }),
);

export function signupCreditModelIds(settings: {
  creditPromotionPolicy: z.infer<typeof CreditPromotionPolicy>;
}) {
  return (
    settings.creditPromotionPolicy.signupModelIds ?? settings.creditPromotionPolicy.defaultModelIds
  );
}

export function promotionalCreditScope(
  settings: { creditPromotionPolicy: z.infer<typeof CreditPromotionPolicy> },
  couponId: string,
): PromotionalCreditScope | undefined {
  const policy = settings.creditPromotionPolicy;
  const offer = policy.offers[couponId];
  const eligibleModelIds = offer?.eligibleModelIds ?? policy.defaultModelIds;
  return eligibleModelIds
    ? { label: offer?.label ?? "Promotional credits", eligibleModelIds }
    : undefined;
}
