// The typed HTTP answers every provider's routes on the shared subscription
// core use (design docs/design/subscription-core-2026-10-07.md, 5.3).
// Provider-neutral.
import { ApiHttpError } from "../http/api-error";

/** `details.reason` of the 503 a provider's route answers while its cutover row is missing or disabled. */
export const SUBSCRIPTION_CORE_CUTOVER_DISABLED = "subscription_core_cutover_disabled";

/** The public error envelope with the core reason in `details.reason`. */
export function typedHttpError(status: 409 | 503, reason: string, message: string): ApiHttpError {
  return new ApiHttpError(status, {
    code: status === 503 ? "upstream_unavailable" : "conflict",
    message,
    retryable: status === 503,
    outcomeUnknown: false,
    details: { reason },
  });
}
