import { describe, expect, test } from "bun:test";

import {
  managedAuthRequiresEmailVerification,
  isolatedManagedAuthOAuthCallbackRequest,
  managedAuthUserCreateAdmission,
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
import { validatedManagedAuthSocialAuthorizationUrl } from "../src/routes/managed-auth-session-sets";

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

  test("rejects an unverified social identity before creating its managed user", () => {
    expect(
      managedAuthUserCreateAdmission(
        { environment: "production" },
        { id: "user-1", emailVerified: false },
        "github",
      ),
    ).toBe(false);
    expect(
      managedAuthUserCreateAdmission(
        { environment: "production" },
        { id: "user-1", emailVerified: true },
        "google",
      ),
    ).toBeUndefined();
    expect(
      managedAuthUserCreateAdmission(
        { environment: "production" },
        { id: "user-1", emailVerified: false },
        "credential",
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

  test("accepts only the provider's exact authorization endpoint and callback", () => {
    const valid =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client&redirect_uri=" +
      encodeURIComponent("https://app.opengeni.test/v1/auth/callback/google") +
      "&state=opaque&scope=openid";
    expect(
      validatedManagedAuthSocialAuthorizationUrl({
        provider: "google",
        rawUrl: valid,
        expectedClientId: "google-client",
        expectedCallbackUrl: "https://app.opengeni.test/v1/auth/callback/google",
      }),
    ).toBe(valid);
    for (const rawUrl of [
      valid.replace("accounts.google.com", "accounts.google.com.attacker.test"),
      valid.replace("client_id=google-client", "client_id=attacker"),
      valid.replace(
        encodeURIComponent("https://app.opengeni.test/v1/auth/callback/google"),
        encodeURIComponent("https://attacker.test/callback"),
      ),
      `${valid}&state=second`,
    ]) {
      expect(() =>
        validatedManagedAuthSocialAuthorizationUrl({
          provider: "google",
          rawUrl,
          expectedClientId: "google-client",
          expectedCallbackUrl: "https://app.opengeni.test/v1/auth/callback/google",
        }),
      ).toThrow();
    }

    const github =
      "https://github.com/login/oauth/authorize?client_id=github-client&redirect_uri=" +
      encodeURIComponent("https://app.opengeni.test/v1/auth/callback/github") +
      "&state=opaque&scope=read%3Auser+user%3Aemail";
    expect(
      validatedManagedAuthSocialAuthorizationUrl({
        provider: "github",
        rawUrl: github,
        expectedClientId: "github-client",
        expectedCallbackUrl: "https://app.opengeni.test/v1/auth/callback/github",
      }),
    ).toBe(github);
  });

  test("accepts only the exact provider and isolated popup return", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000001";
    const value = JSON.stringify({
      callbackURL: `https://app.opengeni.test/account-auth?transaction=${transactionId}&social=complete`,
      errorURL: `https://app.opengeni.test/account-auth?transaction=${transactionId}&social=error`,
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
    await expect(
      resolveManagedAuthOAuthAttempt(auth as never, request, "google", "https://app.opengeni.test"),
    ).resolves.toEqual({
      transactionId,
      provider: "google",
      authorityHash: "a".repeat(64),
      transactionSecretHash: "b".repeat(64),
      expectedGeneration: "4",
      expectedActorEpoch: "2",
    });
    await expect(
      resolveManagedAuthOAuthAttempt(auth as never, request, "github", "https://app.opengeni.test"),
    ).resolves.toBeNull();
    await expect(
      resolveManagedAuthOAuthAttempt(
        auth as never,
        request,
        "google",
        "https://other.opengeni.test",
      ),
    ).resolves.toBeNull();
    const wrongErrorReturn = {
      $context: Promise.resolve({
        internalAdapter: {
          findVerificationValue: async () => ({
            value: value.replace(
              "https://app.opengeni.test/account-auth?transaction=" +
                transactionId +
                "&social=error",
              "https://attacker.test/account-auth?transaction=" + transactionId + "&social=error",
            ),
          }),
        },
      }),
    };
    await expect(
      resolveManagedAuthOAuthAttempt(
        wrongErrorReturn as never,
        request,
        "google",
        "https://app.opengeni.test",
      ),
    ).resolves.toBeNull();
  });

  test("isolates the callback to the one Better Auth state cookie", async () => {
    const auth = {
      $context: Promise.resolve({
        createAuthCookie: () => ({ name: "better-auth.state" }),
      }),
    };
    const original = new Request("https://app.opengeni.test/v1/auth/callback/google?state=opaque", {
      headers: {
        authorization: "Bearer ambient-secret",
        cookie: "selected_session=ambient; better-auth.state=oauth-state; unrelated=private",
        "x-forwarded-user": "ambient-user",
      },
    });
    const isolated = await isolatedManagedAuthOAuthCallbackRequest(auth as never, original);
    expect(isolated.stateCookieName).toBe("better-auth.state");
    expect(isolated.request.headers.get("cookie")).toBe("better-auth.state=oauth-state");
    expect(isolated.request.headers.has("authorization")).toBe(false);
    expect(isolated.request.headers.has("x-forwarded-user")).toBe(false);
  });
});
