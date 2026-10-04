/**
 * Insights > Activity helpers over the workspace snapshot
 * (`GET /v1/workspaces/:id/insights`): labels, number formats and the
 * "Worth a look" diagnostics. Usage lives in `usage-*.ts`.
 */
import type {
  InsightsFloorSession,
  InsightsModelCallRow,
  InsightsRange,
  WorkspaceInsightsSnapshot,
} from "@opengeni/sdk";

export type { InsightsFloorSession as FloorSession, InsightsRange };

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

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
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
        driver.cacheHitPct < LOW_CACHE_ROOT_MAX_PCT && driver.tokens >= LOW_CACHE_ROOT_MIN_TOKENS,
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
