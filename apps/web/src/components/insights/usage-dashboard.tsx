import { CalendarIcon, LockIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ModelTile } from "@/components/model-identity";
import { OpenGeniCreditsTile, ProviderTile } from "@/components/models/provider-mark";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { HelpTip, InlineHelp } from "@/components/ui/inline-help";
import {
  ListRow,
  ListRowSkeleton,
  RowList,
  type RowListColumn,
  type RowListSort,
} from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { ReasonTooltip } from "@/components/ui/disabled-reason";
import { SECTION_TITLE_CLASS } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { StatGroup, StatTile, type StatDelta } from "@/components/ui/stat-tile";
import {
  ToolbarFilterChips,
  ToolbarFilterMenu,
  type ToolbarFilterGroup,
  type ToolbarFilterValue,
} from "@/components/ui/toolbar";
import { useAppContext } from "@/context";
import { apiErrorAdvice, isPermissionDenied } from "@/lib/api-error";
import { cn } from "@/lib/utils";

import {
  catalogLabels,
  modelDisplayName,
  providerDisplayName,
  type MarkId,
  type ModelLabelSource,
} from "./model-display";
import { StackedBarChart, type ChartBucket, type ChartSeries } from "./usage-chart";
import {
  modelFilterKey,
  parseModelFilterKey,
  type UsageCall,
  type UsageFilterField,
  type UsageGroupBy,
  type UsageMeasures,
  type UsageResponse,
  type UsageScope,
} from "./usage-contract";
import {
  DRILL_NEXT,
  FILTER_FIELD_OF,
  GROUP_LABELS,
  GROUP_ORDER,
  breakdownRows,
  type BreakdownRow,
} from "./usage-groups";
import {
  OTHER_TONE,
  PAYER_IDS,
  RANGES,
  SERIES_TONES,
  TOKEN_CLASSES,
  cacheHitRate,
  costIsEstimate,
  costMicros,
  costUnknown,
  formatBucket,
  formatChange,
  formatCount,
  formatMoney,
  formatMoneyAxis,
  formatPct,
  formatUtc,
  inputTotal,
  payerName,
  priorLabel,
  rangeLabel,
  relativeChange,
  tokenTotal,
  type TokenClassId,
} from "./usage-format";
import { loadUsage, loadUsageCalls, type UsageLoad } from "./usage-source";
import {
  activeFilterCount,
  nextUsageSearch,
  usageMetric,
  usageQuery,
  type UsageMetric,
  type UsageSearch,
  type UsageSearchChange,
} from "./usage-search";

export interface UsageDashboardProps {
  scope: UsageScope;
  search: UsageSearch;
  onSearchChange: (next: UsageSearch) => void;
  /** Catalog model labels for display names; empty until the catalog loads. */
  modelLabels?: ReadonlyArray<{ id: string; label: string }>;
  /** Opens a session the viewer can read. */
  onOpenSession?: (sessionId: string, workspaceId: string | null) => void;
  /** Who can see this: shown when the server refuses. */
  deniedMessage: string;
}

const PANEL = "min-w-0 rounded-lg border border-border";
const PANEL_TITLE = "text-sm leading-5 font-semibold text-fg";

/**
 * Insights usage: one dashboard at workspace and organization scope. Filters,
 * KPIs, an over-time chart, the token/cost mix and one breakdown table with a
 * group-by. The whole selection lives in the URL.
 */
export function UsageDashboard(props: UsageDashboardProps) {
  const { client } = useAppContext();
  const query = useMemo(() => usageQuery(props.search), [props.search]);
  const queryKey = JSON.stringify(query);
  const metric = usageMetric(props.search);
  const [load, setLoad] = useState<{ scope: string; key: string; data: UsageLoad } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const scopeKey = `${props.scope.kind}:${props.scope.workspaceId ?? props.scope.accountId}`;
  const labels = useMemo(() => catalogLabels(props.modelLabels ?? []), [props.modelLabels]);
  // Labels for filter chips whose rows aren't on screen (a session filtered from the table).
  const [chipLabels, setChipLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadUsage(client, props.scope, JSON.parse(queryKey), controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setLoad({ scope: scopeKey, key: queryKey, data });
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught);
        setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scopeKey, queryKey, retry]);

  const update = (change: UsageSearchChange) =>
    props.onSearchChange(nextUsageSearch(props.search, change));

  // Another workspace's (or the organization's) numbers never stand in for this one's.
  const current = load?.scope === scopeKey ? load : null;
  const usage = current?.data.usage ?? null;

  useEffect(() => setChipLabels({}), [scopeKey]);
  const rows = useMemo(() => (usage ? breakdownRows(usage, labels) : []), [usage, labels]);

  useEffect(() => {
    if (rows.length === 0) return;
    setChipLabels((previous) => {
      const next = { ...previous };
      for (const row of rows) {
        for (const value of row.filter?.values ?? []) next[value] = row.label;
      }
      return next;
    });
  }, [rows]);

  if (error && !usage) {
    if (isPermissionDenied(error)) {
      return (
        <p role="alert" className="text-sm text-fg-muted">
          {props.deniedMessage}
        </p>
      );
    }
    return (
      <div role="alert">
        <Notice
          tone="failed"
          title="Insights couldn't load"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetry((n) => n + 1)}
            >
              Try again
            </Button>
          }
        >
          {apiErrorAdvice(error)}
        </Notice>
      </div>
    );
  }

  if (!usage) return <DashboardSkeleton />;

  const stale = loading || current?.key !== queryKey;
  const capabilities = usage.capabilities;
  const groupOptions = GROUP_ORDER.filter(
    (group) =>
      capabilities.groupBy.includes(group) &&
      (group !== "workspace" || props.scope.kind === "organization"),
  );

  return (
    <div data-insights-usage aria-busy={stale || undefined} className="flex min-w-0 flex-col gap-6">
      <FilterBar
        usage={usage}
        query={query}
        scope={props.scope}
        labels={labels}
        chipLabels={chipLabels}
        onChange={update}
      />
      {current && current.data.ignoredFilters.length > 0 ? (
        <InlineHelp icon>
          {`This server can't filter by ${current.data.ignoredFilters
            .map((field) => FILTER_FIELD_LABEL[field].toLowerCase())
            .join(" or ")} yet, so these numbers include everything.`}
        </InlineHelp>
      ) : null}
      {error ? (
        <div role="alert">
          <Notice
            tone="failed"
            title="Couldn't refresh"
            action={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRetry((n) => n + 1)}
              >
                Try again
              </Button>
            }
          >
            Showing the last selection that loaded. {apiErrorAdvice(error)}
          </Notice>
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-6 transition-opacity duration-150",
          stale && "opacity-60",
        )}
      >
        {usage.totals.calls === 0 && activeFilterCount(query.filters) === 0 ? (
          <EmptyState
            variant="page"
            icon={<CalendarIcon />}
            title={emptyTitle(usage.range)}
            description="Usage shows here as soon as an agent calls a model."
            action={
              query.range !== "ytd" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => update({ range: "ytd" })}
                >
                  Show year to date
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <KpiTiles usage={usage} />
            <div className="@container/insights-panels min-w-0">
              <div className="grid min-w-0 gap-6 @5xl/insights-panels:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
                <OverTimePanel
                  usage={usage}
                  rows={rows}
                  metric={metric}
                  split={props.search.split === "group"}
                  onMetric={(next) => update({ metric: next })}
                  onSplit={(next) => update({ split: next })}
                />
                <CompositionPanel measures={usage.totals} />
              </div>
            </div>
            <BreakdownPanel
              usage={usage}
              rows={rows}
              scope={props.scope}
              query={query}
              groupOptions={groupOptions}
              tab={props.search.tab === "calls" ? "calls" : "breakdown"}
              legacyCalls={current?.data.calls ?? null}
              source={current?.data.source ?? "usage"}
              labels={labels}
              onChange={update}
              onOpenSession={props.onOpenSession}
            />
          </>
        )}
        <p className="text-xs leading-4.5 text-fg-subtle" data-insights-freshness>
          <span role="status">{stale ? "Refreshing… " : null}</span>
          {formatUtc(usage.windowStart)} – {formatUtc(usage.windowEnd)}
          {usage.dataThrough ? ` · Data through ${formatUtc(usage.dataThrough)}` : ""}. Plans and
          your own API keys aren't charged by Opengeni; their amounts are list-price estimates.
        </p>
      </div>
    </div>
  );
}

function emptyTitle(range: UsageResponse["range"]): string {
  switch (range) {
    case "today":
      return "No model usage today";
    case "month":
      return "No model usage this month";
    case "ytd":
      return "No model usage this year";
    default:
      return `No model usage in the ${rangeLabel(range).toLowerCase()}`;
  }
}

/* ----------------------------------------------------------------------------
   Filters and range
   -------------------------------------------------------------------------- */

const FILTER_FIELD_LABEL: Record<UsageFilterField, string> = {
  workspaceId: "Workspace",
  model: "Model",
  provider: "Provider",
  payer: "Paid with",
  projectId: "Project",
  person: "Person",
  rootSessionId: "Session",
  scheduleId: "Schedule",
};

function FilterBar(props: {
  usage: UsageResponse;
  query: ReturnType<typeof usageQuery>;
  scope: UsageScope;
  labels: ModelLabelSource;
  chipLabels: Record<string, string>;
  onChange: (change: UsageSearchChange) => void;
}) {
  const { facets, capabilities } = props.usage;
  const filters = props.query.filters;
  const allowed = (field: UsageFilterField) =>
    capabilities.filters.includes(field) &&
    (field !== "workspaceId" || props.scope.kind === "organization");

  // One option per name: the same model on a workspace and an organization
  // Claude plan reads (and filters) as one. An option's id is its raw ids
  // joined by "," (the URL's own separator), so picking it applies them all.
  const groups: ToolbarFilterGroup[] = [];
  const value: ToolbarFilterValue = {};
  const push = (field: UsageFilterField, options: Array<{ ids: string[]; label: string }>) => {
    if (!allowed(field) && (filters[field]?.length ?? 0) === 0) return;
    const selected = new Set(filters[field] ?? []);
    const merged = mergeOptions(options);
    const chosen: string[] = [];
    const covered = new Set<string>();
    for (const option of merged) {
      if (option.ids.every((id) => selected.has(id))) {
        chosen.push(option.id);
        for (const id of option.ids) covered.add(id);
      }
    }
    for (const id of selected) {
      if (covered.has(id)) continue;
      merged.push({
        id,
        ids: [id],
        label: props.chipLabels[id] ?? chipFallback(field, id, props.labels),
      });
      chosen.push(id);
    }
    if (merged.length < 2 && selected.size === 0) return;
    value[field] = chosen;
    groups.push({
      id: field,
      label: FILTER_FIELD_LABEL[field],
      options: merged.map(({ id, label }) => ({ id, label })),
    });
  };
  push(
    "workspaceId",
    facets.workspaces.filter((w) => !w.personal).map((w) => ({ ids: [w.id], label: w.name })),
  );
  const modelNames = facets.models.map((m) => ({
    ids: [modelFilterKey(m.provider, m.model)],
    model: modelDisplayName(m.provider, m.model, props.labels),
    provider: providerDisplayName(m.provider),
  }));
  push(
    "model",
    modelNames.map((m) => ({
      ids: m.ids,
      // Name the plan or API only when the same model runs on more than one.
      label: modelNames.some((other) => other.model === m.model && other.provider !== m.provider)
        ? `${m.model} · ${m.provider}`
        : m.model,
    })),
  );
  push(
    "provider",
    facets.providers.map((p) => ({ ids: [p], label: providerDisplayName(p) })),
  );
  push(
    "payer",
    facets.payers.map((p) => ({ ids: [p], label: payerName(p) })),
  );
  push(
    "projectId",
    facets.projects.map((p) => ({ ids: [p.id], label: p.name })),
  );
  push(
    "person",
    facets.people.map((p) => ({
      ids: [p.key],
      label: p.you ? `${p.name ?? "You"} (you)` : (p.name ?? "Someone"),
    })),
  );
  push(
    "scheduleId",
    facets.schedules.map((s) => ({ ids: [s.id], label: s.name })),
  );
  push("rootSessionId", []);

  const single = capabilities.multiValue === false;
  const onValueChange = (next: ToolbarFilterValue) => {
    const fields = new Set([...Object.keys(next), ...Object.keys(value)]) as Set<UsageFilterField>;
    let change: UsageSearchChange | null = null;
    for (const field of fields) {
      const before = value[field] ?? [];
      let after = [...(next[field] ?? [])];
      if (before.join("\n") === after.join("\n")) continue;
      // The older endpoints take one value per filter: the newest pick wins.
      if (single && after.length > 1) after = after.filter((id) => !before.includes(id)).slice(-1);
      change = { filter: { field, values: after.flatMap((id) => id.split(",")) } };
    }
    if (Object.keys(next).every((field) => (next[field] ?? []).length === 0)) {
      props.onChange({ clearFilters: true });
      return;
    }
    if (change) props.onChange(change);
  };
  const ranges = RANGES.filter((range) => capabilities.ranges.includes(range.id));

  return (
    <div role="group" aria-label="Filters" className="flex min-w-0 flex-wrap items-center gap-2">
      <SelectMenu
        aria-label="Period"
        size="sm"
        value={props.usage.range}
        onValueChange={(range) => props.onChange({ range })}
        options={ranges.map((range) => ({ value: range.id, label: range.label }))}
        className="w-40"
      />
      {groups.length > 0 ? (
        <ToolbarFilterMenu
          groups={groups}
          value={value}
          onValueChange={onValueChange}
          align="start"
          className="h-8 rounded-[8px]"
        />
      ) : null}
      <ToolbarFilterChips groups={groups} value={value} onValueChange={onValueChange} />
    </div>
  );
}

function mergeOptions(
  options: Array<{ ids: string[]; label: string }>,
): Array<{ id: string; ids: string[]; label: string }> {
  const byLabel = new Map<string, string[]>();
  for (const option of options) {
    byLabel.set(option.label, [...(byLabel.get(option.label) ?? []), ...option.ids]);
  }
  return [...byLabel.entries()]
    .map(([label, ids]) => {
      const unique = [...new Set(ids)].sort();
      return { id: unique.join(","), ids: unique, label };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function chipFallback(field: UsageFilterField, id: string, labels: ModelLabelSource): string {
  if (field === "model") {
    const parsed = parseModelFilterKey(id);
    if (parsed) return modelDisplayName(parsed.provider, parsed.model, labels);
  }
  if (field === "provider") return providerDisplayName(id);
  if (field === "payer" && (PAYER_IDS as readonly string[]).includes(id)) {
    return payerName(id as (typeof PAYER_IDS)[number]);
  }
  return field === "rootSessionId" ? `Session ${id.slice(0, 8)}` : id;
}

/* ----------------------------------------------------------------------------
   KPIs
   -------------------------------------------------------------------------- */

function changeDelta(
  current: number,
  prior: number | null | undefined,
  comparison: string,
): StatDelta | undefined {
  const change = relativeChange(current, prior);
  if (change === null) return undefined;
  return {
    value: formatChange(change),
    trend: Math.abs(change) < 0.005 ? "flat" : change > 0 ? "up" : "down",
    sentiment: "neutral",
    comparison,
  };
}

/** "—" with an explanation, for an amount nobody priced. */
function Unpriced(props: { reason?: string }) {
  return (
    <ReasonTooltip reason={props.reason ?? "No list price is recorded for these models yet."}>
      <span tabIndex={0} className="cursor-help text-fg-subtle" aria-label="Not priced">
        —
      </span>
    </ReasonTooltip>
  );
}

function MoneyValue(props: { measures: UsageMeasures; compact?: boolean }) {
  const { measures } = props;
  if (measures.calls > 0 && costUnknown(measures)) return <Unpriced />;
  const value = formatMoney(costMicros(measures), { compact: props.compact });
  const partlyUnpriced = measures.pricedCalls < measures.calls && costIsEstimate(measures);
  return (
    <span className="tabular-nums">
      {costIsEstimate(measures) ? "~" : ""}
      {value}
      {partlyUnpriced ? (
        <ReasonTooltip
          reason={`${formatCount(measures.calls - measures.pricedCalls)} of ${formatCount(measures.calls)} calls have no list price yet and aren't counted.`}
        >
          <span tabIndex={0} className="ml-0.5 cursor-help align-super text-2xs text-fg-subtle">
            *
          </span>
        </ReasonTooltip>
      ) : null}
    </span>
  );
}

function KpiTiles(props: { usage: UsageResponse }) {
  const { totals, prior, range } = props.usage;
  const comparison = `vs ${priorLabel(range)}`;
  const credits = totals.byPayer?.opengeni_credits?.chargedMicros ?? totals.chargedMicros;
  const estimated =
    (totals.byPayer?.subscription?.listMicros ?? 0) + (totals.byPayer?.own_key?.listMicros ?? 0);
  const tokens = totals.tokensTotal ?? tokenTotal(totals.tokens);
  const priorTokens = prior ? (prior.tokensTotal ?? tokenTotal(prior.tokens)) : null;
  const hit = cacheHitRate(totals);
  const priorHit = prior ? cacheHitRate(prior) : null;
  const spendCaption = costUnknown(totals)
    ? "No list price recorded for these models"
    : estimated > 0
      ? `${formatMoney(credits)} charged · ~${formatMoney(estimated)} estimated`
      : "Charged to Opengeni credits";
  const withDelta = (delta: StatDelta | undefined) => (delta ? { delta } : {});
  const cacheDelta: StatDelta | undefined =
    hit !== null && priorHit !== null && prior && prior.cacheKnownCalls > 0
      ? {
          value:
            Math.round((hit - priorHit) * 100) === 0
              ? "0 pts"
              : `${hit > priorHit ? "+" : "−"}${Math.abs(Math.round((hit - priorHit) * 100))} pts`,
          trend: Math.round((hit - priorHit) * 100) === 0 ? "flat" : hit > priorHit ? "up" : "down",
          sentiment: "neutral",
          comparison,
        }
      : undefined;
  const tokensUnknown =
    totals.tokenKnownCalls === 0 && totals.calls > 0 && totals.tokensTotal === undefined;
  return (
    <StatGroup columns={4} label={rangeLabel(range)}>
      <StatTile
        label="Spend"
        value={<MoneyValue measures={totals} />}
        {...withDelta(
          prior && !costUnknown(prior) && costMicros(prior) > 0
            ? changeDelta(costMicros(totals), costMicros(prior), comparison)
            : undefined,
        )}
        caption={spendCaption}
      />
      <StatTile
        label="Model calls"
        value={totals.calls.toLocaleString("en-US")}
        {...withDelta(prior ? changeDelta(totals.calls, prior.calls, comparison) : undefined)}
        {...(totals.calls > 0 && !tokensUnknown
          ? { caption: `${formatCount(tokens / totals.calls)} tokens per call` }
          : {})}
      />
      <StatTile
        label="Tokens"
        value={
          tokensUnknown ? (
            <Unpriced reason="These calls didn't report token counts." />
          ) : (
            formatCount(tokens)
          )
        }
        {...withDelta(priorTokens ? changeDelta(tokens, priorTokens, comparison) : undefined)}
        {...(totals.tokensTotal === undefined && !tokensUnknown
          ? {
              caption: `${formatCount(inputTotal(totals.tokens))} in · ${formatCount(totals.tokens.output)} out`,
            }
          : {})}
      />
      <StatTile
        label="Cache hit rate"
        value={
          hit === null ? (
            <Unpriced reason="No call in this period reported cache use." />
          ) : (
            formatPct(hit)
          )
        }
        {...withDelta(cacheDelta)}
        caption="Input read from cache"
      />
    </StatGroup>
  );
}

/* ----------------------------------------------------------------------------
   Over time
   -------------------------------------------------------------------------- */

const METRIC_LABEL: Record<UsageMetric, string> = {
  spend: "Spend",
  tokens: "Tokens",
  calls: "Calls",
};

function OverTimePanel(props: {
  usage: UsageResponse;
  rows: readonly BreakdownRow[];
  metric: UsageMetric;
  split: boolean;
  onMetric: (metric: UsageMetric) => void;
  onSplit: (split: boolean) => void;
}) {
  const { usage, metric } = props;
  const canSplit = usage.capabilities.seriesGroups && usage.series.some((point) => point.groups);
  const split = props.split && canSplit;
  const groupWord = GROUP_LABELS[usage.groupBy].toLowerCase();

  const { series, buckets } = useMemo(() => {
    const bucketsOut: ChartBucket[] = usage.series.map((point) => ({
      key: point.start,
      label: formatBucket(point.start, usage.bucket),
      title:
        usage.bucket === "hour"
          ? `${formatBucket(point.start, "day", true)}, ${formatBucket(point.start, "hour")} UTC`
          : formatBucket(point.start, "day", true),
      values: {},
    }));
    const valueOf = (
      m: Pick<UsageMeasures, "calls" | "chargedMicros" | "listMicros" | "tokens" | "byPayer">,
    ) =>
      metric === "calls"
        ? m.calls
        : metric === "tokens"
          ? tokenTotal(m.tokens)
          : costMicros(m as UsageMeasures);
    if (split) {
      const keyToRow = new Map<string, BreakdownRow>();
      for (const group of usage.groups) {
        const row = props.rows.find(
          (candidate) =>
            candidate.filter?.values.includes(
              usage.groupBy === "model" && group.provider && group.model
                ? modelFilterKey(group.provider, group.model)
                : group.key,
            ) || candidate.id === `${group.kind}:${group.key}`,
        );
        if (row) keyToRow.set(group.key, row);
      }
      const order = props.rows.slice(0, 6);
      const seriesOut: ChartSeries[] = order.map((row, index) => ({
        id: row.id,
        // Two series that read the same ("Private chats" for two people) add their detail.
        label:
          row.detail && order.some((other) => other !== row && other.label === row.label)
            ? `${row.label} · ${row.detail}`
            : row.label,
        text: SERIES_TONES[index]!.text,
        bg: SERIES_TONES[index]!.bg,
      }));
      let hasOther = false;
      usage.series.forEach((point, index) => {
        for (const [key, value] of Object.entries(point.groups ?? {})) {
          const row = keyToRow.get(key);
          const id = row && order.includes(row) ? row.id : "other";
          if (id === "other") hasOther = true;
          const bucket = bucketsOut[index]!;
          bucket.values[id] = (bucket.values[id] ?? 0) + valueOf(value as UsageMeasures);
        }
      });
      if (hasOther) seriesOut.push({ id: "other", label: "Other", ...OTHER_TONE });
      return { series: seriesOut, buckets: bucketsOut };
    }
    if (metric === "tokens") {
      const tokenSeries: ChartSeries[] = TOKEN_CLASSES.map((tokenClass) => ({
        id: tokenClass.id,
        label: tokenClass.label,
        text: tokenClass.text,
        bg: tokenClass.bg,
      }));
      usage.series.forEach((point, index) => {
        for (const tokenClass of TOKEN_CLASSES) {
          bucketsOut[index]!.values[tokenClass.id] = point.measures.tokens[tokenClass.id];
        }
      });
      return { series: tokenSeries, buckets: bucketsOut };
    }
    usage.series.forEach((point, index) => {
      bucketsOut[index]!.values.total = valueOf(point.measures);
    });
    return {
      series: [
        { id: "total", label: METRIC_LABEL[metric], text: "text-chart-1", bg: "bg-chart-1" },
      ],
      buckets: bucketsOut,
    };
  }, [usage, metric, split, props.rows]);

  const format = (value: number) =>
    metric === "spend"
      ? formatMoney(value)
      : metric === "tokens"
        ? formatCount(value)
        : value.toLocaleString("en-US");
  const axis = (value: number) =>
    metric === "spend" ? formatMoneyAxis(value) : formatCount(value);
  const unit = usage.bucket === "hour" ? "hour" : "day";

  return (
    <section aria-label="Over time" className={cn(PANEL, "flex flex-col gap-4 p-4")}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className={PANEL_TITLE}>
          {METRIC_LABEL[metric]} per {unit}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {canSplit ? (
            <SegmentedControl<"total" | "group">
              size="sm"
              variant="outlined"
              aria-label="Split the chart"
              value={split ? "group" : "total"}
              onValueChange={(next) => props.onSplit(next === "group")}
              options={[
                { value: "total", label: metric === "tokens" ? "By type" : "Total" },
                { value: "group", label: `By ${groupWord}` },
              ]}
            />
          ) : null}
          <SegmentedControl<UsageMetric>
            size="sm"
            aria-label="Chart measure"
            value={metric}
            onValueChange={props.onMetric}
            options={[
              { value: "spend", label: "Spend" },
              { value: "tokens", label: "Tokens" },
              { value: "calls", label: "Calls" },
            ]}
          />
        </div>
      </div>
      {buckets.length === 0 ? (
        <p className="grid min-h-40 place-items-center text-xs text-fg-subtle">
          The chart isn't available for this selection yet.
        </p>
      ) : metric === "spend" && costUnknown(usage.totals) ? (
        <p className="grid min-h-40 place-items-center px-6 text-center text-xs text-fg-subtle">
          No list price is recorded for these models yet, so there's no spend to chart. Switch to
          Tokens or Calls.
        </p>
      ) : (
        <StackedBarChart
          label={`${METRIC_LABEL[metric]} per ${unit}`}
          buckets={buckets}
          series={series}
          formatValue={format}
          formatAxis={axis}
          height={232}
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
   Token and cost composition
   -------------------------------------------------------------------------- */

function CompositionPanel(props: { measures: UsageMeasures }) {
  const { measures } = props;
  const classesKnown = measures.tokensTotal === undefined && measures.tokenKnownCalls > 0;
  const total = tokenTotal(measures.tokens);
  const costs = measures.listByClassMicros;
  const costTotal = costs
    ? costs.uncachedInput + costs.cacheRead + costs.cacheWrite + costs.output
    : 0;
  const cacheWritesUnrecorded =
    measures.cacheWriteKnownCalls < measures.cacheKnownCalls && measures.tokens.cacheWrite === 0;

  return (
    <section aria-label="Tokens and cost" className={cn(PANEL, "flex flex-col gap-4 p-4")}>
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className={PANEL_TITLE}>Tokens and cost by type</h2>
        <HelpTip label="About token types">
          Input is split by how the provider served it. Cost is each type's share at list price
          {measures.listByClassApprox ? ", allocated from each call's total" : ""}.
        </HelpTip>
      </div>
      {!classesKnown ? (
        <p className="text-xs leading-4.5 text-fg-muted">
          These calls didn't report their token types.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            <ShareBar
              label="Tokens"
              values={TOKEN_CLASSES.map((c) => ({
                id: c.id,
                bg: c.bg,
                value: measures.tokens[c.id],
              }))}
            />
            {costs && costTotal > 0 ? (
              <ShareBar
                label="Cost"
                values={TOKEN_CLASSES.map((c) => ({ id: c.id, bg: c.bg, value: costs[c.id] }))}
              />
            ) : null}
          </div>
          <div
            role="table"
            aria-label="Tokens and cost by type"
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 text-xs"
          >
            <div role="row" className="contents text-fg-subtle">
              <span role="columnheader" className="pb-1.5">
                Type
              </span>
              <span role="columnheader" className="pb-1.5 text-right">
                Tokens
              </span>
              <span role="columnheader" className="pb-1.5 text-right">
                Cost
              </span>
            </div>
            {TOKEN_CLASSES.map((tokenClass) => {
              const tokens = measures.tokens[tokenClass.id];
              const cost = costs ? costs[tokenClass.id] : null;
              return (
                <div role="row" key={tokenClass.id} className="contents">
                  <span
                    role="cell"
                    className="flex min-w-0 items-center gap-2 border-t border-border py-2 text-fg"
                  >
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-[3px]", tokenClass.bg)}
                    />
                    <span className="min-w-0">{tokenClass.label}</span>
                    <HelpTip label={`About ${tokenClass.label.toLowerCase()}`}>
                      {tokenClass.help}
                    </HelpTip>
                  </span>
                  <span role="cell" className="border-t border-border py-2 text-right tabular-nums">
                    {tokenClass.id === "cacheWrite" && cacheWritesUnrecorded ? (
                      <Unpriced reason="This provider doesn't report cache writes for these calls." />
                    ) : (
                      <>
                        <span className="text-fg">{formatCount(tokens)}</span>
                        <span className="ml-1.5 inline-block w-9 text-fg-subtle">
                          {formatPct(total > 0 ? tokens / total : null)}
                        </span>
                      </>
                    )}
                  </span>
                  <span role="cell" className="border-t border-border py-2 text-right tabular-nums">
                    {cost === null || costTotal === 0 ? (
                      <Unpriced reason="Cost by token type isn't recorded for these calls yet." />
                    ) : (
                      <>
                        <span className="text-fg">{formatMoney(cost)}</span>
                        <span className="ml-1.5 inline-block w-9 text-fg-subtle">
                          {formatPct(cost / costTotal)}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {measures.tokens.reasoning > 0 ? (
            <p className="text-xs leading-4.5 text-fg-subtle">
              Output includes {formatCount(measures.tokens.reasoning)} reasoning tokens.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function ShareBar(props: {
  label: string;
  values: Array<{ id: TokenClassId; bg: string; value: number }>;
}) {
  const total = props.values.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  return (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-3">
      <span className="text-xs text-fg-muted">{props.label}</span>
      <div aria-hidden="true" className="flex h-2.5 min-w-0 gap-0.5 overflow-hidden rounded-full">
        {total > 0 ? (
          props.values
            .filter((item) => item.value > 0)
            .map((item) => (
              <span
                key={item.id}
                className={cn("h-full min-w-0.5 first:rounded-l-full last:rounded-r-full", item.bg)}
                style={{ flexGrow: item.value, flexBasis: 0 }}
              />
            ))
        ) : (
          <span className="h-full w-full rounded-full bg-surface-2" />
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Breakdown
   -------------------------------------------------------------------------- */

type SortColumn = "name" | "calls" | TokenClassId | "cost";

const BREAKDOWN_COLUMNS: RowListColumn[] = [
  { id: "calls", label: "Calls", width: 76, align: "end", sortable: true },
  { id: "uncachedInput", label: "Input", width: 76, align: "end", sortable: true },
  { id: "cacheRead", label: "Cache reads", width: 112, align: "end", sortable: true },
  { id: "cacheWrite", label: "Cache writes", width: 112, align: "end", sortable: true },
  { id: "output", label: "Output", width: 76, align: "end", sortable: true },
  {
    id: "cost",
    label: "Cost",
    width: 96,
    align: "end",
    sortable: true,
    hideLabel: true,
    leadsWhenFolded: true,
  },
  { id: "share", label: "Share", width: 112, align: "end" },
];

function sortValue(row: BreakdownRow, column: SortColumn): number | string {
  if (column === "name") return row.label.toLocaleLowerCase();
  if (column === "calls") return row.measures.calls;
  if (column === "cost") return row.cost;
  return row.measures.tokensTotal !== undefined ? -1 : row.measures.tokens[column];
}

function RowMark(props: {
  mark: MarkId;
  modelId?: string | undefined;
  kind: BreakdownRow["kind"];
}) {
  if (props.modelId) return <ModelTile model={props.modelId} />;
  if (props.kind === "private") return <LogoTile icon={<LockIcon />} />;
  if (props.kind === "deleted") return <LogoTile icon={<Trash2Icon />} />;
  if (props.mark === "opengeni") return <OpenGeniCreditsTile />;
  if (props.mark) return <ProviderTile provider={props.mark} />;
  return null;
}

function BreakdownPanel(props: {
  usage: UsageResponse;
  rows: readonly BreakdownRow[];
  scope: UsageScope;
  query: ReturnType<typeof usageQuery>;
  groupOptions: readonly UsageGroupBy[];
  tab: "breakdown" | "calls";
  legacyCalls: UsageCall[] | null;
  source: UsageLoad["source"];
  labels: ModelLabelSource;
  onChange: (change: UsageSearchChange) => void;
  onOpenSession?: ((sessionId: string, workspaceId: string | null) => void) | undefined;
}) {
  const { usage, rows } = props;
  const [sort, setSort] = useState<RowListSort>({ column: "cost", direction: "desc" });
  const groupBy = usage.groupBy;
  const marks =
    groupBy === "model" ||
    groupBy === "provider" ||
    groupBy === "payer" ||
    rows.some((row) => row.kind === "private" || row.kind === "deleted");
  const sorted = useMemo(() => {
    const column = sort.column as SortColumn;
    const direction = sort.direction === "asc" ? 1 : -1;
    const rank = (row: BreakdownRow) => (row.kind === "other" ? 1 : 0);
    return [...rows].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const left = sortValue(a, column);
      const right = sortValue(b, column);
      if (left < right) return -direction;
      if (left > right) return direction;
      return 0;
    });
  }, [rows, sort]);
  const totalCost = costMicros(usage.totals);
  const next = DRILL_NEXT[groupBy];
  const nextAllowed =
    usage.capabilities.groupBy.includes(next) &&
    (next !== "workspace" || props.scope.kind === "organization");
  const filterAllowed = usage.capabilities.filters.includes(FILTER_FIELD_OF[groupBy]);
  const legacyLimit =
    props.scope.kind === "workspace" && !usage.capabilities.filters.includes("payer");

  return (
    <section aria-label="Breakdown" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className={SECTION_TITLE_CLASS}>Breakdown by</h2>
          <SelectMenu
            aria-label="Group by"
            size="sm"
            value={groupBy}
            onValueChange={(group) => props.onChange({ group, tab: "breakdown" })}
            options={props.groupOptions.map((group) => ({
              value: group,
              label: GROUP_LABELS[group],
            }))}
            className="w-36"
          />
        </div>
        <SegmentedControl<"breakdown" | "calls">
          size="sm"
          aria-label="Breakdown view"
          value={props.tab}
          onValueChange={(tab) => props.onChange({ tab })}
          options={[
            { value: "breakdown", label: "Totals" },
            { value: "calls", label: "Recent calls" },
          ]}
        />
      </div>
      {props.tab === "calls" ? (
        <RecentCalls
          scope={props.scope}
          query={props.query}
          legacyCalls={props.legacyCalls}
          source={props.source}
          labels={props.labels}
          onOpenSession={props.onOpenSession}
        />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">No usage in this selection.</p>
      ) : (
        <>
          <RowList
            variant="table"
            label={`Usage by ${GROUP_LABELS[groupBy].toLowerCase()}`}
            nameLabel={GROUP_LABELS[groupBy]}
            nameSortable
            columns={BREAKDOWN_COLUMNS}
            sort={sort}
            onSortChange={setSort}
          >
            {sorted.map((row) => {
              const unknownClasses = row.measures.tokensTotal !== undefined;
              const share =
                totalCost > 0 && !costUnknown(row.measures) ? row.cost / totalCost : null;
              const canDrill = row.filter !== null && filterAllowed;
              const tokenCell = (id: TokenClassId) =>
                unknownClasses ? (
                  id === "uncachedInput" ? (
                    <ReasonTooltip
                      reason={`${formatCount(row.measures.tokensTotal ?? 0)} tokens in total; their types weren't reported.`}
                    >
                      <span tabIndex={0} className="cursor-help text-fg-subtle">
                        —
                      </span>
                    </ReasonTooltip>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )
                ) : (
                  <Quiet>{formatCount(row.measures.tokens[id])}</Quiet>
                );
              return (
                <ListRow
                  key={row.id}
                  leading={
                    marks ? (
                      <RowMark mark={row.mark} modelId={row.modelId} kind={row.kind} />
                    ) : undefined
                  }
                  title={row.label}
                  titleAddon={
                    row.you ? <span className="text-xs text-fg-subtle">You</span> : undefined
                  }
                  meta={row.detail ? [row.detail] : undefined}
                  cells={{
                    calls:
                      unknownClasses && row.measures.calls === 0 ? (
                        <span className="text-fg-subtle">—</span>
                      ) : (
                        <Quiet>{row.measures.calls.toLocaleString("en-US")}</Quiet>
                      ),
                    uncachedInput: tokenCell("uncachedInput"),
                    cacheRead: tokenCell("cacheRead"),
                    cacheWrite: tokenCell("cacheWrite"),
                    output: tokenCell("output"),
                    cost: (
                      <span className="text-sm text-fg">
                        <MoneyValue measures={row.measures} />
                      </span>
                    ),
                    share: <ShareCell share={share} />,
                  }}
                  {...(canDrill
                    ? {
                        onOpen: () =>
                          props.onChange({
                            filter: { field: row.filter!.field, values: row.filter!.values },
                            ...(nextAllowed ? { group: next } : {}),
                          }),
                        indicator: "open" as const,
                      }
                    : {})}
                  {...(row.sessionId && props.onOpenSession
                    ? {
                        menu: (
                          <DropdownMenuItem
                            onSelect={() =>
                              props.onOpenSession!(row.sessionId!, row.workspaceId ?? null)
                            }
                          >
                            Open session
                          </DropdownMenuItem>
                        ),
                        menuLabel: `More for ${row.label}`,
                      }
                    : {})}
                />
              );
            })}
          </RowList>
          <p className="text-xs leading-4.5 text-fg-subtle">
            {usage.groupsTruncated
              ? `The ${rows.length} largest of ${usage.groupCount.toLocaleString("en-US")}. `
              : ""}
            {canDrillHint(groupBy, filterAllowed)}
            {rows.some((row) => row.kind === "private")
              ? " Other people's private chats show as amounts only."
              : ""}
            {legacyLimit && rows.some((row) => row.measures.tokensTotal !== undefined)
              ? " Token types by row arrive with the next update."
              : ""}
          </p>
        </>
      )}
    </section>
  );
}

function canDrillHint(groupBy: UsageGroupBy, allowed: boolean): string {
  if (!allowed) return "";
  return `Select a ${GROUP_LABELS[groupBy].toLowerCase()} to filter everything to it.`;
}

function ShareCell(props: { share: number | null }) {
  if (props.share === null) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="inline-flex w-full items-center justify-end gap-2">
      <span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2">
        <span
          className="block h-full rounded-full bg-fg-muted"
          style={{ width: `${Math.max(2, props.share * 100)}%` }}
        />
      </span>
      <span className="w-9 text-right text-xs text-fg-muted tabular-nums">
        {formatPct(props.share)}
      </span>
    </span>
  );
}

function Quiet(props: { children: ReactNode }) {
  return <span className="text-sm text-fg-muted tabular-nums">{props.children}</span>;
}

/* ----------------------------------------------------------------------------
   Recent calls
   -------------------------------------------------------------------------- */

const CALL_COLUMNS: RowListColumn[] = [
  { id: "model", label: "Model", width: 168 },
  { id: "input", label: "Input", width: 76, align: "end" },
  { id: "cached", label: "Cache reads", width: 104, align: "end" },
  { id: "output", label: "Output", width: 76, align: "end" },
  { id: "cost", label: "Cost", width: 96, align: "end", hideLabel: true, leadsWhenFolded: true },
];

function RecentCalls(props: {
  scope: UsageScope;
  query: ReturnType<typeof usageQuery>;
  legacyCalls: UsageCall[] | null;
  source: UsageLoad["source"];
  labels: ModelLabelSource;
  onOpenSession?: ((sessionId: string, workspaceId: string | null) => void) | undefined;
}) {
  const { client } = useAppContext();
  const [state, setState] = useState<
    { key: string; calls: UsageCall[] } | { key: string; error: unknown } | null
  >(null);
  const key = JSON.stringify([
    props.scope.kind,
    props.scope.workspaceId ?? props.scope.accountId,
    props.query.filters,
    props.query.range,
  ]);
  // The older endpoints have no calls route; their calls come with the totals.
  const fetches = !props.legacyCalls && props.source === "usage";
  useEffect(() => {
    if (!fetches) return;
    const controller = new AbortController();
    loadUsageCalls(client, props.scope, props.query, controller.signal)
      .then((response) => !controller.signal.aborted && setState({ key, calls: response.calls }))
      .catch((error: unknown) => !controller.signal.aborted && setState({ key, error }));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, fetches]);

  const loaded = state?.key === key ? state : null;
  const calls = props.legacyCalls ?? (loaded && "calls" in loaded ? loaded.calls : null);
  if (!calls) {
    if (!fetches || (loaded && "error" in loaded)) {
      return (
        <p className="py-6 text-center text-sm text-fg-muted">
          Recent calls aren't available here yet.
        </p>
      );
    }
    return (
      <div className="flex flex-col">
        {[0, 1, 2, 3].map((index) => (
          <ListRowSkeleton key={index} />
        ))}
      </div>
    );
  }
  if (calls.length === 0) {
    return <p className="py-6 text-center text-sm text-fg-muted">No calls in this selection.</p>;
  }
  return (
    <RowList variant="table" label="Recent model calls" nameLabel="Session" columns={CALL_COLUMNS}>
      {calls.map((call) => {
        const title =
          call.sessionKind === "private"
            ? "Private chat"
            : call.sessionKind === "deleted"
              ? "Deleted chat"
              : (call.sessionTitle ?? "Untitled session");
        const cost: UsageMeasures = {
          calls: 1,
          tokenKnownCalls: call.tokens ? 1 : 0,
          cacheKnownCalls: 1,
          cacheWriteKnownCalls: 1,
          tokens: call.tokens ?? {
            uncachedInput: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            reasoning: 0,
          },
          chargedMicros: call.chargedMicros,
          listMicros: call.listMicros ?? 0,
          listByClassMicros: null,
          listClassKnownCalls: 0,
          listByClassApprox: false,
          pricedCalls: call.listMicros === null ? 0 : 1,
          byPayer: {
            [call.payer]: {
              calls: 1,
              chargedMicros: call.chargedMicros,
              listMicros: call.listMicros ?? 0,
            },
          },
        };
        return (
          <ListRow
            key={call.id}
            title={title}
            meta={[
              new Date(call.occurredAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
                timeZone: "UTC",
              }) + " UTC",
            ]}
            cells={{
              model: (
                <span className="inline-flex min-w-0 items-center gap-2 text-sm text-fg-muted">
                  <ModelTile model={call.model} size="sm" />
                  <span className="truncate">
                    {modelDisplayName(call.provider, call.model, props.labels)}
                  </span>
                </span>
              ),
              input: <Quiet>{call.tokens ? formatCount(inputTotal(call.tokens)) : "—"}</Quiet>,
              cached: <Quiet>{call.tokens ? formatCount(call.tokens.cacheRead) : "—"}</Quiet>,
              output: <Quiet>{call.tokens ? formatCount(call.tokens.output) : "—"}</Quiet>,
              cost: (
                <span className="text-sm text-fg">
                  <MoneyValue measures={cost} />
                </span>
              ),
            }}
            {...(call.sessionKind === "visible" && call.sessionId && props.onOpenSession
              ? {
                  onOpen: () => props.onOpenSession!(call.sessionId!, call.workspaceId),
                  indicator: "open" as const,
                }
              : {})}
          />
        );
      })}
    </RowList>
  );
}

/* ----------------------------------------------------------------------------
   Loading
   -------------------------------------------------------------------------- */

function DashboardSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        Loading Insights
      </span>
      <div className="flex gap-2">
        <span className="h-8 w-40 rounded-[8px] bg-surface-2 motion-safe:animate-pulse" />
        <span className="h-8 w-24 rounded-[8px] bg-surface-2 motion-safe:animate-pulse" />
      </div>
      <StatGroup columns={4}>
        <StatTile label="Spend" loading />
        <StatTile label="Model calls" loading />
        <StatTile label="Tokens" loading />
        <StatTile label="Cache hit rate" loading />
      </StatGroup>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className={cn(PANEL, "h-72 motion-safe:animate-pulse")} />
        <div className={cn(PANEL, "h-72 motion-safe:animate-pulse")} />
      </div>
      <div className="flex flex-col">
        {[0, 1, 2, 3, 4].map((index) => (
          <ListRowSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}
