/**
 * Loads Insights usage for one scope. Asks the usage query API first and falls
 * back to the older endpoints (through `usage-adapter.ts`) when this
 * deployment doesn't serve the route at all.
 */
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";
import type { InsightsUsageResponse } from "@opengeni/contracts/insights-usage";

import {
  legacyRange,
  legacyWorkspaceFilters,
  organizationUsageFromModelUsage,
  workspaceUsageFromSnapshot,
} from "./usage-adapter";
import {
  usageResponseForGrouping,
  type UsageCall,
  type UsageFilterField,
  type UsageFilters,
  type UsageQuery,
  type UsageResponse,
  type UsageScope,
} from "./usage-contract";

export type UsageLoad = {
  usage: UsageResponse;
  /** Recent calls the older endpoint returned with the totals; null when they load separately. */
  calls: UsageCall[] | null;
  source: "usage" | "legacy";
  /** Filters in the URL this source can't apply, so the page can say so. */
  ignoredFilters: UsageFilterField[];
};

const ALL_CAPABILITIES: UsageResponse["capabilities"] = {
  groupBy: [
    "model",
    "provider",
    "payer",
    "workspace",
    "project",
    "rootSession",
    "person",
    "schedule",
    "source",
  ],
  filters: [
    "workspaceId",
    "provider",
    "model",
    "payer",
    "projectId",
    "person",
    "rootSessionId",
    "scheduleId",
    "source",
  ],
  ranges: ["today", "week", "month", "30d", "90d", "ytd", "custom"],
  seriesGroups: true,
};

function queryParams(query: UsageQuery): Record<string, string> {
  const params: Record<string, string> = {
    range: query.range,
    ...(query.range === "custom" && query.from && query.to
      ? { from: query.from, to: query.to }
      : {}),
    groupBy: query.groupBy,
    seriesGroups: "true",
  };
  for (const [field, values] of Object.entries(query.filters) as Array<
    [keyof UsageFilters, string[] | undefined]
  >) {
    if (values && values.length > 0) params[field] = values.join(",");
  }
  return params;
}

function basePath(scope: UsageScope): string {
  return scope.kind === "workspace"
    ? `/v1/workspaces/${scope.workspaceId}/insights`
    : `/v1/organizations/${scope.accountId}/insights`;
}

/**
 * The route itself is missing (an older API): the API's catch-all 404, a 405
 * or a 501. A 404 from the handler (an unknown workspace) is a real error.
 */
export function routeUnsupported(error: unknown): boolean {
  const failure = error as { status?: unknown; body?: unknown; message?: unknown } | null;
  if (failure?.status === 405 || failure?.status === 501) return true;
  if (failure?.status !== 404) return false;
  let serverMessage: unknown = null;
  if (typeof failure.body === "string" && failure.body) {
    try {
      serverMessage = (JSON.parse(failure.body) as { error?: { message?: unknown } }).error
        ?.message;
    } catch {
      serverMessage = failure.body;
    }
  }
  const text = typeof serverMessage === "string" ? serverMessage : String(failure.message ?? "");
  return /\bResource not found\.|^Not Found$/.test(text);
}

/** Deployments without the usage query API, remembered briefly per API and scope kind. */
const LEGACY_TTL_MS = 5 * 60_000;
const legacyUntil = new Map<string, number>();

function legacyKey(client: OpenGeniClient, scope: UsageScope): string {
  return `${(client as unknown as { baseUrl?: string }).baseUrl ?? ""}|${scope.kind}`;
}

/** Tests: forget which deployments lacked the usage query API. */
export function resetUsageSourceMemo(): void {
  legacyUntil.clear();
}

function ignored(query: UsageQuery, supported: readonly UsageFilterField[]): UsageFilterField[] {
  return (Object.entries(query.filters) as Array<[UsageFilterField, string[] | undefined]>)
    .filter(([field, values]) => (values?.length ?? 0) > 0 && !supported.includes(field))
    .map(([field]) => field);
}

export async function loadUsage(
  client: OpenGeniClient,
  scope: UsageScope,
  query: UsageQuery,
  signal: AbortSignal,
): Promise<UsageLoad> {
  // Dev only: `localStorage["opengeni.insights.fixture"] = "1"` previews the
  // full usage API shape before a local stack serves it.
  if (import.meta.env.DEV && globalThis.localStorage?.getItem("opengeni.insights.fixture")) {
    const { fixtureUsage } = await import("./usage-fixtures");
    return {
      usage: { ...fixtureUsage({ scope, groupBy: query.groupBy }), range: query.range },
      calls: null,
      source: "usage",
      ignoredFilters: [],
    };
  }
  const memo = legacyKey(client, scope);
  if ((legacyUntil.get(memo) ?? 0) <= Date.now()) {
    try {
      const usage = await client.requestJson<
        InsightsUsageResponse & { capabilities?: UsageResponse["capabilities"] }
      >("GET", `${basePath(scope)}/usage`, undefined, queryParams(query), { signal });
      // The source dimension and custom ranges arrived together; a server that
      // lists no source facet answers neither (its query schema is strict).
      const extended = Array.isArray(usage.facets?.sources);
      const capabilities = usage.capabilities ?? {
        ...ALL_CAPABILITIES,
        groupBy: ALL_CAPABILITIES.groupBy.filter((group) => extended || group !== "source"),
        filters: ALL_CAPABILITIES.filters.filter((field) => extended || field !== "source"),
        ranges: ALL_CAPABILITIES.ranges.filter((range) => extended || range !== "custom"),
      };
      return {
        usage: usageResponseForGrouping(usage, query.groupBy, capabilities),
        calls: null,
        source: "usage",
        ignoredFilters: ignored(query, capabilities.filters),
      };
    } catch (error) {
      if (!routeUnsupported(error)) throw error;
      legacyUntil.set(memo, Date.now() + LEGACY_TTL_MS);
    }
  }
  if (scope.kind === "workspace") {
    const response = await client.getWorkspaceInsights(scope.workspaceId, {
      range: legacyRange(query.range),
      signal,
      ...legacyWorkspaceFilters(query),
    });
    const { usage, calls } = workspaceUsageFromSnapshot(response.snapshot, query, scope);
    return {
      usage,
      calls,
      source: "legacy",
      ignoredFilters: ignored(query, usage.capabilities.filters),
    };
  }
  const data = await client.getOrganizationModelUsage(
    { accountId: scope.accountId, period: legacyRange(query.range) },
    { signal },
  );
  const usage = organizationUsageFromModelUsage(data, query);
  return {
    usage,
    calls: null,
    source: "legacy",
    ignoredFilters: ignored(query, usage.capabilities.filters),
  };
}

export async function loadUsageCalls(
  client: OpenGeniClient,
  scope: UsageScope,
  query: UsageQuery,
  signal: AbortSignal,
): Promise<{ calls: UsageCall[]; nextCursor: string | null }> {
  const params = queryParams(query);
  delete params.groupBy;
  delete params.seriesGroups;
  return await client.requestJson(
    "GET",
    `${basePath(scope)}/calls`,
    undefined,
    { ...params, limit: "50" },
    { signal },
  );
}
