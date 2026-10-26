import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { useCallback, type ReactNode } from "react";
import {
  ClientPaymentPageActivity,
  PaymentPageActivityProvider,
} from "../../timeline/payment-page-card";
import { useAppContext } from "../app-context";
import { notifyCreditBalanceChanged } from "../lib/credit-balance-events";

/**
 * The app's chat page: a payment page an app action opened confirms its
 * credits in place through the app's client, like any conversation does
 * through its own (see ClientPaymentPageActivity), and here also refreshes
 * every balance the app shows.
 */
export function ChatPaymentPages({ children }: { children: ReactNode }) {
  const { client } = useAppContext();
  const onCredited = useCallback((status: BillingCheckoutStatus) => {
    if (status.balance) notifyCreditBalanceChanged(status.balance.accountId);
  }, []);
  return (
    <PaymentPageActivityProvider onCredited={onCredited}>
      <ClientPaymentPageActivity client={client}>{children}</ClientPaymentPageActivity>
    </PaymentPageActivityProvider>
  );
}
