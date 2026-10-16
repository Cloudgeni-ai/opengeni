import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  InsightsSiteUsageQuery,
  InsightsSiteUsageResponse,
} from "@opengeni/contracts/insights-usage";
import { useEffect, useState } from "react";
import { Section } from "@/components/ui/section";
import { formatCount, formatMoney } from "./usage-format";

/** Source attribution is aggregate accounting, never private conversation discovery. */
export function SiteAiUsageSection({
  client,
  workspaceId,
  range,
}: {
  client: Pick<OpenGeniBrowserClient, "getWorkspaceInsightsSiteUsage">;
  workspaceId: string;
  range: InsightsSiteUsageQuery["range"];
}) {
  const [usage, setUsage] = useState<InsightsSiteUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setUsage(null);
    setFailed(false);
    client
      .getWorkspaceInsightsSiteUsage(workspaceId, { range }, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setUsage(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [client, workspaceId, range]);
  if (failed)
    return (
      <Section title="Site AI">
        <p className="text-sm text-fg-muted">Couldn’t load Site AI usage.</p>
      </Section>
    );
  if (!usage) return null;
  return <SiteAiUsageView usage={usage} />;
}

export function SiteAiUsageView({ usage }: { usage: InsightsSiteUsageResponse }) {
  return (
    <Section
      title="Site AI"
      description="All Site AI in this period, without conversation details. API-equivalent amounts are estimates, not additional charges."
    >
      {usage.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No attributed Site AI usage in this period.</p>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs font-medium text-fg-muted">
              <tr>
                <th className="py-2 text-left font-medium">Site</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                  Credits charged
                </th>
                <th className="py-2 text-right font-medium whitespace-nowrap">API-equivalent</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((row, index) => (
                <tr className="border-t border-border" key={row.siteId ?? `${row.kind}-${index}`}>
                  <td className="max-w-64 py-3 pr-4">
                    <span className="line-clamp-2">{row.title}</span>
                  </td>
                  <td className="px-3 py-3 text-right">{formatCount(row.calls)}</td>
                  <td className="px-3 py-3 text-right">{formatMoney(row.chargedMicros)}</td>
                  <td
                    className="py-3 text-right"
                    title={`Subscriptions: ${formatMoney(row.subscriptionApiEquivalentMicros)}; own API keys: ${formatMoney(row.ownKeyApiEquivalentMicros)}. ${row.pricedCalls} of ${row.calls} calls priced.`}
                  >
                    {row.pricedCalls > 0 ? formatMoney(row.apiEquivalentMicros) : "—"}
                    {row.pricedCalls < row.calls ? (
                      <span className="ml-1 text-xs text-fg-subtle">partial</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
