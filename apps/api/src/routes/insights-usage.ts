import {
  InsightsCallsResponse,
  InsightsUsageResponse,
  OrganizationInsightsCallsQuery,
  OrganizationInsightsUsageQuery,
  WorkspaceInsightsCallsQuery,
  WorkspaceInsightsUsageQuery,
} from "@opengeni/contracts/insights-usage";
import type { AccessContext } from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  getInsightsUsage,
  hasPermission,
  listInsightsCalls,
  requireAccessContext,
  requireAccessGrant,
  type ApiRouteDeps,
  type InsightsQueryScope,
} from "@opengeni/core";
import { currentSessionRlsActorIdentityKey, InvalidInsightsCallsCursorError } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireSelectedAccount, withBillingUsageActor } from "./billing";
import { createInFlightCoalescer } from "./insights";

/** Keep repeated filters, but reject repeated scalar options in the strict schema. */
export function insightsQueryParameters(
  query: Record<string, string[]>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(query).map(([key, values]) => [key, values.length === 1 ? values[0]! : values]),
  );
}

/** Frozen interim capabilities: a newer additive contract must not silently widen a raw query. */
export function insightsRawQuerySupported(
  query: Record<string, unknown>,
  organization: boolean,
  calls: boolean,
): boolean {
  const keys = new Set([
    "range",
    "provider",
    "model",
    "payer",
    "projectId",
    "person",
    "rootSessionId",
    "scheduleId",
    "limit",
    ...(organization ? ["workspaceId"] : []),
    ...(calls ? ["cursor"] : ["groupBy", "seriesGroups"]),
  ]);
  if (Object.keys(query).some((key) => !keys.has(key))) return false;
  if (
    query.range !== undefined &&
    !new Set(["today", "week", "month", "30d", "90d", "ytd"]).has(String(query.range))
  )
    return false;
  return (
    query.groupBy === undefined ||
    new Set([
      "model",
      "provider",
      "payer",
      "project",
      "rootSession",
      "person",
      "schedule",
      ...(organization ? ["workspace"] : []),
    ]).has(String(query.groupBy))
  );
}

function rawUsageResponse(response: Awaited<ReturnType<typeof getInsightsUsage>>) {
  const parsed = InsightsUsageResponse.parse(response);
  // A newer contract can supply an additive default. Absence is a capability
  // signal, so this raw implementation must not manufacture source support.
  if (!Object.hasOwn(response.facets, "sources")) Reflect.deleteProperty(parsed.facets, "sources");
  return parsed;
}

/** No retained result cache; the actor is part of every in-flight sharing key. */
export function insightsUsageCoalesceKey(
  scope: InsightsQueryScope,
  query: unknown,
  actor: string | null,
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    [...(scope.detailsWorkspaceIds ?? [])].sort(),
    scope.detailsSharedWorkspaces === true,
    query,
    actor,
  ]);
}

/** Reuse canonical read grants, never infer session access from billing authority. */
export function organizationInsightsScope(
  context: AccessContext,
  accountId: string,
): InsightsQueryScope {
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  if (authority?.accountId === accountId) {
    const readable = hasPermission(
      authority.permissions,
      "sessions:read",
      authority.permissionMode,
    );
    return {
      accountId,
      workspaceId: null,
      detailsWorkspaceIds:
        readable && authority.workspaceScope.kind === "selected"
          ? [...authority.workspaceScope.workspaceIds].sort()
          : [],
      detailsSharedWorkspaces: readable && authority.workspaceScope.kind === "all",
    };
  }
  return {
    accountId,
    workspaceId: null,
    detailsWorkspaceIds: [
      ...new Set(
        context.workspaceGrants
          .filter(
            (grant) =>
              grant.accountId === accountId &&
              grant.subjectId === context.subjectId &&
              hasPermission(grant.permissions, "sessions:read", grant.permissionMode),
          )
          .map((grant) => grant.workspaceId),
      ),
    ].sort(),
    detailsSharedWorkspaces: false,
  };
}

async function callsWithValidation(
  read: () => Promise<Awaited<ReturnType<typeof listInsightsCalls>>>,
) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof InvalidInsightsCallsCursorError)
      throw new HTTPException(400, { message: "invalid Insights calls cursor" });
    throw error;
  }
}

export function registerInsightsUsageRoutes(app: Hono, deps: ApiRouteDeps): void {
  const usage = createInFlightCoalescer<Awaited<ReturnType<typeof getInsightsUsage>>>();
  const calls = createInFlightCoalescer<Awaited<ReturnType<typeof listInsightsCalls>>>();

  app.get("/v1/workspaces/:workspaceId/insights/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const query = insightsQueryParameters(c.req.queries());
    if (!insightsRawQuerySupported(query, false, false))
      throw new HTTPException(400, { message: "unsupported interim Insights query" });
    const parsed = WorkspaceInsightsUsageQuery.safeParse(query);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights usage query" });
    const scope = {
      accountId: grant.accountId,
      workspaceId,
      detailsWorkspaceIds: hasPermission(grant.permissions, "sessions:read", grant.permissionMode)
        ? [workspaceId]
        : [],
    };
    // The API's workspace middleware already binds/revalidates this grant's RLS actor.
    const response = await usage.run(
      insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
      () => getInsightsUsage(deps.db, { ...scope, query: parsed.data }),
    );
    c.header("cache-control", "private, no-store");
    return c.json(rawUsageResponse(response));
  });

  app.get("/v1/workspaces/:workspaceId/insights/calls", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const query = insightsQueryParameters(c.req.queries());
    if (!insightsRawQuerySupported(query, false, true))
      throw new HTTPException(400, { message: "unsupported interim Insights query" });
    const parsed = WorkspaceInsightsCallsQuery.safeParse(query);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights calls query" });
    const scope = {
      accountId: grant.accountId,
      workspaceId,
      detailsWorkspaceIds: hasPermission(grant.permissions, "sessions:read", grant.permissionMode)
        ? [workspaceId]
        : [],
    };
    const response = await calls.run(
      insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
      () => callsWithValidation(() => listInsightsCalls(deps.db, { ...scope, query: parsed.data })),
    );
    c.header("cache-control", "private, no-store");
    return c.json(InsightsCallsResponse.parse(response));
  });

  app.get("/v1/organizations/:accountId/insights/usage", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.param("accountId"), "billing:read");
    const query = insightsQueryParameters(c.req.queries());
    if (!insightsRawQuerySupported(query, true, false))
      throw new HTTPException(400, { message: "unsupported interim Insights query" });
    const parsed = OrganizationInsightsUsageQuery.safeParse(query);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights usage query" });
    const scope = organizationInsightsScope(context, accountId);
    const response = await withBillingUsageActor(deps, context, accountId, () =>
      usage.run(
        insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
        () => getInsightsUsage(deps.db, { ...scope, query: parsed.data }),
      ),
    );
    c.header("cache-control", "private, no-store");
    return c.json(rawUsageResponse(response));
  });

  app.get("/v1/organizations/:accountId/insights/calls", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.param("accountId"), "billing:read");
    const query = insightsQueryParameters(c.req.queries());
    if (!insightsRawQuerySupported(query, true, true))
      throw new HTTPException(400, { message: "unsupported interim Insights query" });
    const parsed = OrganizationInsightsCallsQuery.safeParse(query);
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights calls query" });
    const scope = organizationInsightsScope(context, accountId);
    // Call readers intersect these canonical grants with current actor visibility.
    const response = await withBillingUsageActor(deps, context, accountId, () =>
      calls.run(
        insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
        () =>
          callsWithValidation(() => listInsightsCalls(deps.db, { ...scope, query: parsed.data })),
      ),
    );
    c.header("cache-control", "private, no-store");
    return c.json(InsightsCallsResponse.parse(response));
  });
}
