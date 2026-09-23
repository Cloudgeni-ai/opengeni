import type {
  OrganizationUsagePeriod,
  OrganizationUsageSummary,
  OrganizationUsageWorkspacePage,
} from "@opengeni/contracts";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { LoadErrorState } from "@/components/common";
import { AreaChart } from "@/components/insights/charts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { usageMetricLabel, usageUnitLabel } from "@/lib/usage-metric";

type Total = OrganizationUsageSummary["totals"][number];
const periods: Array<[OrganizationUsagePeriod, string]> = [
  ["today", "Today"],
  ["week", "Last 7 days"],
  ["month", "This month"],
  ["ytd", "Year to date"],
];
const metricKey = (total: Pick<Total, "eventType" | "unit">) =>
  JSON.stringify([total.eventType, total.unit]);

export function formatExactUsage(quantity: string, unit: string): string {
  if (unit !== "usd_micros") return `${BigInt(quantity).toLocaleString("en-US")} ${unit}`;
  const value = BigInt(quantity);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}$${(absolute / 1_000_000n).toLocaleString("en-US")}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Fill every UTC bucket; missing metering rows are zero, never connected gaps. */
export function organizationUsageChart(summary: OrganizationUsageSummary, selected: Total) {
  const step = summary.granularity === "hour" ? 3_600_000 : 86_400_000;
  const rows = new Map(summary.buckets.map((row) => [row.bucket, row.totals]));
  const labels: string[] = [];
  const values: number[] = [];
  for (let time = Date.parse(summary.since); time < Date.parse(summary.until); time += step) {
    const date = new Date(time).toISOString();
    const bucket = summary.granularity === "hour" ? date.slice(0, 16) : date.slice(0, 10);
    const quantity =
      rows.get(bucket)?.find((total) => metricKey(total) === metricKey(selected))?.quantity ?? "0";
    labels.push(bucket);
    values.push(Number(quantity) / (selected.unit === "usd_micros" ? 1_000_000 : 1));
  }
  return { labels, values };
}

export function OrganizationUsageDashboard(props: { accountId: string; enabled: boolean }) {
  const { client } = useAppContext();
  const [period, setPeriod] = useState<OrganizationUsagePeriod>("month");
  const [cursor, setCursor] = useState<string | undefined>();
  const [revision, setRevision] = useState(0);
  const [metric, setMetric] = useState("");
  const [state, setState] = useState<{
    key: string;
    data?: OrganizationUsageSummary;
    error?: Error;
  }>({ key: "" });
  const [pageState, setPageState] = useState<{
    key: string;
    data?: OrganizationUsageWorkspacePage;
    error?: Error;
  }>({ key: "" });
  const key = JSON.stringify([props.accountId, props.enabled, period, revision]);
  useEffect(() => {
    if (!props.enabled) return;
    let active = true;
    const controller = new AbortController();
    // The identity check also hides prior-account data before effects run.
    setState({ key });
    void (async () => {
      try {
        const data = await client.getOrganizationUsageSummary(
          { accountId: props.accountId, period },
          { signal: controller.signal },
        );
        if (active) setState({ key, data });
      } catch (error) {
        if (active)
          setState({ key, error: error instanceof Error ? error : new Error(String(error)) });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, key, props.accountId, props.enabled, period]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  const pageKey = JSON.stringify([key, data?.until, cursor]);
  useEffect(() => {
    if (!props.enabled || !data || !cursor) return;
    let active = true;
    const controller = new AbortController();
    setPageState({ key: pageKey });
    void (async () => {
      try {
        const page = await client.getOrganizationUsageWorkspacePage(
          {
            accountId: props.accountId,
            period,
            until: data.until,
            afterWorkspaceId: cursor,
          },
          { signal: controller.signal },
        );
        if (active) setPageState({ key: pageKey, data: page });
      } catch (pageLoadError) {
        if (active)
          setPageState({
            key: pageKey,
            error:
              pageLoadError instanceof Error ? pageLoadError : new Error(String(pageLoadError)),
          });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, props.enabled, props.accountId, data, period, cursor, pageKey]);
  const page = cursor ? (pageState.key === pageKey ? pageState.data : undefined) : data;
  const pageError = cursor && pageState.key === pageKey ? pageState.error : undefined;
  const selected =
    data?.totals.find((total) => metricKey(total) === metric) ??
    data?.totals.find((total) => total.eventType === "model.cost") ??
    data?.totals[0];
  const chart = data && selected ? organizationUsageChart(data, selected) : null;
  const hasCorrections = chart?.values.some((value) => value < 0) ?? false;
  return (
    <section className="space-y-5" aria-label="Organization usage dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Usage by period</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Complete period totals for usage you can view. UTC time; not an invoice.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Usage period"
            value={period}
            disabled={!props.enabled}
            onChange={(event) => {
              setPeriod(event.target.value as OrganizationUsagePeriod);
              setCursor(undefined);
            }}
          >
            {periods.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={!props.enabled}
            onClick={() => {
              setCursor(undefined);
              setRevision((value) => value + 1);
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
      {!props.enabled ? (
        <p className="text-xs text-fg-subtle">You don't have permission to view usage.</p>
      ) : error ? (
        <LoadErrorState
          title="Couldn't load period usage"
          error={error}
          onRetry={() => setRevision((value) => value + 1)}
        />
      ) : !data ? (
        <p role="status" className="text-xs text-fg-muted">
          Loading period usage
        </p>
      ) : data.totals.length === 0 ? (
        <p className="text-xs text-fg-muted">No visible usage recorded in this period.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select
              aria-label="Usage metric"
              value={selected ? metricKey(selected) : ""}
              onChange={(event) => setMetric(event.target.value)}
            >
              {data.totals.map((total) => (
                <option key={metricKey(total)} value={metricKey(total)}>
                  {usageMetricLabel(total.eventType)} ({usageUnitLabel(total.unit)})
                </option>
              ))}
            </Select>
            {selected && (
              <p className="text-lg font-semibold tabular-nums text-fg">
                {formatExactUsage(selected.quantity, selected.unit)}
              </p>
            )}
          </div>
          {chart && selected && (
            <AreaChart
              labels={chart.labels}
              series={[
                {
                  id: "usage",
                  label: usageMetricLabel(selected.eventType),
                  values: chart.values.map((value) => Math.max(0, value)),
                  className: "text-brand",
                },
                ...(hasCorrections
                  ? [
                      {
                        id: "corrections",
                        label: "Negative adjustment magnitude",
                        values: chart.values.map((value) => Math.max(0, -value)),
                        className: "text-status-waiting",
                      },
                    ]
                  : []),
              ]}
              valuePrefix={selected.unit === "usd_micros" ? "$" : ""}
              valueSuffix={selected.unit === "usd_micros" ? "" : ` ${selected.unit}`}
            />
          )}
          {hasCorrections && (
            <p className="text-xs text-fg-muted">
              Negative adjustments are shown as a separate magnitude. The period total includes
              their negative sign.
            </p>
          )}
          <p className="text-xs text-fg-subtle">
            {data.since} to {data.until}. Chart values are rounded; totals retain exact metered
            units.
          </p>
          {cursor && !page && !pageError && (
            <p role="status" className="text-xs text-fg-muted">
              Loading workspace totals
            </p>
          )}
          {pageError && (
            <LoadErrorState
              title="Couldn't load workspace totals"
              error={pageError}
              onRetry={() => setCursor(undefined)}
            />
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="pb-3 text-left text-sm font-semibold text-fg">
                By shared workspace
              </caption>
              <thead>
                <tr className="border-b border-border text-fg-muted">
                  <th className="py-2 font-medium">Workspace</th>
                  <th className="py-2 text-right font-medium">
                    {selected ? usageMetricLabel(selected.eventType) : "Usage"} total
                  </th>
                </tr>
              </thead>
              <tbody>
                {(page?.workspaces ?? []).map((workspace) => {
                  const total = workspace.totals.find(
                    (item) => selected && metricKey(item) === metricKey(selected),
                  );
                  return (
                    <tr key={workspace.workspaceId} className="border-b border-border">
                      <td className="py-3 pr-4">
                        <span className="text-fg">{workspace.name ?? "Workspace"}</span>
                        <span className="mt-1 block text-fg-subtle">{workspace.workspaceId}</span>
                      </td>
                      <td className="py-3 text-right tabular-nums">
                        {formatExactUsage(total?.quantity ?? "0", selected?.unit ?? "")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-fg-subtle">
            Personal workspaces are not listed. Period totals include all usage you can view, so
            shared workspace rows may not add up to the period total.
          </p>
          {(cursor || page?.nextWorkspaceCursor) && (
            <div className="flex gap-2">
              {cursor && (
                <Button variant="outline" size="sm" onClick={() => setCursor(undefined)}>
                  First workspaces
                </Button>
              )}
              {page?.nextWorkspaceCursor && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCursor(page.nextWorkspaceCursor!)}
                >
                  Next workspaces
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
