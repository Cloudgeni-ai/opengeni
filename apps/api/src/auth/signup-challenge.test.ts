import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  oauthSignupChallengeVerified,
  requireSignupChallenge,
  runWithSignupChallenge,
  verifySignupChallenge,
  verifySocialSignupChallenge,
} from "./signup-challenge";
const settings = {
  signupChallengeEnabled: true,
  signupChallengeSecretKey: "secret",
  signupChallengeHostnames: "app.example.test",
} as Settings;
const passed = () => ({
  success: true,
  action: "signup",
  hostname: "app.example.test",
  challenge_ts: new Date().toISOString(),
});
const mockFetch = (value: unknown) => (async () => Response.json(value)) as unknown as typeof fetch;
describe("signup challenge admission", () => {
  test("fails closed without proof, including nested and parallel request contexts", async () => {
    expect(() => requireSignupChallenge(settings)).toThrow();
    await runWithSignupChallenge(true, async () => {
      await Promise.resolve();
      requireSignupChallenge(settings);
      expect(() => runWithSignupChallenge(false, () => requireSignupChallenge(settings))).toThrow();
    });
    expect(() => requireSignupChallenge(settings)).toThrow();
  });
  test("accepts exact server verification and refuses forged, expired, replay and wrong audience results", async () => {
    await verifySignupChallenge(settings, "valid", mockFetch(passed()));
    for (const response of [
      null,
      {},
      { ...passed(), success: false, "error-codes": ["timeout-or-duplicate"] },
      { ...passed(), hostname: "evil.test" },
      { ...passed(), action: "login" },
      { ...passed(), challenge_ts: new Date(Date.now() - 301000).toISOString() },
      { ...passed(), challenge_ts: "garbage" },
    ]) {
      await expect(verifySignupChallenge(settings, "token", mockFetch(response))).rejects.toThrow();
    }
    for (const token of [undefined, "", "x".repeat(2049)]) {
      await expect(verifySignupChallenge(settings, token, mockFetch(passed()))).rejects.toThrow();
    }
  });
  test("provider outage never falls open", async () => {
    await expect(
      verifySignupChallenge(settings, "token", (async () => {
        throw new Error("timeout");
      }) as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 503 });
  });
  test("HTTP 200 provider failures and malformed replies are retryable unavailability", async () => {
    for (const reply of [
      { success: false, "error-codes": ["internal-error"] },
      { success: false, "error-codes": ["invalid-input-secret"] },
      null,
      {},
      [],
      "unavailable",
    ]) {
      await expect(
        verifySignupChallenge(settings, "token", mockFetch(reply)),
      ).rejects.toMatchObject({ status: 503 });
    }
    await expect(
      verifySignupChallenge(
        settings,
        "token",
        mockFetch({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("disabled local installations need no token", async () => {
    await verifySignupChallenge({ ...settings, signupChallengeEnabled: false }, undefined);
  });
  test("a social start carries proof only for a verified token and never refuses a sign-in", async () => {
    let calls = 0;
    const reported: string[] = [];
    const counted = (value: unknown) => ({
      fetcher: (async () => {
        calls++;
        return Response.json(value);
      }) as unknown as typeof fetch,
      onUnverified: (code: string) => {
        reported.push(code);
        // A failing reporter never changes the start.
        throw new Error("telemetry down");
      },
    });
    expect(await verifySocialSignupChallenge(settings, "valid", counted(passed()))).toBe(true);
    expect(reported).toEqual([]);
    for (const reply of [
      { ...passed(), success: false, "error-codes": ["timeout-or-duplicate"] },
      { success: false, "error-codes": ["internal-error"] },
      { ...passed(), hostname: "evil.test" },
    ]) {
      expect(await verifySocialSignupChallenge(settings, "token", counted(reply))).toBe(false);
    }
    expect(
      await verifySocialSignupChallenge(settings, "token", {
        fetcher: (async () => {
          throw new Error("timeout");
        }) as unknown as typeof fetch,
        onUnverified: (code) => reported.push(code),
      }),
    ).toBe(false);
    expect(await verifySocialSignupChallenge(settings, "x".repeat(2049), counted(passed()))).toBe(
      false,
    );
    expect(reported).toEqual([
      "SIGNUP_CHALLENGE_FAILED",
      "SIGNUP_CHALLENGE_UNAVAILABLE",
      "SIGNUP_CHALLENGE_FAILED",
      "SIGNUP_CHALLENGE_UNAVAILABLE",
      "SIGNUP_CHALLENGE_REQUIRED",
    ]);
    // No token, or the challenge is off: nothing to verify and nothing consumed.
    calls = 0;
    reported.length = 0;
    expect(await verifySocialSignupChallenge(settings, undefined, counted(passed()))).toBe(false);
    expect(await verifySocialSignupChallenge(settings, "", counted(passed()))).toBe(false);
    expect(
      await verifySocialSignupChallenge(
        { ...settings, signupChallengeEnabled: false },
        "valid",
        counted(passed()),
      ),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(reported).toEqual([]);
  });
  test("OAuth proof is provider and expiry bound and malformed state denies", () => {
    const now = Date.now();
    const state = JSON.stringify({
      opengeniSignupChallenge: { provider: "google", expiresAt: now + 600000 },
    });
    expect(oauthSignupChallengeVerified(state, "google", now)).toBe(true);
    expect(oauthSignupChallengeVerified(state, "github", now)).toBe(false);
    expect(oauthSignupChallengeVerified(state, "google", now + 600000)).toBe(false);
    expect(oauthSignupChallengeVerified(state, "google", now - 1)).toBe(false);
    expect(oauthSignupChallengeVerified("invalid", "google", now)).toBe(false);
  });
});
