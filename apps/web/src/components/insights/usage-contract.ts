/**
 * The Insights usage query: one shape at workspace and organization scope.
 *
 * Mirrors the agreed backend contract (`GET .../insights/usage`). Until that
 * endpoint ships everywhere, `usage-adapter.ts` builds the same shape from the
 * older Insights and billing endpoints, so the dashboard never branches on the
 * source.
 */
import type { InsightsUsageResponse } from "@opengeni/contracts/insights-usage";

/** "custom" pairs with `from`/`to` (UTC days, `to` inclusive). */
export type UsageRange = "today" | "week" | "month" | "30d" | "90d" | "ytd" | "custom";

export type UsageGroupBy =
  | "model"
  | "provider"
  | "payer"
  | "workspace"
  | "project"
  | "rootSession"
  | "person"
  | "schedule"
  /** Where the work came from: web app, API/SDK/embed, Slack, schedule, agent. */
  | "source";

export type UsagePayerId = "opengeni_credits" | "subscription" | "own_key";

/** Token classes. Input = uncachedInput + cacheRead + cacheWrite; reasoning is part of output. */
export type UsageTokens = {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

/** The priced classes. Reasoning is billed as output. */
export type UsageCostClass = "uncachedInput" | "cacheRead" | "cacheWrite" | "output";

export type UsagePayerMeasures = { calls: number; chargedMicros: number; listMicros: number };

export type UsageMeasures = {
  calls: number;
  /** Calls that reported token counts. */
  tokenKnownCalls: number;
  /** Calls that reported cache reads. */
  cacheKnownCalls: number;
  /** Calls that reported cache writes; older calls didn't record them. */
  cacheWriteKnownCalls: number;
  tokens: UsageTokens;
  /** Opengeni credits actually charged. */
  chargedMicros: number;
  /** List-price estimate over every payer, for calls with a list price. */
  listMicros: number;
  /** listMicros by token class; null when the split isn't known. */
  listByClassMicros: Record<UsageCostClass, number> | null;
  /** Calls whose class split is known. */
  listClassKnownCalls: number;
  /** The split is an allocation, not per-class prices captured at call time. */
  listByClassApprox: boolean;
  /** Calls with a list price. calls - pricedCalls are unpriced. */
  pricedCalls: number;
  byPayer?: Partial<Record<UsagePayerId, UsagePayerMeasures>>;
  /**
   * Set only when the token classes are unknown and only their sum is (rows
   * from the older Insights endpoint). The classes then read as unknown.
   */
  tokensTotal?: number;
};

export type UsageGroupKind =
  | "item"
  | "other"
  | "deleted"
  | "private"
  | "personal"
  | "unfiled"
  | "service"
  | "restricted";

export type UsageGroup = {
  /** Stable; the filter value for click-to-filter when kind is "item" (or "unfiled" for projects). */
  key: string;
  kind: UsageGroupKind;
  label: string;
  provider?: string;
  model?: string;
  payer?: UsagePayerId;
  workspaceId?: string;
  you?: boolean;
  /** On private rows: the person's key in `facets.people`, to filter by them. */
  personKey?: string;
  measures: UsageMeasures;
};

export type UsageSeriesGroupValue = Pick<
  UsageMeasures,
  "calls" | "chargedMicros" | "listMicros" | "tokens"
> & { byPayer?: UsageMeasures["byPayer"] };

export type UsageSeriesPoint = {
  start: string;
  measures: UsageMeasures;
  groups?: Record<string, UsageSeriesGroupValue>;
};

export type UsageFacets = {
  workspaces: Array<{ id: string; name: string; personal: boolean }>;
  providers: string[];
  models: Array<{ provider: string; model: string }>;
  /** Payer ids; unknown values are ignored by the UI. */
  payers: string[];
  projects: Array<{ id: string; name: string }>;
  people: Array<{ key: string; name: string | null; you: boolean }>;
  schedules: Array<{ id: string; name: string }>;
  /** Present when the server answers the source dimension and custom ranges. */
  sources?: string[];
};

export type UsageFilters = {
  workspaceId?: string[];
  provider?: string[];
  /** `provider/model` pairs, split on the first "/"; see modelFilterKey. */
  model?: string[];
  payer?: UsagePayerId[];
  projectId?: string[];
  person?: string[];
  rootSessionId?: string[];
  scheduleId?: string[];
  source?: string[];
};

export type UsageFilterField = keyof UsageFilters;

export type UsageScope =
  | { kind: "workspace"; accountId: string | null; workspaceId: string }
  | { kind: "organization"; accountId: string; workspaceId: null };

export type UsageQuery = {
  range: UsageRange;
  /** Custom range only: UTC days, `to` inclusive. */
  from?: string;
  to?: string;
  groupBy: UsageGroupBy;
  filters: UsageFilters;
};

export type UsageResponse = {
  scope: UsageScope;
  range: UsageRange;
  windowStart: string;
  windowEnd: string;
  priorWindowStart: string | null;
  priorWindowEnd: string | null;
  bucket: "hour" | "day";
  generatedAt: string;
  dataThrough: string | null;
  totals: UsageMeasures;
  /** Null when the prior window has no calls: no "vs prior" comparison. */
  prior: UsageMeasures | null;
  groupBy: UsageGroupBy;
  groups: UsageGroup[];
  groupCount: number;
  groupsTruncated: boolean;
  series: UsageSeriesPoint[];
  facets: UsageFacets;
  /** What this source can answer; the adapter is narrower than the real endpoint. */
  capabilities: {
    groupBy: UsageGroupBy[];
    filters: UsageFilterField[];
    ranges: UsageRange[];
    seriesGroups: boolean;
    /** False when each filter takes one value (the older endpoints). */
    multiValue?: boolean;
  };
};

/** The API supports more groupings than this dashboard requests. Never relabel a different one. */
export function usageResponseForGrouping(
  response: InsightsUsageResponse,
  groupBy: UsageGroupBy,
  capabilities: UsageResponse["capabilities"],
): UsageResponse {
  if (response.groupBy !== groupBy) {
    throw new Error("Usage response grouping does not match the request");
  }
  return { ...response, groupBy, capabilities };
}

export type UsageCallKind = "visible" | "private" | "deleted";

export type UsageCall = {
  id: string;
  occurredAt: string;
  workspaceId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  sessionKind: UsageCallKind;
  provider: string;
  model: string;
  payer: UsagePayerId;
  tokens: UsageTokens | null;
  chargedMicros: number;
  listMicros: number | null;
};

export const MODEL_KEY_SEPARATOR = "/";

export function modelFilterKey(provider: string, model: string): string {
  return `${provider}${MODEL_KEY_SEPARATOR}${model}`;
}

export function parseModelFilterKey(key: string): { provider: string; model: string } | null {
  const index = key.indexOf(MODEL_KEY_SEPARATOR);
  if (index <= 0 || index === key.length - 1) return null;
  return { provider: key.slice(0, index), model: key.slice(index + 1) };
}

export function emptyTokens(): UsageTokens {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

export function emptyMeasures(): UsageMeasures {
  return {
    calls: 0,
    tokenKnownCalls: 0,
    cacheKnownCalls: 0,
    cacheWriteKnownCalls: 0,
    tokens: emptyTokens(),
    chargedMicros: 0,
    listMicros: 0,
    listByClassMicros: null,
    listClassKnownCalls: 0,
    listByClassApprox: false,
    pricedCalls: 0,
  };
}

export function addMeasures(target: UsageMeasures, source: UsageMeasures): UsageMeasures {
  target.calls += source.calls;
  target.tokenKnownCalls += source.tokenKnownCalls;
  target.cacheKnownCalls += source.cacheKnownCalls;
  target.cacheWriteKnownCalls += source.cacheWriteKnownCalls;
  target.tokens.uncachedInput += source.tokens.uncachedInput;
  target.tokens.cacheRead += source.tokens.cacheRead;
  target.tokens.cacheWrite += source.tokens.cacheWrite;
  target.tokens.output += source.tokens.output;
  target.tokens.reasoning += source.tokens.reasoning;
  target.chargedMicros += source.chargedMicros;
  target.listMicros += source.listMicros;
  target.pricedCalls += source.pricedCalls;
  target.listClassKnownCalls += source.listClassKnownCalls;
  target.listByClassApprox ||= source.listByClassApprox;
  if (source.listByClassMicros) {
    const into = (target.listByClassMicros ??= {
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });
    into.uncachedInput += source.listByClassMicros.uncachedInput;
    into.cacheRead += source.listByClassMicros.cacheRead;
    into.cacheWrite += source.listByClassMicros.cacheWrite;
    into.output += source.listByClassMicros.output;
  }
  if (source.tokensTotal !== undefined) {
    target.tokensTotal = (target.tokensTotal ?? 0) + source.tokensTotal;
  }
  if (source.byPayer) {
    target.byPayer ??= {};
    for (const [payer, value] of Object.entries(source.byPayer) as Array<
      [UsagePayerId, NonNullable<UsageMeasures["byPayer"]>[UsagePayerId]]
    >) {
      if (!value) continue;
      const existing = (target.byPayer[payer] ??= { calls: 0, chargedMicros: 0, listMicros: 0 });
      existing.calls += value.calls;
      existing.chargedMicros += value.chargedMicros;
      existing.listMicros += value.listMicros;
    }
  }
  return target;
}

export function sumMeasures(rows: readonly UsageMeasures[]): UsageMeasures {
  return rows.reduce((total, row) => addMeasures(total, row), emptyMeasures());
}

/*
 * Drift guard (types only, nothing ships): the shared contract
 * (`@opengeni/contracts/insights-usage`) must stay assignable to the shapes
 * this dashboard reads after its requested grouping is verified above.
 * Every dashboard grouping must remain supported by the shared query contract;
 * additive API-only groupings do not automatically become dashboard controls.
 */
type AssertAssignable<_T extends true> = true;
type DashboardUsageResponse = Omit<InsightsUsageResponse, "groupBy"> & {
  groupBy: Extract<InsightsUsageResponse["groupBy"], UsageGroupBy>;
};
export type UsageContractGuard = [
  AssertAssignable<
    DashboardUsageResponse extends Omit<UsageResponse, "capabilities"> ? true : false
  >,
  AssertAssignable<UsageGroupBy extends InsightsUsageResponse["groupBy"] ? true : false>,
  AssertAssignable<
    import("@opengeni/contracts/insights-usage").InsightsCall extends UsageCall ? true : false
  >,
];
