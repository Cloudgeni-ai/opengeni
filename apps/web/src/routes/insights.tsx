import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3Icon, XIcon } from "lucide-react";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import { AreaChart, UsageMeter } from "@/components/insights/charts";
import { CausalSheet } from "@/components/insights/causal-sheet";
import { CountUp } from "@/components/insights/count-up";
import { PageHeader } from "@/components/common";
import {
  RANGE_OPTIONS,
  backendLabel,
  billingLabel,
  buildInsightsDiagnostics,
  buildInsightsView,
  driverRootSessionId,
  formatCachePct,
  formatDeltaUsd,
  formatPctDelta,
  formatTokens,
  formatUtcTimestamp,
  formatUsd,
  formatUsdTick,
  formatWarmHours,
  providerLabel,
  CACHE_MISS_MIN_INPUT_TOKENS,
  OUTLIER_MEDIAN_MULTIPLE,
  type BillingPath,
  type FloorSession,
  type InsightsFilters,
  type InsightsMeasure,
  type InsightsRange,
  type TraceTarget,
} from "@/components/insights/mock-data";
import {
  insightsFilters,
  insightsMeasure,
  insightsRange,
  nextInsightsSearch,
  parseInsightsSearch,
  type InsightsSearch,
} from "@/components/insights/search";
import { Button } from "@/components/ui/button";
import { ContentPage, DataScroller } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

function inputSeriesHeading(seriesLabel: string, subject: string): string {
  const separator = seriesLabel.indexOf(" / ");
  return separator >= 0 ? `${subject}${seriesLabel.slice(separator)}` : subject;
}

const PROMPT_SOURCE_LABELS = {
  workspace_instruction_policy: "Workspace instruction policy",
  legacy_workspace_instructions: "Legacy workspace instructions",
  preference_registry_descriptor: "Skill descriptors",
  company_profile: "Company profile",
  legacy_memory_v1: "Workspace memory",
  runtime_skill_catalog: "Available skill guides",
} as const;

const EMPTY_PROMPT_CONTRIBUTIONS: WorkspaceInsightsSnapshot["promptContributions"] = {
  estimatedTokens: 0,
  utf8Bytes: 0,
  coveredCalls: 0,
  totalCalls: 0,
  sources: [],
};

type CostRow = {
  billing: BillingPath;
  calls: number;
  creditUsd: number;
  estimatedProviderUsd: number;
  estimatedProviderCostKnownCalls: number;
};

/** Credit-paid rows show what was charged; external rows show a provider-rate estimate. */
function costLabel(row: CostRow): string {
  if (row.billing === "opengeni_credits") return formatUsd(row.creditUsd);
  if (row.estimatedProviderCostKnownCalls === 0) return "Unknown";
  const estimate = `~${formatUsd(row.estimatedProviderUsd)} est.`;
  return row.estimatedProviderCostKnownCalls < row.calls
    ? `${estimate} · ${row.estimatedProviderCostKnownCalls.toLocaleString()}/${row.calls.toLocaleString()} priced`
    : estimate;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function sameFilters(a: InsightsFilters, b: InsightsFilters): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    (a.rootSessionId ?? null) === (b.rootSessionId ?? null) &&
    (a.sessionId ?? null) === (b.sessionId ?? null)
  );
}

type SelectionChange = Parameters<typeof nextInsightsSearch>[1];

/**
 * Workspace Insights — live rollups from usage_events + model_call_facts.
 * The selection (range, chart, provider, model, root session, session) lives in the URL.
 */
export function InsightsRoute({
  workspaceId,
  search,
  onSearchChange,
}: {
  workspaceId: string;
  search?: Record<string, unknown>;
  onSearchChange?: (next: InsightsSearch) => void;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((w) => w.id === workspaceId);
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const reduceMotion = useReducedMotion();
  const [localSearch, setLocalSearch] = useState<InsightsSearch>(() =>
    parseInsightsSearch(search ?? {}),
  );
  const routedSelection = useMemo(() => parseInsightsSearch(search ?? {}), [search]);
  const selection = onSearchChange ? routedSelection : localSearch;
  const range = insightsRange(selection);
  const measure = insightsMeasure(selection);
  const { provider, model, root, session } = selection;
  const filters = useMemo(
    () => insightsFilters({ provider, model, root, session }),
    [provider, model, root, session],
  );
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const [floorFilter, setFloorFilter] = useState<"all" | "active">("all");
  const [snapshot, setSnapshot] = useState<WorkspaceInsightsSnapshot | null>(null);
  const [loadedFilters, setLoadedFilters] = useState<InsightsFilters>(filters);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [scopeLabels, setScopeLabels] = useState<Record<string, string>>({});

  const update = (change: SelectionChange) => {
    const next = nextInsightsSearch(selection, change);
    if (onSearchChange) onSearchChange(next);
    else setLocalSearch(next);
  };

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setLoadError("Workspace admin permission is required to view Insights.");
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void context.client
      .getWorkspaceInsights(workspaceId, {
        range,
        signal: controller.signal,
        ...(filters.provider !== "all" ? { provider: filters.provider } : {}),
        ...(filters.model !== "all" ? { model: filters.model } : {}),
        ...(filters.rootSessionId ? { rootSessionId: filters.rootSessionId } : {}),
        ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
      })
      .then((response) => {
        if (cancelled) return;
        setSnapshot(response.snapshot);
        setLoadedFilters(filters);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [canRead, context.client, filters, range, retry, workspaceId]);

  // Remember session titles seen in any snapshot so scope chips stay readable after narrowing.
  useEffect(() => {
    if (!snapshot) return;
    setScopeLabels((previous) => {
      const next = { ...previous };
      for (const driver of snapshot.drivers) {
        const id = driverRootSessionId(driver.id);
        if (id) next[id] = driver.label;
      }
      for (const call of snapshot.recentCalls) next[call.sessionId] = call.sessionTitle;
      for (const row of snapshot.floor) next[row.id] = row.title;
      return next;
    });
  }, [snapshot]);

  const view = useMemo(
    () => (snapshot ? buildInsightsView(snapshot, loadedFilters) : null),
    [loadedFilters, snapshot],
  );
  const diagnostics = useMemo(
    () => (snapshot ? buildInsightsDiagnostics(snapshot) : null),
    [snapshot],
  );
  const snap = view?.snap ?? null;
  const totals = view?.totals;
  const deltas = view?.deltas;
  const series = view?.series ?? [];
  const models = view?.models ?? [];
  const providers = view?.providers ?? [];
  const promptContributions = snap?.promptContributions ?? {
    ...EMPTY_PROMPT_CONTRIBUTIONS,
    totalCalls: snap?.modelCalls ?? 0,
  };
  const maxDepthSessions = Math.max(...(snap?.depth.map((b) => b.sessions) ?? [1]), 1);
  const scopeActive = Boolean(filters.rootSessionId || filters.sessionId);
  const filtered = filters.provider !== "all" || filters.model !== "all" || scopeActive;
  const showingPreviousSelection =
    snapshot !== null && (snapshot.range !== range || !sameFilters(loadedFilters, filters));

  const setProvider = (next: string) => {
    const nextProvider = next === "all" ? "all" : next;
    const keepModel =
      nextProvider === "all" ||
      filters.model === "all" ||
      !snapshot ||
      (snapshot.facets ?? []).some(
        (facet) => facet.provider === nextProvider && facet.model === filters.model,
      );
    update({ provider: nextProvider, ...(keepModel ? {} : { model: "all" }) });
  };

  const scopeToRoot = (rootSessionId: string, label?: string) => {
    if (label) setScopeLabels((previous) => ({ ...previous, [rootSessionId]: label }));
    update({ rootSessionId, sessionId: null });
  };
  const scopeToSession = (sessionId: string, label?: string) => {
    if (label) setScopeLabels((previous) => ({ ...previous, [sessionId]: label }));
    update({ sessionId });
  };
  const clearFilters = () =>
    update({ provider: "all", model: "all", rootSessionId: null, sessionId: null });

  const openTrace = (driverId: string) => {
    const driver = snap?.drivers.find((d) => d.id === driverId);
    setTrace({ driverId, label: driver?.label ?? driverId });
  };

  const floor = (snap?.floor ?? []).filter((row) => {
    if (floorFilter === "active") {
      return row.state === "running" || row.state === "compacting" || row.state === "waiting";
    }
    return true;
  });

  const heading = (
    <PageHeader
      icon={<BarChart3Icon className="size-4" />}
      title="Insights"
      description={`Usage and activity in ${workspace?.name ?? "this workspace"}.`}
    />
  );

  if (!canRead || (loadError && !snapshot)) {
    return (
      <ContentPage width="wide" data-insights className="gap-6">
        {heading}
        <div role="alert">
          <Notice
            tone={canRead ? "failed" : "muted"}
            title={canRead ? "Insights couldn't load" : "Workspace access required"}
            action={
              canRead ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {canRead
              ? `Try again to load workspace usage. ${loadError}`
              : "Workspace admin permission is required to view Insights."}
          </Notice>
        </div>
      </ContentPage>
    );
  }

  if ((!snapshot && loading) || !snap || !totals || !deltas || !view || !diagnostics) {
    return (
      <ContentPage width="wide" data-insights className="gap-6">
        {heading}
        <div role="status" aria-label="Loading workspace insights" className="grid gap-3">
          <span className="text-sm text-fg-muted">Loading workspace usage…</span>
          <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-32 sm:col-span-2" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton aria-hidden="true" className="h-56" />
        </div>
      </ContentPage>
    );
  }

  const cacheDelta =
    deltas.cachePts === null
      ? totals.cacheHitPct === null
        ? "No calls reported cache detail"
        : `No cache data for ${snap.priorLabel.toLowerCase()}`
      : `${deltas.cachePts > 0 ? "+" : ""}${deltas.cachePts} pts vs ${snap.priorLabel.toLowerCase()}`;
  const externalValue =
    totals.externalCalls === 0
      ? formatUsd(0)
      : totals.externalPricedCalls === 0
        ? "Unknown"
        : `~${formatUsd(totals.externalEstimatedUsd)}`;
  const externalDetail =
    totals.externalCalls === 0
      ? "No externally paid calls"
      : totals.externalPricedCalls === 0
        ? `${totals.externalCalls.toLocaleString()} calls without captured pricing`
        : `Provider list rates · ${totals.externalPricedCalls.toLocaleString()}/${totals.externalCalls.toLocaleString()} calls priced`;
  const composition = [
    {
      id: "cache-read",
      label: "Cache read",
      value: totals.cachedTokens,
      className: "bg-status-running",
    },
    {
      id: "uncached",
      label: "Uncached input",
      value: totals.uncachedInputTokens,
      className: "bg-status-waiting",
    },
    {
      id: "cache-write",
      label: "Cache write",
      value: totals.cacheWriteTokens,
      className: "bg-brand",
    },
    { id: "output", label: "Output", value: totals.outputTokens, className: "bg-fg-muted" },
    ...(totals.unreportedCacheInputTokens > 0
      ? [
          {
            id: "unreported",
            label: "Input, cache not reported",
            value: totals.unreportedCacheInputTokens,
            className: "bg-surface-3",
          },
        ]
      : []),
  ];
  const tokenSeriesValue = (known: number, calls: number, value: number) =>
    calls > 0 && known === 0 ? null : value;

  return (
    <ContentPage width="wide" data-insights className="gap-7 sm:gap-9">
      {heading}
      <div className="grid min-w-0 gap-3">
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <FilterSelect
              label="Provider"
              value={filters.provider}
              onChange={setProvider}
              options={[
                { value: "all", label: "All providers" },
                ...view.availableProviders.map((p) => ({ value: p, label: providerLabel(p) })),
              ]}
            />
            <FilterSelect
              label="Model"
              value={filters.model}
              onChange={(next) => update({ model: next })}
              options={[
                { value: "all", label: "All models" },
                ...view.availableModels.map((m) => ({ value: m, label: m })),
              ]}
            />
            {filters.rootSessionId ? (
              <ScopeChip
                icon={<GitBranchIcon className="size-3" />}
                kind="Root session"
                label={scopeLabels[filters.rootSessionId] ?? shortId(filters.rootSessionId)}
                onRemove={() => update({ rootSessionId: null })}
              />
            ) : null}
            {filters.sessionId ? (
              <ScopeChip
                icon={<MessageSquareIcon className="size-3" />}
                kind="Session"
                label={scopeLabels[filters.sessionId] ?? shortId(filters.sessionId)}
                onRemove={() => update({ sessionId: null })}
              />
            ) : null}
            {filtered ? (
              <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                <XIcon className="size-3.5" />
                Clear filters
              </Button>
            ) : null}
          </div>
          <RangeControl value={range} onChange={(next) => update({ range: next })} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-fg-muted">
          <span role="status">
            {loading
              ? showingPreviousSelection
                ? "Refreshing… showing previous selection"
                : "Refreshing…"
              : null}
          </span>
          <span data-insights-freshness>
            {snap.dataThrough
              ? `Data through ${formatUtcTimestamp(snap.dataThrough)}`
              : "No model calls recorded yet"}
          </span>
        </div>
        {snap.facetsTruncated ? (
          <p className="text-xs text-fg-subtle">
            Filter menus list the first {snap.facets.length.toLocaleString()} provider/model pairs;
            more exist in this window.
          </p>
        ) : null}
      </div>

      {loadError ? (
        <div role="alert">
          <Notice
            tone="failed"
            title="Couldn't refresh insights"
            action={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </Button>
            }
          >
            Showing the last successful selection. {loadError}
          </Notice>
        </div>
      ) : null}

      {snap.modelCalls === 0 ? (
        <EmptyState
          title={filtered ? "No calls match these filters" : "No model calls in this window"}
          description={
            filtered
              ? "Choose another provider, model, or session to see usage."
              : "Model usage will appear here after this workspace makes a call. Other workspace activity may still appear below."
          }
          action={
            filtered ? (
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <Section
        title="Overview"
        aside={
          <p>
            {formatUtcTimestamp(snap.windowStart)} – {formatUtcTimestamp(snap.windowEnd)}
          </p>
        }
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
          <Metric
            featured
            label="Credits spent"
            value={formatUsd(totals.creditUsd)}
            delta={`${formatPctDelta(deltas.modelPct, snap.priorLabel)} · ${totals.creditPaidCalls.toLocaleString()} credit-paid calls`}
          />
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Metric
              label="External spend · estimate"
              value={externalValue}
              delta={externalDetail}
            />
            <Metric
              label="Tokens"
              value={formatTokens(totals.totalTokens)}
              delta={`${formatPctDelta(deltas.tokensPct, snap.priorLabel)} · ${snap.modelCalls.toLocaleString()} calls${totals.tokenCoveragePct < 100 ? ` · ${totals.tokenCoveragePct}% reported` : ""}`}
            />
            <Metric
              label="Cache hit"
              value={formatCachePct(totals.cacheHitPct)}
              delta={`${cacheDelta}${totals.cacheHitPct !== null && totals.cacheCoveragePct < 100 ? ` · ${totals.cacheCoveragePct}% of calls reported` : ""}`}
              tone={totals.cacheHitPct !== null && totals.cacheHitPct >= 60 ? "good" : "neutral"}
            />
          </div>
        </div>
        {totals.ledgerGapUsd !== null && Math.abs(totals.ledgerGapUsd) >= 0.01 ? (
          <div data-insights-ledger-gap>
            <Notice tone="waiting" title="Breakdown coverage">
              {totals.ledgerGapUsd > 0
                ? `Per-model breakdowns cover ${formatUsd(totals.creditPaidUsd, 2)} of the ${formatUsd(totals.creditUsd, 2)} charged. ${formatUsd(totals.ledgerGapUsd, 2)} has no per-call record yet; recent gaps are rebuilt automatically from each call's usage event.`
                : `Per-call records exceed the ${formatUsd(totals.creditUsd, 2)} charged in this window by ${formatUsd(-totals.ledgerGapUsd, 2)}.`}
            </Notice>
          </div>
        ) : null}
        {filtered ? (
          <p className="text-2xs text-fg-subtle">
            Filters narrow model usage, spend, and diagnostics. Sandbox time, live sessions, caps,
            and session depth stay workspace-wide.
          </p>
        ) : null}

        <div className="mt-2 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-fg">
                  {inputSeriesHeading(snap.seriesLabel, measure === "tokens" ? "Tokens" : "Spend")}
                </h3>
                <p className="mt-0.5 text-2xs text-fg-subtle">
                  {measure === "tokens"
                    ? "Gaps mark buckets where calls reported no token counts"
                    : "Provider-rate estimate covers every priced call, credit-paid or external"}
                </p>
              </div>
              <MeasureControl value={measure} onChange={(next) => update({ measure: next })} />
            </div>
            <AreaChart
              key={`${measure}-${range}-${filters.provider}-${filters.model}-${filters.rootSessionId}-${filters.sessionId}`}
              className="mt-3"
              labels={series.map((p) => p.label)}
              formatValue={measure === "tokens" ? formatTokens : formatUsd}
              formatAxisValue={measure === "tokens" ? formatTokens : formatUsdTick}
              height={210}
              series={
                measure === "tokens"
                  ? [
                      {
                        id: "total",
                        label: "Total",
                        values: series.map((d) =>
                          tokenSeriesValue(d.tokenKnownCalls, d.calls, d.totalTokens),
                        ),
                        className: "text-brand",
                      },
                      {
                        id: "input",
                        label: "Input",
                        values: series.map((d) =>
                          tokenSeriesValue(d.tokenKnownCalls, d.calls, d.inputTokens),
                        ),
                        className: "text-status-running",
                      },
                      {
                        id: "output",
                        label: "Output",
                        values: series.map((d) =>
                          tokenSeriesValue(d.tokenKnownCalls, d.calls, d.outputTokens),
                        ),
                        className: "text-status-waiting",
                      },
                    ]
                  : [
                      {
                        id: "credits",
                        label: "Credits spent",
                        values: series.map((d) => d.modelCostUsd),
                        className: "text-brand",
                      },
                      {
                        id: "estimated",
                        label: "Provider-rate estimate",
                        values: series.map((d) =>
                          d.calls > 0 && d.estimatedProviderCostKnownCalls === 0
                            ? null
                            : d.estimatedProviderUsd,
                        ),
                        className: "text-status-running",
                      },
                    ]
              }
            />
          </div>

          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-fg">{snap.cacheSeriesLabel}</h3>
              <p className="font-mono text-xs tabular-nums text-fg-muted">
                {formatCachePct(totals.cacheHitPct)}
              </p>
            </div>
            <p className="mt-0.5 text-2xs text-fg-subtle">
              Share of reported input served from cache · gaps mean no cache detail
            </p>
            <AreaChart
              key={`cache-${range}-${filters.provider}-${filters.model}-${filters.rootSessionId}-${filters.sessionId}`}
              className="mt-3"
              labels={series.map((p) => p.label)}
              valueSuffix="%"
              valueDigits={0}
              yMax={100}
              height={210}
              series={[
                {
                  id: "cache",
                  label: "Cache hit",
                  values: series.map((d) => d.cacheHitPct),
                  className: "text-status-running",
                },
              ]}
            />
          </div>
        </div>

        <TokenComposition segments={composition} reduceMotion={reduceMotion ?? false} />
      </Section>

      <Section
        title="Diagnostics"
        aside={
          <p>
            Among the {diagnostics.sampleSize.toLocaleString()} most recent calls
            {diagnostics.sampleTruncated ? " (older calls not sampled)" : ""}
          </p>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <DiagnosticCard
            title="Outlier calls"
            body={
              diagnostics.medianTotalTokens === null
                ? "Needs calls that reported token totals."
                : `At least ${OUTLIER_MEDIAN_MULTIPLE}× the median of ${formatTokens(Math.round(diagnostics.medianTotalTokens))} tokens per call.`
            }
            empty="No call stands out from the rest of the sample."
            rows={diagnostics.outliers.map(({ call, ratio }) => ({
              id: call.id,
              title: call.sessionTitle,
              meta: `${call.model} · ${formatUtcTimestamp(call.occurredAt)}`,
              value: formatTokens(call.totalTokens ?? 0),
              badge: `${ratio.toFixed(1)}×`,
              onSelect: () => scopeToSession(call.sessionId, call.sessionTitle),
            }))}
          />
          <DiagnosticCard
            title="Cache misses"
            body={`Calls with no cache read and at least ${formatTokens(CACHE_MISS_MIN_INPUT_TOKENS)} uncached input tokens.`}
            empty="Every large prompt in the sample reused cache."
            rows={diagnostics.cacheMisses.map(({ call, uncachedInputTokens }) => ({
              id: call.id,
              title: call.sessionTitle,
              meta: `${call.model} · ${formatUtcTimestamp(call.occurredAt)}`,
              value: formatTokens(uncachedInputTokens),
              badge: "0% cached",
              onSelect: () => scopeToSession(call.sessionId, call.sessionTitle),
            }))}
          />
        </div>
        {diagnostics.lowCacheRoots.length > 0 ? (
          <DiagnosticCard
            title="Root sessions with low cache reuse"
            body="Large root sessions where under a quarter of reported input came from cache."
            empty=""
            rows={diagnostics.lowCacheRoots.map((driver) => {
              const rootId = driverRootSessionId(driver.id);
              return {
                id: driver.id,
                title: driver.label,
                meta: `${formatTokens(driver.tokens)} tokens`,
                value: formatCachePct(driver.cacheHitPct),
                badge: "cache hit",
                onSelect: rootId ? () => scopeToRoot(rootId, driver.label) : undefined,
              };
            })}
          />
        ) : null}
      </Section>

      <Section
        title="By model"
        aside={<p>Click a row to filter · credit-paid rows show charged credits</p>}
      >
        <DataScroller aria-label="Usage by model" className="border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Model",
                  "Billing",
                  "Calls",
                  "Tokens",
                  "Cache read",
                  "Uncached input",
                  "Cache write",
                  "Output",
                  "Cost",
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((row, index) => {
                const share = totals.totalTokens > 0 ? row.totalTokens / totals.totalTokens : 0;
                return (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-surface-2/60"
                    onClick={() => update({ provider: row.provider, model: row.model })}
                  >
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <button
                        type="button"
                        aria-label={`Filter by ${row.model} from ${providerLabel(row.provider)}`}
                        className="rounded text-left font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(event) => {
                          event.stopPropagation();
                          update({ provider: row.provider, model: row.model });
                        }}
                      >
                        {row.model}
                      </button>
                      <p className="text-2xs text-fg-subtle">{providerLabel(row.provider)}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <BillingPill billing={row.billing} />
                    </td>
                    <Num>{row.calls.toLocaleString()}</Num>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-12 font-mono tabular-nums text-fg">
                          {formatTokens(row.totalTokens)}
                        </span>
                        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
                          <motion.span
                            className="block h-full rounded-full bg-brand"
                            initial={reduceMotion ? false : { width: 0 }}
                            animate={{ width: `${Math.max(2, share * 100)}%` }}
                            transition={{ delay: index * 0.04, duration: 0.4 }}
                          />
                        </span>
                        <span className="w-8 text-right font-mono text-2xs tabular-nums text-fg-subtle">
                          {Math.round(share * 100)}%
                        </span>
                      </div>
                    </td>
                    <Num>
                      {row.cacheKnownCalls === 0
                        ? "Unknown"
                        : `${formatTokens(row.cachedTokens)} · ${formatCachePct(hitPct(row.cachedTokens, row.cacheInputTokens))}`}
                    </Num>
                    <Num>
                      {row.cacheKnownCalls === 0
                        ? "Unknown"
                        : formatTokens(
                            Math.max(
                              0,
                              row.cacheInputTokens - row.cachedTokens - row.cacheWriteTokens,
                            ),
                          )}
                    </Num>
                    <Num>{formatTokens(row.cacheWriteTokens)}</Num>
                    <Num>{formatTokens(row.outputTokens)}</Num>
                    <Num>{costLabel(row)}</Num>
                  </tr>
                );
              })}
              {models.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-fg-subtle">
                    No model calls match this window and filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataScroller>

        {providers.length > 1 ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {providers.map((p) => {
              const active = filters.provider === p.provider;
              return (
                <button
                  key={p.provider}
                  type="button"
                  onClick={() => setProvider(active ? "all" : p.provider)}
                  className={cn(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors",
                    active
                      ? "border-brand/40 bg-brand/5"
                      : "border-border bg-surface/35 hover:bg-surface-2/60",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-fg">{providerLabel(p.provider)}</p>
                    <p className="font-mono text-xs tabular-nums text-fg-muted">
                      {formatCachePct(p.cacheHitPct)} cache
                    </p>
                  </div>
                  <p className="mt-1.5 font-mono text-xs tabular-nums text-fg-muted">
                    {formatTokens(p.totalTokens)} · {p.calls.toLocaleString()} calls ·{" "}
                    {formatUsd(p.creditUsd)} credits
                  </p>
                  <p className="mt-1 text-2xs text-fg-subtle">
                    {p.creditsPathCalls} credit-paid · {p.externalCalls} external · {p.models} model
                    {p.models === 1 ? "" : "s"}
                  </p>
                </button>
              );
            })}
          </div>
        ) : null}
      </Section>

      <Section
        title="By root session"
        aside={
          <p>
            {snap.driversTruncated
              ? `Top ${snap.drivers.length} of ${snap.driverGroups.toLocaleString()} root sessions by tokens`
              : `${snap.drivers.length} root session${snap.drivers.length === 1 ? "" : "s"} by tokens`}
          </p>
        }
      >
        <DataScroller aria-label="Usage by root session" className="border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Root session",
                  "Tokens",
                  "Share",
                  "Cache",
                  "Credits",
                  "Credit Δ",
                  "Provider-rate est.",
                  "",
                ].map((h, i) => (
                  <th key={h || i} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.drivers.map((driver) => {
                const rootId = driverRootSessionId(driver.id);
                const selected = rootId !== null && rootId === filters.rootSessionId;
                return (
                  <tr
                    key={driver.id}
                    className={cn(
                      "border-b border-border/70 last:border-0",
                      rootId && !selected && "cursor-pointer hover:bg-surface-2/60",
                      selected && "bg-brand/5",
                    )}
                    onClick={() => {
                      if (rootId && !selected) scopeToRoot(rootId, driver.label);
                    }}
                  >
                    <td className="max-w-72 truncate px-3 py-2.5 font-medium text-fg">
                      {rootId && !selected ? (
                        <button
                          type="button"
                          aria-label={`Scope to root session ${driver.label}`}
                          className="max-w-full truncate rounded text-left text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(event) => {
                            event.stopPropagation();
                            scopeToRoot(rootId, driver.label);
                          }}
                        >
                          {driver.label}
                        </button>
                      ) : (
                        driver.label
                      )}
                    </td>
                    <Num>{formatTokens(driver.tokens)}</Num>
                    <Num>{driver.pctOfTokens}%</Num>
                    <Num>{formatCachePct(driver.cacheHitPct)}</Num>
                    <Num>{formatUsd(driver.creditUsd)}</Num>
                    <td
                      className={cn(
                        "px-3 py-2.5 font-mono tabular-nums",
                        driver.deltaUsdVsPrior > 0 ? "text-status-failed" : "text-fg-muted",
                      )}
                    >
                      {formatDeltaUsd(driver.deltaUsdVsPrior)}
                    </td>
                    <Num>
                      {driver.estimatedProviderCostKnownCalls > 0
                        ? `~${formatUsd(driver.estimatedProviderUsd)}`
                        : "Unknown"}
                    </Num>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        aria-label={`Trace ${driver.label}`}
                        title="Trace cost path"
                        onClick={(event) => {
                          event.stopPropagation();
                          openTrace(driver.id);
                        }}
                        className="inline-flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
                      >
                        <RouteIcon className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {snap.drivers.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-fg-subtle">
                    No attributed model usage in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataScroller>
      </Section>

      <Section
        title="Recent model calls"
        aside={
          <p>
            {snap.recentCallsTruncated
              ? `Latest ${snap.recentCalls.length} calls · older calls not shown`
              : `${snap.recentCalls.length} call${snap.recentCalls.length === 1 ? "" : "s"}`}
          </p>
        }
      >
        <DataScroller aria-label="Recent model calls" className="border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Time (UTC)",
                  "Session",
                  "Model",
                  "Billing",
                  "Tokens",
                  "Cache read",
                  "Cache write",
                  "Output",
                  "Cost",
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.recentCalls.map((call) => (
                <tr key={call.id} className="border-b border-border/70 last:border-0">
                  <td
                    className="whitespace-nowrap px-3 py-2.5 font-mono text-2xs text-fg-muted"
                    title={call.occurredAt}
                  >
                    {formatUtcTimestamp(call.occurredAt)}
                  </td>
                  <td className="max-w-56 px-3 py-2.5">
                    {call.sessionId === filters.sessionId ? (
                      <span className="block truncate font-medium text-fg">
                        {call.sessionTitle}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => scopeToSession(call.sessionId, call.sessionTitle)}
                        className="block max-w-full truncate text-left font-medium text-fg hover:text-brand hover:underline"
                      >
                        {call.sessionTitle}
                      </button>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <p className="font-mono text-2xs text-fg">{call.model}</p>
                    <p className="text-2xs text-fg-subtle">
                      {providerLabel(call.provider)} · {call.providerApi}
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <BillingPill billing={call.billing} />
                  </td>
                  <Num>{call.totalTokens == null ? "Unknown" : formatTokens(call.totalTokens)}</Num>
                  <Num>
                    {call.cachedTokens == null || call.inputTokens == null
                      ? "Unknown"
                      : `${formatTokens(call.cachedTokens)} · ${formatCachePct(hitPct(call.cachedTokens, call.inputTokens))}`}
                  </Num>
                  <Num>
                    {call.cacheWriteTokens == null
                      ? "Unknown"
                      : formatTokens(call.cacheWriteTokens)}
                  </Num>
                  <Num>
                    {call.outputTokens == null ? "Unknown" : formatTokens(call.outputTokens)}
                  </Num>
                  <Num>
                    {call.billing === "opengeni_credits"
                      ? formatUsd(call.creditUsd)
                      : call.estimatedProviderUsd == null
                        ? "Unknown"
                        : `~${formatUsd(call.estimatedProviderUsd)} est.`}
                  </Num>
                </tr>
              ))}
              {snap.recentCalls.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-fg-subtle">
                    No model calls match this window and filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataScroller>
      </Section>

      <Section title="Schedules">
        <p className="text-2xs text-fg-subtle">
          Attribution covers turns whose initiator carried a scheduled run id. Goal continuations
          without that lineage remain session usage rather than schedule usage.
        </p>
        <DataScroller aria-label="Schedule usage" className="border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Schedule",
                  "Fires",
                  "Tokens",
                  "Cache",
                  "Credits",
                  "External est.",
                  "Billing",
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.schedules.map((row) => (
                <tr key={row.id} className="border-b border-border/70 last:border-0">
                  <td className="px-3 py-2.5 font-medium text-fg">{row.name}</td>
                  <Num>{row.fires.toLocaleString()}</Num>
                  <Num>{row.tokens == null ? "—" : formatTokens(row.tokens)}</Num>
                  <Num>
                    {row.tokens == null || row.tokens === 0 ? "—" : formatCachePct(row.cacheHitPct)}
                  </Num>
                  <Num>{row.creditUsd == null ? "—" : formatUsd(row.creditUsd)}</Num>
                  <Num>
                    {row.billing !== "external"
                      ? "—"
                      : row.estimatedProviderUsd == null || !row.estimatedProviderCostKnownCalls
                        ? "Unknown"
                        : `~${formatUsd(row.estimatedProviderUsd)}`}
                  </Num>
                  <td className="px-3 py-2.5">
                    {row.billing == null ? "—" : <BillingPill billing={row.billing} />}
                  </td>
                </tr>
              ))}
              {snap.schedules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-fg-subtle">
                    No schedules in this workspace.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataScroller>
      </Section>

      <Section
        title="Prompt context"
        aside={
          <p>
            {promptContributions.coveredCalls.toLocaleString()} /{" "}
            {promptContributions.totalCalls.toLocaleString()} calls covered
          </p>
        }
      >
        <p className="max-w-2xl text-xs leading-5 text-fg-muted">
          Estimated tokens that workspace instructions, company profile, memory, and Skill
          descriptors add to model input (UTF-8 bytes ÷ 4). Kept separate from provider-reported
          input tokens.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric
            label="Estimated prompt tokens"
            value={formatTokens(promptContributions.estimatedTokens)}
            delta="Agent Knowledge material only"
          />
          <Metric
            label="Average per covered call"
            value={
              promptContributions.coveredCalls > 0
                ? formatTokens(
                    Math.round(
                      promptContributions.estimatedTokens / promptContributions.coveredCalls,
                    ),
                  )
                : "Unknown"
            }
            delta="Content-free receipt estimate"
          />
          <Metric
            label="Receipt coverage"
            value={
              promptContributions.totalCalls > 0
                ? `${Math.round((promptContributions.coveredCalls / promptContributions.totalCalls) * 100)}%`
                : "Unknown"
            }
            delta="Historical calls may be unavailable"
          />
        </div>
        <DataScroller aria-label="Prompt context sources" className="border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 text-right font-medium">Est. tokens</th>
                <th className="px-3 py-2 text-right font-medium">Share</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {promptContributions.sources.map((row) => (
                <tr key={row.source}>
                  <td className="px-3 py-2 text-fg">{PROMPT_SOURCE_LABELS[row.source]}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
                    {formatTokens(row.estimatedTokens)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-muted">
                    {promptContributions.estimatedTokens > 0
                      ? Math.round(
                          (row.estimatedTokens / promptContributions.estimatedTokens) * 100,
                        )
                      : 0}
                    %
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-muted">
                    {row.calls.toLocaleString()}
                  </td>
                </tr>
              ))}
              {promptContributions.sources.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-5 text-center text-fg-subtle">
                    No contribution receipts are available in this selection yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataScroller>
      </Section>

      <Section title="Sandbox usage" aside={filtered ? <p>Workspace-wide</p> : undefined}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Warm time"
            value={formatWarmHours(snap.warmSeconds)}
            delta={formatPctDelta(deltas.warmPct, snap.priorLabel)}
          />
          <Metric
            label="Top warm groups"
            value={<CountUp value={snap.warmGroups.length} key={`groups-${range}`} />}
            delta="Highest warm-second groups in range (top 24)"
          />
          <Metric
            label="Live warm"
            value={<CountUp value={snap.liveWarm.length} />}
            delta={`${snap.warmIdleNow} idle · ${snap.liveWarm.length - snap.warmIdleNow} in use`}
            tone={snap.warmIdleNow > 0 ? "warn" : "neutral"}
          />
          <Metric
            label="Machines"
            value={<CountUp value={snap.machinesOnline} />}
            delta={
              snap.selfhostedEnabled
                ? "Connected Machines online · no warm meter"
                : "Connected Machines disabled"
            }
          />
        </div>

        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <h3 className="text-sm font-medium text-fg">Warm hours</h3>
            <AreaChart
              key={`warm-${range}`}
              className="mt-3"
              labels={snap.series.map((p) => p.label)}
              valueSuffix="h"
              valueDigits={1}
              height={200}
              series={[
                {
                  id: "warm",
                  label: "Warm hours",
                  values: snap.series.map((d) => Math.round((d.warmSeconds / 3600) * 10) / 10),
                  className: "text-status-waiting",
                },
              ]}
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2">
              <h3 className="text-sm font-medium text-fg">By sandbox group</h3>
              <p className="text-2xs text-fg-subtle">
                Top 24 by warm seconds · sessions share the group
              </p>
            </div>
            <table className="min-w-full text-left text-xs">
              <thead className="border-b border-border bg-surface/50 text-fg-subtle">
                <tr>
                  {["Group", "Backend", "Warm", "Sessions"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...snap.warmGroups]
                  .sort((a, b) => b.warmSeconds - a.warmSeconds)
                  .map((group) => (
                    <tr key={group.id} className="border-b border-border/70 last:border-0">
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-fg">{group.label}</p>
                        <p className="font-mono text-2xs text-fg-subtle">{group.groupId}</p>
                      </td>
                      <td className="px-3 py-2.5 text-fg-muted">{backendLabel(group.backend)}</td>
                      <Num>{formatWarmHours(group.warmSeconds)}</Num>
                      <Num>{group.sessionsAttached}</Num>
                    </tr>
                  ))}
                {snap.warmGroups.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-fg-subtle">
                      No warm sandbox time in this window.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {snap.liveWarm.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2">
              <h3 className="text-sm font-medium text-fg">Live warm boxes</h3>
              <p className="text-2xs text-fg-subtle">Idle = warm with no active turn</p>
            </div>
            <ul className="grid gap-0 sm:grid-cols-2 lg:grid-cols-3">
              {snap.liveWarm.map((lease) => {
                const idle = lease.turnHolders === 0;
                return (
                  <li
                    key={lease.id}
                    className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            idle ? "bg-status-waiting" : "bg-status-running",
                          )}
                        />
                        <p className="truncate font-mono text-xs text-fg">{lease.groupId}</p>
                      </div>
                      <p className="mt-0.5 text-2xs text-fg-subtle">
                        {backendLabel(lease.backend)} ·{" "}
                        {idle
                          ? lease.viewerHolders > 0
                            ? `idle · ${lease.viewerHolders} viewer`
                            : "idle warm"
                          : `${lease.turnHolders} turn · ${lease.viewerHolders} viewer`}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-xs tabular-nums text-fg-muted">
                        {lease.warmForLabel}
                      </p>
                      <p className="font-mono text-2xs tabular-nums text-fg-subtle">
                        {formatWarmHours(lease.warmSeconds)} this window
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section title="Live now" aside={<p>Workspace-wide · click a session to scope</p>}>
        <div className="flex w-fit gap-1 rounded-md border border-border p-0.5">
          {(
            [
              ["all", "All"],
              ["active", "Active"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFloorFilter(id)}
              className={cn(
                "rounded px-2.5 py-1 text-2xs font-medium transition-colors",
                floorFilter === id ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <DataScroller aria-label="Live sessions" className="border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {["Session", "Model", "Route", "State", "Age", "Cache"].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {floor.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-surface-2/50"
                    onClick={() => scopeToSession(row.id, row.title)}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <StateDot state={row.state} />
                        <button
                          type="button"
                          aria-label={`Scope to session ${row.title}`}
                          className="rounded text-left font-medium text-fg hover:text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(event) => {
                            event.stopPropagation();
                            scopeToSession(row.id, row.title);
                          }}
                        >
                          {row.title}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-2xs text-fg-muted">
                      {row.model ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted">{backendLabel(row.route)}</td>
                    <td className="px-3 py-2.5">
                      <StatePill state={row.state} />
                    </td>
                    <Num>{row.ageLabel}</Num>
                    <Num>{formatCachePct(row.cacheHitPct)}</Num>
                  </tr>
                ))}
              </AnimatePresence>
              {floor.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-fg-subtle">
                    No sessions to show.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </DataScroller>
      </Section>

      <Section title="Caps" aside={filtered ? <p>Workspace-wide</p> : undefined}>
        <p className="text-2xs text-fg-subtle">
          Credit-paid billable tokens and agent runs since the start of this UTC month. Externally
          paid usage is not counted against the token meter.
        </p>
        <div className="grid gap-4 rounded-lg border border-border bg-surface/35 p-4 sm:grid-cols-2">
          {snap.billableTokenCap != null ? (
            <UsageMeter
              key={`tok-cap-${range}`}
              label="Billable tokens (credits path)"
              detail={`${formatTokens(snap.billableTokensUsed)} / ${formatTokens(snap.billableTokenCap)}`}
              total={snap.billableTokenCap}
              segments={[
                {
                  id: "billable",
                  value: snap.billableTokensUsed,
                  className: "bg-brand",
                  label: "model.tokens",
                },
              ]}
            />
          ) : (
            <Metric
              label="Billable tokens (credits path)"
              value={formatTokens(snap.billableTokensUsed)}
              delta="No workspace token cap configured"
            />
          )}
          {snap.agentRunCap != null ? (
            <UsageMeter
              key={`run-cap-${range}`}
              label="Agent runs"
              detail={`${snap.agentRunsUsed.toLocaleString()} / ${snap.agentRunCap.toLocaleString()}`}
              total={snap.agentRunCap}
              segments={[
                {
                  id: "runs",
                  value: Math.min(snap.agentRunCap, snap.agentRunsUsed),
                  className: "bg-status-running",
                  label: "agent_run.created",
                },
              ]}
            />
          ) : (
            <Metric
              label="Agent runs"
              value={<CountUp value={snap.agentRunsUsed} key={`runs-${range}`} />}
              delta="No workspace run cap configured"
            />
          )}
        </div>
      </Section>

      <Section title="Session depth" aside={<p>All-time workspace topology</p>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric
            label="Sessions"
            value={<CountUp value={snap.sessionsTouched} key={`sess-${range}`} />}
            delta={`${snap.rootSessions} roots · avg ${snap.avgDepth.toFixed(2)}`}
          />
          <Metric label="Deepest" value={snap.deepestDepth} delta={snap.deepestSessionTitle} />
          <Metric
            label="Goals done"
            value={<CountUp value={snap.goalsCompleted} key={`goals-${range}`} />}
            delta={`${snap.goalsActive} active now`}
          />
        </div>
        <ul className="grid gap-2.5 rounded-lg border border-border bg-surface/35 p-4">
          {snap.depth.map((bucket, index) => {
            const widthPct = Math.max(4, (bucket.sessions / maxDepthSessions) * 100);
            return (
              <li key={bucket.depth} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium text-fg">
                    Depth {bucket.depth}
                    {bucket.depth === 0 ? (
                      <span className="ml-1.5 font-normal text-fg-subtle">· roots</span>
                    ) : null}
                  </span>
                  <span className="font-mono tabular-nums text-fg-muted">
                    {bucket.sessions.toLocaleString()} sessions
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <motion.div
                    className="h-full rounded-full bg-fg-muted"
                    initial={reduceMotion ? false : { width: 0 }}
                    animate={{ width: `${widthPct}%` }}
                    transition={{ delay: index * 0.04, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <CausalSheet
        open={trace !== null}
        target={trace}
        onOpenChange={(open) => {
          if (!open) setTrace(null);
        }}
        snapshot={snap}
      />
    </ContentPage>
  );
}

// Local glyphs: importing these lucide icons here moves modules shared with the
// session route into new chunks and pushes its direct-load graph over budget.
function Glyph(props: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      {props.children}
    </svg>
  );
}

function GitBranchIcon(props: { className?: string }) {
  return (
    <Glyph className={props.className}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Glyph>
  );
}

function MessageSquareIcon(props: { className?: string }) {
  return (
    <Glyph className={props.className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Glyph>
  );
}

function RouteIcon(props: { className?: string }) {
  return (
    <Glyph className={props.className}>
      <circle cx="6" cy="19" r="3" />
      <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
      <circle cx="18" cy="5" r="3" />
    </Glyph>
  );
}

function hitPct(cached: number, input: number): number | null {
  if (input <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((cached / input) * 100)));
}

function Num(props: { children: ReactNode }) {
  return (
    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
      {props.children}
    </td>
  );
}

function ScopeChip(props: { icon: ReactNode; kind: string; label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-8 max-w-72 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/5 pl-2 pr-1 text-xs text-fg">
      <span className="text-brand">{props.icon}</span>
      <span className="whitespace-nowrap text-fg-subtle">{props.kind}</span>
      <span className="truncate font-medium">{props.label}</span>
      <button
        type="button"
        aria-label={`Remove ${props.kind.toLowerCase()} filter`}
        onClick={props.onRemove}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

function TokenComposition(props: {
  segments: Array<{ id: string; label: string; value: number; className: string }>;
  reduceMotion: boolean;
}) {
  const total = props.segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className="rounded-lg border border-border bg-surface/35 p-4" data-insights-composition>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-fg">Token composition</h3>
        <p className="text-2xs text-fg-subtle">
          Cache read and write are parts of input · output includes reasoning
        </p>
      </div>
      {total === 0 ? (
        <p className="mt-3 text-xs text-fg-subtle">No token counts reported in this selection.</p>
      ) : (
        <>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-2">
            {props.segments.map((segment, index) =>
              segment.value > 0 ? (
                <motion.div
                  key={segment.id}
                  className={cn("h-full", segment.className)}
                  initial={props.reduceMotion ? false : { width: 0 }}
                  animate={{ width: `${(segment.value / total) * 100}%` }}
                  transition={{ delay: index * 0.05, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                />
              ) : null,
            )}
          </div>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {props.segments.map((segment) => (
              <div key={segment.id} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-2xs text-fg-subtle">
                  <span className={cn("size-2 shrink-0 rounded-sm", segment.className)} />
                  {segment.label}
                </dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums text-fg">
                  {formatTokens(segment.value)}
                  <span className="ml-1.5 text-2xs text-fg-subtle">
                    {Math.round((segment.value / total) * 100)}%
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

function DiagnosticCard(props: {
  title: string;
  body: string;
  empty: string;
  rows: Array<{
    id: string;
    title: string;
    meta: string;
    value: string;
    badge: string;
    onSelect?: () => void;
  }>;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/35">
      <div className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-medium text-fg">{props.title}</h3>
        <p className="mt-0.5 text-2xs text-fg-subtle">{props.body}</p>
      </div>
      {props.rows.length === 0 ? (
        <p className="px-4 py-5 text-xs text-fg-subtle">{props.empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {props.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                disabled={!row.onSelect}
                onClick={row.onSelect}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left enabled:hover:bg-surface-2/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-fg">{row.title}</span>
                  <span className="block truncate text-2xs text-fg-subtle">{row.meta}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs tabular-nums text-fg">{row.value}</span>
                  <span className="rounded border border-status-waiting/35 bg-status-waiting/10 px-1.5 py-0.5 font-mono text-2xs text-status-waiting">
                    {row.badge}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MeasureControl(props: {
  value: InsightsMeasure;
  onChange: (measure: InsightsMeasure) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Usage measure"
      className="inline-flex rounded-lg border border-border bg-surface/50 p-0.5"
    >
      {(
        [
          ["tokens", "Tokens"],
          ["money", "Spend"],
        ] as const
      ).map(([id, label]) => {
        const active = props.value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => props.onChange(id)}
            className={cn(
              "relative min-h-8 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId="insights-measure-pill"
                className="absolute inset-0 rounded-md bg-surface-2 shadow-sm"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            ) : null}
            <span className="relative z-10">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RangeControl(props: { value: InsightsRange; onChange: (range: InsightsRange) => void }) {
  return (
    <div
      role="group"
      aria-label="Time range"
      className="inline-flex rounded-lg border border-border bg-surface/50 p-0.5"
    >
      {RANGE_OPTIONS.map((option) => {
        const active = props.value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => props.onChange(option.id)}
            className={cn(
              "relative min-h-8 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId="insights-range-pill"
                className="absolute inset-0 rounded-md bg-surface-2 shadow-sm"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            ) : null}
            <span className="relative z-10 hidden sm:inline">{option.label}</span>
            <span className="relative z-10 sm:hidden">{option.shortLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-medium text-fg-muted">
      <span>{props.label}</span>
      <Select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="max-w-52 text-xs"
      >
        {props.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

function Section(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight text-fg">{props.title}</h2>
        {props.aside ? <div className="text-xs text-fg-subtle">{props.aside}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

function Metric(props: {
  label: string;
  value: ReactNode;
  delta: string;
  tone?: "warn" | "neutral" | "good";
  featured?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-center rounded-lg border",
        props.featured
          ? "border-brand/25 bg-brand/[0.06] px-5 py-5"
          : "border-border bg-surface/35 px-3.5 py-3",
      )}
    >
      <p className="text-xs font-medium text-fg-muted">{props.label}</p>
      <p
        className={cn(
          "mt-1.5 break-words font-semibold tracking-tight tabular-nums",
          props.featured ? "text-3xl sm:text-4xl" : "text-xl",
          props.tone === "warn" && "text-status-failed",
          props.tone === "good" && "text-status-running",
          (props.tone == null || props.tone === "neutral") && "text-fg",
        )}
      >
        {props.value}
      </p>
      <p className="mt-2 text-xs leading-5 tabular-nums text-fg-muted">{props.delta}</p>
    </div>
  );
}

function BillingPill(props: { billing: BillingPath }) {
  return (
    <span
      className={cn(
        "inline-flex rounded border px-1.5 py-0.5 text-2xs font-medium",
        props.billing === "external" && "border-brand/35 bg-brand/10 text-brand",
        props.billing === "opengeni_credits" && "border-border bg-surface-2 text-fg-muted",
      )}
    >
      {billingLabel(props.billing)}
    </span>
  );
}

function StateDot(props: { state: FloorSession["state"] }) {
  const live = props.state === "running" || props.state === "compacting";
  return (
    <span className="relative flex size-2 shrink-0">
      {live ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-40" />
      ) : null}
      <span className={cn("relative size-2 rounded-full", stateColor(props.state))} />
    </span>
  );
}

function StatePill(props: { state: FloorSession["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex rounded border px-1.5 py-0.5 text-2xs font-medium capitalize",
        statePillClass(props.state),
      )}
    >
      {props.state}
    </span>
  );
}

function stateColor(state: FloorSession["state"]): string {
  switch (state) {
    case "waiting":
      return "bg-status-waiting";
    case "running":
    case "compacting":
      return "bg-status-running";
    case "paused":
      return "bg-status-queued";
    case "failed":
      return "bg-status-failed";
    case "idle":
      return "bg-status-idle";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function statePillClass(state: FloorSession["state"]): string {
  switch (state) {
    case "waiting":
      return "border-status-waiting/40 bg-status-waiting/10 text-status-waiting";
    case "running":
    case "compacting":
      return "border-status-running/40 bg-status-running/10 text-status-running";
    case "paused":
      return "border-border bg-surface-2 text-fg-muted";
    case "failed":
      return "border-status-failed/40 bg-status-failed/10 text-status-failed";
    case "idle":
      return "border-status-idle/40 bg-status-idle/10 text-status-idle";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
