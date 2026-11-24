import type { BillingCheckoutStatus, BillingPlanBalance } from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { PageHost } from "./navigation";

// Buying or redeeming credits through Stripe Checkout without losing the page
// the person is on: checkout opens in a new tab, this page waits for the
// credits to land, then celebrates with the real amount. When the browser
// blocks the tab, checkout takes over this tab and returns to organization
// billing, which waits and celebrates the same way. A purchase started from a
// chat returns to that chat instead (`checkoutPageReturnUrl`).

export type CreditCheckoutClient = Pick<
  ChatClient<OpenGeniBrowserClient>,
  "createBillingCheckout" | "getBillingCheckout"
>;

/** What the page a checkout returns to reads to confirm credits or a plan. */
export type CheckoutReturnClient = Pick<
  ChatClient<OpenGeniBrowserClient>,
  "getBillingCheckout" | "getBilling"
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
 * Query keys of a return to the page checkout started from. Organization
 * billing reads `checkoutSession` only beside its own `checkout=success`, so
 * it never handles this return a second time.
 */
export const CHECKOUT_RETURN_QUERY = {
  outcome: "checkoutReturn",
  account: "checkoutAccount",
  session: "checkoutSession",
  plan: "checkoutPlan",
} as const;

/**
 * The page checkout started from (a chat or the new-chat page), so paying
 * lands back where the person was, with their draft, instead of in settings.
 * The page confirms the credits from these query keys and removes them.
 */
export function checkoutPageReturnUrl(
  href: string,
  accountId: string,
  outcome: "success" | "cancelled",
): string {
  const url = new URL(href);
  url.hash = "";
  for (const key of Object.values(CHECKOUT_RETURN_QUERY)) url.searchParams.delete(key);
  url.searchParams.set(CHECKOUT_RETURN_QUERY.outcome, outcome);
  url.searchParams.set(CHECKOUT_RETURN_QUERY.account, accountId);
  // Appended raw: URL encoding would turn Stripe's placeholder into %7B…%7D.
  return outcome === "success"
    ? `${url.toString()}&${CHECKOUT_RETURN_QUERY.session}=${CHECKOUT_SESSION_PLACEHOLDER}`
    : url.toString();
}

export type CheckoutPageReturn =
  | { outcome: "success"; accountId: string; checkoutSessionId: string }
  | { outcome: "plan"; accountId: string; planKey: string }
  | { outcome: "cancelled" };

/**
 * Where a paid plan checkout returns: the page it started from (Billing or
 * onboarding), which says the plan is active once billing reports it. Only
 * the success URL carries these keys: a cancelled plan checkout returns to the
 * plain page and shows nothing new.
 */
export function planCheckoutReturnUrl(href: string, accountId: string, planKey: string): string {
  const url = new URL(href);
  url.hash = "";
  for (const key of Object.values(CHECKOUT_RETURN_QUERY)) url.searchParams.delete(key);
  url.searchParams.set(CHECKOUT_RETURN_QUERY.outcome, "success");
  url.searchParams.set(CHECKOUT_RETURN_QUERY.account, accountId);
  url.searchParams.set(CHECKOUT_RETURN_QUERY.plan, planKey);
  return url.toString();
}

/** The checkout return in a page query, or null when there is none or it is malformed. */
export function readCheckoutPageReturn(query: URLSearchParams): CheckoutPageReturn | null {
  const outcome = query.get(CHECKOUT_RETURN_QUERY.outcome);
  if (outcome === "cancelled") return { outcome };
  if (outcome !== "success") return null;
  const accountId = query.get(CHECKOUT_RETURN_QUERY.account);
  const planKey = query.get(CHECKOUT_RETURN_QUERY.plan);
  if (planKey !== null) {
    if (!accountId || !/^[A-Za-z0-9_-]{1,64}$/u.test(planKey)) return null;
    return { outcome: "plan", accountId, planKey };
  }
  const checkoutSessionId = query.get(CHECKOUT_RETURN_QUERY.session);
  if (!accountId || !checkoutSessionId || !/^cs_[A-Za-z0-9_]{1,250}$/u.test(checkoutSessionId))
    return null;
  return { outcome, accountId, checkoutSessionId };
}

/**
 * Open the checkout tab inside the click handler, before any await, so the
 * browser allows it. It shows a short message until checkout loads. Null when
 * the browser blocks new tabs.
 */
export function openCheckoutTab(page: Pick<PageHost, "openTab">): Window | null {
  // Checkout never needs a handle back to this page; `openTab` drops it.
  const tab = page.openTab();
  if (!tab) return null;
  try {
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
  /** False when checkout took over this page (the browser blocked the tab). */
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
    signal?: AbortSignal | undefined;
    /** The console origin the checkout returns to. */
    origin: string;
    /** Leaves for checkout when no tab was opened. */
    navigate: (url: string) => void;
    /** `navigate` opens checkout beside this page (an embed) instead of leaving it. */
    navigateOpensBeside?: boolean | undefined;
  },
): Promise<StartedCreditCheckout> {
  const { origin } = input;
  const inNewTab = input.tab !== null || input.navigateOpensBeside === true;
  let session: Awaited<ReturnType<CreditCheckoutClient["createBillingCheckout"]>>;
  try {
    input.signal?.throwIfAborted();
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
    // A late response must not navigate after leaving this account or form.
    input.signal?.throwIfAborted();
  } catch (error) {
    input.tab?.close();
    throw error;
  }
  if (input.tab) {
    input.tab.location.href = session.url;
  } else {
    input.navigate(session.url);
  }
  return { checkoutSessionId: session.checkoutSessionId, url: session.url, inNewTab };
}

/** Wait `ms`, or reject as soon as `signal` aborts, without leaving a listener behind. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
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
    intervalMs?: number | undefined;
    onStatus?: ((status: BillingCheckoutStatus) => void) | undefined;
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
    await pause(interval, input.signal);
  }
}

/** A refusal that waiting can't change: a bad, foreign or unreadable account. */
function refusedRead(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : null;
  return status === 400 || status === 401 || status === 403 || status === 404;
}

/**
 * Poll billing until the organization is on `planKey`, the plan is active and
 * its plan credit has landed. Stripe sends the subscription (the plan) and the
 * paid invoice (its credit) as separate webhooks in no fixed order; a plan
 * that stays creditless past `creditGraceMs` counts as ready, for plans
 * without credit. Resolves with that plan, so the confirmation names the plan
 * billing reports, never a guess; null when billing refuses the read. Rejects
 * only when aborted. Transient read failures keep polling.
 */
export async function waitForActivePlan(
  client: Pick<CheckoutReturnClient, "getBilling">,
  input: {
    accountId: string;
    planKey: string;
    signal: AbortSignal;
    intervalMs?: number | undefined;
    creditGraceMs?: number | undefined;
  },
): Promise<BillingPlanBalance | null> {
  const interval = input.intervalMs ?? 2_000;
  const creditGrace = input.creditGraceMs ?? 60_000;
  let activeSince: number | null = null;
  for (;;) {
    if (input.signal.aborted) throw input.signal.reason ?? new Error("aborted");
    try {
      const plan = (await client.getBilling({ accountId: input.accountId })).balance.plan;
      const active =
        plan?.key === input.planKey && (plan.status === "active" || plan.status === "trialing");
      activeSince = active ? (activeSince ?? Date.now()) : null;
      if (
        plan &&
        activeSince !== null &&
        (plan.creditGrantedMicros > 0 || Date.now() - activeSince >= creditGrace)
      )
        return plan;
    } catch (error) {
      if (refusedRead(error)) return null;
      // Keep waiting through a dropped request; the subscription itself is unaffected.
    }
    await pause(interval, input.signal);
  }
}

/** The checkout return in the address the app opened with, until the page reads it. */
let launchCheckoutReturn: URLSearchParams | null = null;

/**
 * Remember a checkout return from the address the app opened with, before a
 * route, a host redirect or an unfinished setup step rewrites the address.
 * The page that confirms checkouts reads it once it mounts.
 */
export function rememberCheckoutPageReturn(search: string): void {
  const query = new URLSearchParams(search);
  launchCheckoutReturn = query.has(CHECKOUT_RETURN_QUERY.outcome) ? query : null;
}

/** The remembered launch return, if it hasn't been confirmed yet. */
export function rememberedCheckoutPageReturn(): URLSearchParams | null {
  return launchCheckoutReturn;
}

/** Forget the launch return once a page has handled it. */
export function forgetCheckoutPageReturn(): void {
  launchCheckoutReturn = null;
}
