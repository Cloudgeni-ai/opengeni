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
  formatUsd,
  formatWarmHours,
  providerLabel,
  type BillingPath,
  type FloorSession,
  type InsightsFilters,
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
  const [filters, setFilters] = useState<InsightsFilters>({
    provider: "all",
    model: "all",
  });
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const [floorFilter, setFloorFilter] = useState<"all" | "active">("all");
  const [snapshot, setSnapshot] = useState<WorkspaceInsightsSnapshot | null>(null);
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
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSnapshot(null);
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, context.client, filters.model, filters.provider, range, workspaceId]);

  const view = useMemo(
    () => (snapshot ? buildInsightsView(snapshot, filters) : null),
    [filters, snapshot],
  );
  const snap = view?.snap ?? null;
  const totals = view?.totals;
  const deltas = view?.deltas;
  const series = view?.series ?? [];
  const models = view?.models ?? [];
  const providers = view?.providers ?? [];
  const maxDepthSessions = Math.max(...(snap?.depth.map((b) => b.sessions) ?? [1]), 1);
  const filtered = filters.provider !== "all" || filters.model !== "all";

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
        session.state === "running" ||
        session.state === "compacting" ||
        session.state === "waiting"
      );
    }
    return true;
  });

  if (!canRead || loadError) {
    return (
      <ContentPage width="wide" data-insights className="gap-4">
        <h1 className="text-lg font-semibold text-fg">Workspace insights</h1>
        <p className="text-sm text-fg-muted">{loadError ?? "Unavailable."}</p>
      </ContentPage>
    );
  }

  if (loading || !snap || !totals || !deltas || !view) {
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
          <RangeControl value={range} onChange={setRange} />
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
        </div>
      </motion.header>

      {/* 1. Headline — model $ / sandbox warm / tokens / cache */}
      <Section title="Overview">
        {snap.modelFilterActive ? (
          <p className="mb-3 text-2xs text-fg-subtle">
            Model filter active — sandbox warm, caps, live boxes, and session depth stay
            workspace-wide.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label={snap.modelFilterActive ? "Model $ (filtered)" : "OpenGeni credit $"}
            value={formatUsd(totals.creditUsd, totals.creditUsd >= 100 ? 0 : 2)}
            delta={formatPctDelta(deltas.modelPct, snap.priorLabel)}
            tone={(deltas.modelPct ?? 0) > 20 ? "warn" : "neutral"}
          />
          <Metric
            label="Sandbox warm"
            value={formatWarmHours(snap.warmSeconds)}
            delta={
              snap.modelFilterActive
                ? "workspace-wide"
                : formatPctDelta(deltas.warmPct, snap.priorLabel)
            }
            tone={!snap.modelFilterActive && (deltas.warmPct ?? 0) > 40 ? "warn" : "neutral"}
          />
          <Metric
            label="Input tokens"
            value={formatTokens(totals.inputTokens)}
            delta={formatPctDelta(deltas.tokensPct, snap.priorLabel)}
          />
          <Metric
            label="Cache hit"
            value={`${totals.cacheHitPct}%`}
            delta={`${deltas.cachePts > 0 ? "+" : ""}${deltas.cachePts} pts vs ${snap.priorLabel.toLowerCase()}`}
            tone={totals.cacheHitPct >= 60 ? "good" : "neutral"}
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-fg">{snap.seriesLabel}</h3>
              <LegendDot className="bg-brand" label="Model $" />
            </div>
            <AreaChart
              key={`cost-${range}-${filters.provider}-${filters.model}`}
              className="mt-3"
              labels={series.map((p) => p.label)}
              valuePrefix="$"
              height={210}
              series={[
                {
                  id: "model",
                  label: "Model $",
                  values: series.map((d) => d.modelCostUsd),
                  className: "text-brand",
                },
              ]}
            />
          </div>

          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-fg">{snap.cacheSeriesLabel}</h3>
              <p className="font-mono text-xs tabular-nums text-fg-muted">
                {totals.cacheHitPct}%
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
            <h3 className="text-sm font-medium text-fg">Input tokens</h3>
            <p className="mt-0.5 text-2xs text-fg-subtle">Share by model · click to filter</p>
            <DonutChart
              key={`model-donut-${range}-${filters.provider}-${filters.model}`}
              className="mt-3"
              centerLabel="input tokens"
              centerValue={formatTokens(totals.inputTokens)}
              formatValue={(v) => formatTokens(v)}
              onSelect={(id) => {
                const row = models.find((m) => m.id === id);
                if (row) setFilters({ provider: row.provider, model: row.model });
              }}
              slices={models.map((row, i) => ({
                id: row.id,
                label: row.model,
                value: row.inputTokens,
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
                    "Input",
                    "Output",
                    "Cache",
                    "Credit $",
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
                      {formatTokens(row.inputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {formatTokens(row.outputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {hit(row.cachedTokens, row.inputTokens)}%
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                      {row.billing === "external" ? "—" : formatUsd(row.creditUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      {/* 3. Providers */}
      <Section title="By provider">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="rounded-lg border border-border bg-surface/35 p-4">
            <h3 className="text-sm font-medium text-fg">Input tokens</h3>
            <p className="mt-0.5 text-2xs text-fg-subtle">Share by provider · click to filter</p>
            <DonutChart
              key={`provider-donut-${range}-${filters.provider}-${filters.model}`}
              className="mt-3"
              centerLabel="input tokens"
              centerValue={formatTokens(totals.inputTokens)}
              formatValue={(v) => formatTokens(v)}
              onSelect={(id) => {
                const next = id;
                setProvider(filters.provider === next && filters.model === "all" ? "all" : next);
              }}
              slices={providers.map((p, i) => ({
                id: p.provider,
                label: providerLabel(p.provider),
                value: p.inputTokens,
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
                    {formatTokens(p.inputTokens)} in · {p.calls.toLocaleString()} calls
                  </p>
                  <p className="mt-1 font-mono text-xs tabular-nums text-fg-subtle">
                    {p.creditUsd > 0 ? formatUsd(p.creditUsd) : "external"} · {p.models} model
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
          <p className="mb-2 text-2xs text-fg-subtle">Workspace-wide — not affected by model filter.</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Warm time"
            value={formatWarmHours(snap.warmSeconds)}
            delta={formatPctDelta(deltas.warmPct, snap.priorLabel)}
          />
          <Metric
            label="Sandbox groups"
            value={<CountUp value={snap.warmGroups.length} key={`groups-${range}`} />}
            delta="Boxes that accrued warm seconds"
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
            <p className="mt-0.5 text-2xs text-fg-subtle">By sandbox group</p>
            <DonutChart
              key={`warm-donut-${range}`}
              className="mt-3"
              centerLabel="warm time"
              centerValue={formatWarmHours(snap.warmSeconds)}
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
              One warm meter per box · sessions share the group
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
                          idle ? "bg-status-failed" : "bg-status-running",
                        )}
                      />
                      <p className="truncate font-mono text-xs text-fg">{lease.groupId}</p>
                    </div>
                    <p className="mt-0.5 text-2xs text-fg-subtle">
                      {backendLabel(lease.backend)} ·{" "}
                      {idle
                        ? "idle · viewer only"
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

      {/* 6. Credit drivers */}
      <Section title="Credit $ drivers">
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {["Driver", "Credit $", "Tokens", "Cache", "Share", "Δ"].map((h) => (
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
                    {formatUsd(driver.creditUsd)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {formatTokens(driver.tokens)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {driver.tokens === 0 ? "—" : `${driver.cacheHitPct}%`}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {driver.pctOfCreditUsd}%
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
            </tbody>
          </table>
        </div>
      </Section>

      {/* 6. Live */}
      <Section title="Live now">
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
                          provider: filters.provider,
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
                    <td className="px-3 py-2.5 text-fg-muted">
                      {backendLabel(session.route)}
                    </td>
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
          Credit $ covers turns whose initiator carried a scheduled run id (usually the first
          wake of a fire). Goal continuations without that lineage show as session spend, not
          schedule spend.
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface/50 text-fg-subtle">
              <tr>
                {["Schedule", "Fires", "Credit $", "Tokens", "Cache"].map((h) => (
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
                    {row.creditUsd == null || row.creditUsd === 0 ? "—" : formatUsd(row.creditUsd)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.tokens == null ? "—" : formatTokens(row.tokens)}
                  </td>
                  <td className="px-3 py-2.5 font-mono tabular-nums text-fg-muted">
                    {row.tokens == null || row.tokens === 0 || row.cacheHitPct == null
                      ? "—"
                      : `${row.cacheHitPct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 8. Caps — billable meters (UTC month), not Insights input tokens */}
      <Section title="Caps">
        <p className="text-2xs text-fg-subtle">
          Credits-path billable tokens and agent runs since the start of this UTC month
          {snap.modelFilterActive ? " · workspace-wide (not model-filtered)" : ""}.
          Codex/external usage is omitted from the token meter.
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

function RangeControl(props: {
  value: InsightsRange;
  onChange: (range: InsightsRange) => void;
}) {
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

function LegendDot(props: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", props.className)} />
      {props.label}
    </span>
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
