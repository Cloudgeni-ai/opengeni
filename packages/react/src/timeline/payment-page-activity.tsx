import type { BillingCheckoutStatus, OpenGeniClient } from "@opengeni/sdk";
import { createContext, useContext, useMemo, type ReactNode } from "react";

/*
 * How a chat checks the payments its payment page cards open. This lives
 * apart from the card so every conversation can provide it without loading
 * the card itself, which the timeline loads only when a chat shows one.
 */

/**
 * How the chat checks a credits payment the person makes from a payment page
 * card. Without it the card still opens the page; it just can't confirm.
 */
export type PaymentPageActivity = {
  /** Where one credits checkout stands (GET /v1/billing/checkout/:id). */
  readCheckout?:
    | ((input: {
        checkoutSessionId: string;
        accountId?: string | undefined;
        signal: AbortSignal;
      }) => Promise<BillingCheckoutStatus>)
    | undefined;
  /** The checkout's credits reached the balance, so balances shown elsewhere refresh. */
  onCredited?: ((status: BillingCheckoutStatus) => void) | undefined;
};

const PaymentPageActions = createContext<PaymentPageActivity>({});

/** How the payment page cards here check and report a payment. */
export function usePaymentPageActivity(): PaymentPageActivity {
  return useContext(PaymentPageActions);
}

/**
 * Set how payment page cards below check and report a payment. What this
 * provider leaves out comes from the one around it, so a host can add
 * `onCredited` around a chat that already checks payments itself.
 */
export function PaymentPageActivityProvider({
  children,
  readCheckout,
  onCredited,
}: PaymentPageActivity & { children: ReactNode }) {
  const outer = useContext(PaymentPageActions);
  const value = useMemo(
    () => ({
      readCheckout: readCheckout ?? outer.readCheckout,
      onCredited: onCredited ?? outer.onCredited,
    }),
    [readCheckout, onCredited, outer.readCheckout, outer.onCredited],
  );
  return <PaymentPageActions.Provider value={value}>{children}</PaymentPageActions.Provider>;
}

/**
 * A conversation's payment cards check payments through its own client
 * (the app's, or an embed's session proxy), unless a provider around the
 * conversation already says how. Clients without the billing read can't confirm.
 *
 * An agent's checkout is for the chat's organization unless it names another,
 * so a host that knows that organization passes it as `accountId`: without it
 * the read is for the person's default organization. (An embed's session proxy
 * already reads the chat workspace's organization whatever the browser sends.)
 * A host still finding out the chat's organization sets `accountPending`:
 * checks wait for it instead of asking the default organization and failing.
 */
export function ClientPaymentPageActivity({
  client,
  accountId: chatAccountId,
  accountPending = false,
  children,
}: {
  client: unknown;
  /** The chat's organization, for checkouts that don't name one. */
  accountId?: string | null | undefined;
  /** The chat's organization isn't known yet: checks wait until it is. */
  accountPending?: boolean | undefined;
  children: ReactNode;
}) {
  const readCheckout = useMemo((): PaymentPageActivity["readCheckout"] => {
    const reader = client as Partial<Pick<OpenGeniClient, "getBillingCheckout">> | null;
    if (typeof reader?.getBillingCheckout !== "function") return undefined;
    if (accountPending) {
      // Settles only when the card stops this check, which it does once the
      // organization is known and this reader is replaced.
      return ({ signal }) =>
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    }
    return ({ checkoutSessionId, accountId, signal }) => {
      const account = accountId ?? chatAccountId ?? undefined;
      return reader.getBillingCheckout!(checkoutSessionId, {
        ...(account ? { accountId: account } : {}),
        signal,
      });
    };
  }, [client, chatAccountId, accountPending]);
  const outer = useContext(PaymentPageActions);
  return (
    <PaymentPageActivityProvider readCheckout={outer.readCheckout ?? readCheckout}>
      {children}
    </PaymentPageActivityProvider>
  );
}
