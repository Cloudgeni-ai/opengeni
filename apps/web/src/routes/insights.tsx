import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import { AreaChart, DonutChart, UsageMeter, donutTone } from "@/components/insights/charts";
import { CausalSheet } from "@/components/insights/causal-sheet";
import { CountUp } from "@/components/insights/count-up";
import {
  RANGE_OPTIONS,
  backendLabel,
  billingLabel,
  buildInsightsView,
  formatDeltaUsd,
  formatPctDelta,
  formatTokens,
  formatUtcTimestamp,
  formatUsd,
  formatWarmHours,
  providerLabel,
  type BillingPath,
  type FloorSession,
  type InsightsFilters,
  type InsightsMeasure,
  type InsightsRange,
  type TraceTarget,
} from "@/components/insights/mock-data";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * Workspace Insights — live rollups from usage_events + model_call_facts.
 */
export function InsightsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const workspace = context.workspaces.find((w) => w.id === workspaceId);
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const reduceMotion = useReducedMotion();
  const [range, setRange] = useState<InsightsRange>("week");
  const [measure, setMeasure] = useState<InsightsMeasure>("tokens");
  const [filters, setFilters] = useState<InsightsFilters>({
    provider: "all",
    model: "all",
  });
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const [floorFilter, setFloorFilter] = useState<"all" | "active">("all");
  const [snapshot, setSnapshot] = useState<WorkspaceInsightsSnapshot | null>(null);
  const [loadedFilters, setLoadedFilters] = useState<InsightsFilters>(filters);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setLoadError("Workspace admin permission is required to view Insights.");
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void context.client
      .getWorkspaceInsights(workspaceId, {
        range,
        ...(filters.provider !== "all" ? { provider: filters.provider } : {}),
        ...(filters.model !== "all" ? { model: filters.model } : {}),
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
    };
  }, [canRead, context.client, filters, range, workspaceId]);

  const view = useMemo(
    () => (snapshot ? buildInsightsView(snapshot, loadedFilters) : null),
    [loadedFilters, snapshot],
  );
  const snap = view?.snap ?? null;
  const totals = view?.totals;
  const deltas = view?.deltas;
  const series = view?.series ?? [];
  const models = view?.models ?? [];
  const providers = view?.providers ?? [];
  const maxDepthSessions = Math.max(...(snap?.depth.map((b) => b.sessions) ?? [1]), 1);
  const filtered = filters.provider !== "all" || filters.model !== "all";
  const showingPreviousSelection =
    snapshot !== null &&
    (snapshot.range !== range ||
      loadedFilters.provider !== filters.provider ||
      loadedFilters.model !== filters.model);

  const setProvider = (provider: string) => {
    setFilters((prev) => {
      const next: InsightsFilters = {
        provider: provider === "all" ? "all" : provider,
        model: prev.model,
      };
      if (
        next.provider !== "all" &&
        prev.model !== "all" &&
        snapshot &&
        !(snapshot.facets ?? []).some(
          (facet) => facet.provider === next.provider && facet.model === prev.model,
        )
      ) {
        next.model = "all";
      }
      return next;
    });
  };

  const setModel = (model: string | "all") => {
    setFilters((prev) => ({ ...prev, model }));
  };

  const clearFilters = () => setFilters({ provider: "all", model: "all" });

  const openTrace = (driverId: string) => {
    const driver = snap?.drivers.find((d) => d.id === driverId);
    setTrace({ driverId, label: driver?.label ?? driverId });
  };

  const floor = (snap?.floor ?? []).filter((session) => {
    if (floorFilter === "active") {
      return (
        session.state === "running" || session.state === "compacting" || session.state === "waiting"
      );
    }
    return true;
  });

  if (!canRead || (loadError && !snapshot)) {
    return (
      <ContentPage width="wide" data-insights className="gap-4">
        <h1 className="text-lg font-semibold text-fg">Workspace insights</h1>
        <p className="text-sm text-fg-muted">{loadError ?? "Unavailable."}</p>
      </ContentPage>
    );
  }

  if ((!snapshot && loading) || !snap || !totals || !deltas || !view) {
    return (
      <ContentPage width="wide" data-insights className="gap-4">
        <h1 className="text-lg font-semibold text-fg">Workspace insights</h1>
        <p className="text-sm text-fg-muted">Loading rollups…</p>
      </ContentPage>
    );
  }

  return (
    <ContentPage width="wide" data-insights className="gap-8">
      <motion.header
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col gap-4 border-b border-border pb-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-2xs font-medium uppercase tracking-[0.14em] text-fg-subtle">
              {workspace?.name ?? "Workspace"}
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-fg">Insights</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <MeasureControl value={measure} onChange={setMeasure} />
            <RangeControl value={range} onChange={setRange} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="Provider"
            value={filters.provider}
            onChange={(v) => setProvider(v)}
            options={[
              { value: "all", label: "All providers" },
              ...view.availableProviders.map((p) => ({
                value: p,
                label: providerLabel(p),
              })),
            ]}
          />
          <FilterSelect
            label="Model"
            value={filters.model}
            onChange={setModel}
            options={[
              { value: "all", label: "All models" },
              ...view.availableModels.map((m) => ({ value: m, label: m })),
            ]}
          />
          {filtered ? (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-2xs text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <XIcon className="size-3" />
              Clear
            </button>
          ) : null}
          {loading ? (
            <span className="text-2xs text-fg-subtle" role="status">
              {showingPreviousSelection ? "Refreshing… showing previous selection" : "Refreshing…"}
            </span>
          ) : null}
        </div>
      </motion.header>

      {loadError ? (
        <div className="rounded-lg border border-status-failed/30 bg-status-failed/5 px-3 py-2 text-xs text-status-failed">
          Refresh failed; showing the last successful selection and snapshot. {loadError}
        </div>
      ) : null}

      {/* 1. Headline — token truth by default; money remains explicitly split. */}
      <Section title="Overview">
        <div className="flex flex-wrap items-start justify-between gap-2 text-2xs text-fg-subtle">
          <p>
            {formatUtcTimestamp(snap.windowStart)} – {formatUtcTimestamp(snap.windowEnd)} ·
            generated {formatUtcTimestamp(snap.generatedAt)}
          </p>
          {snap.modelFilterActive ? (
            <p>Model filters do not alter sandbox, cap, or topology totals.</p>
          ) : null}
        </div>
        {measure === "money" ? (
          <div className="rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-xs leading-5 text-fg-muted">
            <strong className="text-fg">Estimated provider USD</strong> is a hypothetical
            provider-rate comparison from captured list pricing or gateway-reported inference cost,
            not an OpenGeni charge. <strong className="text-fg">OpenGeni credit price</strong> is
            shown separately and is zero for externally paid calls.
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {measure === "tokens" ? (
            <>
              <Metric
                label="Total tokens"
                value={formatTokens(totals.totalTokens)}
                delta={`${formatPctDelta(deltas.tokensPct, snap.priorLabel)} · ${totals.tokenCoveragePct}% call coverage`}
              />
              <Metric
                label="Input tokens"
                value={formatTokens(totals.inputTokens)}
                delta={`${formatTokens(totals.cachedTokens)} cache reads`}
              />
              <Metric
                label="Output tokens"
                value={formatTokens(totals.outputTokens)}
                delta={`${formatTokens(totals.reasoningTokens)} reasoning tokens reported`}
              />
              <Metric
                label="Cache hit"
                value={`${totals.cacheHitPct}%`}
                delta={`${deltas.cachePts > 0 ? "+" : ""}${deltas.cachePts} pts vs ${snap.priorLabel.toLowerCase()} · ${totals.cacheCoveragePct}% coverage`}
                tone={totals.cacheHitPct >= 60 ? "good" : "neutral"}
              />
            </>
          ) : (
            <>
              <Metric
                label="Estimated provider USD"
                value={formatUsd(totals.estimatedProviderUsd)}
                delta={`${formatPctDelta(deltas.estimatedPct, snap.priorLabel)} · ${totals.pricingCoveragePct}% call coverage`}
              />
              <Metric
                label={
                  snap.modelFilterActive
                    ? "OpenGeni credit price (filtered)"
                    : "OpenGeni credit price"
                }
                value={formatUsd(totals.creditUsd)}
                delta={`${formatPctDelta(deltas.modelPct, snap.priorLabel)} · external calls excluded`}
              />
              <Metric
                label="Priced calls"
                value={`${snap.estimatedProviderCostKnownCalls.toLocaleString()} / ${snap.modelCalls.toLocaleString()}`}
                delta="Historical or unconfigured prices remain unknown"
              />
              <Metric
                label="Total tokens"
                value={formatTokens(totals.totalTokens)}
                delta={`${totals.tokenCoveragePct}% of calls reported total tokens`}
              />
            </>
          )}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-fg">
                {measure === "tokens" ? "Token usage / UTC day" : "Pricing / UTC day"}
              </h3>
              <p className="text-2xs text-fg-subtle">
                {measure === "tokens"
                  ? "Total includes input + output"
                  : "Estimate and credits never merge"}
              </p>
            </div>
            <AreaChart
              key={`${measure}-${range}-${filters.provider}-${filters.model}`}
              className="mt-3"
              labels={series.map((p) => p.label)}
              formatValue={measure === "tokens" ? formatTokens : formatUsd}
              height={210}
              series={
                measure === "tokens"
                  ? [
                      {
                        id: "total",
                        label: "Total",
                        values: series.map((d) => d.totalTokens),
                        className: "text-brand",
                      },
                      {
                        id: "input",
                        label: "Input",
                        values: series.map((d) => d.inputTokens),
                        className: "text-status-running",
                      },
                      {
                        id: "output",
                        label: "Output",
                        values: series.map((d) => d.outputTokens),
                        className: "text-status-waiting",
                      },
                    ]
                  : [
                      {
                        id: "estimated",
                        label: "Estimated provider USD",
                        values: series.map((d) => d.estimatedProviderUsd),
                        className: "text-brand",
                      },
                      {
                        id: "credits",
                        label: "OpenGeni credit price",
                        values: series.map((d) => d.modelCostUsd),
                        className: "text-status-waiting",
                      },
                    ]
              }
            />
          </div>

          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-fg">{snap.cacheSeriesLabel}</h3>
              <p className="font-mono text-xs tabular-nums text-fg-muted">
                {totals.cacheHitPct}% · {totals.cacheCoveragePct}% coverage
              </p>
            </div>
            <AreaChart
              key={`cache-${range}-${filters.provider}-${filters.model}`}
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
      </Section>

      {/* 2. Models — primary pivot */}
      <Section title="By model">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <h3 className="text-sm font-medium text-fg">
              {measure === "tokens" ? "Total tokens" : "Estimated provider USD"}
            </h3>
            <p className="mt-0.5 text-2xs text-fg-subtle">Share by model · click to filter</p>
            <DonutChart
              key={`model-donut-${measure}-${range}-${filters.provider}-${filters.model}`}
              className="mt-3"
              centerLabel={measure === "tokens" ? "total tokens" : "priced calls only"}
              centerValue={
                measure === "tokens"
                  ? formatTokens(totals.totalTokens)
                  : formatUsd(totals.estimatedProviderUsd)
              }
              formatValue={measure === "tokens" ? formatTokens : formatUsd}
              onSelect={(id) => {
                const row = models.find((m) => m.id === id);
                if (row) setFilters({ provider: row.provider, model: row.model });
              }}
              slices={models.map((row, i) => ({
                id: row.id,
                label: row.model,
                value: measure === "tokens" ? row.totalTokens : row.estimatedProviderUsd,
                toneClass: donutTone(i),
              }))}
            />
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full text-left text-xs">
              <thead className="border-b border-border bg-surface/50 text-fg-subtle">
                <tr>
                  {[
                    "Model",
                    "Provider",
                    "Billing",
                    "Calls",
                    "Total",
                    "Input",
                    "Output",
                    "Cache read",
                    "Cache write",
                    "Reasoning",
                    "Est. provider USD",
                    "OpenGeni credits",
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-surface-2/60"
                    onClick={() => {
                      setFilters({ provider: row.provider, model: row.model });
                    }}
                  >
                    <td className="px-3 py-2.5 font-medium text-fg">{row.model}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{providerLabel(row.provider)}</td>
                    <td className="px-3 py-2.5">
                      <BillingPill billing={row.billing} />
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {row.calls.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.totalTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.inputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.outputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.cachedTokens)} ·{" "}
                      {hit(row.cachedTokens, row.cacheInputTokens)}%
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.cacheWriteTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.reasoningTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {row.estimatedProviderCostKnownCalls > 0
                        ? `${formatUsd(row.estimatedProviderUsd)} · ${row.estimatedProviderCostKnownCalls}/${row.calls}`
                        : "Unknown"}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatUsd(row.creditUsd)}
                    </td>
                  </tr>
                ))}
                {models.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-fg-subtle">
                      No model calls match this window and filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section title="Recent model calls">
        <p className="text-2xs text-fg-subtle">
          Most recent 50 calls in the selected UTC window. Unknown means the provider did not report
          that field or historical pricing was not captured.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Time (UTC)",
                  "Session",
                  "Model",
                  "Provider / API",
                  "Billing",
                  "Total",
                  "Input",
                  "Output",
                  "Cache read",
                  "Cache write",
                  "Reasoning",
                  "Est. provider USD",
                  "OpenGeni credits",
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
                  <td className="max-w-48 truncate px-3 py-2.5 font-medium text-fg">
                    {call.sessionTitle}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-2xs text-fg-muted">
                    {call.model}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-fg-muted">
                    {providerLabel(call.provider)} · {call.providerApi}
                  </td>
                  <td className="px-3 py-2.5">
                    <BillingPill billing={call.billing} />
                  </td>
                  {(
                    [
                      ["total", call.totalTokens],
                      ["input", call.inputTokens],
                      ["output", call.outputTokens],
                    ] as const
                  ).map(([kind, value]) => (
                    <td
                      key={`${call.id}-token-${kind}`}
                      className="px-3 py-2.5 font-mono tabular-nums text-fg-muted"
                    >
                      {value == null ? "Unknown" : formatTokens(value)}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {call.cachedTokens == null
                      ? "Unknown"
                      : `${formatTokens(call.cachedTokens)}${call.inputTokens ? ` · ${hit(call.cachedTokens, call.inputTokens)}%` : ""}`}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {call.cacheWriteTokens == null
                      ? "Unknown"
                      : formatTokens(call.cacheWriteTokens)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {call.reasoningTokens == null ? "Unknown" : formatTokens(call.reasoningTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {call.estimatedProviderUsd == null
                      ? "Unknown"
                      : `${formatUsd(call.estimatedProviderUsd)} · ${call.pricingSource === "gateway_reported" ? "gateway reported" : "list price"}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {formatUsd(call.creditUsd)}
                  </td>
                </tr>
              ))}
              {snap.recentCalls.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-8 text-center text-fg-subtle">
                    No model calls match this window and filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 3. Providers */}
      <Section title="By provider">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <h3 className="text-sm font-medium text-fg">
              {measure === "tokens" ? "Total tokens" : "Estimated provider USD"}
            </h3>
            <p className="mt-0.5 text-2xs text-fg-subtle">Share by provider · click to filter</p>
            <DonutChart
              key={`provider-donut-${measure}-${range}-${filters.provider}-${filters.model}`}
              className="mt-3"
              centerLabel={measure === "tokens" ? "total tokens" : "priced calls only"}
              centerValue={
                measure === "tokens"
                  ? formatTokens(totals.totalTokens)
                  : formatUsd(totals.estimatedProviderUsd)
              }
              formatValue={measure === "tokens" ? formatTokens : formatUsd}
              onSelect={(id) => {
                const next = id;
                setProvider(filters.provider === next && filters.model === "all" ? "all" : next);
              }}
              slices={providers.map((p, i) => ({
                id: p.provider,
                label: providerLabel(p.provider),
                value: measure === "tokens" ? p.totalTokens : p.estimatedProviderUsd,
                toneClass: donutTone(i),
              }))}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {providers.map((p) => {
              const active = filters.provider === p.provider;
              return (
                <button
                  key={p.provider}
                  type="button"
                  onClick={() =>
                    setProvider(active && filters.model === "all" ? "all" : p.provider)
                  }
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
                      {p.cacheHitPct}% cache
                    </p>
                  </div>
                  <p className="mt-2 font-mono text-xs tabular-nums text-fg-muted">
                    {formatTokens(p.totalTokens)} total · {p.calls.toLocaleString()} calls
                  </p>
                  <p className="mt-1 font-mono text-xs tabular-nums text-fg-subtle">
                    {p.estimatedProviderCostKnownCalls > 0
                      ? `${formatUsd(p.estimatedProviderUsd)} est. provider`
                      : "provider price unknown"}
                    {" · "}
                    {formatUsd(p.creditUsd)} credits
                  </p>
                  <p className="mt-1 text-2xs text-fg-subtle">
                    {p.creditsPathCalls} credit-path · {p.externalCalls} external · {p.models} model
                    {p.models === 1 ? "" : "s"}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      {/* 5. Sandbox usage — warm seconds (pricing later) */}
      <Section title="Sandbox usage">
        {snap.modelFilterActive ? (
          <p className="mb-2 text-2xs text-fg-subtle">
            Workspace-wide — not affected by model filter.
          </p>
        ) : null}
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

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
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

          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <h3 className="text-sm font-medium text-fg">Warm share</h3>
            <p className="mt-0.5 text-2xs text-fg-subtle">
              Top groups only · center matches slices
            </p>
            <DonutChart
              key={`warm-donut-${range}`}
              className="mt-3"
              centerLabel="top groups"
              centerValue={formatWarmHours(
                snap.warmGroups.reduce((sum, group) => sum + group.warmSeconds, 0),
              )}
              formatValue={(v) => formatWarmHours(v)}
              slices={[...snap.warmGroups]
                .sort((a, b) => b.warmSeconds - a.warmSeconds)
                .map((group, i) => ({
                  id: group.id,
                  label: group.label,
                  value: group.warmSeconds,
                  toneClass: donutTone(i),
                }))}
            />
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border">
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
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatWarmHours(group.warmSeconds)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {group.sessionsAttached}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border">
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
                  className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5 last:border-0 sm:border-r sm:odd:border-r lg:[&:nth-child(3n)]:border-r-0"
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
      </Section>

      {/* 6. Usage drivers */}
      <Section title="Usage drivers">
        <p className="text-2xs text-fg-subtle">
          Top drivers ranked by total tokens, so externally paid work is never hidden by a zero
          OpenGeni-credit price. Share is relative to the rows shown.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Driver",
                  "Tokens",
                  "Shown share",
                  "Cache",
                  "Est. provider USD",
                  "OpenGeni credits",
                  "Credit Δ",
                ].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.drivers.map((driver) => (
                <tr
                  key={driver.id}
                  className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-surface-2/60"
                  onClick={() => openTrace(driver.id)}
                >
                  <td className="px-3 py-2.5 font-medium text-fg">{driver.label}</td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {formatTokens(driver.tokens)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {driver.pctOfTokens}%
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {driver.tokens === 0 ? "—" : `${driver.cacheHitPct}%`}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {driver.estimatedProviderCostKnownCalls > 0
                      ? formatUsd(driver.estimatedProviderUsd)
                      : "Unknown"}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {formatUsd(driver.creditUsd)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2.5 font-mono tabular-nums",
                      driver.deltaUsdVsPrior > 0 ? "text-status-failed" : "text-fg-muted",
                    )}
                  >
                    {formatDeltaUsd(driver.deltaUsdVsPrior)}
                  </td>
                </tr>
              ))}
              {snap.drivers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-fg-subtle">
                    No attributed model usage in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 6. Live */}
      <Section title="Live now">
        <p className="mb-2 text-2xs text-fg-subtle">
          Current sessions
          {filters.model !== "all" ? ` · model ${filters.model}` : " · workspace-wide"}
          {filters.provider !== "all" && filters.model === "all"
            ? " (provider filter needs a model to narrow this list)"
            : ""}
          .
        </p>
        <div className="mb-3 flex gap-1 rounded-md border border-border p-0.5 w-fit">
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
        <div className="overflow-x-auto rounded-lg border border-border">
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
                {floor.map((session) => (
                  <tr
                    key={session.id}
                    className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-surface-2/50"
                    onClick={() => {
                      if (session.model) {
                        setFilters({
                          provider: "all",
                          model: session.model,
                        });
                      }
                    }}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <StateDot state={session.state} />
                        <span className="font-medium text-fg">{session.title}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-2xs text-fg-muted">
                      {session.model ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted">{backendLabel(session.route)}</td>
                    <td className="px-3 py-2.5">
                      <StatePill state={session.state} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {session.ageLabel}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {session.cacheHitPct == null ? "—" : `${session.cacheHitPct}%`}
                    </td>
                  </tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      </Section>

      {/* 7. Schedules */}
      <Section title="Schedules">
        <p className="mb-2 text-2xs text-fg-subtle">
          Attribution covers turns whose initiator carried a scheduled run id. Goal continuations
          without that lineage remain session usage rather than schedule usage.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {[
                  "Schedule",
                  "Fires",
                  "Tokens",
                  "Cache",
                  "Est. provider USD",
                  "OpenGeni credits",
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
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.fires.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.tokens == null ? "—" : formatTokens(row.tokens)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.tokens == null || row.tokens === 0 || row.cacheHitPct == null
                      ? "—"
                      : `${row.cacheHitPct}%`}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.estimatedProviderUsd == null ||
                    row.estimatedProviderCostKnownCalls == null ||
                    row.estimatedProviderCostKnownCalls === 0
                      ? "Unknown"
                      : formatUsd(row.estimatedProviderUsd)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.creditUsd == null ? "—" : formatUsd(row.creditUsd)}
                  </td>
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
        </div>
      </Section>

      {/* 8. Caps — billable meters (UTC month), not Insights input tokens */}
      <Section title="Caps">
        <p className="text-2xs text-fg-subtle">
          Credits-path billable tokens and agent runs since the start of this UTC month
          {snap.modelFilterActive ? " · workspace-wide (not model-filtered)" : ""}. Codex/external
          usage is omitted from the token meter.
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

      {/* 9. Session depth — secondary */}
      <Section title="Session depth">
        <p className="mb-2 text-2xs text-fg-subtle">
          All-time workspace topology — not scoped to the selected Insights range.
        </p>
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
        <ul className="mt-4 grid gap-2.5 rounded-lg border border-border bg-surface/35 p-4">
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
                    transition={{
                      delay: index * 0.04,
                      duration: 0.4,
                      ease: [0.22, 1, 0.36, 1],
                    }}
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

function hit(cached: number, input: number): number {
  if (input <= 0) return 0;
  return Math.round((cached / input) * 100);
}

function MeasureControl(props: {
  value: InsightsMeasure;
  onChange: (measure: InsightsMeasure) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Usage measure"
      className="inline-flex rounded-lg border border-border bg-surface/50 p-0.5"
    >
      {(
        [
          ["tokens", "Tokens"],
          ["money", "Money"],
        ] as const
      ).map(([id, label]) => {
        const active = props.value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(id)}
            className={cn(
              "relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
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
      role="tablist"
      aria-label="Time range"
      className="inline-flex rounded-lg border border-border bg-surface/50 p-0.5"
    >
      {RANGE_OPTIONS.map((option) => {
        const active = props.value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(option.id)}
            className={cn(
              "relative rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
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
    <label className="inline-flex items-center gap-2 text-2xs text-fg-subtle">
      <span className="sr-only">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-8 rounded-md border border-border bg-surface/50 px-2 text-xs text-fg outline-none focus-visible:border-brand/50"
      >
        {props.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-semibold tracking-[-0.02em] text-fg">{props.title}</h2>
      {props.children}
    </section>
  );
}

function Metric(props: {
  label: string;
  value: ReactNode;
  delta: string;
  tone?: "warn" | "neutral" | "good";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/40 px-3.5 py-3">
      <p className="text-2xs font-medium text-fg-subtle">{props.label}</p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-semibold tracking-[-0.03em] tabular-nums",
          props.tone === "warn" && "text-status-failed",
          props.tone === "good" && "text-status-running",
          (props.tone == null || props.tone === "neutral") && "text-fg",
        )}
      >
        {props.value}
      </p>
      <p className="mt-1 line-clamp-2 text-2xs tabular-nums text-fg-muted">{props.delta}</p>
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
