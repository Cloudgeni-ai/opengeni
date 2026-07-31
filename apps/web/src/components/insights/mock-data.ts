/**
 * Insights view helpers. Snapshot truth comes from GET /v1/workspaces/:id/insights.
 * No embedded mock rollups — keep filter math honest (server already filtered).
 */
import type {
  InsightsBillingPath,
  InsightsFloorSession,
  InsightsModelUsageRow,
  InsightsRange,
  InsightsSeriesPoint,
  WorkspaceInsightsSnapshot,
} from "@opengeni/sdk";

export type {
  InsightsBillingPath as BillingPath,
  InsightsFloorSession as FloorSession,
  InsightsModelUsageRow as ModelUsageRow,
  InsightsRange,
  InsightsSeriesPoint as SeriesPoint,
  WorkspaceInsightsSnapshot as InsightsSnapshot,
};

export type ProviderId = string;

export type InsightsFilters = {
  provider: ProviderId | "all";
  model: string | "all";
};

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
  { id: "week", label: "This week", shortLabel: "Week" },
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
      return "credits";
    case "external":
      return "external";
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

export function formatUsd(value: number, digits = 2): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
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
    cacheHitPct: number;
    creditUsd: number;
    models: number;
  }>;
  totals: {
    /** OpenGeni credit $ for the headline (workspace ledger when unfiltered). */
    creditUsd: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheHitPct: number;
  };
  deltas: {
    modelPct: number | null;
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
  const calls = models.reduce((n, row) => n + row.calls, 0);
  const cacheHitPct = hitPct(cachedTokens, inputTokens);
  // Unfiltered headline follows usage_events.model.cost; filtered uses facts.
  const creditUsd = snap.modelFilterActive ? snap.creditUsd : snap.workspaceCreditUsd;
  const priorCreditUsd = snap.modelFilterActive
    ? snap.priorCreditUsd
    : snap.priorWorkspaceCreditUsd;

  const byProvider = new Map<
    string,
    {
      provider: string;
      calls: number;
      inputTokens: number;
      cachedTokens: number;
      creditUsd: number;
      models: number;
    }
  >();
  for (const row of models) {
    const existing = byProvider.get(row.provider) ?? {
      provider: row.provider,
      calls: 0,
      inputTokens: 0,
      cachedTokens: 0,
      creditUsd: 0,
      models: 0,
    };
    existing.calls += row.calls;
    existing.inputTokens += row.inputTokens;
    existing.cachedTokens += row.cachedTokens;
    existing.creditUsd += row.creditUsd;
    existing.models += 1;
    byProvider.set(row.provider, existing);
  }

  const providers = [...byProvider.values()]
    .map((row) => ({
      ...row,
      cacheHitPct: hitPct(row.cachedTokens, row.inputTokens),
    }))
    .sort((a, b) => b.inputTokens - a.inputTokens);

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
      cacheHitPct,
    },
    deltas: {
      modelPct: pctDelta(creditUsd, priorCreditUsd),
      warmPct: pctDelta(snap.warmSeconds, snap.priorWarmSeconds),
      tokensPct: pctDelta(inputTokens, snap.priorInputTokens),
      cachePts: cacheHitPct - snap.priorCacheHitPct,
    },
    series: snap.series,
    availableModels,
    availableProviders,
  };
}
