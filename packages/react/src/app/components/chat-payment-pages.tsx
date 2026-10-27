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
export function ChatPaymentPages({
  accountId,
  children,
}: {
  /**
   * The chat's organization: an agent's checkout is for it unless it names
   * another. Undefined while the chat is still loading, so no check goes to
   * another organization in the meantime.
   */
  accountId: string | undefined;
  children: ReactNode;
}) {
  const { client } = useAppContext();
  const onCredited = useCallback((status: BillingCheckoutStatus) => {
    if (status.balance) notifyCreditBalanceChanged(status.balance.accountId);
  }, []);
  return (
    <PaymentPageActivityProvider onCredited={onCredited}>
      <ClientPaymentPageActivity
        client={client}
        accountId={accountId}
        accountPending={accountId === undefined}
      >
        {children}
      </ClientPaymentPageActivity>
    </PaymentPageActivityProvider>
  );
}
