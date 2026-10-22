import { defineSchema } from "./define-schema";
import { z } from "zod";

const PositiveSafeInteger = /* @__PURE__ */ defineSchema(() =>
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
);
/**
 * Canonical lowercase UUID, matching PostgreSQL uuid::text and the
 * session_turns CHECK, so an accepted snapshot can never silently mismatch.
 */
const CanonicalUuid = /* @__PURE__ */ defineSchema(() =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);

/**
 * Immutable personal authority for accepted subscription work. Shared pool
 * eligibility is live and deliberately absent from this snapshot.
 */
export const SubscriptionPersonalAuthorityV2 = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(2),
      personal: z
        .array(
          z
            .object({
              provider: z.enum(["codex", "claude", "xai"]),
              ownerMembershipId: CanonicalUuid,
              authorityGeneration: PositiveSafeInteger,
              /**
               * Explicit personal consent accepted in a shared chat. Unlike the
               * historical private-work pool, this authorizes only this connection
               * in this session. Copies retain the restriction verbatim.
               */
              sharedSessionChoice: z
                .object({ sessionId: CanonicalUuid, connectionId: CanonicalUuid })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .max(3),
    })
    .strict()
    .superRefine((snapshot, ctx) => {
      const providers = snapshot.personal.map((authority) => authority.provider);
      if (new Set(providers).size !== providers.length) {
        ctx.addIssue({ code: "custom", message: "Duplicate provider personal authority" });
      }
    }),
);

export type SubscriptionPersonalAuthorityV2 = z.infer<typeof SubscriptionPersonalAuthorityV2>;

/** Return one provider's immutable personal authority from a parsed snapshot. */
export function subscriptionPersonalAuthorityForProviderV2(
  snapshot: SubscriptionPersonalAuthorityV2,
  provider: SubscriptionPersonalAuthorityV2["personal"][number]["provider"],
): SubscriptionPersonalAuthorityV2["personal"][number] | null {
  return snapshot.personal.find((authority) => authority.provider === provider) ?? null;
}

export const EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2 = {
  version: 2,
  personal: [],
} as const satisfies SubscriptionPersonalAuthorityV2;
