import {
  InsightsCallsResponse,
  InsightsUsageResponse,
  OrganizationInsightsCallsQuery,
  OrganizationInsightsUsageQuery,
  WorkspaceInsightsCallsQuery,
  WorkspaceInsightsUsageQuery,
} from "@opengeni/contracts/insights-usage";
import {
  getInsightsUsage,
  listInsightsCalls,
  requireAccessContext,
  requireAccessGrant,
  type ApiRouteDeps,
  type InsightsQueryScope,
} from "@opengeni/core";
import { currentSessionRlsActorIdentityKey } from "@opengeni/db";
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

/** No retained result cache; the actor is part of every in-flight sharing key. */
export function insightsUsageCoalesceKey(
  scope: InsightsQueryScope,
  query: unknown,
  actor: string | null,
): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, query, actor]);
}

export function registerInsightsUsageRoutes(app: Hono, deps: ApiRouteDeps): void {
  const usage = createInFlightCoalescer<Awaited<ReturnType<typeof getInsightsUsage>>>();
  const calls = createInFlightCoalescer<Awaited<ReturnType<typeof listInsightsCalls>>>();

  app.get("/v1/workspaces/:workspaceId/insights/usage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const parsed = WorkspaceInsightsUsageQuery.safeParse(insightsQueryParameters(c.req.queries()));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights usage query" });
    const scope = { accountId: grant.accountId, workspaceId };
    // The API's workspace middleware already binds/revalidates this grant's RLS actor.
    const response = await usage.run(
      insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
      () => getInsightsUsage(deps.db, { ...scope, query: parsed.data }),
    );
    c.header("cache-control", "private, no-store");
    return c.json(InsightsUsageResponse.parse(response));
  });

  app.get("/v1/workspaces/:workspaceId/insights/calls", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const parsed = WorkspaceInsightsCallsQuery.safeParse(insightsQueryParameters(c.req.queries()));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights calls query" });
    const scope = { accountId: grant.accountId, workspaceId };
    const response = await calls.run(
      insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
      () => listInsightsCalls(deps.db, { ...scope, query: parsed.data }),
    );
    c.header("cache-control", "private, no-store");
    return c.json(InsightsCallsResponse.parse(response));
  });

  app.get("/v1/organizations/:accountId/insights/usage", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.param("accountId"), "billing:read");
    const parsed = OrganizationInsightsUsageQuery.safeParse(
      insightsQueryParameters(c.req.queries()),
    );
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights usage query" });
    const scope = { accountId, workspaceId: null };
    const response = await withBillingUsageActor(deps, context, accountId, () =>
      usage.run(
        insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
        () => getInsightsUsage(deps.db, { ...scope, query: parsed.data }),
      ),
    );
    c.header("cache-control", "private, no-store");
    return c.json(InsightsUsageResponse.parse(response));
  });

  app.get("/v1/organizations/:accountId/insights/calls", async (c) => {
    const context = await requireAccessContext(c, deps);
    const accountId = requireSelectedAccount(context, c.req.param("accountId"), "billing:read");
    const parsed = OrganizationInsightsCallsQuery.safeParse(
      insightsQueryParameters(c.req.queries()),
    );
    if (!parsed.success) throw new HTTPException(400, { message: "invalid Insights calls query" });
    const scope = { accountId, workspaceId: null };
    // Billing permission is amounts authority only; DB call readers still enforce actor visibility.
    const response = await withBillingUsageActor(deps, context, accountId, () =>
      calls.run(
        insightsUsageCoalesceKey(scope, parsed.data, currentSessionRlsActorIdentityKey()),
        () => listInsightsCalls(deps.db, { ...scope, query: parsed.data }),
      ),
    );
    c.header("cache-control", "private, no-store");
    return c.json(InsightsCallsResponse.parse(response));
  });
}
