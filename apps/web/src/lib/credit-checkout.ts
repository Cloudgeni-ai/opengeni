import type { BillingCheckoutStatus } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

// Buying or redeeming credits through Stripe Checkout without losing the page
// the person is on: checkout opens in a new tab, this page waits for the
// credits to land, then celebrates with the real amount. When the browser
// blocks the tab, checkout takes over this tab and returns to organization
// billing, which waits and celebrates the same way.

export type CreditCheckoutClient = Pick<
  OpenGeniBrowserClient,
  "createBillingCheckout" | "getBillingCheckout"
>;

/** Stripe replaces this placeholder in a success URL with the session id. */
export const CHECKOUT_SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

/** Organization billing, where a same-tab checkout returns and celebrates. */
export function billingCheckoutReturnUrl(
  origin: string,
  workspaceId: string,
  outcome: "success" | "cancelled",
): string {
  const base = `${origin}/workspaces/${encodeURIComponent(workspaceId)}/organization?section=billing&checkout=${outcome}`;
  // Appended raw: URL encoding would turn Stripe's placeholder into %7B…%7D.
  return outcome === "success" ? `${base}&checkoutSession=${CHECKOUT_SESSION_PLACEHOLDER}` : base;
}

/** The small static page a checkout tab lands on; it asks the person to go back. */
export function checkoutTabReturnUrl(origin: string, outcome: "success" | "cancelled"): string {
  return `${origin}/checkout-complete.html?checkout=${outcome}`;
}

/**
 * Open the checkout tab inside the click handler, before any await, so the
 * browser allows it. It shows a short message until checkout loads. Null when
 * the browser blocks new tabs.
 */
export function openCheckoutTab(): Window | null {
  let tab: Window | null = null;
  try {
    tab = window.open("", "_blank");
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    // Checkout never needs a handle back to this page.
    tab.opener = null;
    tab.document.title = "Opening checkout…";
    tab.document.body.style.cssText =
      "font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#5f5f5f";
    tab.document.body.textContent = "Opening secure checkout…";
  } catch {
    // A tab we can't write to still navigates.
  }
  return tab;
}

export type StartedCreditCheckout = {
  checkoutSessionId: string;
  url: string;
  /** False when the browser blocked the tab and checkout took over this page. */
  inNewTab: boolean;
};

/**
 * Start a checkout for credits: a fixed amount, a promotion code, or both. A
 * fixed-amount USD code sets the amount by itself. `tab` comes from
 * `openCheckoutTab()` in the same click; without one, this page navigates.
 */
export async function startCreditCheckout(
  client: CreditCheckoutClient,
  input: {
    accountId: string;
    workspaceId: string;
    amountUsd?: number | undefined;
    promotionCode?: string | undefined;
    tab: Window | null;
    origin?: string;
    navigate?: (url: string) => void;
  },
): Promise<StartedCreditCheckout> {
  const origin = input.origin ?? window.location.origin;
  const inNewTab = input.tab !== null;
  let session: Awaited<ReturnType<CreditCheckoutClient["createBillingCheckout"]>>;
  try {
    session = await client.createBillingCheckout({
      accountId: input.accountId,
      ...(input.amountUsd !== undefined ? { amountUsd: input.amountUsd } : {}),
      ...(input.promotionCode ? { promotionCode: input.promotionCode } : {}),
      successUrl: inNewTab
        ? checkoutTabReturnUrl(origin, "success")
        : billingCheckoutReturnUrl(origin, input.workspaceId, "success"),
      cancelUrl: inNewTab
        ? checkoutTabReturnUrl(origin, "cancelled")
        : billingCheckoutReturnUrl(origin, input.workspaceId, "cancelled"),
    });
  } catch (error) {
    input.tab?.close();
    throw error;
  }
  if (input.tab) {
    input.tab.location.href = session.url;
  } else {
    (input.navigate ?? ((url: string) => window.location.assign(url)))(session.url);
  }
  return { checkoutSessionId: session.checkoutSessionId, url: session.url, inNewTab };
}

/**
 * Poll one checkout until its credits are granted or it expires. Resolves with
 * the final status; rejects only when aborted. Transient read failures keep
 * polling.
 */
export async function waitForCheckoutCredits(
  client: Pick<CreditCheckoutClient, "getBillingCheckout">,
  input: {
    accountId: string;
    checkoutSessionId: string;
    signal: AbortSignal;
    intervalMs?: number;
    onStatus?: (status: BillingCheckoutStatus) => void;
  },
): Promise<BillingCheckoutStatus> {
  const interval = input.intervalMs ?? 2_000;
  for (;;) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("aborted");
    try {
      const status = await client.getBillingCheckout(input.checkoutSessionId, {
        accountId: input.accountId,
      });
      input.onStatus?.(status);
      if (status.credit.state === "granted" || status.status === "expired") return status;
    } catch {
      // Keep waiting through a dropped request; the checkout itself is unaffected.
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      input.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(input.signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}
