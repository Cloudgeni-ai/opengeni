// Kept apart from `credit-checkout.ts` so the app shell's route table can
// validate a Stripe return without pulling the checkout helpers into it.

/** A Stripe Checkout session id from a return URL, or null. */
export function parseCheckoutSessionId(value: unknown): string | null {
  return typeof value === "string" && /^cs_[A-Za-z0-9_]{1,250}$/.test(value) ? value : null;
}
