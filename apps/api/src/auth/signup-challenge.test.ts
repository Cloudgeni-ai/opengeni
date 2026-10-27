import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  oauthSignupChallengeVerified,
  requireSignupChallenge,
  runWithSignupChallenge,
  verifySignupChallenge,
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
