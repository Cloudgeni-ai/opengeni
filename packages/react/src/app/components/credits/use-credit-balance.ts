import { useEffect, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

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
  client: OpenGeniBrowserClient,
  accountId: string | null | undefined,
  canReadBilling: boolean,
): { balance: CreditBalance | null; settled: boolean } {
  const [state, setState] = useState<{
    key: string | null;
    balance: CreditBalance | null;
  }>({ key: null, balance: null });
  const key = accountId && canReadBilling ? accountId : null;

  useEffect(() => {
    if (!key) return;
    let active = true;
    void client
      .getBilling({ accountId: key })
      .then((summary) => {
        if (!active) return;
        setState({
          key,
          balance: {
            billingEnabled: summary.mode !== "disabled",
            stripeEnabled: summary.mode === "stripe",
            someCredit: summary.balance.balanceMicros > 0,
          },
        });
      })
      .catch(() => {
        if (active) setState({ key, balance: null });
      });
    return () => {
      active = false;
    };
  }, [client, key]);

  if (!key) return { balance: null, settled: true };
  return state.key === key
    ? { balance: state.balance, settled: true }
    : { balance: null, settled: false };
}
