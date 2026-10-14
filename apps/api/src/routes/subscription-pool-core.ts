// Subscription account-pool routes served from the shared subscription core
// once a provider cut over (design docs/design/subscription-core-2026-10-07.md,
// 5.3 "SuperGrok track", X2b). Provider-neutral: a provider passes its
// binding and its projection of core rows into its legacy account shape; the
// Claude track reuses this with its own.
//
// Every pool route reads `subscriptionCoreRoute` first. Without the
// provider's cutover receipt it is `legacy` after one read and the legacy
// handler runs unchanged (a provider whose legacy runtime was deleted uses
// `requireSubscriptionCoreRoute`, which fails closed there instead);
// `maintenance` fails closed with a typed 503; `core`
// runs the handlers below: the same paths, verbs, request fields and
// response shapes over core connections and settings, with legacy ids
// resolved through the cutover's aliases. Authority is the core's own
// (row-level security and the neutral writers); the route keeps the legacy
// browser and scope checks in front of it, except that a private (`user`)
// connection is managed only from its owner's own Personal workspace, where
// the core keeps it.
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod/v4";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  deliverSubscriptionCoreWake,
  disconnectSubscriptionCoreConnection,
  readSubscriptionCoreProviderRouteForRequest,
  renameSubscriptionCoreConnection,
  resolveSubscriptionCoreRouteConnectionId,
  resolveNamedManagedPersonalWorkspaceGrant,
  setSubscriptionCoreAllocator,
  setSubscriptionCorePrimary,
  setSubscriptionCoreRotation,
  type Database,
  type SubscriptionCoreConnectRefusal,
  type SubscriptionCoreDisconnectOutcome,
  type SubscriptionCoreProvider,
  type SubscriptionCoreWake,
} from "@opengeni/db";
import type { SubscriptionPoolAccount } from "./subscription-account-pools";
import { SUBSCRIPTION_CORE_CUTOVER_DISABLED, typedHttpError } from "./subscription-core-http";
import {
  requirePrivateSubscriptionHuman,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";

/** The legacy pool account shape every pool route shares. */
type PoolAccount = SubscriptionPoolAccount;

export type SubscriptionCorePoolProjection = {
  source: "workspace" | "user" | "organization";
  accounts: PoolAccount[];
  activeCredentialId: string | null;
  rotationEnabled: boolean;
};

/** What a provider supplies to serve its pool routes from the core. */
export type SubscriptionPoolCore = {
  binding: SubscriptionCoreProvider;
  workspaceProjection(
    db: Database,
    input: { accountId: string; workspaceId: string; viewerSubjectId: string },
  ): Promise<SubscriptionCorePoolProjection>;
  organizationProjection(
    db: Database,
    input: { organizationId: string; subjectId: string },
  ): Promise<SubscriptionCorePoolProjection>;
  /**
   * The JSON of one core account in the listings, when it differs from the
   * legacy `accountJson` (fields the legacy listing adds beside it, such as
   * a usage reading). Defaults to the legacy `accountJson`; every other
   * route answers the legacy `accountJson`.
   */
  listedAccountJson?: (account: PoolAccount, activeId: string | null) => Record<string, unknown>;
};

type PoolContext = {
  deps: ApiRouteDeps;
  core: SubscriptionPoolCore;
  displayName: string;
  accountJson: (account: PoolAccount, activeId: string | null) => Record<string, unknown>;
  /** The listings' account JSON (`SubscriptionPoolCore.listedAccountJson`). */
  listedAccountJson: (account: PoolAccount, activeId: string | null) => Record<string, unknown>;
};

/**
 * The runtime serving this provider for the organization: `legacy` without
 * the provider's cutover receipt (one read; `accountId` is not called),
 * `core` with an enabled switch row; maintenance fails closed and never
 * falls back to legacy state.
 */
export async function subscriptionCoreRoute(
  deps: ApiRouteDeps,
  provider: string,
  displayName: string,
  accountId: () => Promise<string>,
): Promise<"legacy" | "core"> {
  const route = await readSubscriptionCoreProviderRouteForRequest(deps.db, provider, accountId);
  if (route === "maintenance") {
    throw typedHttpError(
      503,
      SUBSCRIPTION_CORE_CUTOVER_DISABLED,
      `${displayName} subscriptions are paused for maintenance in this organization`,
    );
  }
  return route;
}

/**
 * The runtime for a provider whose legacy runtime was deleted after its
 * cutover: only `core` serves. Any other route (maintenance, or no receipt,
 * which the deployed binary's readiness check refuses) fails closed exactly
 * as maintenance does.
 */
export async function requireSubscriptionCoreRoute(
  deps: ApiRouteDeps,
  provider: string,
  displayName: string,
  accountId: () => Promise<string>,
): Promise<"core"> {
  const route = await subscriptionCoreRoute(deps, provider, displayName, accountId);
  if (route !== "core") {
    // Without a receipt the reader returns before resolving the
    // organization; resolve it here so authorization runs first, as it does
    // under maintenance, and a stranger learns nothing about the provider.
    await accountId();
    throw subscriptionCoreMaintenanceError(displayName);
  }
  return route;
}

/** The typed refusal of a core-only provider that is not on `core`. */
export function subscriptionCoreMaintenanceError(displayName: string) {
  return typedHttpError(
    503,
    SUBSCRIPTION_CORE_CUTOVER_DISABLED,
    `${displayName} subscriptions are paused for maintenance in this organization`,
  );
}

/** Deliver a committed change's wake; never fails the request (waiters recheck). */
export async function deliverPoolCoreWake(
  deps: ApiRouteDeps,
  core: Pick<SubscriptionPoolCore, "binding">,
  wake: SubscriptionCoreWake | null,
): Promise<void> {
  await deliverSubscriptionCoreWake(
    deps.db,
    core.binding.adapter.provider,
    wake,
    core.binding.adapter.displayName,
  ).catch(() => undefined);
}

/** The legacy texts for a refused core connect. */
export function coreConnectRefused(
  reason: SubscriptionCoreConnectRefusal,
  displayName: string,
  personal: boolean,
): HTTPException | ReturnType<typeof typedHttpError> {
  switch (reason) {
    case "identity_unverified":
      return new HTTPException(409, {
        message: `this migrated ${displayName} login has no verified person identity; an organization administrator must disconnect it before connecting again`,
      });
    case "managed_elsewhere":
      return new HTTPException(409, {
        message: `this ${displayName} account is already connected in this organization and is managed elsewhere`,
      });
    case "personal_connections_disabled":
      return new HTTPException(409, {
        message: `personal ${displayName} connections are turned off in this organization`,
      });
    case "unavailable":
      return typedHttpError(
        503,
        SUBSCRIPTION_CORE_CUTOVER_DISABLED,
        `${displayName} subscriptions are paused for maintenance in this organization`,
      );
    case "changed":
      return new HTTPException(409, {
        message: `${displayName} account changed. Reload it before reconnecting.`,
      });
    default:
      return new HTTPException(personal ? 409 : 403, {
        message: personal
          ? `a private ${displayName} account is connected from your Personal workspace`
          : `only an administrator of this workspace or of the organization can connect a ${displayName} account here`,
      });
  }
}

function disconnectRefused(outcome: SubscriptionCoreDisconnectOutcome, displayName: string): void {
  if (outcome === "not_found")
    throw new HTTPException(404, { message: `${displayName} account not found` });
  if (outcome === "forbidden")
    throw new HTTPException(403, {
      message: `only an organization administrator can disconnect this ${displayName} account; a workspace administrator can disconnect only an account that serves just their workspace`,
    });
  if (outcome === "unresolved_redemption")
    throw new HTTPException(409, {
      message:
        "this subscription has an unresolved reset redemption; recover it before disconnecting",
    });
  if (outcome === "in_use")
    throw new HTTPException(409, {
      message: `${displayName} subscription cannot disconnect while active turns are using it`,
    });
}

function settingsJson(projection: { rotationEnabled: boolean; activeCredentialId: string | null }) {
  return {
    rotationEnabled: projection.rotationEnabled,
    rotationStrategy: "sharded" as const,
    activeCredentialId: projection.activeCredentialId,
  };
}

/**
 * A route's account id as the canonical core connection id: a legacy id the
 * drained cutover kept as an alias resolves to its connection as the caller
 * may see it (`resolveSubscriptionCoreRouteConnectionId`). Anything else is
 * returned as given; the caller's projection or writer decides whether it
 * exists and is theirs.
 */
export async function canonicalConnectionId(
  deps: ApiRouteDeps,
  binding: SubscriptionCoreProvider,
  input: { accountId: string; workspaceId: string | null; subjectId: string; routeId: string },
): Promise<string> {
  if (!z.uuid().safeParse(input.routeId).success) return input.routeId;
  const resolved = await resolveSubscriptionCoreRouteConnectionId(deps.db, binding, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    connectionId: input.routeId,
  });
  return resolved ?? input.routeId;
}

/** A workspace route's account: its canonical id, legacy scope and the caller's authority. */
async function workspaceTarget(c: Context, ctx: PoolContext, workspaceId: string, routeId: string) {
  const { deps, core, displayName } = ctx;
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
  const connectionId = await canonicalConnectionId(deps, core.binding, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    routeId,
  });
  const projection = await core.workspaceProjection(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    viewerSubjectId: grant.subjectId,
  });
  const account = projection.accounts.find((candidate) => candidate.id === connectionId);
  if (!account) throw new HTTPException(404, { message: `${displayName} account not found` });
  const authority = await requireSubscriptionScopeMutation(
    c,
    deps,
    workspaceId,
    account.scope,
    displayName,
    "personal_workspace",
  );
  return {
    admin: { accountId: authority.accountId, workspaceId, subjectId: authority.subjectId },
    connectionId,
    account,
  };
}

export async function coreWorkspaceAccounts(c: Context, ctx: PoolContext, workspaceId: string) {
  const { deps, core, displayName } = ctx;
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
  const projection = await core.workspaceProjection(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    viewerSubjectId: grant.subjectId,
  });
  if (projection.source === "user") {
    const human = await requirePrivateSubscriptionHuman(
      c,
      deps,
      workspaceId,
      displayName,
      "personal_workspace",
    );
    if (human.subjectId !== grant.subjectId)
      throw new HTTPException(403, { message: "managed browser identity mismatch" });
  }
  return c.json({
    source: projection.source,
    organizationId: grant.accountId,
    accounts: projection.accounts.map((account) =>
      ctx.listedAccountJson(account, projection.activeCredentialId),
    ),
    activeAccountId: projection.activeCredentialId,
    settings: settingsJson(projection),
  });
}

/** Legacy "activate": the provider's effective primary at the scope the caller administers. */
export async function coreWorkspaceActivate(
  c: Context,
  ctx: PoolContext,
  workspaceId: string,
  routeId: string,
) {
  const target = await workspaceTarget(c, ctx, workspaceId, routeId);
  if (target.account.status !== "active")
    throw new HTTPException(409, { message: `${ctx.displayName} account requires reconnect` });
  const result = await setSubscriptionCorePrimary(ctx.deps.db, ctx.core.binding, {
    ...target.admin,
    connectionId: target.connectionId,
  });
  if (!result.activated)
    throw new HTTPException(404, { message: `${ctx.displayName} account not found` });
  await deliverPoolCoreWake(ctx.deps, ctx.core, result.wake);
  // The canonical id: the listing (and its active account) shows canonical ids.
  return c.json({ activated: true, accountId: target.connectionId });
}

/** Legacy rotation toggle: on is `spread`, off is `primary_first`. */
export async function coreWorkspaceSettings(
  c: Context,
  ctx: PoolContext,
  workspaceId: string,
  rotationEnabled: boolean,
) {
  const { deps, core, displayName } = ctx;
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
  const projection = await core.workspaceProjection(deps.db, {
    accountId: grant.accountId,
    workspaceId,
    viewerSubjectId: grant.subjectId,
  });
  // Authorized by the workspace, not by the listing's display source: while an
  // organization pool serves the workspace it is managed there (409, as
  // legacy); the caller's own Personal workspace is the owner's to change;
  // any other workspace needs its administrator.
  const scope =
    projection.source === "organization"
      ? "organization"
      : (await resolveNamedManagedPersonalWorkspaceGrant(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
          }))
        ? "user"
        : "workspace";
  const authority = await requireSubscriptionScopeMutation(
    c,
    deps,
    workspaceId,
    scope,
    displayName,
    "personal_workspace",
  );
  const written = await setSubscriptionCoreRotation(deps.db, core.binding, {
    accountId: authority.accountId,
    workspaceId,
    subjectId: authority.subjectId,
    rotationEnabled,
  });
  if (!written) throw new HTTPException(409, { message: `${displayName} settings changed` });
  await deliverPoolCoreWake(deps, core, written.wake);
  return c.json(settingsJson({ rotationEnabled, activeCredentialId: written.primaryConnectionId }));
}

export async function coreWorkspaceAllocator(
  c: Context,
  ctx: PoolContext,
  workspaceId: string,
  routeId: string,
  body: { enabled: boolean; expectedVersion: number },
) {
  const target = await workspaceTarget(c, ctx, workspaceId, routeId);
  const mutation = await setSubscriptionCoreAllocator(ctx.deps.db, ctx.core.binding, {
    ...target.admin,
    connectionId: target.connectionId,
    ...body,
  });
  const result = mutation.result;
  if (result.kind === "not_found")
    throw new HTTPException(404, { message: `${ctx.displayName} account not found` });
  await deliverPoolCoreWake(ctx.deps, ctx.core, mutation.wake);
  const response = {
    allocatorEnabled: result.allocatorEnabled,
    allocatorVersion: result.allocatorVersion,
    allocatorUpdatedAt: result.allocatorUpdatedAt?.toISOString() ?? null,
    changed: result.kind === "updated",
  };
  return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
}

export async function coreWorkspaceRename(
  c: Context,
  ctx: PoolContext,
  workspaceId: string,
  routeId: string,
  label: string | null,
) {
  const target = await workspaceTarget(c, ctx, workspaceId, routeId);
  const renamed = await renameSubscriptionCoreConnection(ctx.deps.db, ctx.core.binding, {
    ...target.admin,
    connectionId: target.connectionId,
    label,
  });
  const projection = renamed
    ? await ctx.core.workspaceProjection(ctx.deps.db, {
        accountId: target.admin.accountId,
        workspaceId,
        viewerSubjectId: target.admin.subjectId,
      })
    : null;
  const row = projection?.accounts.find((account) => account.id === renamed);
  if (!projection || !row)
    throw new HTTPException(404, { message: `${ctx.displayName} account not found` });
  return c.json(ctx.accountJson(row, projection.activeCredentialId));
}

export async function coreWorkspaceDisconnect(
  c: Context,
  ctx: PoolContext,
  workspaceId: string,
  routeId: string,
) {
  const target = await workspaceTarget(c, ctx, workspaceId, routeId);
  const result = await disconnectSubscriptionCoreConnection(ctx.deps.db, ctx.core.binding, {
    ...target.admin,
    connectionId: target.connectionId,
  });
  disconnectRefused(result.outcome, ctx.displayName);
  await deliverPoolCoreWake(ctx.deps, ctx.core, result.wake);
  const projection = await ctx.core.workspaceProjection(ctx.deps.db, {
    accountId: target.admin.accountId,
    workspaceId,
    viewerSubjectId: target.admin.subjectId,
  });
  return c.json({ disconnected: true, newActiveId: projection.activeCredentialId });
}

type OrganizationActor = { organizationId: string; actorSubjectId: string };

export async function coreOrganizationAccounts(
  c: Context,
  ctx: PoolContext,
  actor: OrganizationActor,
) {
  const projection = await ctx.core.organizationProjection(ctx.deps.db, {
    organizationId: actor.organizationId,
    subjectId: actor.actorSubjectId,
  });
  return c.json({
    accounts: projection.accounts.map((account) =>
      ctx.listedAccountJson(account, projection.activeCredentialId),
    ),
    activeAccountId: projection.activeCredentialId,
    source: "organization",
    organizationId: actor.organizationId,
    settings: settingsJson(projection),
  });
}

export async function coreOrganizationSettings(
  c: Context,
  ctx: PoolContext,
  actor: OrganizationActor,
  rotationEnabled: boolean,
) {
  const written = await setSubscriptionCoreRotation(ctx.deps.db, ctx.core.binding, {
    accountId: actor.organizationId,
    workspaceId: null,
    subjectId: actor.actorSubjectId,
    rotationEnabled,
  });
  if (!written) throw new HTTPException(409, { message: `${ctx.displayName} settings changed` });
  await deliverPoolCoreWake(ctx.deps, ctx.core, written.wake);
  return c.json(settingsJson({ rotationEnabled, activeCredentialId: written.primaryConnectionId }));
}

/** The legacy organization account mutations: one change per request. */
export async function coreOrganizationAccount(
  c: Context,
  ctx: PoolContext,
  actor: OrganizationActor,
  routeId: string,
  change:
    | { activate: true }
    | { disconnect: true }
    | { label: string | null }
    | { allocatorEnabled: boolean; expectedAllocatorVersion: number },
) {
  const { deps, core, displayName } = ctx;
  const admin = {
    accountId: actor.organizationId,
    workspaceId: null,
    subjectId: actor.actorSubjectId,
  };
  const connectionId = await canonicalConnectionId(deps, core.binding, { ...admin, routeId });
  const notFound = () => new HTTPException(404, { message: `${displayName} account not found` });
  if ("disconnect" in change) {
    const result = await disconnectSubscriptionCoreConnection(deps.db, core.binding, {
      ...admin,
      connectionId,
    });
    disconnectRefused(result.outcome, displayName);
    await deliverPoolCoreWake(deps, core, result.wake);
    return c.json({ disconnected: true });
  }
  let wake: SubscriptionCoreWake | null = null;
  if ("activate" in change) {
    // Legacy refused a primary that cannot serve: only an active account the
    // allocator may use becomes the organization's primary.
    const projection = await core.organizationProjection(deps.db, {
      organizationId: actor.organizationId,
      subjectId: actor.actorSubjectId,
    });
    const account = projection.accounts.find((candidate) => candidate.id === connectionId);
    if (!account) throw notFound();
    if (account.status !== "active" || !account.allocatorEnabled)
      throw new HTTPException(409, {
        message: `Choose an active, enabled ${displayName} subscription`,
      });
    const result = await setSubscriptionCorePrimary(deps.db, core.binding, {
      ...admin,
      connectionId,
    });
    if (!result.activated) throw notFound();
    wake = result.wake;
  } else if ("label" in change) {
    const renamed = await renameSubscriptionCoreConnection(deps.db, core.binding, {
      ...admin,
      connectionId,
      label: change.label,
    });
    if (!renamed) throw notFound();
  } else {
    const mutation = await setSubscriptionCoreAllocator(deps.db, core.binding, {
      ...admin,
      connectionId,
      enabled: change.allocatorEnabled,
      expectedVersion: change.expectedAllocatorVersion,
    });
    if (mutation.result.kind === "not_found") throw notFound();
    if (mutation.result.kind === "conflict")
      throw new HTTPException(409, { message: "Subscription changed. Refresh and try again." });
    wake = mutation.wake;
  }
  await deliverPoolCoreWake(deps, core, wake);
  return c.json({ updated: true });
}
