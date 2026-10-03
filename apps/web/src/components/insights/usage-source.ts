/**
 * Loads Insights usage for one scope. Asks the usage query API first and falls
 * back to the older endpoints (through `usage-adapter.ts`) when this
 * deployment doesn't serve it yet (404/405).
 */
import type { OpenGeniBrowserClient as OpenGeniClient } from "@opengeni/sdk/browser";

import {
  legacyRange,
  legacyWorkspaceFilters,
  organizationUsageFromModelUsage,
  workspaceUsageFromSnapshot,
} from "./usage-adapter";
import type {
  UsageCall,
  UsageFilters,
  UsageQuery,
  UsageResponse,
  UsageScope,
} from "./usage-contract";

export type UsageLoad = { usage: UsageResponse; calls: UsageCall[] | null };

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
  ],
  ranges: ["today", "week", "month", "30d", "90d", "ytd"],
  seriesGroups: true,
};

function queryParams(query: UsageQuery): Record<string, string> {
  const params: Record<string, string> = {
    range: query.range,
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

function unsupported(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 405 || status === 501;
}

/** Remembers, per scope kind, that this deployment has no usage query API. */
const legacyOnly = new Set<UsageScope["kind"]>();

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
    };
  }
  if (!legacyOnly.has(scope.kind)) {
    try {
      const usage = await client.requestJson<
        Omit<UsageResponse, "capabilities"> & {
          capabilities?: UsageResponse["capabilities"];
        }
      >("GET", `${basePath(scope)}/usage`, undefined, queryParams(query), { signal });
      // Recent calls come from `.../insights/calls`, loaded when that tab opens.
      return {
        usage: { ...usage, capabilities: usage.capabilities ?? ALL_CAPABILITIES },
        calls: null,
      };
    } catch (error) {
      if (!unsupported(error)) throw error;
      legacyOnly.add(scope.kind);
    }
  }
  if (scope.kind === "workspace") {
    const response = await client.getWorkspaceInsights(scope.workspaceId, {
      range: legacyRange(query.range),
      signal,
      ...legacyWorkspaceFilters(query),
    });
    return workspaceUsageFromSnapshot(response.snapshot, query, scope);
  }
  const data = await client.getOrganizationModelUsage(
    { accountId: scope.accountId, period: legacyRange(query.range) },
    { signal },
  );
  return { usage: organizationUsageFromModelUsage(data, query), calls: null };
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

export function usesLegacySource(scope: UsageScope["kind"]): boolean {
  return legacyOnly.has(scope);
}
