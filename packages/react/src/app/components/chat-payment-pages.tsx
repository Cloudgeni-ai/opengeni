import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { useCallback, type ReactNode } from "react";
import { PaymentPageActivityProvider } from "../../timeline/payment-page-card";
import { useAppContext } from "../app-context";
import { notifyCreditBalanceChanged } from "../lib/credit-balance-events";

/**
 * A payment page an app action opened in this chat confirms its credits in
 * place, in the app and in an embed alike, and refreshes every balance shown.
 */
export function ChatPaymentPages({ children }: { children: ReactNode }) {
  const { client } = useAppContext();
  const readCheckout = useCallback(
    (input: { checkoutSessionId: string; accountId?: string | undefined }) =>
      client.getBillingCheckout(
        input.checkoutSessionId,
        input.accountId ? { accountId: input.accountId } : {},
      ),
    [client],
  );
  const onCredited = useCallback((status: BillingCheckoutStatus) => {
    if (status.balance) notifyCreditBalanceChanged(status.balance.accountId);
  }, []);
  return (
    <PaymentPageActivityProvider readCheckout={readCheckout} onCredited={onCredited}>
      {children}
    </PaymentPageActivityProvider>
  );
}
