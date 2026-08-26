import { describe, expect, test } from "bun:test";
import {
  ManagedAuthLoginTransaction,
  ManagedAuthReturnIntent,
  ManagedAuthSessionSetProjection,
} from "../src/managed-auth-session-sets";

describe("managed auth session-set public contracts", () => {
  test("accepts only the bounded safe browser projection", () => {
    const projection = ManagedAuthSessionSetProjection.parse({
      mode: "dual",
      generation: "7",
      actorEpoch: "4",
      csrfToken: "csrf-token-that-is-long-enough-for-the-contract",
      selectedSlotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "ready",
      slots: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          displayName: "Ada",
          verifiedClaim: { kind: "email", value: "ada@example.test" },
          state: "active",
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toMatch(
      /authSession|authUser|identityId|bindingId|sessionToken|secret/i,
    );
  });

  test("accepts only supported secret-free return paths", () => {
    const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(ManagedAuthReturnIntent.parse(`/workspaces/${workspaceId}/sessions/${sessionId}`)).toBe(
      `/workspaces/${workspaceId}/sessions/${sessionId}`,
    );
    for (const path of [
      "/anything",
      `/workspaces/${workspaceId}?tab=sessions`,
      `/workspaces/${workspaceId}#sessions`,
      `/workspaces/${workspaceId}/`,
      `/workspaces/${workspaceId}?foo=token-value`,
      `/${"a".repeat(2048)}`,
      "/\nevil.example",
      "//evil.example",
      "/\\evil.example",
    ]) {
      expect(ManagedAuthReturnIntent.safeParse(path).success).toBe(false);
    }
  });

  test("strips transaction credentials and provider internals", () => {
    const transaction = ManagedAuthLoginTransaction.parse({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "add",
      expiresAt: "2026-08-26T12:00:00.000Z",
      returnIntentId: null,
      secret: "must-not-survive",
      authSessionId: "must-not-survive",
    });
    expect(transaction).toEqual({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "add",
      expiresAt: "2026-08-26T12:00:00.000Z",
      returnIntentId: null,
    });
  });
});
