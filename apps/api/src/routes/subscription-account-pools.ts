import type { XaiSubscriptionAccountMetadata } from "@opengeni/db";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  SubscriptionAccountRenameRequest,
  SubscriptionAccountToggleRequest,
  SubscriptionRotationSettingsRequest,
} from "@opengeni/contracts";
import { requireOrganizationCodexHuman } from "./codex";
import { requireSameOriginBrowserMutation } from "./subscription-pool-access";
import {
  coreOrganizationAccount,
  coreOrganizationAccounts,
  coreOrganizationSettings,
  coreWorkspaceAccounts,
  coreWorkspaceActivate,
  coreWorkspaceAllocator,
  coreWorkspaceDisconnect,
  coreWorkspaceRename,
  coreWorkspaceSettings,
  requireSubscriptionCoreRoute,
  type SubscriptionPoolCore,
} from "./subscription-pool-core";
const allocatorBody = SubscriptionAccountToggleRequest;
const settingsBody = SubscriptionRotationSettingsRequest;
const renameBody = SubscriptionAccountRenameRequest;

/** The legacy pool repository; only Claude still has one (until its own cutover). */

/** The legacy pool account shape SuperGrok and Claude share (SuperGrok's metadata defines it). */
export type SubscriptionPoolAccount = XaiSubscriptionAccountMetadata;
/**
 * The repository of a provider whose legacy runtime was deleted after its
 * cutover: its routes serve only the core (`requireSubscriptionCoreRoute`
 * refuses any other route first), so no legacy handler can reach these.
 */

/** Account CRUD uses one authority, allocator and wake contract for every pool. */
export function registerSubscriptionAccountPoolRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: {
    provider: "xai" | "claude";
    route: "supergrok" | "claude";
    displayName: "SuperGrok" | "Claude";
    enabled: () => boolean;
    accountJson: (
      account: XaiSubscriptionAccountMetadata,
      activeId: string | null,
    ) => Record<string, unknown>;
    core: SubscriptionPoolCore;
  },
) {
  const core = options.core;
  const coreContext = {
    deps,
    core,
    displayName: options.displayName,
    accountJson: options.accountJson,
    listedAccountJson: core.listedAccountJson ?? options.accountJson,
  };
  /**
   * The pool's runtime for this organization: `legacy` without a core
   * binding; a core-only pool (no legacy repository) serves only `core`.
   */
  const route = (accountId: () => Promise<string>) =>
    requireSubscriptionCoreRoute(deps, options.provider, options.displayName, accountId);
  const workspaceRoute = (c: Context, workspaceId: string) =>
    route(async () => (await requireAccessGrant(c, deps, workspaceId, "workspace:read")).accountId);
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

  app.get(`${organizationPath}/accounts`, async (c) => {
    const actor = await organizationActor(c);
    await route(async () => actor.organizationId);
    return await coreOrganizationAccounts(c, coreContext!, actor);
  });
  app.patch(`${organizationPath}/settings`, async (c) => {
    const actor = await organizationActor(c, true);
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "rotationEnabled is required" });
    await route(async () => actor.organizationId);
    return await coreOrganizationSettings(c, coreContext!, actor, parsed.data.rotationEnabled);
  });
  const updateOrganizationAccount = async (
    c: Context,
    changes: {
      activate?: boolean;
      disconnect?: boolean;
      label?: string | null;
      allocatorEnabled?: boolean;
      expectedAllocatorVersion?: number;
    },
  ) => {
    const actor = await organizationActor(c, true);
    await route(async () => actor.organizationId);
    return await coreOrganizationAccount(
      c,
      coreContext!,
      actor,
      c.req.param("accountId")!,
      changes.activate
        ? { activate: true }
        : changes.disconnect
          ? { disconnect: true }
          : changes.label !== undefined
            ? { label: changes.label }
            : {
                allocatorEnabled: changes.allocatorEnabled!,
                expectedAllocatorVersion: changes.expectedAllocatorVersion!,
              },
    );
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
    await workspaceRoute(c, workspaceId);
    return await coreWorkspaceAccounts(c, coreContext!, workspaceId);
  });

  app.post(`${workspacePath}/accounts/:accountId/activate`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    await workspaceRoute(c, workspaceId);
    return await coreWorkspaceActivate(c, coreContext!, workspaceId, credentialId);
  });

  app.patch(`${workspacePath}/settings`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "rotationEnabled is required" });
    await workspaceRoute(c, workspaceId);
    return await coreWorkspaceSettings(c, coreContext!, workspaceId, parsed.data.rotationEnabled);
  });

  app.patch(`${workspacePath}/accounts/:accountId/allocator`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    await workspaceRoute(c, workspaceId);

    const parsed = allocatorBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new HTTPException(400, { message: "enabled and expectedVersion are required" });
    return await coreWorkspaceAllocator(c, coreContext!, workspaceId, credentialId, parsed.data);
  });

  app.patch(`${workspacePath}/accounts/:accountId`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    await workspaceRoute(c, workspaceId);

    const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "label is invalid" });
    return await coreWorkspaceRename(
      c,
      coreContext!,
      workspaceId,
      credentialId,
      parsed.data.label || null,
    );
  });

  app.delete(`${workspacePath}/accounts/:accountId`, async (c) => {
    requireEnabled();
    const workspaceId = c.req.param("workspaceId")!;
    const credentialId = c.req.param("accountId")!;
    await workspaceRoute(c, workspaceId);
    return await coreWorkspaceDisconnect(c, coreContext!, workspaceId, credentialId);
  });
}
