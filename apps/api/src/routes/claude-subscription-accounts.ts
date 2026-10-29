import { createHmac } from "node:crypto";
import { z } from "zod";
import { requireEnvironmentEncryption } from "@opengeni/core";
import { ClaudeSubscriptionCredential } from "@opengeni/config";
import type { ClaudeSubscriptionAccountMetadata } from "@opengeni/db";

import { prepareClaudeSubscriptionCredential } from "../claude-workspace-connection";
import { requireAccessGrant } from "@opengeni/core";
import { ClaudeSubscriptionUsage, ClaudeSubscriptionSetupTokenRequest } from "@opengeni/contracts";

import { requireOrganizationCodexHuman } from "./codex";
import { requireSubscriptionScopeMutation } from "./subscription-pool-access";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";

import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

import type { ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { offerClaudeDefaultModels } from "../claude-default-models";
import { registerSubscriptionAccountPoolRoutes } from "./subscription-account-pools";
import { coreClaudeUsage, type CoreClaudeUsageCaller } from "./claude-core-usage";
import {
  claudeCoreAccount,
  claudePoolCore,
  connectClaudeCore,
  requireClaudeCorePersonalWorkspace,
} from "../claude-subscription-core";
import { deliverPoolCoreWake } from "./subscription-pool-core";
import { managedCookieHuman } from "./subscription-pool-access";

function accountJson(account: ClaudeSubscriptionAccountMetadata, activeId: string | null) {
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

const CLAUDE_CORE = claudePoolCore(accountJson);
const SETUP_TOKEN_CHANGED = "Claude account changed. Reload it before replacing the token.";

export function registerClaudeSubscriptionAccountRoutes(app: Hono, deps: ApiRouteDeps) {
  registerSubscriptionAccountPoolRoutes(app, deps, {
    provider: "claude",
    route: "claude",
    displayName: "Claude",
    enabled: () => deps.settings.claudeSubscriptionEnabled,
    accountJson,
    core: CLAUDE_CORE,
  });
  async function usageAuthority(
    c: Context,
    organization: boolean,
    mutation: boolean,
  ): Promise<CoreClaudeUsageCaller> {
    c.header("cache-control", "private, no-store");
    if (!deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    const credentialId = z.string().uuid().safeParse(c.req.param("accountId"));
    if (!credentialId.success)
      throw new HTTPException(400, { message: "Invalid Claude account ID" });
    if (mutation && !c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
    if (organization) {
      const accountId = c.req.param("organizationId")!;
      const human = await requireOrganizationCodexHuman(c, deps, accountId);
      return {
        core: true,
        accountId,
        workspaceId: null,
        subjectId: human.subjectId,
        accountIdParam: credentialId.data,
      };
    }
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return {
      core: true,
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      accountIdParam: credentialId.data,
    };
  }
  for (const organization of [false, true]) {
    const path = organization
      ? "/v1/organizations/:organizationId/claude/accounts/:accountId/usage"
      : "/v1/workspaces/:workspaceId/claude/accounts/:accountId/usage";
    app.get(path, async (c) => {
      const authority = await usageAuthority(c, organization, false);
      return c.json(
        ClaudeSubscriptionUsage.parse(await coreClaudeUsage(c, deps, authority, false)),
      );
    });
    app.post(path + "/refresh", async (c) => {
      const authority = await usageAuthority(c, organization, true);
      return c.json(ClaudeSubscriptionUsage.parse(await coreClaudeUsage(c, deps, authority, true)));
    });
  }

  const setupRequest = ClaudeSubscriptionSetupTokenRequest;
  for (const organization of [false, true]) {
    const path = organization
      ? "/v1/organizations/:organizationId/claude/accounts/setup-token"
      : "/v1/workspaces/:workspaceId/claude/accounts/setup-token";
    app.post(path, async (c) => {
      c.header("cache-control", "private, no-store");
      if (!deps.settings.claudeSubscriptionEnabled)
        throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
      requireSameOriginBrowserMutation(c, deps);
      const parsed = setupRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success || (organization && parsed.data.scope !== "workspace"))
        throw new HTTPException(422, { message: "Enter the Claude setup token." });
      const actor = organization
        ? {
            organizationId: c.req.param("organizationId")!,
            ...(await requireOrganizationCodexHuman(c, deps, c.req.param("organizationId")!)),
          }
        : null;
      const requestWorkspaceId = organization ? null : c.req.param("workspaceId")!;
      // A private account lives on the core in its owner's Personal
      // workspace; the person connects it from any workspace of the
      // organization, and it is written there.
      const read: { grant?: Awaited<ReturnType<typeof requireAccessGrant>> } = {};
      if (!actor)
        read.grant = await requireAccessGrant(c, deps, requestWorkspaceId!, "workspace:read");
      if (requestWorkspaceId && parsed.data.scope === "user") {
        if (!read.grant) throw new Error("core Claude route without its read grant");
        await requireClaudeCorePersonalWorkspace(deps, {
          accountId: read.grant.accountId,
          subjectId: read.grant.subjectId,
        });
      }
      const authority = requestWorkspaceId
        ? await requireSubscriptionScopeMutation(
            c,
            deps,
            requestWorkspaceId,
            parsed.data.scope,
            "Claude",
            "own_personal_workspace",
          )
        : null;
      // Where the account lives: this workspace, or the owner's Personal workspace.
      const workspaceId = authority?.workspaceId ?? null;
      const accountId = actor?.organizationId ?? authority!.accountId;
      const subjectId = actor?.subjectId ?? authority!.subjectId;
      const encryptionKey = requireEnvironmentEncryption(deps.settings);
      const reconnectId = parsed.data.reconnectAccountId;

      const scope = workspaceId ? parsed.data.scope : "organization";
      const personal = scope === "user";
      const target = reconnectId
        ? await claudeCoreAccount(deps, { accountId, workspaceId, subjectId }, reconnectId)
        : null;
      if (
        reconnectId &&
        (!target ||
          target.version !== parsed.data.expectedCredentialVersion ||
          target.scope !== scope)
      )
        throw new HTTPException(409, { message: SETUP_TOKEN_CHANGED });
      const connected = await connectClaudeCore(
        deps.db,
        {
          accountId,
          workspaceId,
          subjectId,
          ...(personal ? { personal: true } : {}),
          encryptionKey,
          credential: ClaudeSubscriptionCredential.parse(
            JSON.parse(
              prepareClaudeSubscriptionCredential(
                deps.settings,
                workspaceId ? "workspace:" + workspaceId : "organization:" + accountId,
                parsed.data.token,
              ),
            ),
          ),
          providerAccountId:
            "setup:" + createHmac("sha256", encryptionKey).update(parsed.data.token).digest("hex"),
          accountEmail: null,
          planType: null,
          label: target?.label ?? parsed.data.label ?? "Claude subscription",
          connectedBySubjectId: (await managedCookieHuman(c, deps))?.subjectId ?? null,
          ...(target
            ? {
                reconnectTarget: {
                  connectionId: target.id,
                  expectedVersion: target.version,
                  providerAccountId: target.providerAccountId,
                },
              }
            : {}),
        },
        SETUP_TOKEN_CHANGED,
      );
      await deliverPoolCoreWake(deps, CLAUDE_CORE, connected.wake);
      await offerClaudeDefaultModels(deps, {
        ...(workspaceId ? { accountId, workspaceId } : { organizationId: accountId }),
        actorSubjectId: subjectId,
        providerKind: "claude_subscription",
      });
      return c.json({
        connected: true,
        accountId: connected.id,
        credentialVersion: connected.version,
        scope,
      });
    });
  }
}
