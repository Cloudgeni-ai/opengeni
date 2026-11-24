import type { BillingSubscriptionCatalog, ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { planIncludesOwnSubscriptions } from "@opengeni/contracts/billing-origin";
import { formatCreditAmount } from "@opengeni/react/app/lib/onboarding-use-case";
import { subscriptionAction } from "@opengeni/react/app/lib/subscription-plans";
import { analyticsAction } from "@opengeni/react/ui/analytics-actions";
import { Button } from "@opengeni/react/ui/button";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

export type OnboardingPlan = BillingSubscriptionCatalog["plans"][number];

export type OnboardingPlanOffer = {
  /** The plan the step leads with: the cheapest paid plan sold here (Pro). */
  primary: OnboardingPlan;
  /** The next paid plan up (Max), offered as one quiet alternative. */
  alternative: OnboardingPlan | null;
};

/**
 * The paid plans a new organization can subscribe to from onboarding, from the
 * live catalog: never client constants. Null when the catalog sells none, or
 * its current plan can't start a checkout for them (already paid, Enterprise,
 * not active, or cancelling), by the same rule as Billing.
 */
export function onboardingPlanOffer(
  catalog: Pick<BillingSubscriptionCatalog, "plans" | "plan">,
): OnboardingPlanOffer | null {
  const current = catalog.plan;
  const paid = catalog.plans
    .filter(
      (plan) =>
        plan.selfService &&
        plan.monthlyPriceMicros !== null &&
        plan.monthlyPriceMicros > 0 &&
        (!current || subscriptionAction(current, catalog.plans, plan) === "checkout"),
    )
    .sort((a, b) => (a.monthlyPriceMicros ?? 0) - (b.monthlyPriceMicros ?? 0));
  const [primary, alternative] = paid;
  return primary ? { primary, alternative: alternative ?? null } : null;
}

/** A plan read slower than this shows the usual paths instead of waiting. */
export const PLAN_OFFER_TIMEOUT_MS = 5_000;

/**
 * Reads the subscription catalog once for the onboarding step. A deployment
 * without subscription plans (404), a failed or slow read or a client without
 * the method all mean no offer, so the step keeps its usual paths. The first
 * outcome wins, so the screen never switches under the person.
 */
export function useOnboardingPlanOffer(
  client: Pick<ChatClient<OpenGeniBrowserClient>, "getBillingSubscriptionPlans"> | undefined,
  organizationId: string,
  enabled: boolean,
): { loaded: boolean; offer: OnboardingPlanOffer | null } {
  const [state, setState] = useState<{
    key: string;
    offer: OnboardingPlanOffer | null;
  } | null>(null);
  const active = Boolean(enabled && client);
  useEffect(() => {
    if (!active || !client) return;
    let live = true;
    const settle = (offer: OnboardingPlanOffer | null) => {
      if (!live) return;
      live = false;
      setState({ key: organizationId, offer });
    };
    const timeout = setTimeout(() => settle(null), PLAN_OFFER_TIMEOUT_MS);
    Promise.resolve()
      .then(() => client.getBillingSubscriptionPlans({ accountId: organizationId }))
      .then(
        (catalog) => onboardingPlanOffer(catalog),
        () => null,
      )
      .then(settle);
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, [active, client, organizationId]);
  if (!active) return { loaded: true, offer: null };
  return state?.key === organizationId
    ? { loaded: true, offer: state.offer }
    : { loaded: false, offer: null };
}

function monthly(plan: OnboardingPlan): string {
  return formatCreditAmount(plan.monthlyPriceMicros ?? 0, "usd");
}

function seats(limit: number | null): string {
  if (limit === null) return "Unlimited seats";
  return limit === 1 ? "1 seat" : `${limit} seats`;
}

/** The plan onboarding leads with: its price, what it includes and one action. */
export function OnboardingPlanOfferCard({
  offer,
  ownSubscriptions,
  busyPlanKey,
  disabled,
  quiet = false,
  onSubscribe,
}: {
  offer: OnboardingPlanOffer;
  /** Whether this interface offers connecting your own AI subscriptions. */
  ownSubscriptions: boolean;
  busyPlanKey: string | null;
  disabled: boolean;
  /** An outline action, for screens whose primary action is something else. */
  quiet?: boolean;
  onSubscribe: (plan: OnboardingPlan) => void;
}) {
  const { primary, alternative } = offer;
  const includes = [
    primary.monthlyCreditMicros > 0
      ? `${formatCreditAmount(primary.monthlyCreditMicros, "usd")} in credit every month`
      : null,
    ownSubscriptions && planIncludesOwnSubscriptions(primary)
      ? "Use your own AI subscriptions, no fee"
      : null,
    seats(primary.seatLimit),
  ].filter((line): line is string => line !== null);
  return (
    <div
      className="rounded-lg border border-brand bg-brand/5 p-4"
      data-testid="onboarding-plan-offer"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-fg">{primary.label}</h2>
        <p className="m-0 text-sm text-fg-muted">
          <span className="text-lg font-semibold text-fg">{monthly(primary)}</span> / month
        </p>
      </div>
      <ul className="mt-3 grid gap-1.5 text-sm text-fg">
        {includes.map((line) => (
          <li key={line} className="flex items-center gap-2">
            <CheckIcon className="size-4 shrink-0 text-brand" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant={quiet ? "outline" : "default"}
        className="mt-4 w-full"
        disabled={disabled}
        onClick={() => onSubscribe(primary)}
        {...analyticsAction("upgrade_plan")}
      >
        {busyPlanKey === primary.key ? <Loader2Icon className="size-4 animate-spin" /> : null}
        Get {primary.label}
      </Button>
      {alternative ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 w-full text-fg-muted"
          disabled={disabled}
          onClick={() => onSubscribe(alternative)}
          {...analyticsAction("upgrade_plan")}
        >
          {busyPlanKey === alternative.key ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : null}
          Or {alternative.label} for {monthly(alternative)} / month
        </Button>
      ) : null}
    </div>
  );
}
