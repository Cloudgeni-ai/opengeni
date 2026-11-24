import { toast } from "../../lib/toast";
import { notifyCreditBalanceChanged } from "../../lib/credit-balance-events";
import {
  waitForActivePlan,
  waitForCheckoutCredits,
  type CheckoutPageReturn,
  type CheckoutReturnClient,
} from "../../lib/credit-checkout";
import { checkoutCreditsHeading } from "./checkout-credits-celebration";

/** Longest wait for a paid checkout's credits or plan before saying it is still on the way. */
const CHECKOUT_RETURN_WAIT_MS = 10 * 60_000;

const followed = new Set<string>();

/**
 * Back from checkout on the page it started from (a chat or the new-chat
 * page): confirm in one short toast once the credits land, so the person can
 * send right away. The wait is not tied to the page, so sending a message
 * before the credits land still gets the confirmation.
 * A plan checkout (from Billing or onboarding) confirms the same way once
 * billing reports the plan active.
 */
export function followCheckoutPageReturn(
  client: CheckoutReturnClient,
  checkout: CheckoutPageReturn,
  wait: { signal?: AbortSignal | undefined; intervalMs?: number | undefined } = {},
): void {
  if (checkout.outcome === "cancelled") {
    // One id, so a second read of the same return (a remount) shows it once.
    toast("Checkout cancelled", { id: "checkout-cancelled", description: "No charge was made." });
    return;
  }
  if (checkout.outcome === "plan") {
    followPlanCheckoutReturn(client, checkout, wait);
    return;
  }
  const { accountId, checkoutSessionId } = checkout;
  if (followed.has(checkoutSessionId)) return;
  followed.add(checkoutSessionId);
  const toastId = `checkout-credits-${checkoutSessionId}`;
  toast.loading("Adding your credits…", { id: toastId });
  void waitForCheckoutCredits(client, {
    accountId,
    checkoutSessionId,
    signal: wait.signal ?? AbortSignal.timeout(CHECKOUT_RETURN_WAIT_MS),
    intervalMs: wait.intervalMs,
  })
    .then((status) => {
      if (status.credit.state === "granted") {
        notifyCreditBalanceChanged(accountId);
        toast.success(checkoutCreditsHeading(status), {
          id: toastId,
          description: "You're ready to send.",
          // The page may still be loading behind it after the trip to checkout.
          duration: 10_000,
        });
      } else {
        toast("Checkout expired", { id: toastId, description: "No charge was made." });
      }
    })
    .catch(() =>
      toast("Your payment is still processing", {
        id: toastId,
        description: "The credits appear in your balance as soon as it completes.",
      }),
    );
}

/**
 * The webhook that starts the subscription can land after the person does:
 * until billing reports the plan active, the toast says so without naming a
 * plan, then names the plan billing reports.
 */
function followPlanCheckoutReturn(
  client: Pick<CheckoutReturnClient, "getBilling">,
  checkout: Extract<CheckoutPageReturn, { outcome: "plan" }>,
  wait: { signal?: AbortSignal | undefined; intervalMs?: number | undefined },
): void {
  const { accountId, planKey } = checkout;
  const toastId = `checkout-plan-${accountId}-${planKey}`;
  if (followed.has(toastId)) return;
  followed.add(toastId);
  toast.loading("Activating your plan…", { id: toastId });
  void waitForActivePlan(client, {
    accountId,
    planKey,
    signal: wait.signal ?? AbortSignal.timeout(CHECKOUT_RETURN_WAIT_MS),
    intervalMs: wait.intervalMs,
  })
    .then((plan) => {
      // Billing refused the read (a stale or foreign link): nothing to confirm.
      if (!plan) {
        toast.dismiss(toastId);
        return;
      }
      // Plan credit changes the balance; Billing refreshes its plan with it.
      notifyCreditBalanceChanged(accountId);
      toast.success(`${plan.label} is active`, { id: toastId, duration: 10_000 });
    })
    .catch(() =>
      toast("Your payment is still processing", {
        id: toastId,
        description: "Your plan starts as soon as it completes.",
      }),
    );
}
