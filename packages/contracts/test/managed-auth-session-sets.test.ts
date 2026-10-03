import { describe, expect, test } from "bun:test";
import {
  ManagedAuthLoginTransaction,
  ManagedAuthReturnIntent,
  ManagedAuthSessionSetProjection,
  StartManagedAuthSocialTransactionRequest,
} from "../src/managed-auth-session-sets";
import { SignupAttribution } from "../src/signup-attribution";

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

  test("social start carries optional attribution and never fails on a bad one", () => {
    const base = {
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedGeneration: "3",
      transactionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      provider: "google",
    };
    expect(StartManagedAuthSocialTransactionRequest.parse(base).attribution).toBeUndefined();
    expect(
      StartManagedAuthSocialTransactionRequest.parse({
        ...base,
        attribution: { ref: "producthunt", utmCampaign: "hero-cta" },
      }).attribution,
    ).toEqual({ ref: "producthunt", utmCampaign: "hero-cta" });
    for (const attribution of [
      { utmSource: "https://intranet.example/path" },
      { unexpected: "producthunt" },
      "producthunt",
    ]) {
      const parsed = StartManagedAuthSocialTransactionRequest.safeParse({ ...base, attribution });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.attribution).toBeUndefined();
    }
  });

  test("social start attribution mirrors the canonical SignupAttribution rule", () => {
    const base = {
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedGeneration: "3",
      transactionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      provider: "github",
    };
    const values = [
      "producthunt",
      "opengeni.ai",
      "hero-cta",
      " padded ",
      "a~b+c_d",
      "",
      "x".repeat(100),
      "x".repeat(101),
      "launch day",
      "a@b",
      "a/b",
      "a:b",
      "a%20b",
    ];
    for (const key of ["utmSource", "utmMedium", "utmCampaign", "utmContent", "ref"]) {
      for (const value of values) {
        const canonical = SignupAttribution.safeParse({ [key]: value });
        const forwarded = StartManagedAuthSocialTransactionRequest.parse({
          ...base,
          attribution: { [key]: value },
        }).attribution;
        expect(forwarded).toEqual(canonical.success ? canonical.data : undefined);
      }
    }
    expect(
      StartManagedAuthSocialTransactionRequest.parse({ ...base, attribution: { extra: "x" } })
        .attribution,
    ).toBeUndefined();
    expect(SignupAttribution.safeParse({ extra: "x" }).success).toBe(false);
  });
});
