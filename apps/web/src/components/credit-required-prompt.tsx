import { useCreditExposure } from "@/lib/use-analytics-exposure";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Link } from "@tanstack/react-router";
import { CreditCardIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CreditAmountPicker } from "@/components/credit-amount-picker";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import { validTopupAmount } from "@/lib/format";
import { analyticsAction } from "@/lib/analytics-actions";

const DEFAULT_TOPUP = "25.00";

type CreditRequiredPromptProps = {
  open: boolean;
  workspaceId: string;
  accountId: string | null;
  canBuyCredits: boolean;
  purpose?: "required" | "topup";
  onOpenChange: (open: boolean) => void;
};

export function CreditRequiredPrompt(props: CreditRequiredPromptProps) {
  return <CreditRequiredPromptView {...props} client={useAppContext().client} />;
}

export function CreditRequiredPromptView({
  client,
  open,
  workspaceId,
  accountId,
  canBuyCredits,
  purpose = "required",
  onOpenChange,
}: CreditRequiredPromptProps & { client: OpenGeniBrowserClient }) {
  const [topupAmount, setTopupAmount] = useState(DEFAULT_TOPUP);
  const [busy, setBusy] = useState(false);
  const [stripeEnabled, setStripeEnabled] = useState(false);

  useEffect(() => {
    if (!open || !accountId || !canBuyCredits) {
      setStripeEnabled(false);
      return;
    }
    let active = true;
    setStripeEnabled(false);
    void client
      .getBilling({ accountId })
      .then((billing) => {
        if (active) setStripeEnabled(billing.mode === "stripe");
      })
      .catch(() => {
        if (active) setStripeEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, canBuyCredits, client, open]);

  async function buyCredits(): Promise<void> {
    if (!accountId || !validTopupAmount(topupAmount) || busy) return;
    setBusy(true);
    try {
      const session = await client.createBillingCheckout({
        amountUsd: Number(topupAmount),
        accountId,
        successUrl: `${window.location.origin}/workspaces/${workspaceId}/organization?section=billing&checkout=success`,
        cancelUrl: `${window.location.origin}/workspaces/${workspaceId}/organization?section=billing&checkout=cancelled`,
      });
      window.location.assign(session.url);
    } catch (error) {
      toast.error("Checkout failed", { description: userErrorText(error) });
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {purpose === "topup" ? "Add Opengeni credits" : "Add Opengeni credits to continue"}
          </DialogTitle>
          <DialogDescription>
            {purpose === "topup"
              ? "Choose an amount, then enter a gift code or payment details in Stripe Checkout."
              : "This chat uses Opengeni credits and none are currently available. Buy credits, or connect a model you already pay for."}
          </DialogDescription>
        </DialogHeader>
        {canBuyCredits && stripeEnabled ? (
          <div className="grid gap-4">
            <CreditAmountPicker value={topupAmount} onChange={setTopupAmount} disabled={busy} />
            <p className="text-xs text-fg-subtle">
              For a gift code, select its stated credit value and enter the code in Stripe Checkout.
            </p>
            <Button
              type="button"
              variant={purpose === "topup" ? "default" : "outline"}
              disabled={busy || !validTopupAmount(topupAmount)}
              onClick={() => void buyCredits()}
              {...analyticsAction("buy_credits")}
            >
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CreditCardIcon className="size-4" />
              )}
              {purpose === "topup" ? "Continue to Stripe" : "Buy credits"}
            </Button>
          </div>
        ) : !canBuyCredits ? (
          <p className="text-sm text-fg-muted">
            Ask an organization owner to add credits, or an admin to connect a model.
          </p>
        ) : null}
        {purpose === "required" ? (
          <DialogFooter>
            <Button asChild type="button">
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "models", workspace: workspaceId }}
                onClick={() => onOpenChange(false)}
                {...analyticsAction("connect_model")}
              >
                <SparklesIcon className="size-3.5" />
                Connect a model
              </Link>
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function EmptyCreditsNotice({
  workspaceId,
  accountId,
  canBuyCredits,
  canReadBilling,
}: {
  workspaceId: string;
  accountId: string | null;
  canBuyCredits: boolean;
  canReadBilling: boolean;
}) {
  const client = useAppContext().client;
  const [empty, setEmpty] = useState(false);
  const [stripeEnabled, setStripeEnabled] = useState(false);

  useEffect(() => {
    setEmpty(false);
    setStripeEnabled(false);
    if (!accountId || !canReadBilling) return;
    let active = true;
    void client
      .getBilling({ accountId })
      .then((summary) => {
        if (!active) return;
        setEmpty(summary.mode !== "disabled" && summary.balance.balanceMicros <= 0);
        setStripeEnabled(summary.mode === "stripe");
      })
      .catch(() => {
        if (!active) return;
        setEmpty(false);
        setStripeEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, canReadBilling, client]);

  useCreditExposure(empty, workspaceId);
  if (!empty) return null;
  return (
    <Notice tone="waiting" title="This model uses Opengeni credits">
      No credits are available for this model. Buy some or connect a model to continue.
      <div className="mt-2 flex flex-wrap gap-2">
        {canBuyCredits && stripeEnabled ? (
          <Button asChild type="button" size="sm" variant="outline">
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId }}
              search={{ section: "billing" }}
              {...analyticsAction("buy_credits")}
            >
              <CreditCardIcon className="size-3.5" />
              Buy credits
            </Link>
          </Button>
        ) : null}
        <Button asChild type="button" size="sm">
          <Link
            to="/workspaces/$workspaceId/organization"
            params={{ workspaceId }}
            search={{ section: "models", workspace: workspaceId }}
            {...analyticsAction("connect_model")}
          >
            Connect a model
          </Link>
        </Button>
      </div>
    </Notice>
  );
}
