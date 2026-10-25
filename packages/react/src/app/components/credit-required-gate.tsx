import { lazy, Suspense, useEffect, useState } from "react";

import type { AccessContext } from "../types";
import { useAppContext } from "../app-context";
import { CHECKOUT_RETURN_QUERY, readCheckoutPageReturn } from "../lib/credit-checkout";
import { usePage } from "../lib/navigation";
import { hasAccountPermission } from "../lib/permissions";

const CreditRequiredPrompt = lazy(() =>
  import("./credit-required-prompt").then((module) => ({
    default: module.CreditRequiredPrompt,
  })),
);

export type CreditRequired = { workspaceId: string; accountId: string | null };

/**
 * The "add credits" prompt the app state raises when the API refuses work for
 * lack of credits. Every host that renders the session UI mounts it once,
 * beside its routes; buying credits needs `billing:manage` on the account.
 * It also confirms credits bought from the page checkout returns to.
 */
export function CreditRequiredGate(props: {
  creditRequired: CreditRequired | null;
  setCreditRequired: (value: CreditRequired | null) => void;
  accessContext: AccessContext | null;
}) {
  const { creditRequired, setCreditRequired, accessContext } = props;
  useCheckoutPageReturn();
  if (!creditRequired) return null;
  return (
    <Suspense fallback={null}>
      <CreditRequiredPrompt
        open
        workspaceId={creditRequired.workspaceId}
        accountId={creditRequired.accountId}
        canBuyCredits={
          Boolean(creditRequired.accountId) &&
          hasAccountPermission(accessContext, creditRequired.accountId ?? "", "billing:manage")
        }
        onOpenChange={(open) => {
          if (!open) setCreditRequired(null);
        }}
      />
    </Suspense>
  );
}

/**
 * Back from a checkout that started on this page: drop the return keys from
 * the address and confirm the credits. The query is read on the first render,
 * before a route rewrites its own keys.
 */
function useCheckoutPageReturn(): void {
  const page = usePage();
  const client = useAppContext().client;
  const [query] = useState(() => page.readQuery());
  useEffect(() => {
    if (!query.has(CHECKOUT_RETURN_QUERY.outcome)) return;
    const checkout = readCheckoutPageReturn(query);
    const current = page.readQuery();
    for (const key of Object.values(CHECKOUT_RETURN_QUERY)) current.delete(key);
    page.replaceQuery(current, { keepHistoryState: true });
    if (!checkout) return;
    void import("./credits/checkout-return").then(({ followCheckoutPageReturn }) =>
      followCheckoutPageReturn(client, checkout),
    );
    // Once per mount: the return is in the address the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
