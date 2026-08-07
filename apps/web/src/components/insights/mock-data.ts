/**
 * Insights view helpers. Snapshot truth comes from GET /v1/workspaces/:id/insights.
 * No embedded mock rollups — keep filter math honest (server already filtered).
 */
import type {
  InsightsBillingPath,
  InsightsFloorSession,
  InsightsModelCallRow,
  InsightsModelUsageRow,
  InsightsRange,
  InsightsSeriesPoint,
  WorkspaceInsightsSnapshot,
} from "@opengeni/sdk";

export type {
  InsightsBillingPath as BillingPath,
  InsightsFloorSession as FloorSession,
  InsightsModelUsageRow as ModelUsageRow,
  InsightsModelCallRow as ModelCallRow,
  InsightsRange,
  InsightsSeriesPoint as SeriesPoint,
  WorkspaceInsightsSnapshot as InsightsSnapshot,
};

export type ProviderId = string;

export type InsightsFilters = {
  provider: ProviderId | "all";
  model: string | "all";
};

export type InsightsMeasure = "tokens" | "money";

export type TraceTarget = {
  driverId: string;
  label: string;
};

export const RANGE_OPTIONS: ReadonlyArray<{
  id: InsightsRange;
  label: string;
  shortLabel: string;
}> = [
  { id: "today", label: "Today", shortLabel: "Today" },
  { id: "week", label: "Last 7 days", shortLabel: "7 days" },
  { id: "month", label: "This month", shortLabel: "Month" },
  { id: "ytd", label: "Year to date", shortLabel: "YTD" },
];

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  "azure-openai": "Azure OpenAI",
  anthropic: "Anthropic",
  "codex-subscription": "Codex",
  google: "Google",
};

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  return PROVIDER_LABEL[provider] ?? provider;
}

export function billingLabel(billing: InsightsBillingPath): string {
  switch (billing) {
    case "opengeni_credits":
      return "OpenGeni credits";
    case "external":
      return "external payer";
    default: {
      const _exhaustive: never = billing;
      return _exhaustive;
    }
  }
}

export function backendLabel(backend: string | null | undefined): string {
  if (!backend) return "unknown";
  switch (backend) {
    case "modal":
      return "Modal";
    case "docker":
      return "Docker";
    case "selfhosted":
      return "Connected Machine";
    default:
      return backend;
  }
}

export function formatUsd(value: number, digits?: number): string {
  const resolvedDigits =
    digits ?? (value === 0 || Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6);
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: resolvedDigits,
    maximumFractionDigits: resolvedDigits,
  })}`;
}

export function formatDeltaUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatUsd(value)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatUtcTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

export function coveragePct(known: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((known / total) * 100)));
}

export function formatWarmHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 100) return `${Math.round(hours)}h`;
  if (hours >= 10) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(2)}h`;
}

/** Null when prior is empty so the UI can show "—" instead of a fake +100%. */
export function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 100);
}

function hitPct(cached: number, input: number): number {
  if (input <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((cached / input) * 100)));
}

export function formatPctDelta(delta: number | null, priorLabel: string): string {
  if (delta === null) return `new vs ${priorLabel.toLowerCase()}`;
  return `${delta > 0 ? "+" : ""}${delta}% vs ${priorLabel.toLowerCase()}`;
}

export type InsightsView = {
  snap: WorkspaceInsightsSnapshot;
  filters: InsightsFilters;
  models: InsightsModelUsageRow[];
  providers: Array<{
    provider: string;
    calls: number;
    inputTokens: number;
    cachedTokens: number;
    cacheInputTokens: number;
    cacheHitPct: number;
    creditUsd: number;
    estimatedProviderUsd: number;
    estimatedProviderCostKnownCalls: number;
    totalTokens: number;
    creditsPathCalls: number;
    externalCalls: number;
    models: number;
  }>;
  totals: {
    /** OpenGeni credit $ for the headline (workspace ledger when unfiltered). */
    creditUsd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheHitPct: number;
    cacheCoveragePct: number;
    tokenCoveragePct: number;
    estimatedProviderUsd: number;
    pricingCoveragePct: number;
  };
  deltas: {
    modelPct: number | null;
    estimatedPct: number | null;
    warmPct: number | null;
    tokensPct: number | null;
    cachePts: number;
  };
  series: InsightsSeriesPoint[];
  availableModels: string[];
  availableProviders: string[];
};

/**
 * Derive display totals from an already server-filtered snapshot.
 * Does not rescale warm/series — the API owns filter honesty.
 */
export function buildInsightsView(
  snap: WorkspaceInsightsSnapshot,
  filters: InsightsFilters,
): InsightsView {
  const models = snap.models;
  const inputTokens = models.reduce((n, row) => n + row.inputTokens, 0);
  const outputTokens = models.reduce((n, row) => n + row.outputTokens, 0);
  const cachedTokens = models.reduce((n, row) => n + row.cachedTokens, 0);
  const cacheInputTokens = models.reduce((n, row) => n + row.cacheInputTokens, 0);
  const cacheWriteTokens = models.reduce((n, row) => n + row.cacheWriteTokens, 0);
  const reasoningTokens = models.reduce((n, row) => n + row.reasoningTokens, 0);
  const totalTokens = models.reduce((n, row) => n + row.totalTokens, 0);
  const tokenKnownCalls = models.reduce((n, row) => n + row.tokenKnownCalls, 0);
  const cacheKnownCalls = models.reduce((n, row) => n + row.cacheKnownCalls, 0);
  const calls = models.reduce((n, row) => n + row.calls, 0);
  const cacheHitPct = hitPct(cachedTokens, cacheInputTokens);
  // Unfiltered headline follows usage_events.model.cost; filtered uses facts.
  const creditUsd = snap.modelFilterActive ? snap.creditUsd : snap.workspaceCreditUsd;
  const priorCreditUsd = snap.modelFilterActive
    ? snap.priorCreditUsd
    : snap.priorWorkspaceCreditUsd;
  const estimatedProviderUsd = snap.estimatedProviderUsd;

  const byProvider = new Map<
    string,
    {
      provider: string;
      calls: number;
      inputTokens: number;
      cachedTokens: number;
      cacheInputTokens: number;
      creditUsd: number;
      estimatedProviderUsd: number;
      estimatedProviderCostKnownCalls: number;
      totalTokens: number;
      creditsPathCalls: number;
      externalCalls: number;
      modelIds: Set<string>;
    }
  >();
  for (const row of models) {
    const existing = byProvider.get(row.provider) ?? {
      provider: row.provider,
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      cacheInputTokens: 0,
      creditUsd: 0,
      estimatedProviderUsd: 0,
      estimatedProviderCostKnownCalls: 0,
      totalTokens: 0,
      creditsPathCalls: 0,
      externalCalls: 0,
      modelIds: new Set<string>(),
    };
    existing.calls += row.calls;
    existing.inputTokens += row.inputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.cacheInputTokens += row.cacheInputTokens;
    existing.creditUsd += row.creditUsd;
    existing.estimatedProviderUsd += row.estimatedProviderUsd;
    existing.estimatedProviderCostKnownCalls += row.estimatedProviderCostKnownCalls;
    existing.totalTokens += row.totalTokens;
    existing.creditsPathCalls += row.billing === "opengeni_credits" ? row.calls : 0;
    existing.externalCalls += row.billing === "external" ? row.calls : 0;
    existing.modelIds.add(row.model);
    byProvider.set(row.provider, existing);
  }

  const providers = [...byProvider.values()]
    .map(({ modelIds, ...row }) => ({
      ...row,
      models: modelIds.size,
      cacheHitPct: hitPct(row.cachedTokens, row.cacheInputTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const facets = snap.facets ?? [];
  const availableProviders = [...new Set(facets.map((row) => row.provider))].sort();
  const availableModels = [
    ...new Set(
      facets
        .filter((row) => filters.provider === "all" || row.provider === filters.provider)
        .map((row) => row.model),
    ),
  ].sort();

  return {
    snap,
    filters,
    models,
    providers,
    totals: {
      creditUsd,
      calls,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
      cacheHitPct,
      cacheCoveragePct: coveragePct(cacheKnownCalls, calls),
      tokenCoveragePct: coveragePct(tokenKnownCalls, calls),
      estimatedProviderUsd,
      pricingCoveragePct: coveragePct(snap.estimatedProviderCostKnownCalls, snap.modelCalls),
    },
    deltas: {
      modelPct: pctDelta(creditUsd, priorCreditUsd),
      estimatedPct: pctDelta(estimatedProviderUsd, snap.priorEstimatedProviderUsd),
      warmPct: pctDelta(snap.warmSeconds, snap.priorWarmSeconds),
      tokensPct: pctDelta(totalTokens, snap.priorTotalTokens),
      cachePts: cacheHitPct - snap.priorCacheHitPct,
    },
    series: snap.series,
    availableModels,
    availableProviders,
  };
}
