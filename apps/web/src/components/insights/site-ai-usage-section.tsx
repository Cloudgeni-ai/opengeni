import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  InsightsSiteUsageQuery,
  InsightsSiteUsageResponse,
} from "@opengeni/contracts/insights-usage";
import { useEffect, useState } from "react";

import { ListRow, RowList, type RowListColumn } from "@opengeni/react/ui/list-row";

import { formatMoney } from "./usage-format";
import { PartlyUnpricedMark, Quiet, Unpriced } from "./usage-values";

export type SiteAiUsageLoad =
  | { state: "skipped" }
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; usage: InsightsSiteUsageResponse };

/**
 * Model usage by Site for the dashboard's range. `null` (a custom range) skips
 * the request: the endpoint only knows the preset ranges.
 * Source attribution is aggregate accounting, never private conversation discovery.
 */
export function useSiteAiUsage(
  client: Pick<OpenGeniBrowserClient, "getWorkspaceInsightsSiteUsage">,
  workspaceId: string,
  range: InsightsSiteUsageQuery["range"] | null,
): SiteAiUsageLoad {
  const [load, setLoad] = useState<SiteAiUsageLoad>(
    range === null ? { state: "skipped" } : { state: "loading" },
  );
  useEffect(() => {
    if (range === null) {
      setLoad({ state: "skipped" });
      return;
    }
    const abort = new AbortController();
    setLoad({ state: "loading" });
    client
      .getWorkspaceInsightsSiteUsage(workspaceId, { range }, { signal: abort.signal })
      .then((usage) => {
        if (!abort.signal.aborted) setLoad({ state: "ready", usage });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoad({ state: "failed" });
      });
    return () => abort.abort();
  }, [client, workspaceId, range]);
  return load;
}

const SITE_COLUMNS: RowListColumn[] = [
  { id: "calls", label: "Calls", width: 76, align: "end" },
  { id: "charged", label: "Charged", width: 96, align: "end" },
  { id: "apiEquivalent", label: "API-equivalent", width: 120, align: "end", leadsWhenFolded: true },
];

/** The Breakdown table's look: same rows, header, numbers and empty state. */
export function SiteAiUsageTable({ usage }: { usage: InsightsSiteUsageResponse }) {
  if (usage.rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-fg-muted">
        No model usage attributed to Sites in this period.
      </p>
    );
  }
  return (
    <RowList variant="table" label="Model costs by Site" nameLabel="Site" columns={SITE_COLUMNS}>
      {usage.rows.map((row, index) => (
        <ListRow
          key={row.siteId ?? `${row.kind}-${index}`}
          title={row.title}
          cells={{
            calls: <Quiet>{row.calls.toLocaleString("en-US")}</Quiet>,
            charged: (
              <span className="text-sm text-fg tabular-nums">{formatMoney(row.chargedMicros)}</span>
            ),
            apiEquivalent:
              row.pricedCalls > 0 ? (
                <span className="text-sm text-fg tabular-nums">
                  <span
                    title={`Subscriptions: ${formatMoney(row.subscriptionApiEquivalentMicros)}; own API keys: ${formatMoney(row.ownKeyApiEquivalentMicros)}. ${row.pricedCalls} of ${row.calls} calls priced.`}
                  >
                    {row.apiEquivalentMicros > 0 ? "~" : ""}
                    {formatMoney(row.apiEquivalentMicros)}
                  </span>
                  {row.pricedCalls < row.calls ? (
                    <PartlyUnpricedMark calls={row.calls} pricedCalls={row.pricedCalls} />
                  ) : null}
                </span>
              ) : (
                <Unpriced />
              ),
          }}
        />
      ))}
    </RowList>
  );
}
