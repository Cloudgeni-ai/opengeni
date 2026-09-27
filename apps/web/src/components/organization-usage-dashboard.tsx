import type {
  OrganizationUsagePeriod,
  OrganizationUsageSummary,
  OrganizationUsageWorkspacePage,
} from "@opengeni/contracts";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { AreaChart } from "@/components/insights/charts";
import { RowButton } from "@/components/models/models-ui";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { formatDate } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { usageMetricLabel, usageUnitLabel } from "@/lib/usage-metric";

type Total = OrganizationUsageSummary["totals"][number];
const periods: Array<{ value: OrganizationUsagePeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "This month" },
  { value: "ytd", label: "This year" },
];
const WORKSPACE_COLUMNS: RowListColumn[] = [
  { id: "total", label: "Total", width: 132, align: "end", hideLabel: true },
];
const metricKey = (total: Pick<Total, "eventType" | "unit">) =>
  JSON.stringify([total.eventType, total.unit]);

export function formatExactUsage(quantity: string, unit: string): string {
  if (unit !== "usd_micros") return `${BigInt(quantity).toLocaleString("en-US")} ${unit}`;
  const value = BigInt(quantity);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}$${(absolute / 1_000_000n).toLocaleString("en-US")}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * An amount for reading: dollars to the cent ("$12.34", "< $0.01" for a
 * sliver), other units whole. The exact metered value goes in the tooltip.
 */
export function formatUsageAmount(quantity: string, unit: string): string {
  if (unit !== "usd_micros") return formatExactUsage(quantity, unit);
  const value = BigInt(quantity);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const cents = (absolute + 5_000n) / 10_000n;
  if (cents === 0n && absolute > 0n) return negative ? "> -$0.01" : "< $0.01";
  const text = `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
  return negative && cents > 0n ? `-${text}` : text;
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
  const range = data
    ? `${formatDate(data.since, { utc: true })} - ${formatDate(data.until, { utc: true })}, UTC`
    : null;
  return (
    <section aria-label="Organization usage dashboard" className="min-w-0">
      <Section
        title="Usage"
        description="Usage you can see in this organization. Not an invoice."
        action={
          <SegmentedControl<OrganizationUsagePeriod>
            size="sm"
            aria-label="Usage period"
            disabled={!props.enabled}
            value={period}
            onValueChange={(value) => {
              setPeriod(value);
              setCursor(undefined);
            }}
            options={periods}
          />
        }
      >
        <div className="mt-3 flex min-w-0 flex-col gap-4">
          {!props.enabled ? (
            <p className="text-xs leading-[18px] text-fg-muted">
              You don't have permission to view usage. Ask an organization owner.
            </p>
          ) : error ? (
            <ErrorMessage
              variant="block"
              title="Couldn't load period usage"
              announce
              action={
                <RowButton onClick={() => setRevision((value) => value + 1)}>Try again</RowButton>
              }
            >
              {error.message}
            </ErrorMessage>
          ) : !data ? (
            <p role="status" className="text-xs leading-[18px] text-fg-muted">
              Loading period usage
            </p>
          ) : data.totals.length === 0 ? (
            <EmptyState
              variant="inline"
              title="No visible usage recorded in this period."
              description={range ?? undefined}
            />
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  {selected ? (
                    <p
                      className="text-xl leading-7 font-semibold tracking-[-0.5px] text-fg tabular-nums"
                      title={formatExactUsage(selected.quantity, selected.unit)}
                    >
                      {formatUsageAmount(selected.quantity, selected.unit)}
                    </p>
                  ) : null}
                  <p className="text-xs leading-[18px] text-fg-muted">{range}</p>
                </div>
                {data.totals.length > 1 ? (
                  <SelectMenu
                    size="sm"
                    aria-label="Usage metric"
                    value={selected ? metricKey(selected) : null}
                    onValueChange={setMetric}
                    options={data.totals.map((total) => ({
                      value: metricKey(total),
                      label: usageMetricLabel(total.eventType),
                      meta: usageUnitLabel(total.unit),
                    }))}
                    className="w-60 max-w-full"
                  />
                ) : null}
              </div>
              {chart && selected && (
                <AreaChart
                  labels={chart.labels.map((bucket) =>
                    data.granularity === "hour"
                      ? `${bucket.slice(11, 16)} UTC`
                      : formatDate(`${bucket}T00:00:00.000Z`, { utc: true }),
                  )}
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
                <p className="text-xs leading-[18px] text-fg-muted">
                  Negative adjustments show as a separate line. The total includes them.
                </p>
              )}
            </>
          )}
        </div>
      </Section>
      {props.enabled && data && data.totals.length > 0 ? (
        <div className="mt-6 border-t border-border pt-6">
          <Section
            title="By shared workspace"
            description="Personal workspaces aren't listed, so rows may not add up to the total."
          >
            <div className="flex min-w-0 flex-col gap-3">
              {pageError ? (
                <ErrorMessage
                  variant="inline"
                  title="Couldn't load workspace totals"
                  announce
                  action={<RowButton onClick={() => setCursor(undefined)}>Try again</RowButton>}
                >
                  {pageError.message}
                </ErrorMessage>
              ) : null}
              {cursor && !page && !pageError ? (
                <RowList label="Usage by shared workspace" columns={WORKSPACE_COLUMNS} busy flush>
                  <ListRowSkeleton count={3} />
                </RowList>
              ) : (page?.workspaces ?? []).length === 0 ? (
                <p className="text-xs leading-[18px] text-fg-muted">
                  No shared workspace used anything in this period.
                </p>
              ) : (
                <RowList
                  label="Usage by shared workspace"
                  columns={WORKSPACE_COLUMNS}
                  nameLabel="Workspace"
                  flush
                >
                  {(page?.workspaces ?? []).map((workspace) => {
                    const total = workspace.totals.find(
                      (item) => selected && metricKey(item) === metricKey(selected),
                    );
                    const quantity = total?.quantity ?? "0";
                    const unit = selected?.unit ?? "";
                    return (
                      <ListRow
                        key={workspace.workspaceId}
                        leading={<LogoTile name={workspace.name ?? "Workspace"} />}
                        title={workspace.name ?? "Workspace"}
                        cells={{
                          total: (
                            <span
                              className="text-fg tabular-nums"
                              title={formatExactUsage(quantity, unit)}
                            >
                              {formatUsageAmount(quantity, unit)}
                            </span>
                          ),
                        }}
                      />
                    );
                  })}
                </RowList>
              )}
              {(cursor || page?.nextWorkspaceCursor) && (
                <div className="flex gap-2">
                  {cursor && (
                    <RowButton onClick={() => setCursor(undefined)}>First workspaces</RowButton>
                  )}
                  {page?.nextWorkspaceCursor && (
                    <RowButton onClick={() => setCursor(page.nextWorkspaceCursor!)}>
                      Next workspaces
                    </RowButton>
                  )}
                </div>
              )}
            </div>
          </Section>
        </div>
      ) : null}
    </section>
  );
}
