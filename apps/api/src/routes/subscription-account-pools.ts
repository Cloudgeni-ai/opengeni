import type {
  listOrganizationXaiSubscriptions,
  updateOrganizationXaiSubscription,
  updateOrganizationXaiRotation,
  listXaiSubscriptionAccountsMetadata,
  getXaiRotationSettings,
  ensureXaiRotationSettings,
  getXaiSubscriptionAccountAuthoritySnapshot,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  setActiveXaiCredential,
  updateXaiRotationSettings,
  updateXaiAllocatorEligibility,
  renameXaiSubscriptionAccount,
  disconnectXaiSubscriptionCredentialAndRepick,
  wakeXaiCapacityWaiters,
  XaiSubscriptionAccountMetadata,
} from "@opengeni/db";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod/v4";
import { requireOrganizationCodexHuman } from "./codex";
import {
  requirePrivateSubscriptionHuman,
  requireSameOriginBrowserMutation,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";
const allocatorBody = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});
const settingsBody = z.object({ rotationEnabled: z.boolean() });
const renameBody = z.object({ label: z.string().trim().max(200).nullable() });

type PoolRepository = {
  listOrganizationSubscriptions: typeof listOrganizationXaiSubscriptions;
  updateOrganizationSubscription: typeof updateOrganizationXaiSubscription;
  updateOrganizationSubscriptionRotation: typeof updateOrganizationXaiRotation;
  listSubscriptionAccountsMetadata: typeof listXaiSubscriptionAccountsMetadata;
  getSubscriptionRotationSettings: typeof getXaiRotationSettings;
  ensureSubscriptionRotationSettings: typeof ensureXaiRotationSettings;
  getSubscriptionAccountAuthoritySnapshot: typeof getXaiSubscriptionAccountAuthoritySnapshot;
  resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance: typeof resolveXaiProviderAccountAuthoritySnapshotForAcceptance;
  setActiveSubscriptionCredential: typeof setActiveXaiCredential;
  updateSubscriptionRotationSettings: typeof updateXaiRotationSettings;
  updateSubscriptionAllocatorEligibility: typeof updateXaiAllocatorEligibility;
  renameSubscriptionAccount: typeof renameXaiSubscriptionAccount;
  disconnectSubscriptionCredentialAndRepick: typeof disconnectXaiSubscriptionCredentialAndRepick;
  wakeSubscriptionCapacityWaiters: typeof wakeXaiCapacityWaiters;
};

/** Account CRUD uses one authority, allocator and wake contract for every pool. */
export function registerSubscriptionAccountPoolRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: {
    provider: "xai" | "claude";
    route: "supergrok" | "claude";
    displayName: "SuperGrok" | "Claude";
    enabled: () => boolean;
    repository: PoolRepository;
    accountJson: (
      account: XaiSubscriptionAccountMetadata,
      activeId: string | null,
    ) => Record<string, unknown>;
    projectAccounts?: (
      accounts: XaiSubscriptionAccountMetadata[],
      activeId: string | null,
      authority: { accountId: string; workspaceId: string | null; subjectId: string },
    ) => Promise<Record<string, unknown>[]>;
  },
) {
  const { db } = deps;
  const {
    listOrganizationSubscriptions,
    updateOrganizationSubscription,
    updateOrganizationSubscriptionRotation,
    listSubscriptionAccountsMetadata,
    getSubscriptionRotationSettings,
    ensureSubscriptionRotationSettings,
    getSubscriptionAccountAuthoritySnapshot,
    resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance,
    setActiveSubscriptionCredential,
    updateSubscriptionRotationSettings,
    updateSubscriptionAllocatorEligibility,
    renameSubscriptionAccount,
    disconnectSubscriptionCredentialAndRepick,
    wakeSubscriptionCapacityWaiters,
  } = options.repository;
  const workspacePath = `/v1/workspaces/:workspaceId/${options.route}`;
  const organizationPath = `/v1/organizations/:organizationId/${options.route}`;
  const requireEnabled = () => {
    if (!options.enabled())
      throw new HTTPException(404, {
        message: options.displayName + " subscriptions are not enabled",
      });
  };
  const organizationActor = async (c: Context, mutation = false) => {
    requireEnabled();
    if (mutation) requireSameOriginBrowserMutation(c, deps);
    const organizationId = c.req.param("organizationId")!;
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    return { organizationId, actorSubjectId: human.subjectId };
  };
  const resolveReadAuthority = async (c: Context, _deps: ApiRouteDeps, workspaceId: string) => {
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const snapshot = await resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance(db, {
      workspaceId,
      subjectId: grant.subjectId,
    });
    if (snapshot.scope === "user") {
      const human = await requirePrivateSubscriptionHuman(
        c,
        deps,
        workspaceId,
        options.displayName,
      );
      if (human.subjectId !== grant.subjectId)
        throw new HTTPException(403, { message: "managed browser identity mismatch" });
    }
    return { accountId: grant.accountId, subjectId: grant.subjectId, snapshot };
  };
  const authorityForAccountMutation = async (
    c: Context,
    _deps: ApiRouteDeps,
    workspaceId: string,
    credentialId: string,
  ) => {
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const snapshot = await getSubscriptionAccountAuthoritySnapshot(db, {
      workspaceId,
      subjectId: grant.subjectId,
      credentialId,
    });
    if (!snapshot)
      throw new HTTPException(404, { message: options.displayName + " account not found" });
    const authority = await requireSubscriptionScopeMutation(
      c,
      deps,
      workspaceId,
      snapshot.scope,
      options.displayName,
    );
    return { ...authority, snapshot };
  };
  app.get(`${organizationPath}/accounts`, async (c) => {
    const actor = await organizationActor(c);
    const { accounts, rotation } = await listOrganizationSubscriptions(db, actor);
    const activeAccountId = rotation?.activeCredentialId ?? null;
    return c.json({
      accounts: options.projectAccounts
        ? await options.projectAccounts(accounts, activeAccountId, {
            accountId: actor.organizationId,
            workspaceId: null,
            subjectId: actor.actorSubjectId,
          })
        : accounts.map((account) => options.accountJson(account, activeAccountId)),
      activeAccountId,
      source: "organization",
      organizationId: actor.organizationId,
      settings: {
        rotationEnabled: rotation?.rotationEnabled ?? false,
        rotationStrategy: "sharded",
        activeCredentialId: activeAccountId,
      },
    });
  });
  app.patch(`${organizationPath}/settings`, async (c) => {
    const actor = await organizationActor(c, true);
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "rotationEnabled is required" });
    const rotation = await updateOrganizationSubscriptionRotation(db, { ...actor, ...parsed.data });
    return c.json({
      rotationEnabled: rotation.rotationEnabled,
      rotationStrategy: "sharded",
      activeCredentialId: rotation.activeCredentialId,
    });
  });
  const updateOrganizationAccount = async (
    c: Context,
    changes: Omit<
      Parameters<typeof updateOrganizationSubscription>[1],
      "organizationId" | "actorSubjectId" | "credentialId"
    >,
  ) => {
    const actor = await organizationActor(c, true);
    try {
      const result = await updateOrganizationSubscription(db, {
        ...actor,
        credentialId: c.req.param("accountId")!,
        ...changes,
      });
      if (!result)
        throw new HTTPException(404, { message: `${options.displayName} account not found` });
      return c.json(result);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(409, {
        message:
          error instanceof Error
            ? error.message
            : `${options.displayName} subscription could not be updated`,
      });
    }
  };
  app.post(`${organizationPath}/accounts/:accountId/activate`, (c) =>
    updateOrganizationAccount(c, { activate: true }),
  );
  app.delete(`${organizationPath}/accounts/:accountId`, (c) =>
    updateOrganizationAccount(c, { disconnect: true }),
  );
  app.patch(`${organizationPath}/accounts/:accountId`, async (c) => {
    const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "label is invalid" });
    return updateOrganizationAccount(c, { label: parsed.data.label || null });
  });
  app.patch(`${organizationPath}/accounts/:accountId/allocator`, async (c) => {
    const parsed = allocatorBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new HTTPException(400, { message: "enabled and expectedVersion are required" });
    return updateOrganizationAccount(c, {
      allocatorEnabled: parsed.data.enabled,
      expectedAllocatorVersion: parsed.data.expectedVersion,
    });
  });

  app.get(`${workspacePath}/accounts`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const authority = await resolveReadAuthority(c, deps, workspaceId);
    const [accounts, settings] = await Promise.all([
      listSubscriptionAccountsMetadata(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
      }),
      getSubscriptionRotationSettings(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
      }),
    ]);
    const activeCredentialId = settings?.activeCredentialId ?? null;
    return c.json({
      source: authority.snapshot.scope,
      organizationId: authority.accountId,
      accounts: options.projectAccounts
        ? await options.projectAccounts(
            accounts.filter((account) =>
              authority.snapshot.scope === "organization"
                ? account.scope === "organization"
                : account.scope !== "organization",
            ),
            activeCredentialId,
            { accountId: authority.accountId, workspaceId, subjectId: authority.subjectId },
          )
        : accounts
            .filter((account) =>
              authority.snapshot.scope === "organization"
                ? account.scope === "organization"
                : account.scope !== "organization",
            )
            .map((account) => options.accountJson(account, activeCredentialId)),
      activeAccountId: activeCredentialId,
      settings: {
        rotationEnabled: settings?.rotationEnabled ?? true,
        rotationStrategy: "sharded" as const,
        activeCredentialId,
      },
    });
  });

  app.post(`${workspacePath}/accounts/:accountId/activate`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    const activated = await setActiveSubscriptionCredential(deps.db, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: authority.snapshot,
      credentialId,
    });
    if (!activated)
      throw new HTTPException(409, {
        message: `${options.displayName} account requires reconnect`,
      });
    await wakeSubscriptionCapacityWaiters(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: authority.snapshot,
      reason: `${options.provider}_active_credential_changed`,
    });
    return c.json({ activated: true, accountId: credentialId });
  });

  app.patch(`${workspacePath}/settings`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "rotationEnabled is required" });
    const readAuthority = await resolveReadAuthority(c, deps, workspaceId);
    const authority = await requireSubscriptionScopeMutation(
      c,
      deps,
      workspaceId,
      readAuthority.snapshot.scope,
      options.displayName,
    );
    const current = await ensureSubscriptionRotationSettings(deps.db, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: readAuthority.snapshot,
    });
    const updated = await updateSubscriptionRotationSettings(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: readAuthority.snapshot,
      expectedVersion: current.version,
      rotationEnabled: parsed.data.rotationEnabled,
    }).catch(() => null);
    if (!updated)
      throw new HTTPException(409, { message: `${options.displayName} settings changed` });
    await wakeSubscriptionCapacityWaiters(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: readAuthority.snapshot,
      reason: `${options.provider}_rotation_settings_changed`,
    });
    return c.json({
      rotationEnabled: updated.rotationEnabled,
      rotationStrategy: "sharded" as const,
      activeCredentialId: updated.activeCredentialId,
    });
  });

  app.patch(`${workspacePath}/accounts/:accountId/allocator`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    const parsed = allocatorBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "enabled and expectedVersion are required",
      });
    }
    const result = await updateSubscriptionAllocatorEligibility(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      credentialId,
      enabled: parsed.data.enabled,
      expectedVersion: parsed.data.expectedVersion,
    });
    if (result.kind === "not_found") {
      throw new HTTPException(404, {
        message: `${options.displayName} account not found`,
      });
    }
    const response = {
      allocatorEnabled: result.allocatorEnabled,
      allocatorVersion: result.allocatorVersion,
      allocatorUpdatedAt: result.allocatorUpdatedAt?.toISOString() ?? null,
      changed: result.kind === "updated",
    };
    if (result.kind === "updated") {
      await wakeSubscriptionCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
        reason: `${options.provider}_allocator_eligibility_changed`,
      });
    }
    return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
  });

  app.patch(`${workspacePath}/accounts/:accountId`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "label is invalid" });
    const account = await renameSubscriptionAccount(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      credentialId,
      label: parsed.data.label || null,
    });
    if (!account)
      throw new HTTPException(404, {
        message: `${options.displayName} account not found`,
      });
    const settings = await getSubscriptionRotationSettings(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: authority.snapshot,
    });
    return c.json(options.accountJson(account, settings?.activeCredentialId ?? null));
  });

  app.delete(`${workspacePath}/accounts/:accountId`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    if (authority.snapshot.scope === "user") {
      await wakeSubscriptionCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
        reason: `${options.provider}_credential_disconnecting`,
      });
    }
    const result = await disconnectSubscriptionCredentialAndRepick(deps.db, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: authority.subjectId,
      credentialId,
      authoritySnapshot: authority.snapshot,
    });
    if (result.disconnected && authority.snapshot.scope === "workspace") {
      await wakeSubscriptionCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: { version: 1, scope: "workspace" },
        reason: `${options.provider}_credential_disconnected`,
      });
    }
    return c.json({
      disconnected: result.disconnected,
      newActiveId: result.newActiveCredentialId,
    });
  });
}
