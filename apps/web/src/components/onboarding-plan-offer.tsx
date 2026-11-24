import type { BillingSubscriptionCatalog, ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { planIncludesOwnSubscriptions } from "@opengeni/contracts/billing-origin";
import { formatCreditAmount } from "@opengeni/react/app/lib/onboarding-use-case";
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
 * the organization already has a paid or operator-assigned plan.
 */
export function onboardingPlanOffer(
  catalog: Pick<BillingSubscriptionCatalog, "plans" | "plan">,
): OnboardingPlanOffer | null {
  if (catalog.plan && catalog.plan.key !== "free") return null;
  const paid = catalog.plans
    .filter(
      (plan) =>
        plan.selfService && plan.monthlyPriceMicros !== null && plan.monthlyPriceMicros > 0,
    )
    .sort((a, b) => (a.monthlyPriceMicros ?? 0) - (b.monthlyPriceMicros ?? 0));
  const [primary, alternative] = paid;
  return primary ? { primary, alternative: alternative ?? null } : null;
}

/**
 * Reads the subscription catalog once for the onboarding step. A deployment
 * without subscription plans (404), a failed read or a client without the
 * method all mean no offer, so the step keeps its usual paths.
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
    Promise.resolve()
      .then(() => client.getBillingSubscriptionPlans({ accountId: organizationId }))
      .then(
        (catalog) => onboardingPlanOffer(catalog),
        () => null,
      )
      .then((offer) => {
        if (live) setState({ key: organizationId, offer });
      });
    return () => {
      live = false;
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

/** The plan onboarding leads with: its price, what it includes and one action. */
export function OnboardingPlanOfferCard({
  offer,
  ownSubscriptions,
  busyPlanKey,
  disabled,
  onSubscribe,
}: {
  offer: OnboardingPlanOffer;
  /** Whether this interface offers connecting your own AI subscriptions. */
  ownSubscriptions: boolean;
  busyPlanKey: string | null;
  disabled: boolean;
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
    primary.seatLimit === null ? "Unlimited seats" : `${primary.seatLimit} seats`,
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
