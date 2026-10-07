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
