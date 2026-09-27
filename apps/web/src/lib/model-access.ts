import { OpenGeniApiError } from "@opengeni/sdk/browser";

// Eager app-shell helper for model access. Onboarding selection, draft, and
// checkout logic lives in ./model-access-onboarding so it stays out of the
// initial and direct-session bundles.

export function isPaymentRequiredError(error: unknown): error is OpenGeniApiError {
  return (
    error instanceof OpenGeniApiError && error.status === 402 && error.code === "payment_required"
  );
}
