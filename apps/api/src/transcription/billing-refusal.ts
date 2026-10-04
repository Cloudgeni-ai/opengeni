import type { TranscriptionBillingRefusedError } from "@opengeni/core";
import type { Context } from "hono";

/**
 * Same body shape as session admission refusals (`code` + `message`, plus
 * allowance `scope`/`resetsAt`), so SDK/React clients classify it as a
 * definitive credit/allowance refusal rather than a retryable failure.
 */
export function transcriptionBillingRefusal(
  c: Context,
  error: TranscriptionBillingRefusedError,
): Response {
  return c.json({ code: error.code, message: error.message, ...error.details }, error.status);
}
