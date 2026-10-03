import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import { AreaChart, UsageMeter } from "@/components/insights/charts";
import { CountUp } from "@/components/insights/count-up";
import {
  RANGE_OPTIONS,
  backendLabel,
  buildInsightsDiagnostics,
  buildInsightsView,
  driverRootSessionId,
  formatCachePct,
  formatTokens,
  formatUtcTimestamp,
  formatUsd,
  formatUsdTick,
  formatWarmHours,
  pctDelta,
  providerLabel,
  CACHE_MISS_MIN_INPUT_TOKENS,
  OUTLIER_MEDIAN_MULTIPLE,
  type FloorSession,
  type InsightsFilters,
  type InsightsMeasure,
  type InsightsRange,
} from "@/components/insights/mock-data";
import { payerTotals, rowPayerLabel } from "@/components/insights/payer";
import { privateSpendRows } from "@/components/insights/private-usage";
import {
  insightsFilters,
  insightsMeasure,
  insightsRange,
  insightsView,
  nextInsightsSearch,
  parseInsightsSearch,
  type InsightsSearch,
} from "@/components/insights/search";
import {
  MODEL_COLUMNS,
  ModelUsageList,
  PAID_WITH_COLUMNS,
  PaidWithList,
  PrivateChatsList,
  ProjectUsageList,
  SessionUsageList,
  UsageStats,
  amountLabel,
  percentDelta,
} from "@/components/insights/usage-sections";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { BackLink } from "@/components/ui/detail-page";
import { EmptyState } from "@/components/ui/empty-state";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatGroup, StatTile } from "@/components/ui/stat-tile";
import { useAppContext } from "@/context";
import { apiErrorAdvice, isPermissionDenied } from "@/lib/api-error";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { ReturnTo } from "@/lib/return-to";
import { cn } from "@/lib/utils";

const PROMPT_SOURCE_LABELS = {
  workspace_instruction_policy: "Workspace instruction policy",
  legacy_workspace_instructions: "Legacy workspace instructions",
  preference_registry_descriptor: "Skill descriptors",
  company_profile: "Organization identity",
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

const ALL = "all";

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

function sameSearch(raw: Record<string, unknown>, parsed: InsightsSearch): boolean {
  const rawKeys = Object.keys(raw).filter((key) => raw[key] !== undefined);
  const parsedEntries = Object.entries(parsed).filter(([, value]) => value !== undefined);
  return (
    rawKeys.length === parsedEntries.length &&
    parsedEntries.every(([key, value]) => raw[key] === value)
  );
}

/**
 * Workspace Insights: spend, tokens and activity from usage_events and
 * model_call_facts. The selection (tab, range, chart, provider, model, root
 * session, session) lives in the URL.
 */
export function InsightsRoute({
  workspaceId,
  search,
  onSearchChange,
  returnTo,
}: {
  workspaceId: string;
  search?: Record<string, unknown>;
  /** Filter changes push history; `replace` only normalizes an invalid URL. */
  onSearchChange?: (next: InsightsSearch, options?: { replace?: boolean }) => void;
  /** Where a cross-scope link came from ("Billing & usage"); the back link returns there. */
  returnTo?: ReturnTo | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const workspace = context.workspaces.find((w) => w.id === workspaceId);
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const reduceMotion = useReducedMotion();
  const [localSearch, setLocalSearch] = useState<InsightsSearch>(() =>
    parseInsightsSearch(search ?? {}),
  );
  const routedSelection = useMemo(() => parseInsightsSearch(search ?? {}), [search]);
  const selection = onSearchChange ? routedSelection : localSearch;
  const tab = insightsView(selection);
  const range = insightsRange(selection);
  const measure = insightsMeasure(selection);
  const { provider, model, root, session } = selection;
  const filters = useMemo(
    () => insightsFilters({ provider, model, root, session }),
    [provider, model, root, session],
  );
  const [floorFilter, setFloorFilter] = useState<"all" | "active">("all");
  const [snapshot, setSnapshot] = useState<WorkspaceInsightsSnapshot | null>(null);
  const [loadedFilters, setLoadedFilters] = useState<InsightsFilters>(filters);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [scopeLabels, setScopeLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!onSearchChange || sameSearch(search ?? {}, routedSelection)) return;
    onSearchChange(routedSelection, { replace: true });
  }, [onSearchChange, routedSelection, search]);

  const update = (change: SelectionChange) => {
    const next = nextInsightsSearch(selection, change);
    if (onSearchChange) onSearchChange(next);
    else setLocalSearch(next);
  };

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setLoadError(null);
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
        ...(filters.provider !== ALL ? { provider: filters.provider } : {}),
        ...(filters.model !== ALL ? { model: filters.model } : {}),
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
        setLoadError(error);
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
  const scopeActive = Boolean(filters.rootSessionId || filters.sessionId);
  const filtered = filters.provider !== ALL || filters.model !== ALL || scopeActive;
  const showingPreviousSelection =
    snapshot !== null && (snapshot.range !== range || !sameFilters(loadedFilters, filters));

  const setProvider = (next: string) => {
    const keepModel =
      next === ALL ||
      filters.model === ALL ||
      !snapshot ||
      (snapshot.facets ?? []).some(
        (facet) => facet.provider === next && facet.model === filters.model,
      );
    update({ provider: next, ...(keepModel ? {} : { model: ALL }) });
  };
  const scopeToRoot = (rootSessionId: string, label?: string) => {
    if (label) setScopeLabels((previous) => ({ ...previous, [rootSessionId]: label }));
    update({ view: "usage", rootSessionId, sessionId: null });
  };
  const scopeToSession = (sessionId: string, label?: string) => {
    if (label) setScopeLabels((previous) => ({ ...previous, [sessionId]: label }));
    update({ view: "usage", sessionId });
  };
  const clearFilters = () =>
    update({ provider: ALL, model: ALL, rootSessionId: null, sessionId: null });

  const tabs = (
    <LineTabsNav aria-label="Insights views">
      {(
        [
          ["usage", "Usage"],
          ["activity", "Activity"],
        ] as const
      ).map(([id, label]) => (
        <LineTabsLink key={id} asChild active={tab === id}>
          <button type="button" onClick={() => update({ view: id })}>
            {label}
          </button>
        </LineTabsLink>
      ))}
    </LineTabsNav>
  );
  const heading = (
    <div className="min-w-0">
      {returnTo ? (
        <BackLink
          back={{ label: returnTo.label, onClick: () => void navigate({ href: returnTo.path }) }}
        />
      ) : null}
      <PageHeader
        title="Insights"
        description={`Spend, tokens and activity in ${workspace?.name ?? "this workspace"}.`}
        tabs={canRead ? tabs : undefined}
      />
    </div>
  );

  if (!canRead || (loadError && !snapshot)) {
    // A refusal from the server reads like missing access: no red, no Try again.
    const failed = canRead && !isPermissionDenied(loadError);
    return (
      <ContentPage width="wide" data-insights className="gap-6">
        {heading}
        {failed ? (
          <div role="alert">
            <Notice
              tone="failed"
              title="Insights couldn't load"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Try again
                </Button>
              }
            >
              {apiErrorAdvice(loadError)}
            </Notice>
          </div>
        ) : (
          <p role="alert" className="text-sm text-fg-muted">
            Only workspace admins can see Insights. Ask a workspace admin for access.
          </p>
        )}
      </ContentPage>
    );
  }

  if (!snap || !view || !diagnostics) {
    return (
      <ContentPage width="wide" data-insights className="gap-6">
        {heading}
        <InsightsSkeleton filtered={filtered} />
      </ContentPage>
    );
  }

  const { totals, deltas, series, models } = view;
  const comparison = `vs ${snap.priorLabel.toLowerCase()}`;
  const payers = payerTotals(models);
  const { rows: privateRows, truncated: privateTruncated } = privateSpendRows(snap);
  // A session scope holds no one else's private chats: hide the section, no empty state.
  const showPrivate = !scopeActive && privateRows.length > 0;
  // A session scope counts only chats the viewer can read, so it never lists
  // a private-chats row.
  const projects = (snap.projects ?? []).filter(
    (project) => !scopeActive || project.kind !== "unavailable",
  );
  const longerRange = RANGE_OPTIONS[RANGE_OPTIONS.findIndex((option) => option.id === range) + 1];
  const estimatedSpend = payers
    .filter((payer) => payer.estimated)
    .reduce((sum, payer) => sum + payer.amountUsd, 0);
  const anyEstimate = payers.some((payer) => payer.estimated && payer.pricedCalls > 0);
  const spendValue = `${anyEstimate ? "~" : ""}${formatUsd(totals.creditUsd + estimatedSpend, 2)}`;
  // The "~" marks the total as partly estimated; "Paid with" itemises the rest.
  const spendCaption = anyEstimate
    ? `${formatUsd(totals.creditUsd, 2)} charged`
    : "Charged to credits";
  const modelOptions = [
    { value: ALL, label: "All models" },
    ...view.availableModels.map((value) => ({ value, label: value })),
  ];
  const providerOptions = [
    { value: ALL, label: "All providers" },
    ...view.availableProviders.map((value) => ({ value, label: providerLabel(value) })),
  ];
  const selectedModel =
    filters.model !== ALL && filters.provider !== ALL
      ? { provider: filters.provider, model: filters.model }
      : null;

  const usageToolbar = (
    <div role="group" aria-label="Filters" className={TOOLBAR_CLASS}>
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
        {view.availableModels.length > 1 || filters.model !== ALL ? (
          <FilterSelect
            label="Model"
            value={filters.model}
            onChange={(next) => update({ model: next })}
            options={modelOptions}
          />
        ) : null}
        {view.availableProviders.length > 1 || filters.provider !== ALL ? (
          <FilterSelect
            label="Provider"
            value={filters.provider}
            onChange={setProvider}
            options={providerOptions}
          />
        ) : null}
        {filters.rootSessionId ? (
          <ScopeChip
            kind="Session"
            label={scopeLabels[filters.rootSessionId] ?? shortId(filters.rootSessionId)}
            onRemove={() => update({ rootSessionId: null })}
          />
        ) : null}
        {filters.sessionId ? (
          <ScopeChip
            kind="Chat"
            label={scopeLabels[filters.sessionId] ?? shortId(filters.sessionId)}
            onRemove={() => update({ sessionId: null })}
          />
        ) : null}
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="ml-auto flex max-w-full min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
        <RangeControl value={range} onChange={(next) => update({ range: next })} />
      </div>
    </div>
  );

  const freshness = (
    <p className="text-xs leading-[18px] text-fg-muted" data-insights-freshness>
      <span role="status">
        {loading
          ? showingPreviousSelection
            ? "Refreshing, showing the previous selection. "
            : "Refreshing. "
          : null}
      </span>
      {formatUtcTimestamp(snap.windowStart)} - {formatUtcTimestamp(snap.windowEnd)}
      {snap.dataThrough ? ` · Data through ${formatUtcTimestamp(snap.dataThrough)}` : ""}
    </p>
  );

  const refreshError = loadError ? (
    <div role="alert">
      <Notice
        tone="failed"
        title="Couldn't refresh Insights"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </Button>
        }
      >
        Showing the last selection that loaded. {apiErrorAdvice(loadError)}
      </Notice>
    </div>
  ) : null;

  const tokenSeriesValue = (known: number, calls: number, value: number) =>
    calls > 0 && known === 0 ? null : value;

  const usage = (
    <SectionStack variant="open">
      <Section
        title="Overview"
        description={filtered ? FILTERED_DESCRIPTION : OVERVIEW_DESCRIPTION}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <UsageStats
            label={snap.rangeLabel}
            spend={{ value: spendValue, caption: spendCaption }}
            tokens={{
              value:
                totals.tokenCoveragePct === 0 && snap.modelCalls > 0
                  ? "Unknown"
                  : formatTokens(totals.totalTokens),
              delta: percentDelta(deltas.tokensPct, comparison),
              caption:
                totals.tokenCoveragePct < 100
                  ? `${totals.tokenCoveragePct}% of calls reported tokens`
                  : undefined,
            }}
            calls={{
              value: snap.modelCalls.toLocaleString(),
              delta: percentDelta(pctDelta(snap.modelCalls, snap.priorCalls), comparison),
            }}
            cache={{
              value: formatCachePct(totals.cacheHitPct),
              delta: percentDelta(deltas.cachePts, comparison, " pts"),
              caption:
                totals.cacheHitPct === null
                  ? "No call reported cache use"
                  : totals.cacheCoveragePct < 100
                    ? `${totals.cacheCoveragePct}% of calls reported cache use`
                    : undefined,
            }}
          />
          {totals.ledgerGapUsd !== null && Math.abs(totals.ledgerGapUsd) >= 0.01 ? (
            <div data-insights-ledger-gap>
              <Notice tone="waiting" title="Some charges aren't broken down yet">
                {totals.ledgerGapUsd > 0
                  ? `${formatUsd(totals.ledgerGapUsd, 2)} of the ${formatUsd(totals.creditUsd, 2)} charged has no per-call record yet, so the lists below add up to less. Missing records are rebuilt from each call's usage automatically.`
                  : `The per-call records add up to ${formatUsd(-totals.ledgerGapUsd, 2)} more than the ${formatUsd(totals.creditUsd, 2)} charged in this period.`}
              </Notice>
            </div>
          ) : null}
        </div>
      </Section>

      {payers.length > 0 ? (
        <Section title="Paid with" description={PAID_WITH_DESCRIPTION}>
          <PaidWithList totals={payers} />
        </Section>
      ) : null}

      <Section
        title="Over time"
        action={
          <SegmentedControl<InsightsMeasure>
            size="sm"
            aria-label="Chart"
            value={measure}
            onValueChange={(next) => update({ measure: next })}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "money", label: "Spend" },
            ]}
          />
        }
        description={
          measure === "tokens"
            ? TOKENS_CHART_DESCRIPTION
            : "Credits charged, and every priced call at the provider's list price."
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          <AreaChart
            key={`${measure}-${range}-${filters.provider}-${filters.model}-${filters.rootSessionId}-${filters.sessionId}`}
            labels={series.map((p) => p.label)}
            formatValue={measure === "tokens" ? formatTokens : formatUsd}
            formatAxisValue={measure === "tokens" ? formatTokens : formatUsdTick}
            height={220}
            series={
              measure === "tokens"
                ? [
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
                      label: "Credits charged",
                      values: series.map((d) => d.modelCostUsd),
                      className: "text-status-idle",
                    },
                    {
                      id: "estimated",
                      label: "At list price",
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
          <TokenComposition
            reduceMotion={reduceMotion ?? false}
            segments={[
              {
                id: "cache-read",
                label: "Read from cache",
                value: totals.cachedTokens,
                className: "bg-status-idle",
              },
              {
                id: "uncached",
                label: "New input",
                value: totals.uncachedInputTokens,
                className: "bg-status-running",
              },
              {
                id: "cache-write",
                label: "Written to cache",
                value: totals.cacheWriteTokens,
                className: "bg-brand",
              },
              {
                id: "output",
                label: "Output",
                value: totals.outputTokens,
                className: "bg-status-waiting",
              },
              ...(totals.unreportedCacheInputTokens > 0
                ? [
                    {
                      id: "unreported",
                      label: "Input, cache use not reported",
                      value: totals.unreportedCacheInputTokens,
                      className: "bg-surface-3",
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </Section>

      <Section title="By model" description={BY_MODEL_DESCRIPTION}>
        {models.length > 0 ? (
          <ModelUsageList
            models={models}
            selected={selectedModel}
            onSelect={(row) => update({ provider: row.provider, model: row.model })}
          />
        ) : (
          <EmptyLine>No model calls in this selection.</EmptyLine>
        )}
      </Section>

      <Section
        title="By project"
        description="A session and its subagents count under the project its first chat is in now."
      >
        {projects.length > 0 ? (
          <ProjectUsageList projects={projects} />
        ) : (
          <EmptyLine>No project usage in this selection.</EmptyLine>
        )}
      </Section>

      <Section
        title="By session"
        description={
          snap.driversTruncated
            ? `The ${snap.drivers.length} of ${snap.driverGroups.toLocaleString()} sessions that used the most tokens, with their subagents. Select one to see only its usage.`
            : "Each session with its subagents. Select one to see only its usage."
        }
      >
        {snap.drivers.length > 0 ? (
          <SessionUsageList
            drivers={snap.drivers}
            totalTokens={totals.totalTokens}
            selectedRootId={filters.rootSessionId ?? null}
            rootIdOf={(driver) => driverRootSessionId(driver.id)}
            onSelect={scopeToRoot}
          />
        ) : (
          <EmptyLine>No session usage in this selection.</EmptyLine>
        )}
      </Section>

      {showPrivate ? (
        <Section
          title="Private chats"
          description="Other people's Only me chats, already counted above. Amounts only."
        >
          <div className="flex min-w-0 flex-col gap-2">
            <PrivateChatsList rows={privateRows} />
            {privateTruncated ? (
              <p className="text-xs leading-[18px] text-fg-muted">Showing the largest 200.</p>
            ) : null}
          </div>
        </Section>
      ) : null}

      {snap.schedules.length > 0 ? (
        <Section
          title="Schedules"
          description="Runs a schedule started. A goal that keeps going on its own counts under its session."
        >
          <RowList
            variant="table"
            label="Usage by schedule"
            nameLabel="Schedule"
            columns={SCHEDULE_COLUMNS}
          >
            {snap.schedules.map((row) => (
              <ListRow
                key={row.id}
                leading={<LogoTile name={row.name} />}
                title={row.name}
                meta={
                  row.billing
                    ? [
                        row.billing === "opengeni_credits"
                          ? "Opengeni credits"
                          : "Paid outside Opengeni",
                      ]
                    : undefined
                }
                cells={{
                  fires: <Quiet>{row.fires.toLocaleString()}</Quiet>,
                  tokens: <Quiet>{row.tokens == null ? "-" : formatTokens(row.tokens)}</Quiet>,
                  credits: (
                    <Quiet>{row.creditUsd == null ? "-" : formatUsd(row.creditUsd, 2)}</Quiet>
                  ),
                  listPrice: (
                    <Quiet>
                      {row.billing !== "external"
                        ? "-"
                        : amountLabel(
                            row.estimatedProviderUsd ?? 0,
                            true,
                            row.estimatedProviderCostKnownCalls ?? 0,
                          )}
                    </Quiet>
                  ),
                }}
              />
            ))}
          </RowList>
        </Section>
      ) : null}

      <Section
        title="Recent model calls"
        description={
          snap.recentCallsTruncated
            ? `The latest ${snap.recentCalls.length} calls. Select one to see its chat's usage.`
            : "Select a call to see its chat's usage."
        }
      >
        {snap.recentCalls.length > 0 ? (
          <RowList
            variant="table"
            label="Recent model calls"
            nameLabel="Chat"
            columns={CALL_COLUMNS}
          >
            {snap.recentCalls.map((call) => {
              const selected = call.sessionId === filters.sessionId;
              return (
                <ListRow
                  key={call.id}
                  leading={<LogoTile name={call.model} />}
                  title={call.sessionTitle}
                  meta={[formatUtcTimestamp(call.occurredAt), call.model]}
                  selected={selected}
                  onOpen={
                    selected ? undefined : () => scopeToSession(call.sessionId, call.sessionTitle)
                  }
                  cells={{
                    payer: <Quiet>{rowPayerLabel(call.billing, call.provider)}</Quiet>,
                    tokens: (
                      <Quiet>
                        {call.totalTokens == null ? "Unknown" : formatTokens(call.totalTokens)}
                      </Quiet>
                    ),
                    cache: (
                      <Quiet>
                        {call.cachedTokens == null || call.inputTokens == null
                          ? "Unknown"
                          : formatCachePct(hitPct(call.cachedTokens, call.inputTokens))}
                      </Quiet>
                    ),
                    amount: (
                      <span className="text-fg tabular-nums">
                        {call.billing === "opengeni_credits"
                          ? formatUsd(call.creditUsd, 2)
                          : call.estimatedProviderUsd == null
                            ? "Unknown"
                            : `~${formatUsd(call.estimatedProviderUsd, 2)}`}
                      </span>
                    ),
                  }}
                />
              );
            })}
          </RowList>
        ) : (
          <EmptyLine>No model calls in this selection.</EmptyLine>
        )}
      </Section>

      {diagnostics.outliers.length > 0 ||
      diagnostics.cacheMisses.length > 0 ||
      diagnostics.lowCacheRoots.length > 0 ? (
        <Section
          title="Worth a look"
          description={`From the ${diagnostics.sampleSize.toLocaleString()} most recent calls${diagnostics.sampleTruncated ? "; older calls aren't checked" : ""}.`}
        >
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            {diagnostics.outliers.length > 0 ? (
              <DiagnosticList
                title="Unusually large calls"
                description={`At least ${OUTLIER_MEDIAN_MULTIPLE}x the typical ${formatTokens(Math.round(diagnostics.medianTotalTokens ?? 0))} tokens per call.`}
                rows={diagnostics.outliers.map(({ call, ratio }) => ({
                  id: call.id,
                  title: call.sessionTitle,
                  meta: `${call.model} · ${formatUtcTimestamp(call.occurredAt)}`,
                  value: `${formatTokens(call.totalTokens ?? 0)} · ${ratio.toFixed(1)}x`,
                  onSelect: () => scopeToSession(call.sessionId, call.sessionTitle),
                }))}
              />
            ) : null}
            {diagnostics.cacheMisses.length > 0 ? (
              <DiagnosticList
                title="Missed the cache"
                description={`No cache read on at least ${formatTokens(CACHE_MISS_MIN_INPUT_TOKENS)} input tokens.`}
                rows={diagnostics.cacheMisses.map(({ call, uncachedInputTokens }) => ({
                  id: call.id,
                  title: call.sessionTitle,
                  meta: `${call.model} · ${formatUtcTimestamp(call.occurredAt)}`,
                  value: `${formatTokens(uncachedInputTokens)} new`,
                  onSelect: () => scopeToSession(call.sessionId, call.sessionTitle),
                }))}
              />
            ) : null}
            {diagnostics.lowCacheRoots.length > 0 ? (
              <DiagnosticList
                title="Sessions with little cache reuse"
                description="Large sessions where under a quarter of the input came from cache."
                rows={diagnostics.lowCacheRoots.map((driver) => {
                  const rootId = driverRootSessionId(driver.id);
                  return {
                    id: driver.id,
                    title: driver.label,
                    meta: `${formatTokens(driver.tokens)} tokens`,
                    value: `${formatCachePct(driver.cacheHitPct)} from cache`,
                    onSelect: rootId ? () => scopeToRoot(rootId, driver.label) : undefined,
                  };
                })}
              />
            ) : null}
          </div>
        </Section>
      ) : null}

      <PromptContext
        contributions={
          snap.promptContributions ?? { ...EMPTY_PROMPT_CONTRIBUTIONS, totalCalls: snap.modelCalls }
        }
      />
    </SectionStack>
  );

  const floor = snap.floor.filter((row) =>
    floorFilter === "active"
      ? row.state === "running" || row.state === "compacting" || row.state === "waiting"
      : true,
  );
  const maxDepthSessions = Math.max(...snap.depth.map((bucket) => bucket.sessions), 1);

  const activity = (
    <SectionStack variant="open">
      <Section
        title="Live now"
        description="Select a chat to see its usage."
        action={
          snap.floor.length > 0 ? (
            <SegmentedControl<"all" | "active">
              size="sm"
              aria-label="Live chats shown"
              value={floorFilter}
              onValueChange={setFloorFilter}
              options={[
                { value: "all", label: "All" },
                { value: "active", label: "Working" },
              ]}
            />
          ) : undefined
        }
      >
        {floor.length > 0 ? (
          <RowList variant="table" label="Live chats" nameLabel="Chat" columns={FLOOR_COLUMNS}>
            {floor.map((row) => (
              <ListRow
                key={row.id}
                leading={<StateDot state={row.state} />}
                title={row.title}
                meta={[row.model ?? "No model yet", backendLabel(row.route)]}
                onOpen={() => scopeToSession(row.id, row.title)}
                cells={{
                  state: <span className="text-fg-muted capitalize">{row.state}</span>,
                  age: <Quiet>{row.ageLabel}</Quiet>,
                  cache: <Quiet>{formatCachePct(row.cacheHitPct)}</Quiet>,
                }}
              />
            ))}
          </RowList>
        ) : (
          <EmptyLine>No chats are running right now.</EmptyLine>
        )}
      </Section>

      <Section title="Sandbox time">
        <div className="flex min-w-0 flex-col gap-4">
          <StatGroup label="Sandbox time">
            <StatTile
              label="Warm time"
              value={formatWarmHours(snap.warmSeconds)}
              delta={percentDelta(deltas.warmPct, comparison)}
            />
            <StatTile
              label="Warm now"
              value={<CountUp value={snap.liveWarm.length} />}
              caption={`${snap.warmIdleNow} idle · ${snap.liveWarm.length - snap.warmIdleNow} in use`}
            />
            <StatTile
              label="Machines online"
              value={<CountUp value={snap.machinesOnline} />}
              caption={snap.selfhostedEnabled ? "Not metered" : "Not enabled on this server"}
            />
            <StatTile
              label="Sandbox groups"
              value={<CountUp value={snap.warmGroups.length} key={`groups-${range}`} />}
              caption="With warm time in this period"
            />
          </StatGroup>
          <AreaChart
            key={`warm-${range}`}
            labels={snap.series.map((p) => p.label)}
            valueSuffix="h"
            valueDigits={1}
            height={180}
            series={[
              {
                id: "warm",
                label: "Warm hours",
                values: snap.series.map((d) => Math.round((d.warmSeconds / 3600) * 10) / 10),
                className: "text-status-running",
              },
            ]}
          />
          {snap.warmGroups.length > 0 ? (
            <RowList
              variant="table"
              label="Warm time by sandbox"
              nameLabel="Sandbox"
              columns={WARM_COLUMNS}
            >
              {[...snap.warmGroups]
                .sort((a, b) => b.warmSeconds - a.warmSeconds)
                .map((group) => (
                  <ListRow
                    key={group.id}
                    leading={<LogoTile name={group.label} />}
                    title={group.label}
                    meta={[backendLabel(group.backend)]}
                    cells={{
                      warm: <Quiet>{formatWarmHours(group.warmSeconds)}</Quiet>,
                      sessions: <Quiet>{group.sessionsAttached.toLocaleString()}</Quiet>,
                    }}
                  />
                ))}
            </RowList>
          ) : null}
        </div>
      </Section>

      <Section
        title="Limits"
        description="Credit-paid tokens and agent runs since the start of this UTC month. Calls paid by a plan or your own key don't count."
      >
        <div className="grid min-w-0 gap-6 sm:grid-cols-2">
          {snap.billableTokenCap != null ? (
            <UsageMeter
              key={`tok-cap-${range}`}
              label="Credit-paid tokens"
              detail={`${formatTokens(snap.billableTokensUsed)} of ${formatTokens(snap.billableTokenCap)}`}
              total={snap.billableTokenCap}
              segments={[
                {
                  id: "billable",
                  value: snap.billableTokensUsed,
                  className: "bg-brand",
                  label: "Tokens",
                },
              ]}
            />
          ) : (
            <StatTile
              framed
              label="Credit-paid tokens"
              value={formatTokens(snap.billableTokensUsed)}
              caption="No token limit"
            />
          )}
          {snap.agentRunCap != null ? (
            <UsageMeter
              key={`run-cap-${range}`}
              label="Agent runs"
              detail={`${snap.agentRunsUsed.toLocaleString()} of ${snap.agentRunCap.toLocaleString()}`}
              total={snap.agentRunCap}
              segments={[
                {
                  id: "runs",
                  value: Math.min(snap.agentRunCap, snap.agentRunsUsed),
                  className: "bg-status-running",
                  label: "Runs",
                },
              ]}
            />
          ) : (
            <StatTile
              framed
              label="Agent runs"
              value={<CountUp value={snap.agentRunsUsed} key={`runs-${range}`} />}
              caption="No run limit"
            />
          )}
        </div>
      </Section>

      <Section title="Subagents" description="How deep sessions go, across all time.">
        <div className="flex min-w-0 flex-col gap-4">
          <StatGroup label="Subagents" columns={3}>
            <StatTile
              label="Chats"
              value={<CountUp value={snap.sessionsTouched} key={`sess-${range}`} />}
              caption={`${snap.rootSessions.toLocaleString()} sessions · ${snap.avgDepth.toFixed(2)} deep on average`}
            />
            <StatTile
              label="Deepest"
              value={snap.deepestDepth}
              caption={snap.deepestSessionTitle}
            />
            <StatTile
              label="Goals done"
              value={<CountUp value={snap.goalsCompleted} key={`goals-${range}`} />}
              caption={`${snap.goalsActive} active now`}
            />
          </StatGroup>
          <ul className="grid gap-3">
            {snap.depth.map((bucket, index) => (
              <li key={bucket.depth} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium text-fg">
                    {bucket.depth === 0 ? "Sessions" : `Level ${bucket.depth} subagents`}
                  </span>
                  <span className="text-fg-muted tabular-nums">
                    {bucket.sessions.toLocaleString()}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                  <motion.div
                    className="h-full rounded-full bg-fg-muted"
                    initial={reduceMotion ? false : { width: 0 }}
                    animate={{
                      width: `${Math.max(2, (bucket.sessions / maxDepthSessions) * 100)}%`,
                    }}
                    transition={{ delay: index * 0.04, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </SectionStack>
  );

  return (
    <ContentPage width="wide" data-insights className="gap-6">
      {heading}
      <div className="flex min-w-0 flex-col gap-2">
        {tab === "usage" ? (
          usageToolbar
        ) : (
          <div role="group" aria-label="Period" className={TOOLBAR_CLASS}>
            <div className="ml-auto flex max-w-full min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
              <RangeControl value={range} onChange={(next) => update({ range: next })} />
            </div>
          </div>
        )}
        {freshness}
        {tab === "usage" && snap.facetsTruncated ? (
          <p className="text-xs leading-[18px] text-fg-muted">
            The filters list the first {snap.facets.length.toLocaleString()} models; more ran in
            this period.
          </p>
        ) : null}
      </div>
      {refreshError}
      <div
        data-insights-results
        aria-busy={loading}
        className={cn("min-w-0 transition-opacity", showingPreviousSelection && "opacity-60")}
      >
        {tab === "usage" ? (
          snap.modelCalls === 0 && privateRows.length === 0 ? (
            <EmptyState
              variant="page"
              title={filtered ? "No calls match these filters" : "No model calls in this period"}
              description={
                filtered
                  ? "Choose another model or session, or clear the filters."
                  : longerRange
                    ? "Try a longer period."
                    : "Spend and tokens show up here once someone in this workspace starts a chat."
              }
              action={
                filtered ? (
                  <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : longerRange ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => update({ range: longerRange.id })}
                  >
                    Show {longerRange.label.toLowerCase()}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            usage
          )
        ) : (
          activity
        )}
      </div>
    </ContentPage>
  );
}

/*
 * The toolbar's layout, written out: importing the Toolbar primitive here
 * regroups chunks shared with the session route and grows its direct graph.
 */
const TOOLBAR_CLASS = "flex min-w-0 flex-wrap items-center gap-2";

/**
 * The usage tab's shape while the first snapshot loads: toolbar, period line,
 * stats, chart and a list, at their final sizes so nothing jumps when data lands.
 */
function InsightsSkeleton(props: { filtered: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading workspace insights"
      className="flex min-w-0 flex-col gap-6"
    >
      <div aria-hidden="true" className="flex min-w-0 flex-col gap-2">
        <div className={TOOLBAR_CLASS}>
          <Skeleton className="ml-auto h-8 w-56 max-w-full rounded-lg" />
        </div>
        <Skeleton className="h-[18px] w-72 max-w-full rounded-full" />
      </div>
      <SectionStack variant="open">
        <Section
          title="Overview"
          description={props.filtered ? FILTERED_DESCRIPTION : OVERVIEW_DESCRIPTION}
        >
          <StatGroup label="Loading">
            {["Spend", "Tokens", "Model calls", "Cache hit"].map((label) => (
              <StatTile key={label} label={label} loading />
            ))}
          </StatGroup>
        </Section>
        <Section title="Paid with" description={PAID_WITH_DESCRIPTION}>
          <RowList variant="table" label="Loading payers" columns={PAID_WITH_COLUMNS}>
            <ListRowSkeleton count={3} />
          </RowList>
        </Section>
        <Section title="Over time" description={TOKENS_CHART_DESCRIPTION}>
          <div aria-hidden="true" className="flex min-w-0 flex-col gap-4">
            <Skeleton className="h-[220px] rounded-lg" />
            <Skeleton className="h-2 rounded-full" />
          </div>
        </Section>
        <Section title="By model" description={BY_MODEL_DESCRIPTION}>
          <RowList variant="table" label="Loading models" columns={MODEL_COLUMNS}>
            <ListRowSkeleton count={3} />
          </RowList>
        </Section>
      </SectionStack>
    </div>
  );
}

// Shared with the skeleton so loading and loaded copy take the same lines.
const OVERVIEW_DESCRIPTION = "Every chat counts, private ones included.";
const FILTERED_DESCRIPTION =
  "Filters narrow everything on this tab. Activity stays workspace-wide.";
const PAID_WITH_DESCRIPTION =
  "Credits are what Opengeni charged. A connected plan or your own API key is paid outside Opengeni, so its amount is a list-price estimate.";
const TOKENS_CHART_DESCRIPTION =
  "Input and output tokens, in UTC. A gap means those calls reported no token counts.";
const BY_MODEL_DESCRIPTION = "Select a model to see only its usage.";

const SCHEDULE_COLUMNS: RowListColumn[] = [
  { id: "fires", label: "Runs", width: 72, align: "end" },
  { id: "tokens", label: "Tokens", width: 88, align: "end" },
  { id: "credits", label: "Credits", width: 96, align: "end", leadsWhenFolded: true },
  { id: "listPrice", label: "At list price", width: 112, align: "end", leadsWhenFolded: true },
];

const CALL_COLUMNS: RowListColumn[] = [
  { id: "payer", label: "Paid with", width: 128 },
  { id: "tokens", label: "Tokens", width: 88, align: "end" },
  { id: "cache", label: "Cache hit", width: 80, align: "end" },
  {
    id: "amount",
    label: "Amount",
    width: 96,
    align: "end",
    hideLabel: true,
    leadsWhenFolded: true,
  },
];

const FLOOR_COLUMNS: RowListColumn[] = [
  { id: "state", label: "State", width: 104 },
  { id: "age", label: "Running for", width: 104, align: "end" },
  { id: "cache", label: "Cache hit", width: 80, align: "end" },
];

const WARM_COLUMNS: RowListColumn[] = [
  { id: "warm", label: "Warm time", width: 104, align: "end" },
  { id: "sessions", label: "Chats", width: 80, align: "end" },
];

const PROMPT_COLUMNS: RowListColumn[] = [
  { id: "tokens", label: "Est. tokens", width: 104, align: "end" },
  { id: "share", label: "Share", width: 72, align: "end" },
  { id: "calls", label: "Calls", width: 80, align: "end" },
];

function hitPct(cached: number, input: number): number | null {
  if (input <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((cached / input) * 100)));
}

function Quiet(props: { children: ReactNode }) {
  return <span className="text-fg-muted tabular-nums">{props.children}</span>;
}

function EmptyLine(props: { children: ReactNode }) {
  return <p className="text-sm leading-5 text-fg-muted">{props.children}</p>;
}

function ScopeChip(props: { kind: string; label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-8 max-w-72 items-center gap-1.5 rounded-[10px] border border-border bg-selection pr-1 pl-2.5 text-sm text-fg pointer-coarse:h-11">
      <span className="whitespace-nowrap text-fg-muted">{props.kind}</span>
      <span className="truncate font-medium">{props.label}</span>
      <button
        type="button"
        aria-label={`Show every ${props.kind.toLowerCase()}`}
        onClick={props.onRemove}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-[120ms] hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:size-9"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="size-3.5"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

/**
 * The browser's select, restyled to the 32px toolbar control. The menu-style
 * SelectMenu shares a module with the session route, and importing it here
 * splits the session's direct-load graph.
 */
function FilterSelect(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      className="h-8 w-56 max-w-full rounded-[10px] bg-surface pointer-coarse:h-11"
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

function RangeControl(props: { value: InsightsRange; onChange: (range: InsightsRange) => void }) {
  return (
    <SegmentedControl<InsightsRange>
      size="sm"
      aria-label="Period"
      value={props.value}
      onValueChange={props.onChange}
      options={RANGE_OPTIONS.map((option) => ({ value: option.id, label: option.shortLabel }))}
    />
  );
}

function TokenComposition(props: {
  segments: Array<{ id: string; label: string; value: number; className: string }>;
  reduceMotion: boolean;
}) {
  const total = props.segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return null;
  return (
    <div data-insights-composition className="flex min-w-0 flex-col gap-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
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
      <dl className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {props.segments.map((segment) => (
          <div key={segment.id} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span className={cn("size-2 shrink-0 rounded-full", segment.className)} />
              <span className="truncate">{segment.label}</span>
            </dt>
            <dd className="mt-0.5 text-sm font-medium text-fg tabular-nums">
              {formatTokens(segment.value)}
              <span className="ml-1.5 text-xs font-normal text-fg-subtle">
                {Math.round((segment.value / total) * 100)}%
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DiagnosticList(props: {
  title: string;
  description: string;
  rows: Array<{
    id: string;
    title: string;
    meta: string;
    value: string;
    onSelect?: (() => void) | undefined;
  }>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <h3 className="text-sm leading-5 font-medium text-fg">{props.title}</h3>
        <p className="text-xs leading-[18px] text-fg-muted">{props.description}</p>
      </div>
      <RowList label={props.title} flush>
        {props.rows.map((row) => (
          <ListRow
            key={row.id}
            leading={<LogoTile name={row.title} />}
            title={row.title}
            meta={[row.meta, row.value]}
            onOpen={row.onSelect}
          />
        ))}
      </RowList>
    </div>
  );
}

function PromptContext(props: { contributions: WorkspaceInsightsSnapshot["promptContributions"] }) {
  const { contributions } = props;
  if (contributions.sources.length === 0) return null;
  const average =
    contributions.coveredCalls > 0
      ? formatTokens(Math.round(contributions.estimatedTokens / contributions.coveredCalls))
      : "Unknown";
  return (
    <Section
      title="Knowledge in prompts"
      description={`About ${average} tokens per call come from instructions, organization identity, memory and skills (estimated from their size). Measured on ${contributions.coveredCalls.toLocaleString()} of ${contributions.totalCalls.toLocaleString()} calls.`}
    >
      <RowList
        variant="table"
        label="Knowledge in prompts"
        nameLabel="Source"
        columns={PROMPT_COLUMNS}
      >
        {contributions.sources.map((row) => (
          <ListRow
            key={row.source}
            leading={<LogoTile name={PROMPT_SOURCE_LABELS[row.source]} />}
            title={PROMPT_SOURCE_LABELS[row.source]}
            cells={{
              tokens: <Quiet>{formatTokens(row.estimatedTokens)}</Quiet>,
              share: (
                <Quiet>
                  {contributions.estimatedTokens > 0
                    ? `${Math.round((row.estimatedTokens / contributions.estimatedTokens) * 100)}%`
                    : "-"}
                </Quiet>
              ),
              calls: <Quiet>{row.calls.toLocaleString()}</Quiet>,
            }}
          />
        ))}
      </RowList>
    </Section>
  );
}

function StateDot(props: { state: FloorSession["state"] }) {
  const live = props.state === "running" || props.state === "compacting";
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden="true">
      {live ? (
        <span className="absolute inline-flex size-full rounded-full bg-status-running opacity-40 motion-safe:animate-ping" />
      ) : null}
      <span className={cn("relative size-2 rounded-full", stateColor(props.state))} />
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
      return "bg-fg-subtle";
    case "failed":
      return "bg-danger";
    case "idle":
      return "bg-status-idle";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
