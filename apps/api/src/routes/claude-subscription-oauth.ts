import { requireSubscriptionScopeMutation } from "./subscription-pool-access";
import {
  ClaudeSubscriptionOAuthCompleteRequest,
  ClaudeSubscriptionOAuthStartRequest,
} from "@opengeni/contracts";
import { requireAccessGrant, requireFreshAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import { type Context, type Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { hashCodexBrowserSession } from "../codex-redemption-security";
import { isConfiguredDeploymentKeyRequest } from "../http/auth";
import {
  startClaudeSubscriptionOAuth,
  completeClaudeSubscriptionOAuth,
  type ClaudeOAuthScope,
} from "../claude-subscription-oauth";
import {
  managedCookieHuman,
  requireOrganizationCodexHuman,
  requireSameOriginBrowserMutation,
} from "./codex";
import { claudeCoreRoute, requireClaudeCorePersonalWorkspace } from "../claude-subscription-core";

export function registerClaudeSubscriptionOAuthRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  async function scope(
    c: Context,
    organization: boolean,
    fresh = false,
  ): Promise<ClaudeOAuthScope> {
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
    const grant = await (fresh ? requireFreshAccessGrant : requireAccessGrant)(
      c,
      deps,
      id.data,
      "connections:write",
    );
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
  /**
   * Require the Claude cutover receipt at start and completion alike.
   */
  async function oauthCore(c: Context, inputScope: ClaudeOAuthScope) {
    await claudeCoreRoute(deps, async () => inputScope.accountId);
    return { connectedBySubjectId: (await managedCookieHuman(c, deps))?.subjectId ?? null };
  }
  for (const organization of [false, true]) {
    const path = organization
      ? "/v1/organizations/:organizationId/model-providers/claude_subscription/oauth"
      : "/v1/workspaces/:workspaceId/model-providers/claude_subscription/oauth";
    app.post(`${path}/start`, async (c) => {
      const inputScope = await scope(c, organization);
      const payload = ClaudeSubscriptionOAuthStartRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!payload.success || (organization && payload.data.scope !== "workspace"))
        throw new HTTPException(422, { message: "Choose where to connect this Claude account." });
      // The runtime first: on the core a private account is authorized in
      // the owner's Personal workspace and refused (403) anywhere else,
      // before any Claude sign-in.
      const core = await oauthCore(c, inputScope);
      if (payload.data.scope === "user")
        await requireClaudeCorePersonalWorkspace(deps, {
          accountId: inputScope.accountId,
          workspaceId: inputScope.workspaceId,
          subjectId: inputScope.actorSubjectId,
        });
      if (!organization)
        await requireSubscriptionScopeMutation(
          c,
          deps,
          inputScope.workspaceId!,
          payload.data.scope,
          "Claude",
          "personal_workspace",
        );
      return c.json(await startClaudeSubscriptionOAuth(deps, inputScope, payload.data, core));
    });
    app.post(`${path}/complete`, async (c) => {
      const inputScope = await scope(c, organization);
      const payload = ClaudeSubscriptionOAuthCompleteRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!payload.success)
        throw new HTTPException(422, {
          message: "Enter the authorization code from Claude.",
        });
      const core = await oauthCore(c, inputScope);
      return c.json(
        await completeClaudeSubscriptionOAuth(
          deps,
          inputScope,
          payload.data,
          async (poolScope) => {
            if (!organization)
              await requireSubscriptionScopeMutation(
                c,
                deps,
                inputScope.workspaceId!,
                poolScope ?? "workspace",
                "Claude",
                "personal_workspace",
              );
            const fresh = await scope(c, organization, true);
            if (
              fresh.accountId !== inputScope.accountId ||
              fresh.actorSubjectId !== inputScope.actorSubjectId ||
              fresh.browserSessionHash !== inputScope.browserSessionHash
            )
              throw new HTTPException(403, {
                message: "Your access changed during Claude sign-in. Start again.",
              });
          },
          fetchImpl,
          core,
        ),
      );
    });
  }
}
