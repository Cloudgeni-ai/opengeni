import type { OwnSubscriptionPlan, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { Link } from "../../lib/navigation";

import { Button } from "../../../ui/button";
import { Notice } from "../../../ui/notice";
import { analyticsAction } from "../../../ui/analytics-actions";

/**
 * The person's own subscriptions (Codex, Claude, SuperGrok) need a paid plan.
 * The catalog names that plan (`ownSubscriptionPlan`, `requiredPlan`) from
 * the plan catalog, so every sentence here reads its name and price from
 * there: "Using your own subscription needs Pro ($20/month)."
 */

/** "$20/month" from the plan catalog; null when the plan is custom-priced. */
export function planMonthlyPrice(plan: Pick<OwnSubscriptionPlan, "monthlyPriceMicros">) {
  if (plan.monthlyPriceMicros === null) return null;
  const whole = plan.monthlyPriceMicros % 1_000_000 === 0;
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    // "$20", never "US$20" in non-US locales.
    currencyDisplay: "narrowSymbol",
    ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(plan.monthlyPriceMicros / 1_000_000);
  return `${amount}/month`;
}

/** "Pro ($20/month)", or just "Pro" when custom-priced. */
export function planNameWithPrice(plan: OwnSubscriptionPlan): string {
  const price = planMonthlyPrice(plan);
  return price ? `${plan.label} (${price})` : plan.label;
}

/** The one sentence every surface uses: "Using your own subscription needs Pro ($20/month)." */
export function ownSubscriptionPlanSentence(plan: OwnSubscriptionPlan): string {
  return `Using your own subscription needs ${planNameWithPrice(plan)}.`;
}

type CatalogModel = Pick<
  WorkspaceModelCatalogModel,
  "requiredPlan" | "credentialReadiness" | "availability"
>;

/** A connected own subscription the picker lists that waits for a plan. */
function waitsForPlan(model: CatalogModel | undefined): model is CatalogModel & {
  requiredPlan: OwnSubscriptionPlan;
} {
  return Boolean(
    model?.requiredPlan &&
    (model.credentialReadiness?.status ?? "ready") === "ready" &&
    model.availability?.selectable !== false,
  );
}

/**
 * Which own-subscription notice the new-chat page shows, if any. The chosen
 * model waiting for a plan says so before Send, with no dismiss. Otherwise
 * anyone with such a subscription connected (including before this notice
 * existed) gets a one-time heads-up until they dismiss it.
 */
export function ownSubscriptionPlanNotice({
  selected,
  models,
  headsUpDismissed,
}: {
  selected: CatalogModel | undefined;
  models: readonly CatalogModel[];
  headsUpDismissed: boolean;
}): { plan: OwnSubscriptionPlan; dismissible: boolean } | null {
  if (waitsForPlan(selected)) return { plan: selected.requiredPlan, dismissible: false };
  if (headsUpDismissed) return null;
  const connected = models.find(waitsForPlan);
  return connected ? { plan: connected.requiredPlan, dismissible: true } : null;
}

/**
 * Said where a subscription is connected, above its sign-in: connecting
 * still works, and using it waits for the plan.
 */
export function OwnSubscriptionPlanNote({ plan }: { plan: OwnSubscriptionPlan }) {
  return (
    <Notice tone="info">
      <span data-testid="own-subscription-plan-note">{ownSubscriptionPlanSentence(plan)}</span>
    </Notice>
  );
}

/**
 * Above the new-chat composer while the organization's plan doesn't include
 * its own subscriptions and one of them is connected: when that model is
 * chosen (before Send, not after), or once as a heads-up that people who
 * connected one earlier may dismiss. One action: upgrade, or, for someone who
 * can't change the plan, who to ask.
 */
export function OwnSubscriptionPlanNotice({
  plan,
  workspaceId,
  canUpgrade,
  onDismiss,
}: {
  plan: OwnSubscriptionPlan;
  workspaceId: string;
  /** The viewer manages the organization's billing. */
  canUpgrade: boolean;
  /** The one-time heads-up hides for good; the notice for a chosen model has none. */
  onDismiss?: (() => void) | undefined;
}) {
  const price = planMonthlyPrice(plan);
  return (
    <Notice
      tone={onDismiss ? "info" : "waiting"}
      title={`Using your own subscription needs ${plan.label}`}
      {...(onDismiss ? { onDismiss } : {})}
    >
      <div data-testid="own-subscription-plan-notice">
        {canUpgrade ? (
          price ? (
            <span>{`${plan.label} is ${price}.`}</span>
          ) : null
        ) : (
          <span>{`Ask an organization owner to upgrade to ${plan.label}.`}</span>
        )}
        {canUpgrade ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <UpgradePlanButton workspaceId={workspaceId} planLabel={plan.label} />
          </div>
        ) : null}
      </div>
    </Notice>
  );
}

/** Opens billing, where the plan picker offers the plan. */
export function UpgradePlanButton({
  workspaceId,
  planLabel,
}: {
  workspaceId: string;
  planLabel: string;
}) {
  return (
    <Button asChild type="button" size="sm">
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId }}
        search={{ section: "billing" }}
        {...analyticsAction("upgrade_plan")}
      >
        {`Upgrade to ${planLabel}`}
      </Link>
    </Button>
  );
}
