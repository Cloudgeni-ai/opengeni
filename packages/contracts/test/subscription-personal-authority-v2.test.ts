import { describe, expect, test } from "bun:test";
import {
  EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2,
  SubscriptionPersonalAuthorityV2,
  subscriptionPersonalAuthorityForProviderV2,
} from "../src/subscription-personal-authority-v2";

const membershipId = "11111111-1111-4111-8111-111111111111";

describe("subscription personal authority v2", () => {
  test("accepts an empty shared-only snapshot and exact personal authority entries", () => {
    expect(SubscriptionPersonalAuthorityV2.parse(EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2)).toEqual(
      {
        version: 2,
        personal: [],
      },
    );
    expect(
      SubscriptionPersonalAuthorityV2.parse({
        version: 2,
        personal: [{ provider: "codex", ownerMembershipId: membershipId, authorityGeneration: 7 }],
      }),
    ).toEqual({
      version: 2,
      personal: [{ provider: "codex", ownerMembershipId: membershipId, authorityGeneration: 7 }],
    });
  });

  test("reads only the requested provider's personal authority", () => {
    const snapshot = SubscriptionPersonalAuthorityV2.parse({
      version: 2,
      personal: [
        { provider: "codex", ownerMembershipId: membershipId, authorityGeneration: 7 },
        {
          provider: "claude",
          ownerMembershipId: "22222222-2222-4222-8222-222222222222",
          authorityGeneration: 3,
        },
      ],
    });
    expect(subscriptionPersonalAuthorityForProviderV2(snapshot, "codex")).toEqual({
      provider: "codex",
      ownerMembershipId: membershipId,
      authorityGeneration: 7,
    });
    expect(subscriptionPersonalAuthorityForProviderV2(snapshot, "xai")).toBeNull();
  });

  test("rejects malformed generations, duplicate providers, identities and extra authority", () => {
    const validEntry = {
      provider: "codex",
      ownerMembershipId: membershipId,
      authorityGeneration: 7,
    };
    for (const invalid of [
      { version: 1, personal: [] },
      { version: 2, personal: [{ ...validEntry, authorityGeneration: 0 }] },
      { version: 2, personal: [{ ...validEntry, ownerMembershipId: "not-a-uuid" }] },
      // Uppercase would never match PostgreSQL uuid::text, so it is rejected.
      {
        version: 2,
        personal: [{ ...validEntry, ownerMembershipId: "AAAAAAAA-1111-4111-8111-111111111111" }],
      },
      { version: 2, personal: [validEntry, validEntry] },
      { version: 2, personal: [{ ...validEntry, subjectId: "user:someone" }] },
      { version: 2, personal: [{ ...validEntry, credentialId: "credential" }] },
      { version: 2, personal: [], organization: "must-not-be-frozen" },
    ]) {
      expect(SubscriptionPersonalAuthorityV2.safeParse(invalid).success).toBe(false);
    }
  });
});
