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
  rootSessionId?: string | null;
  sessionId?: string | null;
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

export function formatUsdTick(value: number): string {
  return formatUsd(value, value === 0 || Math.abs(value) >= 0.1 ? 2 : undefined);
}

export function formatDeltaUsd(value: number): string {
  if (value === 0) return formatUsd(0);
  return `${value > 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
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

function roundMicros(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Null when prior is empty so the UI can show "—" instead of a fake +100%. */
export function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 100);
}

function hitPct(cached: number, input: number): number | null {
  if (input <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((cached / input) * 100)));
}

export function formatCachePct(value: number | null | undefined): string {
  return value === null || value === undefined ? "Unknown" : `${value}%`;
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
    cacheHitPct: number | null;
    creditUsd: number;
    estimatedProviderUsd: number;
    estimatedProviderCostKnownCalls: number;
    equivalentCreditUsd: number;
    equivalentCreditCostKnownCalls: number;
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
    cacheHitPct: number | null;
    cacheCoveragePct: number;
    creditPaidUsd: number;
    creditPaidCalls: number;
    /**
     * Charged ledger credits minus the credits the per-call breakdown accounts
     * for. Null when a filter or scope makes the headline itself fact-based.
     */
    ledgerGapUsd: number | null;
    externalEstimatedUsd: number;
    externalCalls: number;
    externalPricedCalls: number;
    /** Input from calls that reported cache detail, minus cache reads and writes. */
    uncachedInputTokens: number;
    /** Input from calls that did not report cache detail; its cache split is unknown. */
    unreportedCacheInputTokens: number;
    tokenCoveragePct: number;
    estimatedProviderUsd: number;
    pricingCoveragePct: number;
    equivalentCreditUsd: number;
    equivalentPricingCoveragePct: number;
  };
  deltas: {
    modelPct: number | null;
    estimatedPct: number | null;
    equivalentPct: number | null;
    warmPct: number | null;
    tokensPct: number | null;
    cachePts: number | null;
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
  const creditRows = models.filter((row) => row.billing === "opengeni_credits");
  const externalRows = models.filter((row) => row.billing === "external");
  const creditPaidUsd = creditRows.reduce((n, row) => n + row.creditUsd, 0);
  const creditPaidCalls = creditRows.reduce((n, row) => n + row.calls, 0);
  const externalEstimatedUsd = externalRows.reduce((n, row) => n + row.estimatedProviderUsd, 0);
  const externalCalls = externalRows.reduce((n, row) => n + row.calls, 0);
  const externalPricedCalls = externalRows.reduce(
    (n, row) => n + row.estimatedProviderCostKnownCalls,
    0,
  );
  const uncachedInputTokens = Math.max(0, cacheInputTokens - cachedTokens - cacheWriteTokens);
  const unreportedCacheInputTokens = Math.max(0, inputTokens - cacheInputTokens);
  // Unfiltered headline follows usage_events.model.cost; filtered uses facts.
  const scoped =
    snap.modelFilterActive || Boolean(snap.scope?.rootSessionId || snap.scope?.sessionId);
  const creditUsd = scoped ? snap.creditUsd : snap.workspaceCreditUsd;
  const priorCreditUsd = scoped ? snap.priorCreditUsd : snap.priorWorkspaceCreditUsd;
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
      equivalentCreditUsd: number;
      equivalentCreditCostKnownCalls: number;
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
      equivalentCreditUsd: 0,
      equivalentCreditCostKnownCalls: 0,
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
    existing.equivalentCreditUsd += row.equivalentCreditUsd;
    existing.equivalentCreditCostKnownCalls += row.equivalentCreditCostKnownCalls;
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
      creditPaidUsd,
      creditPaidCalls,
      ledgerGapUsd: scoped ? null : roundMicros(snap.workspaceCreditUsd - creditPaidUsd),
      externalEstimatedUsd,
      externalCalls,
      externalPricedCalls,
      uncachedInputTokens,
      unreportedCacheInputTokens,
      cacheCoveragePct: coveragePct(cacheKnownCalls, calls),
      tokenCoveragePct: coveragePct(tokenKnownCalls, calls),
      estimatedProviderUsd,
      pricingCoveragePct: coveragePct(snap.estimatedProviderCostKnownCalls, snap.modelCalls),
      equivalentCreditUsd: snap.equivalentCreditUsd,
      equivalentPricingCoveragePct: coveragePct(
        snap.equivalentCreditCostKnownCalls,
        snap.modelCalls,
      ),
    },
    deltas: {
      modelPct: pctDelta(creditUsd, priorCreditUsd),
      estimatedPct: pctDelta(estimatedProviderUsd, snap.priorEstimatedProviderUsd),
      equivalentPct: pctDelta(snap.equivalentCreditUsd, snap.priorEquivalentCreditUsd),
      warmPct: pctDelta(snap.warmSeconds, snap.priorWarmSeconds),
      tokensPct: pctDelta(totalTokens, snap.priorTotalTokens),
      cachePts:
        cacheHitPct === null || snap.priorCacheHitPct === null
          ? null
          : cacheHitPct - snap.priorCacheHitPct,
    },
    series: snap.series,
    availableModels,
    availableProviders,
  };
}

export type InsightsOutlierCall = {
  call: InsightsModelCallRow;
  /** Multiple of the median total across the sampled calls. */
  ratio: number;
};

export type InsightsCacheMissCall = {
  call: InsightsModelCallRow;
  uncachedInputTokens: number;
};

export type InsightsDiagnostics = {
  /** Calls considered; the snapshot carries only the most recent calls. */
  sampleSize: number;
  sampleTruncated: boolean;
  medianTotalTokens: number | null;
  outliers: InsightsOutlierCall[];
  cacheMisses: InsightsCacheMissCall[];
  lowCacheRoots: WorkspaceInsightsSnapshot["drivers"];
};

export const OUTLIER_MIN_SAMPLE = 5;
export const OUTLIER_MEDIAN_MULTIPLE = 3;
export const CACHE_MISS_MIN_INPUT_TOKENS = 8_000;
export const LOW_CACHE_ROOT_MAX_PCT = 25;
export const LOW_CACHE_ROOT_MIN_TOKENS = 50_000;
const DIAGNOSTIC_ROWS = 5;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Outliers and cache misses among the recent calls the snapshot carries, plus
 * root sessions whose reported cache hit is low. Calls with unreported fields
 * are skipped rather than treated as zero.
 */
export function buildInsightsDiagnostics(snap: WorkspaceInsightsSnapshot): InsightsDiagnostics {
  const calls = snap.recentCalls;
  const totals = calls
    .map((call) => call.totalTokens)
    .filter((value): value is number => value !== null);
  const medianTotalTokens = median(totals);
  const outliers =
    medianTotalTokens !== null && medianTotalTokens > 0 && totals.length >= OUTLIER_MIN_SAMPLE
      ? calls
          .filter(
            (call) =>
              call.totalTokens !== null &&
              call.totalTokens >= medianTotalTokens * OUTLIER_MEDIAN_MULTIPLE,
          )
          .map((call) => ({ call, ratio: call.totalTokens! / medianTotalTokens }))
          .sort((a, b) => b.ratio - a.ratio)
          .slice(0, DIAGNOSTIC_ROWS)
      : [];
  const cacheMisses = calls
    .filter(
      (call) => call.inputTokens !== null && call.cachedTokens !== null && call.cachedTokens === 0,
    )
    .map((call) => ({
      call,
      uncachedInputTokens: Math.max(0, call.inputTokens! - (call.cacheWriteTokens ?? 0)),
    }))
    .filter((row) => row.uncachedInputTokens >= CACHE_MISS_MIN_INPUT_TOKENS)
    .sort((a, b) => b.uncachedInputTokens - a.uncachedInputTokens)
    .slice(0, DIAGNOSTIC_ROWS);
  const lowCacheRoots = snap.drivers
    .filter(
      (driver) =>
        driver.cacheHitPct !== null &&
        driver.cacheHitPct < LOW_CACHE_ROOT_MAX_PCT &&
        driver.tokens >= LOW_CACHE_ROOT_MIN_TOKENS,
    )
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, DIAGNOSTIC_ROWS);
  return {
    sampleSize: calls.length,
    sampleTruncated: snap.recentCallsTruncated,
    medianTotalTokens,
    outliers,
    cacheMisses,
    lowCacheRoots,
  };
}

/** Root-session id carried by a `root:<uuid>` driver id, or null for other driver kinds. */
export function driverRootSessionId(driverId: string): string | null {
  return driverId.startsWith("root:") ? driverId.slice("root:".length) : null;
}
