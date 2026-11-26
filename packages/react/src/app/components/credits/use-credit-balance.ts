import type { ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback } from "react";
import { useSharedQuery } from "../../../hooks/shared-query";
import { billingSummaryQueryKey } from "../../lib/billing-summary-read";

/**
 * What the organization's billing summary says about its credit, so a
 * credit notice can tell "no credit at all" from "credit this model can't
 * use" and word each one truthfully. `null` while it loads, without
 * `billing:read`, or when the read fails: then neither is known.
 */
export type CreditBalance = {
  /** Billing is on for this deployment (`stripe` or another non-disabled mode). */
  billingEnabled: boolean;
  stripeEnabled: boolean;
  /** Any positive balance, including promotional credit for other models. */
  someCredit: boolean;
};

export function useCreditBalance(
  client: ChatClient<OpenGeniBrowserClient>,
  accountId: string | null | undefined,
  canReadBilling: boolean,
): { balance: CreditBalance | null; settled: boolean } {
  const key = accountId && canReadBilling ? accountId : null;
  // The same read as the rail's credit row, so a page sends one request.
  const load = useCallback(
    async () => await client.getBilling({ accountId: key ?? "" }),
    [client, key],
  );
  const summary = useSharedQuery(client, billingSummaryQueryKey(key ?? ""), load, {
    enabled: key !== null,
  });
  if (!key) return { balance: null, settled: true };
  if (summary.loading) return { balance: null, settled: false };
  const data = summary.error ? null : summary.data;
  return {
    balance: data
      ? {
          billingEnabled: data.mode !== "disabled",
          stripeEnabled: data.mode === "stripe",
          someCredit: data.balance.balanceMicros > 0,
        }
      : null,
    settled: true,
  };
}
