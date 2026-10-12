import { VaultProviderError, type VaultProviderErrorCode } from "./contract";

/**
 * The 1Password SDK types only three errors (RateLimitExceededError,
 * AuthExpiredError, DesktopSessionExpiredError); everything else arrives as a
 * plain `Error(message)` whose text comes from the WASM core. This module is the
 * single place that turns those messages into provider error codes. The
 * substrings below were read from @1password/sdk-core 0.5.0 (core_bg.wasm) and
 * are pinned by the unit table in test/errors.test.ts.
 */
type MessageRule = { code: VaultProviderErrorCode; needles: readonly string[] };

export const ONEPASSWORD_MESSAGE_RULES: readonly MessageRule[] = [
  {
    code: "provider_rate_limited",
    needles: ["rate limit exceeded", "too many requests"],
  },
  {
    code: "provider_auth_invalid",
    needles: [
      "service account token had invalid format",
      "service account token base64 decoding failed",
      "service account deserialization failed",
      "invalid service account token",
      "service account token is invalid",
      "bad service account token",
      "prefix 'ops_' was expected",
      "throttle token is invalid",
      "account couldn't be found",
      "invalid sign-in address",
      "failed to authenticate",
    ],
  },
  {
    code: "provider_auth_expired",
    needles: ["you are not authenticated", "session expired"],
  },
  {
    code: "provider_conflict",
    needles: [
      "incorrect item version",
      "itemstatusincorrectitemversion",
      "a conflict occurred on the server",
      "data conflict occurred on the server",
    ],
  },
  {
    code: "provider_permission_denied",
    needles: [
      "you don't have the right permissions",
      // Live (2026-10-12): item update in a read-only vault.
      "you do not have the right permissions",
      "not sufficient permissions",
      "itemstatuspermissionerror",
      "permission denied",
    ],
  },
  {
    code: "provider_not_found",
    needles: [
      "resource not found",
      "itemnotfound",
      "vaultnotfound",
      "document not found in item",
      "file uuid not found",
      "file not found",
      "group not found",
    ],
  },
];

export type OnePasswordErrorClasses = {
  RateLimitExceededError?: abstract new (...args: never[]) => Error;
  AuthExpiredError?: abstract new (...args: never[]) => Error;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message ?? "";
  if (typeof error === "string") return error;
  return "";
}

function isNamed(error: unknown, name: string, cls?: abstract new (...args: never[]) => Error) {
  if (cls && error instanceof cls) return true;
  return error instanceof Error && error.constructor?.name === name;
}

const MINUTE = 60_000;

/**
 * 1Password reports two rate-limit scopes: the hourly per-token limit ("this
 * service account") and the daily per-account limit ("this 1Password
 * account"). When the message carries an explicit "retry in N <unit>", that
 * wins; otherwise fall back to a scope-shaped default.
 */
export function onePasswordRetryAfterMs(message: string): number {
  const lower = message.toLowerCase();
  const match = /retry (?:in|after) (\d+(?:\.\d+)?)\s*(second|sec|s|minute|min|m|hour|hr|h)/.exec(
    lower,
  );
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2] ?? "m";
    const factor = unit.startsWith("h") ? 60 * MINUTE : unit.startsWith("m") ? MINUTE : 1_000;
    return Math.max(1_000, Math.round(amount * factor));
  }
  if (lower.includes("1password account") || lower.includes("daily")) return 6 * 60 * MINUTE;
  if (lower.includes("service account") || lower.includes("hourly")) return 60 * MINUTE;
  return 15 * MINUTE;
}

/** Map a thrown SDK error to a provider error. Never includes token material. */
export function mapOnePasswordError(
  error: unknown,
  classes: OnePasswordErrorClasses = {},
): VaultProviderError {
  if (error instanceof VaultProviderError) return error;
  const message = errorMessage(error);
  if (isNamed(error, "RateLimitExceededError", classes.RateLimitExceededError)) {
    return new VaultProviderError(
      "provider_rate_limited",
      `1Password rate limit reached: ${message}`,
      onePasswordRetryAfterMs(message),
    );
  }
  if (isNamed(error, "AuthExpiredError", classes.AuthExpiredError)) {
    return new VaultProviderError(
      "provider_auth_expired",
      `1Password service account token expired: ${message}`,
    );
  }
  const code = classifyOnePasswordMessage(message);
  if (code === "provider_rate_limited") {
    return new VaultProviderError(
      code,
      `1Password rate limit reached: ${message}`,
      onePasswordRetryAfterMs(message),
    );
  }
  return new VaultProviderError(code, `1Password: ${message || "unknown error"}`);
}

export function classifyOnePasswordMessage(message: string): VaultProviderErrorCode {
  const lower = message.toLowerCase();
  for (const rule of ONEPASSWORD_MESSAGE_RULES) {
    if (rule.needles.some((needle) => lower.includes(needle))) return rule.code;
  }
  return "provider_unavailable";
}

/** True for errors after which a fresh SDK client (new sign-in) may succeed. */
export function isOnePasswordSessionError(error: VaultProviderError): boolean {
  return error.code === "provider_auth_expired" && !/token expired/i.test(error.message);
}
