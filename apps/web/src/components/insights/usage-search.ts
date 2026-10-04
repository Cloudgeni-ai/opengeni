/**
 * The Insights dashboard selection as URL search params, shared by the
 * workspace route and Organization > Insights. Omitted keys mean the default.
 * Filter values are comma-separated; a value holding a comma is dropped.
 */
import type {
  UsageFilterField,
  UsageFilters,
  UsageGroupBy,
  UsagePayerId,
  UsageQuery,
  UsageRange,
} from "./usage-contract";

export type UsageMetric = "spend" | "tokens" | "calls";
export type UsageTab = "breakdown" | "calls";

export type UsageSearch = {
  range?: UsageRange;
  group?: UsageGroupBy;
  metric?: UsageMetric;
  /** Split the chart by the breakdown's groups instead of totals / token classes. */
  split?: "group";
  tab?: "calls";
  ws?: string;
  prov?: string;
  model?: string;
  payer?: string;
  proj?: string;
  who?: string;
  root?: string;
  sched?: string;
  src?: string;
  /** Custom range: YYYY-MM-DD, UTC (`from` is taken by the back link). */
  start?: string;
  end?: string;
};

const FILTER_KEYS: Record<UsageFilterField, keyof UsageSearch> = {
  workspaceId: "ws",
  provider: "prov",
  model: "model",
  payer: "payer",
  projectId: "proj",
  person: "who",
  rootSessionId: "root",
  scheduleId: "sched",
  source: "src",
};

const RANGES: readonly UsageRange[] = ["today", "week", "month", "30d", "90d", "ytd", "custom"];
const GROUPS: readonly UsageGroupBy[] = [
  "model",
  "provider",
  "payer",
  "workspace",
  "project",
  "rootSession",
  "person",
  "schedule",
  "source",
];
const PAYERS: readonly UsagePayerId[] = ["opengeni_credits", "subscription", "own_key"];
const VALUE_MAX = 300;
const VALUES_MAX = 50;

export const DEFAULT_RANGE: UsageRange = "week";
export const DEFAULT_GROUP: UsageGroupBy = "model";

function values(raw: unknown, field: UsageFilterField): string[] {
  if (typeof raw !== "string") return [];
  const parts = [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part.length <= VALUE_MAX),
    ),
  ].slice(0, VALUES_MAX);
  if (field === "payer")
    return parts.filter((part) => (PAYERS as readonly string[]).includes(part));
  return parts;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: unknown): string | undefined {
  if (typeof value !== "string" || !DAY.test(value)) return undefined;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value;
}

export function parseUsageSearch(search: Record<string, unknown>): UsageSearch {
  const from = day(search.start);
  const to = day(search.end);
  const custom = search.range === "custom" && from && to && from <= to;
  const range = custom
    ? ("custom" as const)
    : RANGES.find((id) => id === search.range && id !== "custom");
  const group = GROUPS.find((id) => id === search.group);
  const metric = (["tokens", "calls"] as const).find((id) => id === search.metric);
  const out: UsageSearch = {
    ...(range && range !== DEFAULT_RANGE ? { range } : {}),
    ...(custom ? { start: from, end: to } : {}),
    ...(group && group !== DEFAULT_GROUP ? { group } : {}),
    ...(metric ? { metric } : {}),
    ...(search.split === "group" ? { split: "group" as const } : {}),
    ...(search.tab === "calls" ? { tab: "calls" as const } : {}),
  };
  for (const [field, key] of Object.entries(FILTER_KEYS) as Array<
    [UsageFilterField, keyof UsageSearch]
  >) {
    const list = values(search[key], field);
    if (list.length > 0) (out as Record<string, string>)[key] = list.join(",");
  }
  return out;
}

export function usageFilters(search: UsageSearch): UsageFilters {
  const filters: UsageFilters = {};
  for (const [field, key] of Object.entries(FILTER_KEYS) as Array<
    [UsageFilterField, keyof UsageSearch]
  >) {
    const list = values(search[key], field);
    if (list.length > 0) (filters as Record<string, string[]>)[field] = list;
  }
  return filters;
}

export function usageQuery(search: UsageSearch): UsageQuery {
  return {
    range: search.range ?? DEFAULT_RANGE,
    ...(search.range === "custom" && search.start && search.end
      ? { from: search.start, to: search.end }
      : {}),
    groupBy: search.group ?? DEFAULT_GROUP,
    filters: usageFilters(search),
  };
}

export function usageMetric(search: UsageSearch): UsageMetric {
  return search.metric ?? "spend";
}

export function activeFilterCount(filters: UsageFilters): number {
  return Object.values(filters).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}

export type UsageSearchChange = {
  range?: UsageRange;
  /** With range "custom". */
  from?: string;
  to?: string;
  group?: UsageGroupBy;
  metric?: UsageMetric;
  split?: boolean;
  tab?: UsageTab;
  /** Replace one filter field's values ([] clears it). */
  filter?: { field: UsageFilterField; values: string[] };
  clearFilters?: boolean;
};

export function nextUsageSearch(current: UsageSearch, change: UsageSearchChange): UsageSearch {
  const merged: Record<string, unknown> = { ...current };
  if (change.range !== undefined) {
    merged.range = change.range;
    if (change.range !== "custom") {
      merged.start = undefined;
      merged.end = undefined;
    }
  }
  if (change.from !== undefined) merged.start = change.from;
  if (change.to !== undefined) merged.end = change.to;
  if (change.group !== undefined) merged.group = change.group;
  if (change.metric !== undefined)
    merged.metric = change.metric === "spend" ? undefined : change.metric;
  if (change.split !== undefined) merged.split = change.split ? "group" : undefined;
  if (change.tab !== undefined) merged.tab = change.tab === "calls" ? "calls" : undefined;
  if (change.clearFilters) {
    for (const key of Object.values(FILTER_KEYS)) merged[key] = undefined;
  }
  if (change.filter) {
    const key = FILTER_KEYS[change.filter.field];
    merged[key] = change.filter.values.length > 0 ? change.filter.values.join(",") : undefined;
  }
  return parseUsageSearch(merged);
}
