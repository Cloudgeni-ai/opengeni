import { describe, expect, test } from "bun:test";
import {
  canonicalSessionForkHash,
  canonicalSessionVisibilityTransitionHash,
} from "../src/session-tenancy";

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

  test("hashes the destination and requested fork visibility", () => {
    const input = {
      sourceSessionId: "2dbf723a-cb9b-45e1-9c37-d51fcb73b32c",
      destinationWorkspaceId: "be0d743d-2434-4fe5-8a82-73108a644a36",
      destinationVisibility: "workspace_shared" as const,
    };
    expect(canonicalSessionForkHash(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSessionForkHash(input)).not.toBe(
      canonicalSessionForkHash({
        ...input,
        destinationVisibility: "user_private",
      }),
    );
  });
});
