import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CelebrationBurst } from "@/components/onboarding/celebration-burst";
import { CreditsPrize } from "@/components/onboarding/credits-prize";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { waitForCheckoutCredits, type CreditCheckoutClient } from "@/lib/credit-checkout";
import { formatCreditAmount } from "@/lib/onboarding-use-case";

/** "You got $100 in free credits" for a coupon, "You added $25 in credits" for a purchase. */
export function checkoutCreditsHeading(status: Pick<BillingCheckoutStatus, "credit">): string {
  const amount = formatCreditAmount(status.credit.amountMicros, status.credit.currency);
  return status.credit.free
    ? `You got ${amount} in free credits`
    : `You added ${amount} in credits`;
}

/**
 * After a same-tab Stripe return to organization billing: wait for that
 * checkout's credits to reach the balance, then celebrate them with the real
 * amount, the same prize and confetti as onboarding.
 */
export function CheckoutCreditsCelebration({
  client,
  accountId,
  checkoutSessionId,
}: {
  client: CreditCheckoutClient;
  accountId: string;
  checkoutSessionId: string;
}) {
  const [granted, setGranted] = useState<BillingCheckoutStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const toastId = `checkout-credits-${checkoutSessionId}`;
    toast.loading("Adding your credits…", { id: toastId });
    void waitForCheckoutCredits(client, { accountId, checkoutSessionId, signal: controller.signal })
      .then((status) => {
        toast.dismiss(toastId);
        if (status.credit.state === "granted") {
          setGranted(status);
          setOpen(true);
        } else {
          toast("Checkout expired", { description: "No charge was made." });
        }
      })
      .catch(() => toast.dismiss(toastId));
    return () => {
      controller.abort();
      toast.dismiss(toastId);
    };
  }, [accountId, checkoutSessionId, client]);

  if (!granted) return null;
  return <CreditsCelebrationDialog status={granted} open={open} onOpenChange={setOpen} />;
}

/** The credits celebration as a dialog: confetti, the prize with the real amount, and Done. */
export function CreditsCelebrationDialog({
  status,
  open,
  onOpenChange,
}: {
  status: BillingCheckoutStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      {open ? <CelebrationBurst /> : null}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <CreditsPrize
            amountMicros={status.credit.amountMicros}
            currency={status.credit.currency}
            label={status.credit.free ? "Coupon redeemed" : "Credits added"}
            caption={
              status.balance
                ? `Your balance is now ${formatCreditAmount(status.balance.balanceMicros, status.balance.currency)}`
                : undefined
            }
          />
          <DialogHeader>
            <DialogTitle>{checkoutCreditsHeading(status)}</DialogTitle>
            <DialogDescription>
              They're ready to use. New chats on Opengeni credits draw from this balance.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
