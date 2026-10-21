import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { readSubscriptionUsagePool, resolveNamedManagedPersonalWorkspaceGrant } from "@opengeni/db";
import { SubscriptionUsagePoolsResponse } from "@opengeni/contracts";
import type { Hono } from "hono";
import { requireOrganizationCodexHuman } from "./codex";
import { requireSubscriptionCoreRoute } from "./subscription-pool-core";
import { requirePrivateSubscriptionHuman } from "./subscription-pool-access";

/** Cached observations only; provider checks stay on the page's existing Refresh path. */
export function registerSubscriptionUsagePoolRoutes(app: Hono, deps: ApiRouteDeps) {
  async function read(input: { accountId: string; workspaceId: string | null; subjectId: string }) {
    // xAI currently reports a billing window, not either of these limit windows.
    const providers = [
      "codex" as const,
      ...(deps.settings.claudeSubscriptionEnabled ? ["claude" as const] : []),
    ];
    const pools = [];
    // The RLS transaction's scope is mutable, so do not race providers on it.
    for (const provider of providers) {
      await requireSubscriptionCoreRoute(deps, provider, provider, async () => input.accountId);
      const pool = await readSubscriptionUsagePool(deps.db, { ...input, provider });
      if (pool.windows.some((window) => window.accounts.length > 0)) pools.push(pool);
    }
    return SubscriptionUsagePoolsResponse.parse({ pools, checkedAt: new Date().toISOString() });
  }
  app.get("/v1/organizations/:organizationId/subscription-usage-pools", async (c) => {
    const accountId = c.req.param("organizationId");
    const human = await requireOrganizationCodexHuman(c, deps, accountId);
    return c.json(await read({ accountId, workspaceId: null, subjectId: human.subjectId }));
  });
  app.get("/v1/workspaces/:workspaceId/subscription-usage-pools", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    // Personal account telemetry has the same browser-human fence as its list.
    if (
      await resolveNamedManagedPersonalWorkspaceGrant(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
      })
    ) {
      await requirePrivateSubscriptionHuman(
        c,
        deps,
        workspaceId,
        "Subscription",
        "personal_workspace",
      );
    }
    return c.json(
      await read({ accountId: grant.accountId, workspaceId, subjectId: grant.subjectId }),
    );
  });
}
