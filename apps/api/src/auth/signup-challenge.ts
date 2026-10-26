import { AsyncLocalStorage } from "node:async_hooks";
import type { Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import { APIError } from "better-auth/api";

const admission = new AsyncLocalStorage<boolean>();
export const SIGNUP_CHALLENGE_ACTION = "signup";
export function runWithSignupChallenge<T>(verified: boolean, operation: () => T): T {
  return admission.run(verified, operation);
}
export function requireSignupChallenge(settings: Settings): void {
  if (settings.signupChallengeEnabled && admission.getStore() !== true) {
    throw new APIError("FORBIDDEN", {
      code: "SIGNUP_CHALLENGE_REQUIRED",
      message: "signup_challenge_required",
    });
  }
}

function challengeError(status: 403 | 503, code: string, message: string): HTTPException {
  return new HTTPException(status, {
    res: Response.json({ code, message, retryable: status === 503 }, { status }),
  });
}

export function oauthSignupChallengeVerified(
  value: string,
  provider: string,
  now = Date.now(),
): boolean {
  try {
    const proof = JSON.parse(value)?.opengeniSignupChallenge;
    return (
      proof?.provider === provider &&
      typeof proof.expiresAt === "number" &&
      proof.expiresAt > now &&
      proof.expiresAt <= now + 600_000
    );
  } catch {
    return false;
  }
}

/** Cloudflare consumes tokens globally, so concurrent replicas cannot reuse a pass. */
export async function verifySignupChallenge(
  settings: Settings,
  token: unknown,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!settings.signupChallengeEnabled) return;
  if (typeof token !== "string" || !token.trim() || token.length > 2048) {
    throw challengeError(403, "SIGNUP_CHALLENGE_REQUIRED", "Complete the signup verification.");
  }
  let value: unknown;
  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: settings.signupChallengeSecretKey, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("verification unavailable");
    value = await response.json();
  } catch {
    throw challengeError(
      503,
      "SIGNUP_CHALLENGE_UNAVAILABLE",
      "Verification is unavailable. Please try again.",
    );
  }
  const result =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  // Siteverify can report a provider failure with HTTP 200. Keep this
  // retryable, distinct from a token the human needs to solve again.
  const errorCodes = result?.["error-codes"];
  if (
    typeof result?.success !== "boolean" ||
    (Array.isArray(errorCodes) &&
      errorCodes.some((code) =>
        ["internal-error", "missing-input-secret", "invalid-input-secret"].includes(code),
      ))
  ) {
    throw challengeError(
      503,
      "SIGNUP_CHALLENGE_UNAVAILABLE",
      "Verification is unavailable. Please try again.",
    );
  }
  const timestamp =
    typeof result?.challenge_ts === "string" ? Date.parse(result.challenge_ts) : NaN;
  if (
    result?.success !== true ||
    result.action !== SIGNUP_CHALLENGE_ACTION ||
    typeof result.hostname !== "string" ||
    !settings.signupChallengeHostnames
      .split(",")
      .map((v) => v.trim())
      .includes(result.hostname) ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 30_000 ||
    Date.now() - timestamp > 300_000
  ) {
    throw challengeError(
      403,
      "SIGNUP_CHALLENGE_FAILED",
      "Verification expired or failed. Please try again.",
    );
  }
}
