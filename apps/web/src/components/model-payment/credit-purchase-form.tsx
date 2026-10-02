import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CreditAmountPicker } from "@/components/credit-amount-picker";
import { Button } from "@/components/ui/button";
import { analyticsAction } from "@/lib/analytics-actions";
import { userErrorText } from "@/lib/api-error";
import { validTopupAmount } from "@/lib/format";

/**
 * Buy Opengeni credits: a package (or another amount, $5 to $10,000), then
 * Stripe Checkout. One form for onboarding, the out-of-credits prompt and
 * Organization > Models; Billing keeps its own row-sized control.
 */
export function CreditPurchaseForm({
  client,
  organizationId,
  successUrl,
  cancelUrl,
  primary = true,
  promotionCodes = false,
  disabled = false,
  beforeCheckout,
}: {
  client: OpenGeniBrowserClient | undefined;
  organizationId: string;
  /** Where Stripe returns after paying; defaults to Billing's confirmation. */
  successUrl?: string;
  cancelUrl?: string;
  primary?: boolean;
  /** Checkout accepts promotion codes: say where a gift code goes. */
  promotionCodes?: boolean;
  disabled?: boolean;
  /** Runs first, for example to pick the credits model the return selects. */
  beforeCheckout?: () => Promise<{ successUrl?: string } | void>;
}) {
  const [amount, setAmount] = useState("25.00");
  const [busy, setBusy] = useState(false);
  const valid = validTopupAmount(amount);
  const buy = async () => {
    if (!client || busy || !valid) return;
    setBusy(true);
    try {
      const prepared = (await beforeCheckout?.()) ?? {};
      const session = await client.createBillingCheckout({
        amountUsd: Number(amount),
        accountId: organizationId,
        ...((prepared.successUrl ?? successUrl)
          ? { successUrl: prepared.successUrl ?? successUrl }
          : {}),
        ...(cancelUrl ? { cancelUrl } : {}),
      });
      window.location.assign(session.url);
    } catch (error) {
      toast.error("Couldn't open checkout", { description: userErrorText(error) });
      setBusy(false);
    }
  };
  return (
    <div className="grid min-w-0 gap-3" data-credit-purchase="">
      <CreditAmountPicker value={amount} onChange={setAmount} disabled={busy || disabled} />
      <Button
        type="button"
        variant={primary ? "default" : "outline"}
        className="h-10 w-full"
        disabled={!client || busy || disabled || !valid}
        onClick={() => void buy()}
        {...analyticsAction("buy_credits")}
      >
        {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {valid
          ? `Buy $${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} in credits`
          : "Buy credits"}
        <ArrowUpRightIcon className="size-4" aria-hidden="true" />
      </Button>
      <p className="-mt-1 text-center text-xs text-fg-subtle">
        You pay in Stripe Checkout.
        {promotionCodes ? " Have a gift code? Enter it at checkout." : ""}
      </p>
    </div>
  );
}
