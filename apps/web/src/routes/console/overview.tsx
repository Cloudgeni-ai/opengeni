import type { ConsoleRange, ConsoleSpendPoint, ConsoleSummary } from "@opengeni/sdk";
import { LayoutDashboardIcon } from "lucide-react";
import { useState } from "react";

import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { Section } from "@opengeni/react/ui/section";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { StatGroup, StatTile } from "@opengeni/react/ui/stat-tile";

import {
  CONSOLE_RANGES,
  ConsoleLoadError,
  ConsolePage,
  formatCount,
  formatMicros,
  formatTokens,
  rangeLabel,
  useConsole,
  useConsoleQuery,
} from "./console-shared";

export function RangeControl({
  value,
  onChange,
}: {
  value: ConsoleRange;
  onChange: (range: ConsoleRange) => void;
}) {
  return (
    <SegmentedControl
      aria-label="Range"
      size="sm"
      options={CONSOLE_RANGES.map((range) => ({ value: range.value, label: range.label }))}
      value={value}
      onValueChange={onChange}
    />
  );
}

export function useConsoleSummary(range: ConsoleRange) {
  const { client, organizationId } = useConsole();
  return useConsoleQuery<ConsoleSummary>(
    (signal) => client.getConsoleSummary(organizationId, { range, signal }),
    [client, organizationId, range],
  );
}

export function ConsoleOverviewRoute() {
  const [range, setRange] = useState<ConsoleRange>("30d");
  const summary = useConsoleSummary(range);
  const data = summary.data;
  return (
    <ConsolePage>
      <PageHeader
        title="Overview"
        icon={<LayoutDashboardIcon />}
        description={rangeLabel(range)}
        actions={<RangeControl value={range} onChange={setRange} />}
      />
      {summary.error ? (
        <ConsoleLoadError error={summary.error} onRetry={summary.reload} />
      ) : (
        <>
          <StatGroup label={rangeLabel(range)}>
            <StatTile
              label="Spend"
              loading={!data}
              value={data ? formatMicros(data.spend.totalMicros) : undefined}
              caption={data ? `${formatMicros(data.spend.managedMicros)} in managed` : undefined}
              sparkline={
                data && data.spend.byDay.length > 1 ? sparkline(data.spend.byDay) : undefined
              }
            />
            <StatTile
              label="Managed sessions"
              loading={!data}
              value={data ? formatCount(data.managedSessions) : undefined}
              caption={data?.countsTruncated ? "At least this many" : undefined}
            />
            <StatTile
              label="End users"
              loading={!data}
              value={data ? formatCount(data.endUsers) : undefined}
            />
            <StatTile
              label="Workspaces"
              loading={!data}
              value={data ? formatCount(data.workspaces.managed) : undefined}
              unit={data ? "managed" : undefined}
              caption={data ? `${formatCount(data.workspaces.team)} team` : undefined}
            />
          </StatGroup>
          <Section title="Spend by day">
            {data ? <SpendBars points={data.spend.byDay} /> : <ListRowSkeleton count={1} />}
          </Section>
          <Section title="Top models">
            {!data ? (
              <ListRowSkeleton count={3} />
            ) : data.spend.byModel.length === 0 ? (
              <p className="text-sm text-fg-muted">No model use in this range.</p>
            ) : (
              <RowList
                variant="table"
                label="Top models"
                nameLabel="Model"
                columns={[
                  { id: "calls", label: "Calls", width: 88, align: "end" },
                  { id: "tokens", label: "Tokens", width: 96, align: "end" },
                  { id: "spend", label: "Spend", width: 96, align: "end", leadsWhenFolded: true },
                ]}
              >
                {data.spend.byModel.map((model) => (
                  <ListRow
                    key={model.model}
                    title={model.model}
                    cells={{
                      calls: formatCount(model.calls),
                      tokens: formatTokens(model.inputTokens + model.outputTokens),
                      spend: formatMicros(model.spendMicros),
                    }}
                  />
                ))}
              </RowList>
            )}
          </Section>
        </>
      )}
    </ConsolePage>
  );
}

function sparkline(points: ConsoleSpendPoint[]): number[] {
  return points.map((point) => point.spendMicros);
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function dayLabel(date: string): string {
  return DAY.format(new Date(`${date}T00:00:00Z`));
}

/** One bar per day, with the amount on hover. */
export function SpendBars({ points }: { points: ConsoleSpendPoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-fg-muted">No spend in this range.</p>;
  }
  const max = Math.max(...points.map((point) => point.spendMicros), 1);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div
        role="img"
        aria-label={`Spend by day, highest ${formatMicros(max)}`}
        className="flex h-36 items-end gap-[2px] rounded-lg border border-border px-3 pt-3"
      >
        {points.map((point) => (
          <div
            key={point.date}
            title={`${dayLabel(point.date)} · ${formatMicros(point.spendMicros)}`}
            className="min-w-0 flex-1 rounded-t-[3px] bg-brand/70 transition-colors hover:bg-brand"
            style={{
              height: `${Math.max((point.spendMicros / max) * 100, point.spendMicros ? 2 : 0.5)}%`,
            }}
          />
        ))}
      </div>
      <figcaption className="flex justify-between text-xs text-fg-muted">
        <span>{first ? dayLabel(first.date) : null}</span>
        <span>Highest day {formatMicros(max)}</span>
        <span>{last ? dayLabel(last.date) : null}</span>
      </figcaption>
    </figure>
  );
}
