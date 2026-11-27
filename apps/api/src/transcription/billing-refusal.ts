import type { TranscriptionBillingRefusedError } from "@opengeni/core";
import type { Context } from "hono";
import { purchaseRefusalMessage } from "../http/native-purchase-presentation";

/**
 * Same body shape as session admission refusals (`code` + `message`, plus
 * allowance `scope`/`resetsAt`), so SDK/React clients classify it as a
 * definitive credit/allowance refusal rather than a retryable failure.
 */
export function transcriptionBillingRefusal(
  c: Context,
  error: TranscriptionBillingRefusedError,
  surface: "voice input" | "live voice",
  ios: boolean,
): Response {
  return c.json(
    {
      code: error.code,
      message: purchaseRefusalMessage(error.code, error.message, surface, ios),
      ...error.details,
    },
    error.status,
  );
}
