import { OpenGeniApiError } from "@opengeni/sdk/browser";

// Eager app-shell helper for model access. Onboarding selection, draft, and
// checkout logic lives in ./model-access-onboarding so it stays out of the
// initial and direct-session bundles.

export function isPaymentRequiredError(error: unknown): error is OpenGeniApiError {
  return (
    error instanceof OpenGeniApiError && error.status === 402 && error.code === "payment_required"
  );
}

/** A refusal only credits fix: the own-key platform fee, or API use. */
export type PaymentRefusalCode = "byok_paid_credit_required" | "api_credits_required";

/** Which credit a payment refusal needs, when it is more specific than "no credit". */
export function paymentRefusalCode(error: unknown): PaymentRefusalCode | null {
  if (!isPaymentRequiredError(error)) return null;
  const code = error.details?.code;
  return code === "byok_paid_credit_required" || code === "api_credits_required" ? code : null;
}
