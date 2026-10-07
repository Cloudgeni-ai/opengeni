import { nestedPostgresSqlState } from "@opengeni/db";

import { isPostClaimDatabaseRecoveryCandidate } from "./errors";

export type SubscriptionCapacityArmingFailurePayload = {
  error: string;
  code: string;
  retryable: true;
  recovery: "user_message";
};

const PROVIDER_NAMES = { claude: "Claude", xai: "SuperGrok" } as const;

/**
 * Translate a failure to arm a durable capacity wait into an explicit,
 * user-visible turn failure instead of a generic activity failure.
 *
 * Returns null for structured database failures: those belong to the
 * exact-attempt database recovery path and must be rethrown unchanged. The
 * payload is secret-safe: it never includes the underlying error text, which
 * can carry row identifiers or provider diagnostics.
 *
 * Every other failure, including a permanent database rejection such as an
 * RLS/permission denial or a constraint violation, settles the turn as failed
 * with the session idle. `retryable` means only that a new user message may
 * try again; nothing retries automatically. Callers must report
 * `subscriptionCapacityArmingDiagnostic` to operators so the underlying class
 * and SQLSTATE are not lost behind the user-facing state.
 */
export function subscriptionCapacityArmingFailure(
  provider: keyof typeof PROVIDER_NAMES,
  error: unknown,
): SubscriptionCapacityArmingFailurePayload | null {
  if (isPostClaimDatabaseRecoveryCandidate(error)) return null;
  const name = PROVIDER_NAMES[provider];
  return {
    error:
      "No " +
      name +
      " subscription account is available, and this session could not be queued to wait for one. Send a message to try again.",
    code: provider + "_capacity_wait_unavailable",
    retryable: true,
    recovery: "user_message",
  };
}

export type SubscriptionCapacityArmingDiagnostic = {
  errorClass: string;
  errorCode: string;
  origin: "database" | "worker";
  sqlState?: string;
};

const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Class names only; some ORM errors keep the generic `name` "Error". */
function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  for (const candidate of [error.constructor?.name, error.name]) {
    if (candidate && candidate !== "Error" && SAFE_ERROR_CLASS.test(candidate)) return candidate;
  }
  return "Error";
}

/**
 * Operator-only facts about a wait that could not be armed: the error class
 * and, for database rejections, the SQLSTATE. Never message text, so it is
 * safe for worker logs; it must not enter the user-visible turn payload.
 */
export function subscriptionCapacityArmingDiagnostic(
  provider: keyof typeof PROVIDER_NAMES,
  error: unknown,
): SubscriptionCapacityArmingDiagnostic {
  const sqlState = nestedPostgresSqlState(error);
  return {
    errorClass: safeErrorClass(error),
    errorCode: provider + "_capacity_wait_unavailable",
    origin: sqlState ? "database" : "worker",
    ...(sqlState ? { sqlState } : {}),
  };
}
