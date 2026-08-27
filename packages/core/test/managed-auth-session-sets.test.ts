import { describe, expect, test } from "bun:test";
import {
  managedAuthCsrfToken,
  managedAuthRequestDigest,
  ManagedAuthActorChangeError,
  ManagedAuthRequestAdmissionError,
  requireManagedAuthActorFence,
  requireManagedAuthMutationAdmission,
  resolveManagedAuthSelectedSession,
} from "../src/managed-auth-session-sets";

describe("managed auth session-set request boundaries", () => {
  test("requires exact same-origin JSON and a generation-bound CSRF token", () => {
    const authority = "authority";
    const secret = "signing-secret";
    const request = new Request("https://app.opengeni.ai/v1/auth/session-set/select", {
      method: "POST",
      headers: {
        origin: "https://app.opengeni.ai",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
        "x-opengeni-session-csrf": managedAuthCsrfToken(secret, authority, "4"),
      },
    });
    expect(() =>
      requireManagedAuthMutationAdmission({
        request,
        allowedOrigins: ["https://app.opengeni.ai"],
        authority,
        signingSecret: secret,
        expectedGeneration: "4",
      }),
    ).not.toThrow();
    expect(() =>
      requireManagedAuthMutationAdmission({
        request,
        allowedOrigins: ["https://app.opengeni.ai"],
        authority,
        signingSecret: secret,
        expectedGeneration: "5",
      }),
    ).toThrow(ManagedAuthRequestAdmissionError);
  });

  test("canonical request digests ignore object key order", () => {
    expect(managedAuthRequestDigest({ b: 2, a: [1, 3] })).toBe(
      managedAuthRequestDigest({ a: [1, 3], b: 2 }),
    );
  });

  test("dual mode admits an old client only before actor transition and on the exact selected session", () => {
    expect(() =>
      requireManagedAuthActorFence({
        mode: "dual",
        actorEpoch: "1",
        expectedActorEpoch: null,
        selectedAuthSessionId: "session-a",
        legacyAmbientSessionId: "session-a",
      }),
    ).not.toThrow();
    for (const input of [
      {
        mode: "dual" as const,
        actorEpoch: "1",
        expectedActorEpoch: null,
        selectedAuthSessionId: "session-a",
        legacyAmbientSessionId: "session-b",
      },
      {
        mode: "dual" as const,
        actorEpoch: "2",
        expectedActorEpoch: null,
        selectedAuthSessionId: "session-b",
        legacyAmbientSessionId: "session-b",
      },
      {
        mode: "broker" as const,
        actorEpoch: "1",
        expectedActorEpoch: null,
        selectedAuthSessionId: "session-a",
        legacyAmbientSessionId: "session-a",
      },
      {
        mode: "dual" as const,
        actorEpoch: "2",
        expectedActorEpoch: "1",
        selectedAuthSessionId: "session-b",
      },
    ]) {
      expect(() => requireManagedAuthActorFence(input)).toThrow(ManagedAuthActorChangeError);
    }
  });

  test("rejects a read-only neutral actor-change projection before provider resolution", async () => {
    let adapterCalls = 0;
    const projection = {
      mode: "broker",
      generation: "4",
      actorEpoch: "8",
      selectedSlotId: null,
      state: "actor_change_required",
      slots: [
        {
          id: "7438e162-ded0-45fe-94f1-f4548ca532f8",
          displayName: "Expired actor",
          verifiedClaim: { kind: "email", value: "expired@example.test" },
          state: "reauth_required",
        },
      ],
    } as const;
    const db = {
      execute: async () => [{ result: { projection, selected: null, internalSlots: [] } }],
    };
    const adapter = {
      resolveSelectedSession: async () => {
        adapterCalls += 1;
        return null;
      },
    };

    await expect(
      resolveManagedAuthSelectedSession({
        db: db as never,
        adapter: adapter as never,
        authority: "authority",
        mode: "broker",
        expectedActorEpoch: projection.actorEpoch,
      }),
    ).rejects.toBeInstanceOf(ManagedAuthActorChangeError);
    expect(adapterCalls).toBe(0);
  });
});
