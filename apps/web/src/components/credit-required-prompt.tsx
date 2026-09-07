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
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";

const DEFAULT_TOPUP = "25.00";

function validTopupAmount(value: string): boolean {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 5 && amount <= 10_000;
}

export function CreditRequiredPrompt({
  open,
  workspaceId,
  accountId,
  canBuyCredits,
  onOpenChange,
}: {
  open: boolean;
  workspaceId: string;
  accountId: string | null;
  canBuyCredits: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useAppContext().client;
  const [topupAmount, setTopupAmount] = useState(DEFAULT_TOPUP);
  const [busy, setBusy] = useState(false);

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
        {canBuyCredits ? (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              aria-label="Credit amount"
              type="number"
              min="5"
              max="10000"
              step="0.01"
              value={topupAmount}
              onChange={(event) => setTopupAmount(event.target.value)}
            />
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
        ) : (
          <p className="text-sm text-fg-muted">
            Ask an organization owner to add credits, or connect a model in workspace settings.
          </p>
        )}
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

  useEffect(() => {
    if (!accountId || !canReadBilling) return;
    let active = true;
    void client
      .getBilling({ accountId })
      .then((summary) => {
        if (!active) return;
        setEmpty(summary.balance.balanceMicros <= 0);
      })
      .catch(() => {
        if (!active) return;
        setEmpty(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, canReadBilling, client]);

  if (!empty) return null;
  return (
    <Notice
      tone="waiting"
      title="This model uses OpenGeni credits"
      action={
        <div className="flex flex-wrap gap-2">
          {canBuyCredits ? (
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
      }
    >
      The organization has no credits yet. Buy some or connect a model so the first chat can run.
    </Notice>
  );
}
