import { lazy, Suspense } from "react";

import type { AccessContext } from "../types";
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
 */
export function CreditRequiredGate(props: {
  creditRequired: CreditRequired | null;
  setCreditRequired: (value: CreditRequired | null) => void;
  accessContext: AccessContext | null;
}) {
  const { creditRequired, setCreditRequired, accessContext } = props;
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
