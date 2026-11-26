import { useEffect } from "react";

import { useAppContext } from "@opengeni/react/app/app-context";
import { formatMoneyMicros } from "@opengeni/react/app/lib/format";
import { modelUsesCredits } from "@opengeni/react/app/lib/model-policy";
import { hasAccountPermission } from "@opengeni/react/app/lib/permissions";
import { CREDIT_BALANCE_CHANGED } from "@opengeni/react/app/lib/credit-balance-events";
import { invalidateSharedQueries, useSharedQuery } from "@opengeni/react/app/lib/shared-query";
import { billingSummaryQueryKey } from "@opengeni/react/app/lib/billing-summary-read";
import { creditBalanceSplitLabel } from "@opengeni/react/app/lib/credit-coverage";
import type { BillingSummary, ClientConfig } from "@opengeni/react/app/types";

/*
 * The organization's Opengeni credit balance, read by Settings > Models and by
 * the always-loaded rail's promotion review banner. It lives outside
 * components/models so the rail does not import the lazy settings-pages chunk.
 */

/** This deployment bills Opengeni credits: Stripe billing and at least one credit model. */
export function deploymentBillsCredits(config: Pick<ClientConfig, "billingMode" | "models">) {
  return config.billingMode === "stripe" && config.models.some((model) => modelUsesCredits(model));
}

export interface OpenGeniCredits {
  /** False on deployments without credits: no row, and credits don't count as a payer. */
  visible: boolean;
  /**
   * "$12.40 left", "No credits left", "$0.00 for any model · $100.00 for
   * selected models", or null while unknown or unreadable.
   */
  balanceLabel: string | null;
  /** Billing admins: the row opens organization Billing. */
  canOpenBilling: boolean;
  /** Public funding status, available only to an authorized billing reader. */
  promotionDecision?: BillingSummary["balance"]["promotionDecision"];
}

export function useOpenGeniCredits(organizationId: string | undefined): OpenGeniCredits {
  const { client, clientConfig, accessContext } = useAppContext();
  const visible = deploymentBillsCredits(clientConfig) && Boolean(organizationId);
  const accountId = organizationId ?? "";
  const canManage = visible && hasAccountPermission(accessContext, accountId, "billing:manage");
  const canRead =
    visible && (canManage || hasAccountPermission(accessContext, accountId, "billing:read"));
  // The billing summary is the same shared read as the chat's credit notices.
  // Operator reviews do not emit this browser's credit-change event. The
  // shared cache uses one visible-page timer per client/account, suspends
  // hidden tabs, and revalidates stale data when they become visible again.
  const summary = useSharedQuery(
    client,
    billingSummaryQueryKey(accountId),
    async () => await client.getBilling({ accountId }),
    { enabled: canRead, staleTimeMs: 60_000, pollIntervalMs: 60_000 },
  );
  const billing = summary.error ? null : summary.data;
  const stripe = billing?.mode === "stripe" ? billing : null;
  // Scoped credit only pays for some models: say how much any model can use.
  const split = stripe ? creditBalanceSplitLabel(stripe.balance) : null;
  const needsPlans = Boolean(stripe && !split && stripe.balance.plan);
  const plans = useSharedQuery(
    client,
    ["model-settings", "credits", accountId, "plans"],
    // A failed read is an error, not an empty catalog: the row falls back to
    // the basic label and the next poll reads it again.
    async () => await client.getBillingSubscriptionPlans({ accountId }),
    { enabled: canRead && needsPlans, staleTimeMs: 60_000, pollIntervalMs: 60_000 },
  );
  const balance = creditsBalance(
    stripe,
    split,
    needsPlans ? { loading: plans.loading, data: plans.error ? null : plans.data } : null,
  );
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ accountId: string }>).detail.accountId === accountId)
        void invalidateSharedQueries(client, ["model-settings", "credits", accountId]);
    };
    window.addEventListener(CREDIT_BALANCE_CHANGED, changed);
    return () => window.removeEventListener(CREDIT_BALANCE_CHANGED, changed);
  }, [client, accountId]);
  return {
    visible,
    balanceLabel: balance?.label ?? null,
    canOpenBilling: canManage,
    promotionDecision: canRead ? balance?.promotionDecision : undefined,
  };
}

/**
 * The row's words once everything they need is read: null while the summary
 * (or, for a plan, the plan catalog) is still loading or failed.
 */
function creditsBalance(
  billing: BillingSummary | null,
  split: string | null,
  plans: { loading: boolean; data: { plan?: unknown } | null } | null,
): {
  label: string | null;
  promotionDecision?: BillingSummary["balance"]["promotionDecision"];
} | null {
  if (!billing) return null;
  if (plans?.loading) return null;
  const { balanceMicros, currency } = billing.balance;
  let label =
    balanceMicros > 0 ? `${formatMoneyMicros(balanceMicros, currency)} left` : "No credits left";
  if (split) {
    label = split;
  } else if (billing.balance.plan && plans?.data?.plan) {
    const remaining = billing.balance.plan.creditRemainingMicros;
    // Credits: what API use spends, apart from plan credit (as on Billing).
    const credits = billing.balance.creditsMicros ?? balanceMicros - remaining;
    label = `${formatMoneyMicros(remaining, currency)} plan credit · ${formatMoneyMicros(credits, currency)} credits`;
  }
  return { label, promotionDecision: billing.balance.promotionDecision };
}
