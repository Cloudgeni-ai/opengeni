import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { ListRow } from "@opengeni/react/ui/list-row";
import { OpenGeniCreditsTile } from "@opengeni/react/app/components/models/provider-mark";
import { useAppContext } from "@opengeni/react/app/app-context";
import { formatMoneyMicros } from "@opengeni/react/app/lib/format";
import { modelUsesCredits } from "@opengeni/react/app/lib/model-policy";
import { hasAccountPermission } from "@opengeni/react/app/lib/permissions";
import { currentPageReturnTo, returnToSearch } from "@opengeni/react/app/lib/return-to";
import { CREDIT_BALANCE_CHANGED } from "@opengeni/react/app/lib/credit-balance-events";
import { invalidateSharedQueries, useSharedQuery } from "@opengeni/react/app/lib/shared-query";
import { creditBalanceSplitLabel } from "@opengeni/react/app/lib/credit-coverage";
import type { BillingSummary, ClientConfig } from "@opengeni/react/app/types";

/* ----------------------------------------------------------------------------
   Opengeni credits in Settings > Models: on a deployment that bills credits,
   the organization's credit balance pays for credit models, so it is the
   first row of the Accounts list. Billing admins open organization Billing
   from it; everyone else sees a plain row.
   -------------------------------------------------------------------------- */

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
  const balance = useSharedQuery(
    client,
    ["model-settings", "credits", accountId],
    async () => {
      const billing = await client.getBilling({ accountId });
      if (billing.mode !== "stripe") return { label: null };
      const { balanceMicros, currency } = billing.balance;
      let label =
        balanceMicros > 0
          ? `${formatMoneyMicros(balanceMicros, currency)} left`
          : "No credits left";
      // Scoped credit only pays for some models: say how much any model can use.
      const split = creditBalanceSplitLabel(billing.balance);
      if (split) {
        label = split;
      } else if (billing.balance.plan) {
        const catalog = await client.getBillingSubscriptionPlans({ accountId }).catch(() => null);
        if (catalog?.plan) {
          const remaining = billing.balance.plan.creditRemainingMicros;
          label = `${formatMoneyMicros(remaining, currency)} plan credit · ${formatMoneyMicros(balanceMicros - remaining, currency)} other credit`;
        }
      }
      return { label, promotionDecision: billing.balance.promotionDecision };
    },
    // Operator reviews do not emit this browser's credit-change event. The
    // shared cache uses one visible-page timer per client/account, suspends
    // hidden tabs, and revalidates stale data when they become visible again.
    { enabled: canRead, staleTimeMs: 60_000, pollIntervalMs: 60_000 },
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
    balanceLabel: balance.error ? null : (balance.data?.label ?? null),
    canOpenBilling: canManage,
    promotionDecision: canRead && !balance.error ? balance.data?.promotionDecision : undefined,
  };
}

export function OpenGeniCreditsRow({
  credits,
  workspaceId,
  workspaceName,
  scope,
}: {
  credits: OpenGeniCredits;
  workspaceId: string;
  workspaceName: string;
  /** "Everyone in Acme": credits belong to the whole organization. */
  scope?: string | undefined;
}) {
  const navigate = useNavigate();
  if (!credits.visible) return null;
  const openBilling = () =>
    void navigate({
      to: "/workspaces/$workspaceId/organization",
      params: { workspaceId },
      search: {
        section: "billing",
        ...returnToSearch(currentPageReturnTo(`${workspaceName} · Models`)),
      },
    });
  return (
    <ListRow
      leading={<OpenGeniCreditsTile />}
      title="Opengeni credits"
      meta={[scope, "Pay as you go", credits.balanceLabel]}
      {...(credits.canOpenBilling ? { onOpen: openBilling, indicator: "open" as const } : {})}
    />
  );
}
