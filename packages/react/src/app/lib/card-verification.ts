import type { ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { SANDBOX_CARD_REQUIRED_CODE } from "@opengeni/contracts";

// Card verification (docs/signup-abuse-protection.md, "Card verification"):
// a Free organization's owner adds a card through Stripe Checkout (no
// charge). Checkout returns to the page it started from, which confirms the
// card and continues what was refused.

export { SANDBOX_CARD_REQUIRED_CODE };

export type CardVerificationClient = Pick<
  ChatClient<OpenGeniBrowserClient>,
  | "getBillingCardVerification"
  | "createBillingCardVerificationSession"
  | "confirmBillingCardVerification"
>;

/** Raised (on `window`) when a surface is refused for a missing card. */
export const CARD_REQUIRED_EVENT = "opengeni:card-required";
/** Raised (on `window`) once a card is verified on return from checkout. */
export const CARD_VERIFIED_EVENT = "opengeni:card-verified";
export type CardRequiredDetail = { workspaceId: string; accountId: string | null };

export const CARD_RETURN_QUERY = {
  outcome: "cardVerification",
  account: "cardAccount",
  session: "cardSession",
} as const;

const VERIFIED_KEY = "opengeni:card-verified-at";
const VERIFIED_FRESH_MS = 10 * 60_000;

/** Whether an API error or turn failure is the missing-card refusal. */
export function isCardRequiredRefusal(value: unknown): boolean {
  if (value === SANDBOX_CARD_REQUIRED_CODE) return true;
  if (typeof value !== "object" || value === null) return false;
  const details = (value as { details?: unknown }).details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { code?: unknown }).code === SANDBOX_CARD_REQUIRED_CODE
  );
}

export function announceCardRequired(detail: CardRequiredDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CardRequiredDetail>(CARD_REQUIRED_EVENT, { detail }));
}

export function cardVerificationReturnUrl(
  href: string,
  accountId: string,
  outcome: "success" | "cancelled",
): string {
  const url = new URL(href);
  url.hash = "";
  for (const key of Object.values(CARD_RETURN_QUERY)) url.searchParams.delete(key);
  url.searchParams.set(CARD_RETURN_QUERY.outcome, outcome);
  url.searchParams.set(CARD_RETURN_QUERY.account, accountId);
  // Appended raw: URL encoding would turn Stripe's placeholder into %7B…%7D.
  return outcome === "success"
    ? `${url.toString()}&${CARD_RETURN_QUERY.session}={CHECKOUT_SESSION_ID}`
    : url.toString();
}

/** Opens Stripe Checkout for the card in this tab. */
export async function startCardVerification(
  client: CardVerificationClient,
  accountId: string,
): Promise<void> {
  const href = window.location.href;
  const { url } = await client.createBillingCardVerificationSession({
    accountId,
    idempotencyKey: crypto.randomUUID(),
    successUrl: cardVerificationReturnUrl(href, accountId, "success"),
    cancelUrl: cardVerificationReturnUrl(href, accountId, "cancelled"),
  });
  window.location.assign(url);
}

export type CardVerificationReturn =
  | { outcome: "success"; accountId: string; checkoutSessionId: string }
  | { outcome: "cancelled" };

export function readCardVerificationReturn(query: URLSearchParams): CardVerificationReturn | null {
  const outcome = query.get(CARD_RETURN_QUERY.outcome);
  if (outcome === "cancelled") return { outcome };
  if (outcome !== "success") return null;
  const accountId = query.get(CARD_RETURN_QUERY.account);
  const checkoutSessionId = query.get(CARD_RETURN_QUERY.session);
  if (!accountId || !checkoutSessionId || !/^cs_[A-Za-z0-9_]{1,250}$/u.test(checkoutSessionId)) {
    return null;
  }
  return { outcome, accountId, checkoutSessionId };
}

/** Remembers a fresh verification so the refused chat continues once. */
export function noteCardVerified(): void {
  try {
    window.sessionStorage.setItem(VERIFIED_KEY, String(Date.now()));
  } catch {
    // Storage may be unavailable; the person can retry by hand.
  }
  window.dispatchEvent(new Event(CARD_VERIFIED_EVENT));
}

/** True once after a fresh verification (and forgets it). */
export function takeCardVerified(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(VERIFIED_KEY));
    if (!at) return false;
    window.sessionStorage.removeItem(VERIFIED_KEY);
    return Date.now() - at < VERIFIED_FRESH_MS;
  } catch {
    return false;
  }
}
