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
import { validTopupAmount } from "@/lib/format";

const DEFAULT_TOPUP = "25.00";

type CreditRequiredPromptProps = {
  open: boolean;
  workspaceId: string;
  accountId: string | null;
  canBuyCredits: boolean;
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
      toast.error("Checkout failed", {
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add OpenGeni credits to continue</DialogTitle>
          <DialogDescription>
            This chat uses OpenGeni credits and the organization balance is empty. Buy credits, or
            connect a model you already pay for.
          </DialogDescription>
        </DialogHeader>
        {canBuyCredits && stripeEnabled ? (
          <div className="grid gap-4">
            <CreditAmountPicker value={topupAmount} onChange={setTopupAmount} disabled={busy} />
            <Button
              type="button"
              disabled={busy || !validTopupAmount(topupAmount)}
              onClick={() => void buyCredits()}
            >
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CreditCardIcon className="size-4" />
              )}
              Buy credits
            </Button>
          </div>
        ) : !canBuyCredits ? (
          <p className="text-sm text-fg-muted">
            Ask an organization owner to add credits, or connect a model in workspace settings.
          </p>
        ) : null}
        <DialogFooter>
          <Button asChild type="button" variant="secondary">
            <Link
              to="/workspaces/$workspaceId/settings"
              params={{ workspaceId }}
              search={{ section: "models" }}
              onClick={() => onOpenChange(false)}
            >
              <SparklesIcon className="size-3.5" />
              Connect a model
            </Link>
          </Button>
        </DialogFooter>
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
        setEmpty(summary.balance.balanceMicros <= 0);
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
    <Notice tone="waiting" title="This model uses OpenGeni credits">
      The organization has no credits yet. Buy some or connect a model so the first chat can run.
      <div className="mt-2 flex flex-wrap gap-2">
        {canBuyCredits && stripeEnabled ? (
          <Button asChild type="button" size="sm">
            <Link
              to="/workspaces/$workspaceId/organization"
              params={{ workspaceId }}
              search={{ section: "billing" }}
            >
              <CreditCardIcon className="size-3.5" />
              Buy credits
            </Link>
          </Button>
        ) : null}
        <Button asChild type="button" size="sm" variant="secondary">
          <Link
            to="/workspaces/$workspaceId/settings"
            params={{ workspaceId }}
            search={{ section: "models" }}
          >
            Connect a model
          </Link>
        </Button>
      </div>
    </Notice>
  );
}
