import { isLegacyBillingAccount, type Settings } from "@opengeni/config";
import {
  BYOK_PAID_CREDIT_REQUIRED_MESSAGE,
  BYOK_UPGRADE_REQUIRED_MESSAGE,
  type BillingBalance,
  type BillingOrigin,
  planIncludesOwnSubscriptions,
  type BillingPlanBalance,
} from "@opengeni/contracts";
import { getOrganizationPlanStanding, type Database } from "@opengeni/db";

/* ----------------------------------------------------------------------------
   Bring-your-own-key platform fee (docs/billing-origin.md).

   A call served by the person's own API key (a provider, gateway or custom
   endpoint key) costs Opengeni nothing upstream, so it pays a platform fee
   instead: `byokPlatformFeeBps` (default 500 = 5%) of the call's list-price
   equivalent. The fee is payable only from paid credit.

   A call served by the person's own subscription (Claude, Codex, SuperGrok)
   pays no fee: using one needs a paid plan of at least $20 a month instead
   (`ownSubscriptionPlanAllows`), which then covers unlimited use.
   -------------------------------------------------------------------------- */

/**
 * Who pays upstream for a call Opengeni does not: the person's own API key
 * (pays the platform fee) or their own subscription (needs a paid plan).
 */
export type OwnModelFunding = "api_key" | "subscription";

/**
 * Classify a served route from its accounting labels: a connected
 * subscription credential (or payer) is a subscription; any other route not
 * paid by the deployment is the person's own API key. `providerKind`
 * recognises accepted policies frozen before the Claude subscription routes
 * were relabelled (they carry workspace or organization labels).
 */
export function ownModelFunding(
  model:
    | {
        billing: { upstreamPayer: string };
        credentialSource: { kind: string };
      }
    | null
    | undefined,
  providerKind?: string | null,
): OwnModelFunding | null {
  if (!model) return null;
  if (
    model.credentialSource.kind === "connected_subscription" ||
    model.billing.upstreamPayer === "connected_subscription" ||
    (providerKind != null && providerKind.includes("subscription"))
  ) {
    return "subscription";
  }
  return model.billing.upstreamPayer === "deployment" ? null : "api_key";
}

/**
 * Is work of this billing origin refused connected subscriptions here? API
 * work is, unless the operator set `apiConnectedSubscriptionsEnabled`
 * (`OPENGENI_API_CONNECTED_SUBSCRIPTIONS_ENABLED`). Every admission, model
 * list and default check for API use of a subscription goes through this.
 */
export function connectedSubscriptionsRefusedForOrigin(
  settings: Partial<Pick<Settings, "apiConnectedSubscriptionsEnabled">>,
  billingOrigin: BillingOrigin | null | undefined,
): boolean {
  return billingOrigin === "api" && settings.apiConnectedSubscriptionsEnabled !== true;
}

/**
 * Does using the person's own subscription need a paid plan on this account?
 * Only with Stripe billing and subscription plans (people can buy one), and
 * never for an account on legacy billing terms (internal accounts).
 */
export function ownSubscriptionPlanRequired(
  settings: Pick<Settings, "billingMode" | "subscriptionPlansEnabled" | "billingLegacyAccountIds">,
  accountId: string | null | undefined,
): boolean {
  return (
    settings.billingMode === "stripe" &&
    settings.subscriptionPlansEnabled === true &&
    !isLegacyBillingAccount(settings, accountId)
  );
}

/**
 * A plan that includes the person's own subscriptions: a paid plan of at
 * least $20 a month (or custom-priced, like Enterprise) that is active or
 * trialing. Free, no plan, and a plan whose payment lapsed do not.
 */
export function planAllowsOwnSubscriptions(standing: {
  plan: Pick<BillingPlanBalance, "key" | "status"> | null;
  monthlyPriceMicros: number | null;
}): boolean {
  const { plan, monthlyPriceMicros } = standing;
  if (!plan || (plan.status !== "active" && plan.status !== "trialing")) return false;
  return planIncludesOwnSubscriptions({ key: plan.key, monthlyPriceMicros });
}

/** Admission read: may this account use its own subscriptions? */
export async function ownSubscriptionPlanAllows(
  db: Database,
  settings: Pick<Settings, "billingMode" | "subscriptionPlansEnabled" | "billingLegacyAccountIds">,
  accountId: string,
): Promise<boolean> {
  if (!ownSubscriptionPlanRequired(settings, accountId)) return true;
  return planAllowsOwnSubscriptions(await getOrganizationPlanStanding(db, accountId));
}

/**
 * List rate for a custom endpoint with no reviewed list price, in USD micros
 * per million tokens: a mid-tier frontier rate ($1.25 input, $10 output), so
 * an unpriced model is never free and never priced like the most expensive.
 * Cached and cache-write tokens count as input.
 */
export const BYOK_FALLBACK_LIST_RATE = Object.freeze({
  inputMicrosPerMillionTokens: 1_250_000,
  outputMicrosPerMillionTokens: 10_000_000,
});

/**
 * Is the fee charged for this account? Only with Stripe billing (people can
 * buy the credit it needs) and a positive rate, and never for an account on
 * legacy billing terms (internal accounts: CloudGeni and our own team). Hosts
 * that bind their own entitlements are charged like everyone else.
 */
export function byokPlatformFeeActive(
  settings: Pick<Settings, "billingMode" | "byokPlatformFeeBps" | "billingLegacyAccountIds">,
  accountId: string | null | undefined,
): boolean {
  return (
    settings.billingMode === "stripe" &&
    (settings.byokPlatformFeeBps ?? 0) > 0 &&
    !isLegacyBillingAccount(settings, accountId)
  );
}

/**
 * The list-price equivalent of one bring-your-own-key call: the model's
 * reviewed list price when it has one; else a positive provider-reported
 * cost (a gateway can report $0 on the person's own upstream key); else the
 * fallback rate on the tokens the provider reported.
 */
export function byokListEquivalent(input: {
  listPriceMicros: number | null;
  reportedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): { listMicros: number; source: "list_price" | "reported_cost" | "fallback_rate" } {
  if (input.listPriceMicros !== null && input.listPriceMicros > 0) {
    return { listMicros: input.listPriceMicros, source: "list_price" };
  }
  if (input.reportedCostMicros !== null && input.reportedCostMicros > 0) {
    return { listMicros: input.reportedCostMicros, source: "reported_cost" };
  }
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const outputTokens = Math.max(0, input.outputTokens ?? 0);
  return {
    listMicros: Math.ceil(
      (inputTokens * BYOK_FALLBACK_LIST_RATE.inputMicrosPerMillionTokens +
        outputTokens * BYOK_FALLBACK_LIST_RATE.outputMicrosPerMillionTokens) /
        1_000_000,
    ),
    source: "fallback_rate",
  };
}

/** The fee in USD micros, rounded up so a priced call is never fee-free. */
export function byokPlatformFeeMicros(listMicros: number, bps: number): number {
  if (!Number.isFinite(listMicros) || listMicros <= 0 || bps <= 0) return 0;
  return Math.ceil((listMicros * bps) / 10_000);
}

/**
 * What an own-key refusal tells the person: on the Free plan in the app,
 * upgrading is the fix; otherwise (a paid plan, top-ups, any API use) adding
 * credits is.
 */
export function byokPaidCreditRefusalMessage(
  balance: Pick<BillingBalance, "plan">,
  origin: BillingOrigin,
): string {
  return origin === "app" && balance.plan?.key === "free"
    ? BYOK_UPGRADE_REQUIRED_MESSAGE
    : BYOK_PAID_CREDIT_REQUIRED_MESSAGE;
}
