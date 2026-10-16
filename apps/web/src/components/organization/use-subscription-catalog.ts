import { useEffect, useState } from "react";
import type { BillingPlanBalance, BillingSubscriptionCatalog } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { apiErrorFacts } from "@/lib/api-error";

/** The catalog endpoint is the deployment gate; a balance plan alone is not. */
export function useSubscriptionCatalog(
  client: OpenGeniBrowserClient,
  accountId: string,
  ownerKey: string,
  plan: BillingPlanBalance | null | undefined,
) {
  const [state, setState] = useState<{
    ownerKey: string;
    catalog: BillingSubscriptionCatalog | null;
    error: unknown;
  }>({ ownerKey: "", catalog: null, error: null });
  const [revision, setRevision] = useState(0);
  const hasPlan = Boolean(plan);
  useEffect(() => {
    let active = true;
    setState({ ownerKey, catalog: null, error: null });
    if (!hasPlan) return;
    void client.getBillingSubscriptionPlans({ accountId }).then(
      (catalog) => {
        if (active) setState({ ownerKey, catalog: catalog.plan ? catalog : null, error: null });
      },
      (error: unknown) => {
        if (active)
          setState({
            ownerKey,
            catalog: null,
            error: apiErrorFacts(error).status === 404 ? null : error,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, accountId, ownerKey, hasPlan, revision]);
  return {
    catalog: hasPlan && state.ownerKey === ownerKey ? state.catalog : null,
    error: hasPlan && state.ownerKey === ownerKey ? state.error : null,
    retry: () => setRevision((value) => value + 1),
  };
}
