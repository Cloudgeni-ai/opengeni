import { claudeAccountMutationFailure } from "../claude-subscription-account-conflicts";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { requireEnvironmentEncryption } from "@opengeni/core";
import { ClaudeSubscriptionCredential } from "@opengeni/config";
import {
  upsertClaudeSubscriptionAccount,
  upsertOrganizationClaudeSubscription,
  setInitialActiveClaudeCredential,
} from "@opengeni/db";
import { prepareClaudeSubscriptionCredential } from "../claude-workspace-connection";
import { requireAccessGrant } from "@opengeni/core";
import { ClaudeSubscriptionUsage, ClaudeSubscriptionSetupTokenRequest } from "@opengeni/contracts";
import {
  getClaudeSubscriptionAccountMetadata,
  listClaudeAccountUsage,
  type ClaudeAccountUsageAuthority,
} from "@opengeni/db";
import { requireOrganizationCodexHuman } from "./codex";
import {
  requireSameOriginBrowserMutation,
  requirePrivateSubscriptionHuman,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";
import { refreshClaudeAccountUsage } from "../claude-subscription-account-usage";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import {
  listOrganizationClaudeSubscriptions,
  updateOrganizationClaudeSubscription,
  updateOrganizationClaudeRotation,
  listClaudeSubscriptionAccountsMetadata,
  getClaudeRotationSettings,
  ensureClaudeRotationSettings,
  getClaudeSubscriptionAccountAuthoritySnapshot,
  resolveClaudeProviderAccountAuthoritySnapshotForAcceptance,
  setActiveClaudeCredential,
  updateClaudeRotationSettings,
  updateClaudeAllocatorEligibility,
  renameClaudeSubscriptionAccount,
  disconnectClaudeSubscriptionAccountAndRepick,
  wakeClaudeCapacityWaiters,
  type ClaudeSubscriptionAccountMetadata,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { registerSubscriptionAccountPoolRoutes } from "./subscription-account-pools";

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

export function registerClaudeSubscriptionAccountRoutes(app: Hono, deps: ApiRouteDeps) {
  registerSubscriptionAccountPoolRoutes(app, deps, {
    provider: "claude",
    route: "claude",
    displayName: "Claude",
    enabled: () => deps.settings.claudeSubscriptionEnabled,
    accountJson,
    projectAccounts: async (accounts, activeId, authority) => {
      const usage = await listClaudeAccountUsage(deps.db, authority, accounts);
      return accounts.map((account) => {
        const snapshot = usage.get(account.id);
        return {
          ...accountJson(account, activeId),
          ...(snapshot ? { usage: snapshot } : {}),
          ...(snapshot?.refreshStatus === "reconnect"
            ? { status: "needs_relogin", lastError: "Sign in to Claude again." }
            : {}),
        };
      });
    },
    repository: {
      listOrganizationSubscriptions: listOrganizationClaudeSubscriptions,
      updateOrganizationSubscription: updateOrganizationClaudeSubscription,
      updateOrganizationSubscriptionRotation: updateOrganizationClaudeRotation,
      listSubscriptionAccountsMetadata: listClaudeSubscriptionAccountsMetadata,
      getSubscriptionRotationSettings: getClaudeRotationSettings,
      ensureSubscriptionRotationSettings: ensureClaudeRotationSettings,
      getSubscriptionAccountAuthoritySnapshot: getClaudeSubscriptionAccountAuthoritySnapshot,
      resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance:
        resolveClaudeProviderAccountAuthoritySnapshotForAcceptance,
      setActiveSubscriptionCredential: setActiveClaudeCredential,
      updateSubscriptionRotationSettings: updateClaudeRotationSettings,
      updateSubscriptionAllocatorEligibility: updateClaudeAllocatorEligibility,
      renameSubscriptionAccount: renameClaudeSubscriptionAccount,
      disconnectSubscriptionCredentialAndRepick: disconnectClaudeSubscriptionAccountAndRepick,
      wakeSubscriptionCapacityWaiters: wakeClaudeCapacityWaiters,
    },
  });
  async function usageAuthority(
    c: Context,
    organization: boolean,
    mutation: boolean,
  ): Promise<ClaudeAccountUsageAuthority> {
    c.header("cache-control", "private, no-store");
    if (!deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    const credentialId = z.string().uuid().safeParse(c.req.param("accountId"));
    if (!credentialId.success)
      throw new HTTPException(400, { message: "Invalid Claude account ID" });
    const id = credentialId.data;
    if (mutation && !c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
    if (organization) {
      const organizationId = c.req.param("organizationId")!;
      const human = await requireOrganizationCodexHuman(c, deps, organizationId);
      const { accounts } = await listOrganizationClaudeSubscriptions(deps.db, {
        organizationId,
        actorSubjectId: human.subjectId,
      });
      if (!accounts.some((account) => account.id === id))
        throw new HTTPException(404, { message: "Claude account not found" });
      return {
        accountId: organizationId,
        workspaceId: null,
        subjectId: human.subjectId,
        credentialId: id,
        authoritySnapshot: { version: 1, scope: "organization" },
      };
    }
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const authoritySnapshot = await getClaudeSubscriptionAccountAuthoritySnapshot(deps.db, {
      workspaceId,
      subjectId: grant.subjectId,
      credentialId: id,
    });
    if (!authoritySnapshot) throw new HTTPException(404, { message: "Claude account not found" });
    if (authoritySnapshot.scope === "user")
      await requirePrivateSubscriptionHuman(c, deps, workspaceId, "Claude");
    if (mutation)
      await requireSubscriptionScopeMutation(
        c,
        deps,
        workspaceId,
        authoritySnapshot.scope,
        "Claude",
      );
    return {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      credentialId: id,
      authoritySnapshot,
    };
  }
  for (const organization of [false, true]) {
    const path = organization
      ? "/v1/organizations/:organizationId/claude/accounts/:accountId/usage"
      : "/v1/workspaces/:workspaceId/claude/accounts/:accountId/usage";
    app.get(path, async (c) => {
      const authority = await usageAuthority(c, organization, false);
      const accounts = authority.workspaceId
        ? [
            await getClaudeSubscriptionAccountMetadata(deps.db, {
              workspaceId: authority.workspaceId,
              subjectId: authority.subjectId,
              credentialId: authority.credentialId,
            }),
          ].filter((value): value is ClaudeSubscriptionAccountMetadata => !!value)
        : (
            await listOrganizationClaudeSubscriptions(deps.db, {
              organizationId: authority.accountId,
              actorSubjectId: authority.subjectId,
            })
          ).accounts.filter((account) => account.id === authority.credentialId);
      const usage = (await listClaudeAccountUsage(deps.db, authority, accounts)).get(
        authority.credentialId,
      );
      if (!usage) throw new HTTPException(404, { message: "Claude account not found" });
      return c.json(ClaudeSubscriptionUsage.parse(usage));
    });
    app.post(path + "/refresh", async (c) =>
      c.json(
        ClaudeSubscriptionUsage.parse(
          await refreshClaudeAccountUsage(
            deps.db,
            deps.settings,
            await usageAuthority(c, organization, true),
          ),
        ),
      ),
    );
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
      const workspaceId = organization ? null : c.req.param("workspaceId")!;
      const authority = workspaceId
        ? await requireSubscriptionScopeMutation(c, deps, workspaceId, parsed.data.scope, "Claude")
        : null;
      const accountId = actor?.organizationId ?? authority!.accountId;
      const subjectId = actor?.subjectId ?? authority!.subjectId;
      const encryptionKey = requireEnvironmentEncryption(deps.settings);
      const reconnectId = parsed.data.reconnectAccountId;
      const reconnectAccount = !reconnectId
        ? null
        : workspaceId
          ? await getClaudeSubscriptionAccountMetadata(deps.db, {
              workspaceId,
              subjectId,
              credentialId: reconnectId,
            })
          : ((
              await listOrganizationClaudeSubscriptions(deps.db, {
                organizationId: accountId,
                actorSubjectId: subjectId,
              })
            ).accounts.find((account) => account.id === reconnectId) ?? null);
      const reconnectAuthority =
        reconnectId && workspaceId
          ? await getClaudeSubscriptionAccountAuthoritySnapshot(deps.db, {
              workspaceId,
              subjectId,
              credentialId: reconnectId,
            })
          : null;
      if (
        reconnectId &&
        (!reconnectAccount ||
          reconnectAccount.version !== parsed.data.expectedCredentialVersion ||
          reconnectAccount.scope !== (organization ? "organization" : parsed.data.scope) ||
          (workspaceId && !reconnectAuthority))
      )
        throw new HTTPException(409, {
          message: "Claude account changed. Reload it before replacing the token.",
        });
      const secret = ClaudeSubscriptionCredential.parse(
        JSON.parse(
          prepareClaudeSubscriptionCredential(
            deps.settings,
            workspaceId ? "workspace:" + workspaceId : "organization:" + accountId,
            parsed.data.token,
          ),
        ),
      );
      const providerAccountId =
        "setup:" + createHmac("sha256", encryptionKey).update(parsed.data.token).digest("hex");
      const details = {
        secret,
        encryptionKey,
        providerAccountId,
        label: reconnectAccount?.label ?? parsed.data.label ?? "Claude subscription",
        accountEmail: null,
        planType: null,
        expiresAt: null,
      };
      const saved = await (
        workspaceId
          ? upsertClaudeSubscriptionAccount(deps.db, {
              ...details,
              accountId,
              workspaceId,
              subjectId,
              scope: parsed.data.scope,
              ...(reconnectAccount && reconnectAuthority
                ? {
                    credentialId: reconnectAccount.id,
                    expectedCredentialVersion: reconnectAccount.version,
                    expectedProviderAccountId: reconnectAccount.providerAccountId,
                    authoritySnapshot: reconnectAuthority,
                  }
                : {}),
            })
          : upsertOrganizationClaudeSubscription(deps.db, {
              ...details,
              organizationId: accountId,
              actorSubjectId: subjectId,
              ...(reconnectAccount
                ? {
                    credentialId: reconnectAccount.id,
                    expectedCredentialVersion: reconnectAccount.version,
                    expectedProviderAccountId: reconnectAccount.providerAccountId,
                  }
                : {}),
            })
      ).catch(claudeAccountMutationFailure);
      if (workspaceId && "authoritySnapshot" in saved) {
        await setInitialActiveClaudeCredential(deps.db, {
          accountId,
          workspaceId,
          subjectId,
          credentialId: saved.account.id,
          authoritySnapshot: saved.authoritySnapshot,
        });
        await wakeClaudeCapacityWaiters(deps.db, {
          workspaceId,
          subjectId,
          authoritySnapshot: saved.authoritySnapshot,
          reason: "claude_setup_account_connected",
        });
      }
      return c.json({
        connected: true,
        accountId: saved.account.id,
        credentialVersion: saved.account.version,
        scope: workspaceId ? parsed.data.scope : "organization",
      });
    });
  }
}
