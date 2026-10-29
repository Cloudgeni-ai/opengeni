import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { CreditRefusalKind } from "../../lib/format";

// Eager app-shell helper for model access. Onboarding selection, draft, and
// checkout logic lives in ./model-access-onboarding so it stays out of the
// initial and direct-session bundles.

export function isPaymentRequiredError(error: unknown): error is OpenGeniApiError {
  return (
    error instanceof OpenGeniApiError && error.status === 402 && error.code === "payment_required"
  );
}

/** A refusal one action fixes: Upgrade to Pro (own key on Free) or Add credits. */
export type PaymentRefusalCode = CreditRefusalKind;

/** What a chat route keeps about a credit refusal of a Send, for its notice. */
export type CreditRefusalRecord<Scope> = Scope & {
  model: string;
  message: string;
  code: PaymentRefusalCode | null;
};

/** The notice record for a payment refusal of a Send, or null for any other error. */
export function creditRefusalRecord<Scope extends object>(
  error: unknown,
  scope: Scope,
  model: string,
): CreditRefusalRecord<Scope> | null {
  if (!isPaymentRequiredError(error)) return null;
  return { ...scope, model, message: error.message, code: paymentRefusalCode(error) };
}

/** Which credit a payment refusal needs, when it is more specific than "no credit". */
export function paymentRefusalCode(error: unknown): PaymentRefusalCode | null {
  if (!isPaymentRequiredError(error)) return null;
  const details = error.details as { code?: unknown; action?: { type?: unknown } } | undefined;
  if (details?.code === "api_credits_required") return "api_credits_required";
  if (details?.code !== "byok_paid_credit_required") return null;
  // On the Free plan the server offers Upgrade to Pro as the fix.
  return details.action?.type === "upgrade_plan" ? "byok_upgrade_required" : details.code;
}
