import { createContext, useContext, type ReactNode } from "react";

const PurchasePresentationContext = createContext(true);

/** A host can omit purchase prompts. This does not change billing permissions. */
export function PurchasePresentationProvider({
  children,
  showPurchasePrompts,
}: {
  children: ReactNode;
  showPurchasePrompts: boolean;
}) {
  const parent = useShowPurchasePrompts();
  return (
    <PurchasePresentationContext.Provider value={parent && showPurchasePrompts}>
      {children}
    </PurchasePresentationContext.Provider>
  );
}

export function useShowPurchasePrompts(): boolean {
  return useContext(PurchasePresentationContext);
}

const STRIPE_PAYMENT_HOSTS = new Set([
  "billing.stripe.com",
  "buy.stripe.com",
  "checkout.stripe.com",
  "invoice.stripe.com",
  "pay.stripe.com",
]);

/** Recognizes payment links that can also occur in a chat reply alongside a checkout card. */
export function isStripePaymentLink(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && STRIPE_PAYMENT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
