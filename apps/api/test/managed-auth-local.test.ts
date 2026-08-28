import { describe, expect, test } from "bun:test";

import {
  managedAuthRequiresEmailVerification,
  managedAuthUserCreateOverride,
  resolveManagedAuthOAuthAttempt,
} from "../src/auth/managed-auth";
import {
  currentManagedAuthAttemptId,
  currentManagedAuthCreatedSessionId,
  currentManagedAuthProviderId,
  recordCurrentManagedAuthSession,
  runManagedAuthAttempt,
} from "../src/auth/managed-auth-attempt-context";

describe("managed auth email verification posture", () => {
  test("lets local development exercise sign-up without an email provider", () => {
    expect(managedAuthRequiresEmailVerification({ environment: "local" })).toBe(false);
  });

  test("keeps email verification enabled outside local development", () => {
    expect(managedAuthRequiresEmailVerification({ environment: "test" })).toBe(true);
    expect(managedAuthRequiresEmailVerification({ environment: "production" })).toBe(true);
  });

  test("attests local sign-ups as verified before invitation binding and session creation", () => {
    expect(
      managedAuthUserCreateOverride(
        { environment: "local" },
        { id: "user-1", emailVerified: false },
      ),
    ).toEqual({
      data: { id: "user-1", emailVerified: true },
    });
    expect(
      managedAuthUserCreateOverride(
        { environment: "production" },
        { id: "user-1", emailVerified: false },
      ),
    ).toBeUndefined();
  });
});

describe("managed auth OAuth transaction state", () => {
  test("keeps the provider binding and created session inside one callback attempt", async () => {
    const result = await runManagedAuthAttempt("transaction-1", "github", async () => {
      expect(currentManagedAuthAttemptId()).toBe("transaction-1");
      expect(currentManagedAuthProviderId()).toBe("github");
      recordCurrentManagedAuthSession("session-1");
      await Promise.resolve();
      return currentManagedAuthCreatedSessionId();
    });
    expect(result).toBe("session-1");
    expect(currentManagedAuthCreatedSessionId()).toBeNull();
    expect(currentManagedAuthProviderId()).toBe("credential");
  });

  test("accepts only the exact provider and isolated popup return", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000001";
    const value = JSON.stringify({
      callbackURL: `https://app.opengeni.test/account-auth?transaction=${transactionId}&social=complete`,
      codeVerifier: "verifier",
      expiresAt: Date.now() + 60_000,
      opengeniManagedAuth: {
        version: 1,
        provider: "google",
        transactionId,
        authorityHash: "a".repeat(64),
        transactionSecretHash: "b".repeat(64),
        expectedGeneration: "4",
        expectedActorEpoch: "2",
      },
    });
    const auth = {
      $context: Promise.resolve({
        internalAdapter: { findVerificationValue: async () => ({ value }) },
      }),
    };
    const request = new Request("https://app.opengeni.test/v1/auth/callback/google?state=opaque");
    await expect(resolveManagedAuthOAuthAttempt(auth as never, request, "google")).resolves.toEqual(
      {
        transactionId,
        provider: "google",
        authorityHash: "a".repeat(64),
        transactionSecretHash: "b".repeat(64),
        expectedGeneration: "4",
        expectedActorEpoch: "2",
      },
    );
    await expect(
      resolveManagedAuthOAuthAttempt(auth as never, request, "github"),
    ).resolves.toBeNull();
  });
});
