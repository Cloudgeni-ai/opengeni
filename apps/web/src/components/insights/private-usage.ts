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
 * replica omits the field and the list is simply empty. Largest spend first.
 */
export function privateSpendRows(snap: WorkspaceInsightsSnapshot): {
  rows: PrivateSpendRow[];
  /** The server listed only the largest 200 people. */
  truncated: boolean;
} {
  const source = snap as WorkspaceInsightsSnapshot & {
    privateChats?: PrivateChatsRow[];
    privateChatsTruncated?: boolean;
  };
  const rows = (source.privateChats ?? [])
    .map((row) => ({
      key: `private:${row.ownerKey}`,
      person: row.name ?? "A member",
      you: row.you,
      calls: row.calls,
      tokens: row.tokens,
      creditUsd: row.creditUsd,
      listPriceUsd: row.estimatedProviderUsd,
      listPricedCalls: row.estimatedProviderCostKnownCalls,
    }))
    .sort(
      (a, b) =>
        b.creditUsd - a.creditUsd ||
        b.listPriceUsd - a.listPriceUsd ||
        b.tokens - a.tokens ||
        a.person.localeCompare(b.person),
    );
  return { rows, truncated: source.privateChatsTruncated ?? false };
}
