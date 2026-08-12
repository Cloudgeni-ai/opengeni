import { describe, expect, test } from "bun:test";
import { canonicalSessionVisibilityTransitionHash } from "../src/session-tenancy";

describe("session tenancy domain", () => {
  test("hashes only the immutable transition command", () => {
    const input = {
      sessionId: "2dbf723a-cb9b-45e1-9c37-d51fcb73b32c",
      targetVisibility: "user_private" as const,
      expectedAuthorityEpoch: 7,
    };
    expect(canonicalSessionVisibilityTransitionHash(input)).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(canonicalSessionVisibilityTransitionHash(input)).toBe(
      canonicalSessionVisibilityTransitionHash({ ...input }),
    );
    expect(
      canonicalSessionVisibilityTransitionHash({
        ...input,
        expectedAuthorityEpoch: 8,
      }),
    ).not.toBe(canonicalSessionVisibilityTransitionHash(input));
  });
});
