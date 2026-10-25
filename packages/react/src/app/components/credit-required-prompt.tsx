import { useCreditExposure } from "../lib/use-analytics-exposure";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Link, usePage } from "../lib/navigation";
import { CreditCardIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import type { BillingCheckoutStatus, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { toast } from "../lib/toast";

import { CouponRedeem } from "./credits/coupon-redeem";
import { CreditsCelebrationDialog } from "./credits/checkout-credits-celebration";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { CreditAmountPicker } from "./credit-amount-picker";
import { Notice } from "../../ui/notice";
import { useAppContext } from "../app-context";
import { userErrorText } from "../../ui/api-error";
import { validTopupAmount } from "../lib/format";
import { analyticsAction } from "../../ui/analytics-actions";
import { checkoutPageReturnUrl, checkoutTabReturnUrl } from "../lib/credit-checkout";
import { subscriptionAction } from "../lib/subscription-plans";

const DEFAULT_TOPUP = "25.00";

type CreditRequiredPromptProps = {
  open: boolean;
  workspaceId: string;
  accountId: string | null;
  canBuyCredits: boolean;
  purpose?: "required" | "topup" | undefined;
  onOpenChange: (open: boolean) => void;
  /**
   * Runs before this page leaves for checkout, such as saving the composer's
   * draft now instead of after its autosave pause, so paying keeps it.
   */
  beforeLeave?: (() => Promise<unknown>) | undefined;
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
  beforeLeave,
}: CreditRequiredPromptProps & { client: OpenGeniBrowserClient }) {
  const page = usePage();
  const [topupAmount, setTopupAmount] = useState(DEFAULT_TOPUP);
  const [busy, setBusy] = useState(false);
  // A redeemed coupon, celebrated in this dialog with its real amount.
  const [granted, setGranted] = useState<BillingCheckoutStatus | null>(null);
  useEffect(() => {
    if (!open) setGranted(null);
  }, [open]);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [upgradeAccountId, setUpgradeAccountId] = useState<string | null>(null);
  const canUpgrade = open && canBuyCredits && accountId !== null && upgradeAccountId === accountId;

  useEffect(() => {
    setUpgradeAccountId(null);
    if (!open || !accountId || !canBuyCredits) {
      setStripeEnabled(false);
      return;
    }
    let active = true;
    setStripeEnabled(false);
    void client
      .getBilling({ accountId })
      .then(async (billing) => {
        if (active) setStripeEnabled(billing.mode === "stripe");
        if (!active || !billing.balance.plan || billing.mode !== "stripe") return;
        const catalog = await client.getBillingSubscriptionPlans({ accountId }).catch(() => null);
        if (
          active &&
          catalog?.plan &&
          catalog.plans.some((target) => {
            const action = subscriptionAction(billing.balance.plan!, catalog.plans, target);
            return action === "checkout" || action === "upgrade";
          })
        )
          setUpgradeAccountId(accountId);
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
        // Beside an embed, checkout ends on a page that asks to go back to it.
        // Otherwise it returns to this page (the chat, with its draft), which
        // confirms the credits.
        successUrl: page.opensBeside
          ? checkoutTabReturnUrl(page.origin(), "success")
          : checkoutPageReturnUrl(page.href(), accountId, "success"),
        cancelUrl: page.opensBeside
          ? checkoutTabReturnUrl(page.origin(), "cancelled")
          : checkoutPageReturnUrl(page.href(), accountId, "cancelled"),
      });
      // A failed save (a conflict, a dropped request) doesn't hold up checkout.
      if (!page.opensBeside) await beforeLeave?.().catch(() => undefined);
      page.assign(session.url);
      // The web app has left for checkout; an embed stays and can buy again.
      if (page.opensBeside) setBusy(false);
    } catch (error) {
      toast.error("Checkout failed", { description: userErrorText(error) });
      setBusy(false);
    }
  }

  if (granted) {
    return <CreditsCelebrationDialog status={granted} open={open} onOpenChange={onOpenChange} />;
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
              ? "Choose an amount and pay in Stripe Checkout, or redeem a coupon code."
              : "Add credits to use this model, or choose another model."}
          </DialogDescription>
        </DialogHeader>
        {canBuyCredits && stripeEnabled ? (
          <div className="grid gap-4">
            <CreditAmountPicker value={topupAmount} onChange={setTopupAmount} disabled={busy} />
            <Button
              type="button"
              disabled={busy || !validTopupAmount(topupAmount)}
              onClick={() => void buyCredits()}
              {...analyticsAction("buy_credits")}
            >
              {busy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <CreditCardIcon className="size-4" />
              )}
              {purpose === "topup" ? "Continue to Stripe" : "Add credits"}
            </Button>
            {accountId ? (
              <div className="border-t border-border pt-3">
                <CouponRedeem
                  client={client}
                  accountId={accountId}
                  workspaceId={workspaceId}
                  disabled={busy}
                  onGranted={setGranted}
                />
              </div>
            ) : null}
          </div>
        ) : !canBuyCredits ? (
          <p className="text-sm text-fg-muted">
            Ask an organization owner to add credits, or an admin to connect a model.
          </p>
        ) : null}
        {purpose === "required" ? (
          <DialogFooter>
            {/* Credits are the main action when they can be bought here. */}
            <Button
              asChild
              type="button"
              variant={canBuyCredits && stripeEnabled ? "outline" : "default"}
            >
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={
                  canUpgrade
                    ? { section: "billing" }
                    : { section: "models", workspace: workspaceId }
                }
                onClick={() => onOpenChange(false)}
                {...(canUpgrade ? {} : analyticsAction("connect_model"))}
              >
                {canUpgrade ? (
                  <CreditCardIcon className="size-3.5" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
                {canUpgrade ? "View upgrade options" : "Use your own provider account"}
              </Link>
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Before the person types: the selected model is paid with Opengeni credits
 * and none are left. Says so once, in plain words, with the one action that
 * fixes it; using your own provider account stays as a quiet second choice.
 */
export function EmptyCreditsNotice({
  workspaceId,
  accountId,
  canBuyCredits,
  canReadBilling,
  creditFunding,
  onAddCredits,
}: {
  workspaceId: string;
  accountId: string | null;
  canBuyCredits: boolean;
  canReadBilling: boolean;
  creditFunding?: WorkspaceModelCatalogModel["creditFunding"] | undefined;
  /** Opens the add-credits prompt on this page; without it, Add credits opens billing. */
  onAddCredits?: (() => void) | undefined;
}) {
  const client = useAppContext().client;
  const [legacyEmpty, setEmpty] = useState(false);
  // The balance is positive but this model can't use it (for example free
  // credit for other models), so "you don't have any" would be untrue. Only
  // that much is known, so the words claim no more.
  const [someCredit, setSomeCredit] = useState(false);
  const [stripeEnabled, setStripeEnabled] = useState(false);

  useEffect(() => {
    setEmpty(false);
    setSomeCredit(false);
    setStripeEnabled(false);
    if (!accountId || !canReadBilling) return;
    let active = true;
    void client
      .getBilling({ accountId })
      .then((summary) => {
        if (!active) return;
        setEmpty(summary.mode !== "disabled" && summary.balance.balanceMicros <= 0);
        setSomeCredit(summary.balance.balanceMicros > 0);
        setStripeEnabled(summary.mode === "stripe");
      })
      .catch(() => {
        if (!active) return;
        setEmpty(false);
        setSomeCredit(false);
        setStripeEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, canReadBilling, client]);

  const empty =
    stripeEnabled && (creditFunding === undefined ? legacyEmpty : creditFunding === "unavailable");
  useCreditExposure(empty, workspaceId);
  if (!empty) return null;
  const canAdd = canBuyCredits && stripeEnabled;
  const body = someCredit
    ? canAdd
      ? "This model can't use the Opengeni credits you have right now. Add credits, or choose another model."
      : "This model can't use your organization's Opengeni credits right now. Choose another model, or ask an organization owner to add credits."
    : canAdd
      ? "Chats here are paid with Opengeni credits, and you don't have any right now."
      : "Chats here are paid with Opengeni credits, and there are none left. Ask an organization owner to add some.";
  return (
    <Notice
      tone="waiting"
      title={
        canAdd
          ? someCredit
            ? "Add credits to use this model"
            : "Add credits to start chatting"
          : someCredit
            ? "Credits needed for this model"
            : "No credits left"
      }
    >
      {body}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {canAdd ? (
          onAddCredits ? (
            <Button
              type="button"
              size="sm"
              onClick={onAddCredits}
              {...analyticsAction("buy_credits")}
            >
              <CreditCardIcon className="size-3.5" />
              Add credits
            </Button>
          ) : (
            <Button asChild type="button" size="sm">
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "billing" }}
                {...analyticsAction("buy_credits")}
              >
                <CreditCardIcon className="size-3.5" />
                Add credits
              </Link>
            </Button>
          )
        ) : null}
        {/* Beside Add credits it is a quiet link, flush with the text when it wraps. */}
        <Button
          asChild
          type="button"
          size="sm"
          variant={canAdd ? "link" : "outline"}
          className={canAdd ? "px-0" : undefined}
        >
          <Link
            to="/workspaces/$workspaceId/organization"
            params={{ workspaceId }}
            search={{ section: "models", workspace: workspaceId }}
            {...analyticsAction("connect_model")}
          >
            Use your own provider account
          </Link>
        </Button>
      </div>
    </Notice>
  );
}
