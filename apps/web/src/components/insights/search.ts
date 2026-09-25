import type { InsightsRange } from "@opengeni/sdk";

import type { InsightsFilters, InsightsMeasure } from "./mock-data";

const RANGE_IDS: readonly InsightsRange[] = ["today", "week", "month", "ytd"];

/** Insights selection as it appears in the URL; omitted keys mean the default. */
export type InsightsSearch = {
  range?: InsightsRange;
  chart?: "spend";
  provider?: string;
  model?: string;
  root?: string;
  session?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FACET_MAX_CHARS = 200;

function facet(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FACET_MAX_CHARS || trimmed === "all") {
    return undefined;
  }
  return trimmed;
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

export function parseInsightsSearch(search: Record<string, unknown>): InsightsSearch {
  const range = RANGE_IDS.find((id) => id === search.range);
  const provider = facet(search.provider);
  const model = facet(search.model);
  const root = uuid(search.root);
  const session = uuid(search.session);
  return {
    ...(range && range !== "week" ? { range } : {}),
    ...(search.chart === "spend" ? { chart: "spend" as const } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(root ? { root } : {}),
    ...(session ? { session } : {}),
  };
}

export function insightsRange(search: InsightsSearch): InsightsRange {
  return search.range ?? "week";
}

export function insightsMeasure(search: InsightsSearch): InsightsMeasure {
  return search.chart === "spend" ? "money" : "tokens";
}

export function insightsFilters(search: InsightsSearch): InsightsFilters {
  return {
    provider: search.provider ?? "all",
    model: search.model ?? "all",
    rootSessionId: search.root ?? null,
    sessionId: search.session ?? null,
  };
}

/** Merge a partial change into the URL selection, dropping keys that return to their default. */
export function nextInsightsSearch(
  current: InsightsSearch,
  change: {
    range?: InsightsRange;
    measure?: InsightsMeasure;
    provider?: string | "all";
    model?: string | "all";
    rootSessionId?: string | null;
    sessionId?: string | null;
  },
): InsightsSearch {
  const merged: Record<string, unknown> = { ...current };
  if (change.range !== undefined) merged.range = change.range;
  if (change.measure !== undefined) merged.chart = change.measure === "money" ? "spend" : undefined;
  if (change.provider !== undefined) merged.provider = change.provider;
  if (change.model !== undefined) merged.model = change.model;
  if (change.rootSessionId !== undefined) merged.root = change.rootSessionId ?? undefined;
  if (change.sessionId !== undefined) merged.session = change.sessionId ?? undefined;
  return parseInsightsSearch(merged);
}
