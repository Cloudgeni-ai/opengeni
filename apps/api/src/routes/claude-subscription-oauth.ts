import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { type Context, type Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { hashCodexBrowserSession } from "../codex-redemption-security";
import { isConfiguredDeploymentKeyRequest } from "../http/auth";
import {
  managedCookieHuman,
  requireOrganizationCodexHuman,
  requireSameOriginBrowserMutation,
} from "./codex";

export function registerClaudeSubscriptionOAuthRoutes(app: Hono, deps: ApiRouteDeps) {
  async function scope(c: Context, organization: boolean) {
    c.header("cache-control", "private, no-store");
    if (!deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, {
        message: "Claude subscriptions are not enabled",
      });
    // A key-only deployment has no Opengeni sign-in, so its operator connects
    // Claude with the deployment key itself (console or API).
    const deploymentKey = !organization && isConfiguredDeploymentKeyRequest(c, deps.settings);
    if (!deploymentKey) requireSameOriginBrowserMutation(c, deps);
    const id = z
      .string()
      .uuid()
      .safeParse(c.req.param(organization ? "organizationId" : "workspaceId"));
    if (!id.success) throw new HTTPException(404, { message: "Scope not found" });
    if (organization) {
      const human = await requireOrganizationCodexHuman(c, deps, id.data, {
        providerConsent: true,
      });
      return {
        accountId: id.data,
        workspaceId: null,
        actorSubjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
      };
    }
    const grant = await requireAccessGrant(c, deps, id.data, "connections:write");
    const human = await managedCookieHuman(c, deps);
    if (human && human.subjectId === grant.subjectId)
      return {
        accountId: grant.accountId,
        workspaceId: id.data,
        actorSubjectId: human.subjectId,
        browserSessionHash: human.browserSessionHash,
      };
    if (deploymentKey && grant.principalKind === "configured_key" && grant.subjectId)
      return {
        accountId: grant.accountId,
        workspaceId: id.data,
        actorSubjectId: grant.subjectId,
        browserSessionHash: await hashCodexBrowserSession("configured:" + grant.subjectId),
      };
    if (
      deps.settings.productAccessMode === "local" &&
      grant.subjectId &&
      !c.req.header("authorization")
    )
      return {
        accountId: grant.accountId,
        workspaceId: id.data,
        actorSubjectId: grant.subjectId,
        browserSessionHash: await hashCodexBrowserSession("local:" + grant.subjectId),
      };
    throw new HTTPException(401, {
      message: "Sign in to Opengeni to connect Claude.",
    });
  }
  // The legacy Claude pool these sign-ins wrote is deleted (design 5.3, C4):
  // after authentication, connecting fails closed until the shared
  // subscription core writes Claude connections (C2b).
  for (const organization of [false, true]) {
    const path = organization
      ? "/v1/organizations/:organizationId/model-providers/claude_subscription/oauth"
      : "/v1/workspaces/:workspaceId/model-providers/claude_subscription/oauth";
    for (const step of ["start", "complete"] as const)
      app.post(`${path}/${step}`, async (c) => {
        await scope(c, organization);
        throw new HTTPException(503, {
          message: "Claude subscriptions are served only by the shared subscription core",
        });
      });
  }
}
