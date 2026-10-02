import { LockIcon } from "lucide-react";

import { CreditPurchaseForm } from "@/components/model-payment/credit-purchase-form";
import { useAppContext } from "@/context";
import { formatMoneyMicros } from "@/lib/format";
import {
  checkoutAcceptsPromotionCodes,
  CREDITS_ASK_OWNER_REASON,
  CREDITS_UNAVAILABLE_REASON,
  creditsPriceSentence,
} from "@/lib/model-payment";
import type { OrganizationCredits } from "@/lib/use-organization-credits";
import { cn } from "@/lib/utils";

/**
 * Opengeni credits, the same everywhere: what they cost, the balance (a trial
 * grant included), and either the package choice with Stripe Checkout or the
 * truthful reason it isn't possible here (no Stripe on this server; only an
 * owner can buy).
 */
export function OpengeniCreditsPanel({
  credits,
  organizationId,
  margin,
  successUrl,
  cancelUrl,
  primary = true,
  showPrice = true,
  showBalance = true,
  beforeCheckout,
  className,
}: {
  credits: Pick<OrganizationCredits, "billingMode" | "canBuy" | "balance">;
  organizationId: string;
  margin: string | null;
  successUrl?: string;
  cancelUrl?: string;
  primary?: boolean;
  /** The price sentence; off where the row above already says it. */
  showPrice?: boolean;
  /** The "$X of credits left" line; off where the page shows the balance itself. */
  showBalance?: boolean;
  beforeCheckout?: () => Promise<{ successUrl?: string } | void>;
  className?: string;
}) {
  const { client, clientConfig } = useAppContext();
  const balance = credits.balance;
  const positive = showBalance && balance !== null && balance.balanceMicros > 0;
  return (
    <div className={cn("grid min-w-0 gap-3", className)} data-opengeni-credits="">
      {showPrice || positive ? (
        <p className="text-xs leading-4.5 text-fg-muted">
          {positive ? (
            <span className="font-medium text-fg tabular-nums">
              {formatMoneyMicros(balance.balanceMicros, balance.currency)} of credits left.{" "}
            </span>
          ) : null}
          {showPrice ? creditsPriceSentence(margin) : null}
        </p>
      ) : null}
      {credits.billingMode !== "stripe" ? (
        <Unavailable>{CREDITS_UNAVAILABLE_REASON}</Unavailable>
      ) : !credits.canBuy ? (
        <Unavailable>{CREDITS_ASK_OWNER_REASON}</Unavailable>
      ) : (
        <CreditPurchaseForm
          client={client}
          organizationId={organizationId}
          primary={primary}
          promotionCodes={checkoutAcceptsPromotionCodes(clientConfig)}
          {...(successUrl ? { successUrl } : {})}
          {...(cancelUrl ? { cancelUrl } : {})}
          {...(beforeCheckout ? { beforeCheckout } : {})}
        />
      )}
    </div>
  );
}

function Unavailable({ children }: { children: string }) {
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted">
      <LockIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
