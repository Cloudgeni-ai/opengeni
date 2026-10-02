import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import type { PrivateSpendRow } from "./usage-sections";

type PrivateChatsRow = {
  ownerKey: string;
  name: string | null;
  you: boolean;
  calls: number;
  tokens: number;
  creditUsd: number;
  estimatedProviderUsd: number;
  estimatedProviderCostKnownCalls: number;
};

/**
 * Other people's private chats in this workspace, one row per person with
 * amounts only. The snapshot never carries their titles or ids; an older API
 * replica omits the field and the list is simply empty.
 */
export function privateSpendRows(snap: WorkspaceInsightsSnapshot): PrivateSpendRow[] {
  const rows = (snap as WorkspaceInsightsSnapshot & { privateChats?: PrivateChatsRow[] })
    .privateChats;
  return (rows ?? []).map((row) => ({
    key: `private:${row.ownerKey}`,
    person: row.name ?? "A member",
    you: row.you,
    calls: row.calls,
    tokens: row.tokens,
    creditUsd: row.creditUsd,
    listPriceUsd: row.estimatedProviderUsd,
    listPricedCalls: row.estimatedProviderCostKnownCalls,
  }));
}
