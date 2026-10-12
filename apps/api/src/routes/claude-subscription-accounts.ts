import { ClaudeSubscriptionSetupTokenRequest } from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { XaiSubscriptionAccountMetadata } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireOrganizationCodexHuman } from "./codex";
import { registerSubscriptionAccountPoolRoutes } from "./subscription-account-pools";
import {
  requireDeletedSubscriptionPoolMutation,
  requireSameOriginBrowserMutation,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";

function accountJson(account: XaiSubscriptionAccountMetadata, activeId: string | null) {
  return {
    id: account.id,
    scope: account.scope,
    subject: account.providerAccountId ?? account.id,
    email: account.accountEmail,
    label: account.label,
    plan: account.planType,
    status: account.status,
    active: account.id === activeId,
    version: account.version,
    expiresAt: account.expiresAt?.toISOString() ?? null,
    lastRefreshAt: account.lastRefreshAt?.toISOString() ?? null,
    lastError: account.lastError,
    allocatorEnabled: account.allocatorEnabled,
    allocatorVersion: account.allocatorVersion,
    allocatorUpdatedAt: account.allocatorUpdatedAt?.toISOString() ?? null,
  };
}

/**
 * Claude account routes. The legacy Claude pool is deleted (design 5.3, C4):
 * accounts, usage and setup-token connect fail closed after authentication
 * until the shared subscription core serves them (C2a, C2b).
 */
export function registerClaudeSubscriptionAccountRoutes(app: Hono, deps: ApiRouteDeps) {
  registerSubscriptionAccountPoolRoutes(app, deps, {
    provider: "claude",
    route: "claude",
    displayName: "Claude",
    enabled: () => deps.settings.claudeSubscriptionEnabled,
    accountJson,
  });
  const deleted = () =>
    new HTTPException(503, {
      message: "Claude subscriptions are served only by the shared subscription core",
    });
  // Each route keeps its pre-deletion permission checks ahead of the 503, so a
  // caller refused before the deletion still gets the same refusal.
  async function deletedLegacyRoute(c: Context, organization: boolean, mutation: boolean) {
    c.header("cache-control", "private, no-store");
    if (!deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    if (!z.string().uuid().safeParse(c.req.param("accountId")).success)
      throw new HTTPException(400, { message: "Invalid Claude account ID" });
    if (mutation && !c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
    if (organization) await requireOrganizationCodexHuman(c, deps, c.req.param("organizationId")!);
    else {
      const workspaceId = c.req.param("workspaceId")!;
      await requireAccessGrant(c, deps, workspaceId, "workspace:read");
      if (mutation) await requireDeletedSubscriptionPoolMutation(c, deps, workspaceId);
    }
    throw deleted();
  }
  async function deletedSetupToken(c: Context, organization: boolean) {
    c.header("cache-control", "private, no-store");
    if (!deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    requireSameOriginBrowserMutation(c, deps);
    const parsed = ClaudeSubscriptionSetupTokenRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success || (organization && parsed.data.scope !== "workspace"))
      throw new HTTPException(422, { message: "Enter the Claude setup token." });
    if (organization) await requireOrganizationCodexHuman(c, deps, c.req.param("organizationId")!);
    else
      await requireSubscriptionScopeMutation(
        c,
        deps,
        c.req.param("workspaceId")!,
        parsed.data.scope,
        "Claude",
      );
    throw deleted();
  }
  for (const organization of [false, true]) {
    const scope = organization
      ? "/v1/organizations/:organizationId/claude/accounts"
      : "/v1/workspaces/:workspaceId/claude/accounts";
    app.get(`${scope}/:accountId/usage`, (c) => deletedLegacyRoute(c, organization, false));
    app.post(`${scope}/:accountId/usage/refresh`, (c) => deletedLegacyRoute(c, organization, true));
    app.post(`${scope}/setup-token`, (c) => deletedSetupToken(c, organization));
  }
}
