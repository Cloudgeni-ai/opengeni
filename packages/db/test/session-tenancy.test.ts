import { describe, expect, test } from "bun:test";
import {
  canonicalSessionForkHash as rootCanonicalSessionForkHash,
  canonicalSessionVisibilityTransitionHash as rootCanonicalSessionVisibilityTransitionHash,
} from "@opengeni/db";
import {
  canonicalSessionForkHash,
  canonicalSessionVisibilityTransitionHash,
} from "@opengeni/db/session-tenancy";

describe("session tenancy domain", () => {
  test("hashes only the immutable transition command", () => {
    const input = {
      sessionId: "2dbf723a-cb9b-45e1-9c37-d51fcb73b32c",
      targetVisibility: "user_private" as const,
      expectedAuthorityEpoch: 7,
    };
    expect(canonicalSessionVisibilityTransitionHash(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(rootCanonicalSessionVisibilityTransitionHash).toBe(
      canonicalSessionVisibilityTransitionHash,
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
      workspaceSharedAcknowledged: true,
    };
    expect(canonicalSessionForkHash(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(rootCanonicalSessionForkHash).toBe(canonicalSessionForkHash);
    expect(canonicalSessionForkHash(input)).not.toBe(
      canonicalSessionForkHash({
        ...input,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
      }),
    );
  });

  test("binds ordered restart runtime intent without changing legacy fork hashes", () => {
    const input = {
      sourceSessionId: "2dbf723a-cb9b-45e1-9c37-d51fcb73b32c",
      destinationWorkspaceId: "be0d743d-2434-4fe5-8a82-73108a644a36",
      destinationVisibility: "user_private" as const,
      workspaceSharedAcknowledged: false,
    };
    const legacyHash = canonicalSessionForkHash(input);
    const first = "7ba94a9c-1cd0-4b0e-97c5-0d50dc95eb8e";
    const second = "c3452f0d-2fce-4c19-b901-a3de386f9ea5";
    const rigId = "d3bcb4e9-c88b-4d57-9e38-a337eeb17638";

    expect(canonicalSessionForkHash(input)).toBe(legacyHash);
    expect(
      canonicalSessionForkHash({
        ...input,
        runtimeRequest: { variableSetIds: [first, second], rigId },
      }),
    ).not.toBe(legacyHash);
    expect(
      canonicalSessionForkHash({
        ...input,
        runtimeRequest: { variableSetIds: [first, second], rigId },
      }),
    ).not.toBe(
      canonicalSessionForkHash({
        ...input,
        runtimeRequest: { variableSetIds: [second, first], rigId },
      }),
    );
  });
});
