import { describe, expect, test } from "bun:test";
import { DelegatedAccessTokenPayload } from "../src/index";

/**
 * Pins one coupling that `personalConnectionDelegationSourceForGrant`
 * (`packages/core/src/domain/personal-connection-delegations.ts`) depends on for
 * its security, not merely its behaviour.
 *
 * That function checks the `{sessionId, turnId}` turn branch BEFORE the
 * `metadata.delegated === true` filter. A delegated bearer that could present
 * both a `human_session` principal and a turn reference would therefore route
 * around the delegated filter entirely and reach the personal-connection
 * authority probe with an unvalidated signed-token subject.
 *
 * It cannot, because the refinement below forbids a `human_session` payload
 * from carrying any exact-attempt claim. That is the only thing making the
 * ordering safe. If this test is ever changed to permit the combination, move
 * the delegated filter above the turn branch in the same change.
 */
const base = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "user:owner",
  permissions: ["workspace:read" as const],
  exp: 4_102_444_800,
};

describe("delegated access token attempt claims", () => {
  test("a human_session payload cannot carry a sessionId or turnId", () => {
    for (const claims of [
      { sessionId: "33333333-3333-4333-8333-333333333333" },
      { turnId: "44444444-4444-4444-8444-444444444444" },
      {
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
      },
    ]) {
      const parsed = DelegatedAccessTokenPayload.safeParse({
        ...base,
        principalKind: "human_session",
        ...claims,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path.includes("principalKind"))).toBe(
          true,
        );
      }
    }
  });

  test("a plain human_session payload without attempt claims is still valid", () => {
    expect(
      DelegatedAccessTokenPayload.safeParse({ ...base, principalKind: "human_session" }).success,
    ).toBe(true);
  });

  test("a service payload cannot carry an exact turn reference", () => {
    expect(
      DelegatedAccessTokenPayload.safeParse({
        ...base,
        subjectId: "service:host",
        principalKind: "service",
        turnId: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(false);
  });
});
