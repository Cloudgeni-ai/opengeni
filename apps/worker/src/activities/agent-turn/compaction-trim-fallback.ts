import {
  CompactionProviderResponseError,
  EmptyCompactionSummaryError,
  compactionProviderRejection,
} from "@opengeni/runtime";
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
 * - `provider_failed`: the provider answered with a failed or incomplete
 *   response whose code is not a temporary condition;
 * - `summary_unusable`: a response came back but held no usable summary, no
 *   history fit the summary request, or the summary was too long to install.
 */
export type CompactionTrimFallbackReason =
  | "provider_rejected"
  | "provider_failed"
  | "summary_unusable";

/** Response codes of a temporary provider condition, which a later request may not meet. */
const TEMPORARY_RESPONSE_CODE =
  /server_error|rate_limit|overload|timeout|timed_out|unavailable|internal|capacity|quota|temporar|busy/i;

/**
 * Whether a failed summary may be replaced by trimming history, and why.
 * Only a failure that repeating the same request cannot fix, and that leaves
 * the chat's model usable for ordinary requests, qualifies: a definitive
 * rejection of this request, a failed or incomplete response with a
 * non-temporary code, or an unusable summary. Anything else keeps its existing
 * handling and history stays as it was: a retryable provider or capacity
 * failure keeps the same-turn retry; an exhausted quota, an authentication,
 * permission or missing-model refusal (401, 403, 404) or any other HTTP status
 * would refuse the next ordinary request too; a transport failure with no
 * response may pass on its own; and the attempt's own cancellation keeps
 * propagating. Structural only; the provider's message text is never
 * classified.
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
  if (compactionProviderRejection(error)) return "provider_rejected";
  if (!(error instanceof CompactionProviderResponseError)) return null;
  const diagnostics = error.diagnostics;
  // Any other HTTP status, or none at all (a transport failure), is not this
  // request's own fault.
  if (diagnostics.httpStatus !== undefined && diagnostics.httpStatus !== null) return null;
  const responseStatus = diagnostics.responseStatus;
  const code = typeof diagnostics.code === "string" ? diagnostics.code : null;
  if (code && TEMPORARY_RESPONSE_CODE.test(code)) return null;
  if (responseStatus === "incomplete") return "provider_failed";
  if (responseStatus === "failed" && code) return "provider_failed";
  return null;
}
