import { EmptyCompactionSummaryError, compactionProviderRejection } from "@opengeni/runtime";
import {
  classifyProviderQuotaExhaustionError,
  isCompactionSummaryFailure,
  shouldRecoverCompactionProviderFailure,
} from "./errors";
import { turnOperationCancellationFailure } from "./sandbox-provision";

/**
 * Why a portable checkpoint fell back to trimming history:
 * - `provider_rejected`: the provider definitively refused the summary request
 *   (HTTP 400, 413 or 422);
 * - `provider_failed`: another failure that retrying the same request cannot fix;
 * - `summary_unusable`: a response came back but held no usable summary, or no
 *   history fit the summary request.
 */
export type CompactionTrimFallbackReason =
  | "provider_rejected"
  | "provider_failed"
  | "summary_unusable";

/**
 * Whether a failed summary may be replaced by trimming history, and why.
 * Only a terminal summary failure qualifies: a retryable provider or capacity
 * failure keeps the same-turn retry, an exhausted quota would refuse the next
 * ordinary request too, and the attempt's own cancellation keeps propagating.
 * Structural only; the provider's message text is never classified.
 */
export function compactionTrimFallbackReason(
  error: unknown,
  cancellationSignal?: AbortSignal,
): CompactionTrimFallbackReason | null {
  if (cancellationSignal?.aborted === true) return null;
  if (turnOperationCancellationFailure(error) !== null) return null;
  if (!isCompactionSummaryFailure(error)) return null;
  if (shouldRecoverCompactionProviderFailure(error)) return null;
  if (classifyProviderQuotaExhaustionError(error)) return null;
  if (error instanceof EmptyCompactionSummaryError) return "summary_unusable";
  return compactionProviderRejection(error) ? "provider_rejected" : "provider_failed";
}
