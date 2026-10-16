import { useEffect, useRef, useState } from "react";
import type { BillingPlanBalance, BillingSubscriptionCatalog } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { FormDialog } from "@/components/ui/form-dialog";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import { UsageMeter } from "@/components/ui/usage-meter";
import { formatMoneyMicros } from "@/lib/format";
import { userErrorText } from "@/lib/api-error";
import {
  planDate,
  planSeats,
  subscriptionAction,
  type CatalogPlan,
  type PlanAction,
} from "@/lib/subscription-plans";

type Selection = { target: CatalogPlan; action: PlanAction; idempotencyKey: string };

/** Key this controller by the full organization admin identity. */
export function SubscriptionPlans({
  client,
  accountId,
  returnUrl,
  catalog,
  plan,
  canManage,
  onChanged,
  supportEmail,
}: {
  client: OpenGeniBrowserClient;
  accountId: string;
  returnUrl: string;
  catalog: BillingSubscriptionCatalog;
  plan: BillingPlanBalance;
  canManage: boolean;
  supportEmail?: string | null | undefined;
  onChanged: () => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(false);
  const inFlight = useRef(false);
  // Keep retry identity even when a confirmation is closed and reopened.
  const attempts = useRef(new Map<string, string>());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = catalog.plans.find((item) => item.key === plan.key);
  const reset = planDate(plan.periodResetAt);
  const next = catalog.plans.find(
    (item) =>
      subscriptionAction(plan, catalog.plans, item) ===
      (plan.key === "free" ? "checkout" : "upgrade"),
  );

  function choose(target: CatalogPlan, action: PlanAction) {
    const key = `${action}:${target.key}`;
    const idempotencyKey = attempts.current.get(key) ?? crypto.randomUUID();
    attempts.current.set(key, idempotencyKey);
    setSelection({ target, action, idempotencyKey });
    setError(null);
  }

  async function confirm() {
    if (!selection || !canManage || inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const request = {
      accountId,
      planKey: selection.target.key,
      idempotencyKey: selection.idempotencyKey,
    };
    try {
      if (selection.action === "checkout") {
        const result = await client.createSubscriptionCheckout({
          ...request,
          successUrl: returnUrl,
          cancelUrl: returnUrl,
        });
        if (live.current) window.location.assign(result.url);
      } else {
        const result =
          selection.action === "upgrade"
            ? await client.upgradeBillingSubscription(request)
            : selection.action === "downgrade"
              ? await client.changeBillingSubscription(request)
              : await client.cancelBillingSubscription({
                  accountId,
                  idempotencyKey: selection.idempotencyKey,
                });
        if (!live.current) return false;
        setNotice(
          selection.action === "upgrade"
            ? `Upgraded to ${selection.target.label}. Your new plan credit is available.`
            : `${selection.target.label} starts ${planDate(result.effectiveAt)}. Your current plan continues until then.`,
        );
        attempts.current.delete(`${selection.action}:${selection.target.key}`);
        setSelection(null);
        onChanged();
      }
    } catch (caught) {
      if (live.current) setError(userErrorText(caught));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
    return false;
  }

  async function portal() {
    if (!canManage || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await client.createSubscriptionPortalSession({ accountId, returnUrl });
      if (live.current) window.location.assign(result.url);
    } catch (caught) {
      if (live.current) setError(userErrorText(caught));
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }

  return (
    <>
      <Section title="Your plan">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xl font-semibold tracking-[-0.5px] text-fg">
                {plan.label}
                {current?.monthlyPriceMicros != null ? (
                  <span className="ml-3 text-sm font-normal text-fg-muted">
                    {formatMoneyMicros(current.monthlyPriceMicros, "usd")} / month
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-fg-muted">{planSeats(plan)}</p>
            </div>
            {canManage ? (
              <RowButton disabled={busy} onClick={() => void portal()}>
                Manage billing
              </RowButton>
            ) : null}
          </div>
          <UsageMeter
            label="Monthly plan credit"
            percent={
              plan.creditGrantedMicros > 0
                ? (plan.creditRemainingMicros / plan.creditGrantedMicros) * 100
                : 0
            }
            valueLabel={`${formatMoneyMicros(plan.creditRemainingMicros, "usd")} of ${formatMoneyMicros(plan.creditGrantedMicros, "usd")} left`}
            {...(reset ? { resetsLabel: reset } : {})}
          />
          {plan.cancelAtPeriodEnd ? (
            <Notice title="Cancellation scheduled">
              Your paid plan ends{reset ? ` ${reset}` : " at the end of this period"}. You'll move
              to Free. Top-up credit stays available.
            </Notice>
          ) : plan.status !== "active" ? (
            <Notice title="Your subscription needs attention">
              Manage billing to check your payment and subscription status.
            </Notice>
          ) : null}
          {notice ? (
            <Notice tone="success" live="polite">
              {notice}
            </Notice>
          ) : null}
          {error && !selection ? (
            <Notice tone="failed" live="assertive">
              {error}
            </Notice>
          ) : null}
        </div>
      </Section>
      <Section
        variant="open"
        title="Plans"
        description="Monthly plan credit is used first and doesn't roll over. When it runs out, usage continues on your other credit."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {catalog.plans.map((item) => {
            const action = subscriptionAction(plan, catalog.plans, item);
            const selected = item.key === plan.key;
            return (
              <div
                key={item.key}
                className={`flex min-w-0 flex-col gap-4 rounded-lg border p-4 ${selected ? "border-brand bg-brand/5" : "border-border"}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-fg">{item.label}</h3>
                  {selected ? (
                    <MetaChip>Current</MetaChip>
                  ) : item.key === "pro" ? (
                    <MetaChip>Popular</MetaChip>
                  ) : null}
                </div>
                <div>
                  <p className="text-xl font-semibold tracking-[-0.5px] text-fg">
                    {item.monthlyPriceMicros === null
                      ? "Let's talk"
                      : formatMoneyMicros(item.monthlyPriceMicros, "usd")}
                  </p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {item.monthlyPriceMicros === null ? "For your organization" : "per month"}
                  </p>
                </div>
                <div className="space-y-2 text-sm text-fg">
                  <p>
                    {item.key === "enterprise"
                      ? "Custom credit"
                      : `${formatMoneyMicros(item.monthlyCreditMicros, "usd")} monthly credit`}
                  </p>
                  <p>{item.seatLimit === null ? "Unlimited seats" : `${item.seatLimit} seats`}</p>
                  {item.monthlyPriceMicros &&
                  item.monthlyCreditMicros === item.monthlyPriceMicros * 10 ? (
                    <p className="text-xs text-fg-muted">10× prepaid credit</p>
                  ) : null}
                  {item.freeCredit ? (
                    <p className="text-xs text-fg-muted">Monthly credit for eligible accounts</p>
                  ) : null}
                </div>
                <div className="mt-auto pt-1">
                  {selected ? (
                    <p className="text-xs text-fg-muted">Your current plan</p>
                  ) : item.key === "enterprise" ? (
                    supportEmail ? (
                      <RowButton asChild>
                        <a href={`mailto:${supportEmail}?subject=Enterprise%20plan`}>Talk to us</a>
                      </RowButton>
                    ) : (
                      <p className="text-xs text-fg-muted">Contact your deployment operator</p>
                    )
                  ) : canManage && action ? (
                    <RowButton
                      className="w-full"
                      variant={item.key === next?.key ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => choose(item, action)}
                    >
                      {action === "checkout"
                        ? `Get ${item.label}`
                        : action === "upgrade"
                          ? `Upgrade to ${item.label}`
                          : action === "cancel"
                            ? "Cancel plan"
                            : `Downgrade to ${item.label}`}
                    </RowButton>
                  ) : (
                    <p className="text-xs text-fg-muted">
                      {!canManage
                        ? "Ask an owner to change plans"
                        : plan.cancelAtPeriodEnd
                          ? "Cancellation scheduled"
                          : !item.selfService && item.key !== "free"
                            ? "Not available for checkout yet"
                            : "Manage billing to change plans"}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>
      {selection ? (
        <FormDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) {
              setSelection(null);
              setError(null);
            }
          }}
          size="sm"
          title={
            selection.action === "cancel"
              ? "Cancel your paid plan?"
              : `${selection.action === "upgrade" ? "Upgrade" : selection.action === "downgrade" ? "Downgrade" : "Subscribe"} to ${selection.target.label}`
          }
          submitLabel={
            selection.action === "checkout"
              ? "Continue to checkout"
              : selection.action === "cancel"
                ? "Cancel at period end"
                : `${selection.action === "upgrade" ? "Upgrade" : "Downgrade"} to ${selection.target.label}`
          }
          pendingLabel="Confirming…"
          pending={busy}
          error={error}
          onSubmit={confirm}
        >
          <div className="space-y-3 text-sm leading-6 text-fg-muted">
            <p>
              {selection.action === "checkout"
                ? `Subscribe for ${formatMoneyMicros(selection.target.monthlyPriceMicros ?? 0, "usd")} per month. Review taxes and payment details in Stripe.`
                : selection.action === "upgrade"
                  ? `Your upgrade takes effect immediately at ${formatMoneyMicros(selection.target.monthlyPriceMicros ?? 0, "usd")} per month. Stripe prorates unused time on your current plan and charges the new period now; taxes may apply.`
                  : `Your current plan continues${reset ? ` until ${reset}` : " until the end of this period"}. ${selection.target.label} starts then.`}
            </p>
            {selection.action === "checkout" || selection.action === "upgrade" ? (
              <p>
                After payment, you'll receive{" "}
                {formatMoneyMicros(selection.target.monthlyCreditMicros, "usd")} in fresh plan
                credit. Unused credit from your old plan is replaced, not added.
              </p>
            ) : (
              <p>
                Unused monthly plan credit expires. Top-up credit stays available.
                {selection.target.seatLimit !== null
                  ? ` ${selection.target.label} allows ${selection.target.seatLimit} seats; existing people keep access, but you can't add more while over the limit.`
                  : ""}
              </p>
            )}
          </div>
        </FormDialog>
      ) : null}
    </>
  );
}
