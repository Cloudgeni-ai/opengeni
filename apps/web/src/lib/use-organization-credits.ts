import type { BillingSummary } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "@/context";
import { hasAccountPermission } from "@/lib/permissions";

export type OrganizationCredits = Readonly<{
  /** The deployment sells Opengeni credits (Stripe billing). */
  billingMode: "disabled" | "stripe";
  /** `billing:manage`: may buy credits. Never true without Stripe. */
  canBuy: boolean;
  /** `billing:read` or `billing:manage`: may see the balance. */
  canRead: boolean;
  /**
   * The balance (a trial grant counts) on a deployment that sells credits;
   * null while loading, unreadable, failed, or without Stripe.
   */
  balance: BillingSummary["balance"] | null;
  loading: boolean;
  refresh: () => void;
}>;

/**
 * The organization's Opengeni credits as one person may see and use them.
 * Without Stripe billing the deployment pays for its models and a balance
 * means nothing, so it isn't read.
 */
export function useOrganizationCredits(
  organizationId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): OrganizationCredits {
  const { client, clientConfig, accessContext } = useAppContext();
  const billingMode = clientConfig.billingMode === "stripe" ? "stripe" : "disabled";
  const accountId = organizationId ?? "";
  const canManage =
    Boolean(organizationId) && hasAccountPermission(accessContext, accountId, "billing:manage");
  const canRead =
    canManage ||
    (Boolean(organizationId) && hasAccountPermission(accessContext, accountId, "billing:read"));
  const sold = billingMode === "stripe";
  const [balance, setBalance] = useState<OrganizationCredits["balance"]>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled || !sold || !canRead || !accountId) {
      setBalance(null);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    void client
      .getBilling({ accountId })
      .then((billing) => {
        if (current) setBalance(billing.balance);
      })
      // The balance is a detail: without it every choice still works.
      .catch(() => {
        if (current) setBalance(null);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [accountId, canRead, client, enabled, revision, sold]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    billingMode,
    canBuy: billingMode === "stripe" && canManage,
    canRead,
    balance,
    loading,
    refresh,
  };
}
