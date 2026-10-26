import { toast } from "../../lib/toast";
import { notifyCreditBalanceChanged } from "../../lib/credit-balance-events";
import {
  waitForCheckoutCredits,
  type CheckoutPageReturn,
  type CreditCheckoutClient,
} from "../../lib/credit-checkout";
import { checkoutCreditsHeading } from "./checkout-credits-celebration";

/** Longest wait for a paid checkout's credits before saying they are still on the way. */
const CHECKOUT_RETURN_WAIT_MS = 10 * 60_000;

const followed = new Set<string>();

/**
 * Back from checkout on the page it started from (a chat or the new-chat
 * page): confirm in one short toast once the credits land, so the person can
 * send right away. The wait is not tied to the page, so sending a message
 * before the credits land still gets the confirmation.
 */
export function followCheckoutPageReturn(
  client: Pick<CreditCheckoutClient, "getBillingCheckout">,
  checkout: CheckoutPageReturn,
  wait: { signal?: AbortSignal | undefined; intervalMs?: number | undefined } = {},
): void {
  if (checkout.outcome === "cancelled") {
    // One id, so a second read of the same return (a remount) shows it once.
    toast("Checkout cancelled", { id: "checkout-cancelled", description: "No charge was made." });
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
