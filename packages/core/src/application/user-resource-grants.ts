import type {
  IssueUserResourceGrantRequest,
  OwnResourceReachKind,
  Permission,
  SessionAuthorizationSurface,
  UserResourceKind,
} from "@opengeni/contracts";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import {
  isSubjectOwnPersonalWorkspace,
  issueSelfUserResourceGrant,
  listEnrollments,
  listOwnSubscriptionCoreConnections,
  listSelfUserResourceAuthorities,
  nestedPostgresSqlState,
  revokeSelfUserResourceGrant,
  type UserResourceAuthoritySummary,
} from "@opengeni/db";
import { hasPermission, requirePermission, type AccessGrantAuthorization } from "../access";
import type { AppDependencies } from "../dependencies";
import { listOwnConnectionMetadata } from "../domain/personal-connection-delegations";
import { requireSessionAuthorization } from "../session-authorization";
import {
  requireVerifiedOwningUser,
  SessionTenancyManagedHumanRequiredError,
} from "./session-tenancy";

type UserResourceGrantDependencies = Pick<AppDependencies, "db" | "sessionAuthorization">;

const LIST_PERMISSIONS = {
  connection: ["connections:read"],
  document: ["documents:search"],
  variable_set: ["secrets:list"],
  rig: ["rigs:use"],
  connected_machine: ["enrollments:read"],
  subscription_connection: ["connections:read"],
} as const satisfies Record<UserResourceKind, readonly Permission[]>;

const ISSUE_PERMISSIONS = {
  // Turning your own login on in a workspace (D-54), like adding one there.
  connection: ["connections:personal"],
  document: ["documents:search"],
  variable_set: ["secrets:list", "secrets:use"],
  rig: ["rigs:use"],
  connected_machine: ["enrollments:read"],
  subscription_connection: ["connections:personal"],
} as const satisfies Record<UserResourceKind, readonly Permission[]>;

async function requireOwnerProductGate(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  permissions: readonly Permission[],
): Promise<void> {
  // Target-free gates must run before an optional target-session lookup or host
  // callback so rejected principals cannot use grant management as an oracle.
  requireOwnerAuthority(authorization, workspaceId, permissions);
}

function requireOwnerAuthority(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  permissions: readonly Permission[],
): void {
  if (!authorization.canonicalLocalHumanSession) {
    requireVerifiedOwningUser(authorization, workspaceId);
  } else if (
    !authorization.contextIntegrity ||
    authorization.authenticatedSubjectId !== authorization.grant.subjectId ||
    authorization.grant.workspaceId !== workspaceId
  ) {
    throw new SessionTenancyManagedHumanRequiredError();
  }
  for (const permission of permissions) requirePermission(authorization.grant, permission);
}

export async function listManagedHumanUserResourceAuthorities(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  input: { resourceKind: UserResourceKind; cursor?: string | undefined; limit: number },
) {
  requireOwnerAuthority(authorization, workspaceId, LIST_PERMISSIONS[input.resourceKind]);
  return await listSelfUserResourceAuthorities(deps.db, {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
    ...input,
  });
}

export async function issueManagedHumanUserResourceGrant(
  deps: UserResourceGrantDependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  authorityId: string,
  request: IssueUserResourceGrantRequest,
  authorizationSurface: SessionAuthorizationSurface = "core",
) {
  const modePermissions: Permission[] =
    request.mode === "session" ? ["sessions:control"] : ["sessions:create"];
  if (authorization.canonicalLocalHumanSession) {
    throw new SessionTenancyManagedHumanRequiredError();
  }
  await requireOwnerProductGate(deps, authorization, workspaceId, [
    ...ISSUE_PERMISSIONS[request.resourceKind],
    ...modePermissions,
  ]);

  if (request.mode === "session") {
    // Contract refinement guarantees both fields. Keep the defensive check so
    // direct core callers cannot accidentally weaken the target fence.
    if (!request.sessionId || !request.expectedAuthorityEpoch) {
      throw new TypeError("session grant requires its exact authority epoch");
    }
    await requireSessionAuthorization(deps, authorization.grant, {
      sessionId: request.sessionId,
      operation: "session.personal_resource.grant",
      surface: authorizationSurface,
    });
  }

  return await issueSelfUserResourceGrant(deps.db, {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
    authorityId,
    resourceKind: request.resourceKind,
    mode: request.mode,
    context: request.context,
    sessionId: request.sessionId ?? null,
    expectedAuthorityEpoch: request.expectedAuthorityEpoch ?? null,
    workspaceSharedAcknowledged: request.workspaceSharedAcknowledged,
  });
}

export async function revokeManagedHumanUserResourceGrant(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  grantId: string,
) {
  // Revocation narrows authority. It intentionally does not require the
  // resource-specific permission that may have been removed since issuance.
  await requireOwnerProductGate(deps, authorization, workspaceId, []);
  return await revokeSelfUserResourceGrant(deps.db, {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
    grantId,
  });
}

/** Whether one of your own things works in one workspace for your own messages. */
export type OwnResourceHere = {
  /** Your own Personal workspace. */
  personal: boolean;
  on: boolean;
  /** Logins and plans always work in your Personal workspace. */
  alwaysOn: boolean;
  /** You may turn it on here; turning it off needs no permission. */
  canChange: boolean;
};

const USE_ACTION = {
  connection: "connection.use",
  subscription_connection: "subscription_connection.use",
  connected_machine: "connected_machine.use",
} as const satisfies Record<OwnResourceReachKind, string>;

type OwnResourceInput = { resourceKind: OwnResourceReachKind; resourceId: string };

const OWN_RESOURCE_KINDS = [
  "connection",
  "subscription_connection",
  "connected_machine",
] as const satisfies readonly OwnResourceReachKind[];

/** Your active authorities of one kind, as this workspace may show them. */
async function listOwnAuthorities(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  resourceKind: OwnResourceReachKind,
): Promise<UserResourceAuthoritySummary[]> {
  const authorities: UserResourceAuthoritySummary[] = [];
  let cursor: string | undefined;
  // Bounded: a person has few logins, plans and machines; a broken cursor must not loop.
  for (let page = 0; page < 50; page += 1) {
    const listed = await listSelfUserResourceAuthorities(deps.db, {
      accountId: authorization.grant.accountId,
      workspaceId,
      subjectId: authorization.grant.subjectId,
      resourceKind,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    authorities.push(...listed.authorities.filter((authority) => authority.status === "active"));
    if (!listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  return authorities;
}

async function findOwnAuthority(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  input: OwnResourceInput,
): Promise<UserResourceAuthoritySummary | null> {
  const authorities = await listOwnAuthorities(
    deps,
    authorization,
    workspaceId,
    input.resourceKind,
  );
  return authorities.find((authority) => authority.resourceId === input.resourceId) ?? null;
}

/** Standing (`always`, not bound to one chat) grants for this workspace. */
function standingGrants(
  authority: UserResourceAuthoritySummary,
  workspaceId: string,
  kind: OwnResourceReachKind,
) {
  return authority.grants.filter(
    (grant) =>
      grant.targetWorkspaceId === workspaceId &&
      grant.action === USE_ACTION[kind] &&
      grant.mode === "always" &&
      grant.targetSessionId === null,
  );
}

function liveGrant(grant: { status: string; expiresAt: string | null }, now: number) {
  return (
    grant.status === "active" && (grant.expiresAt === null || Date.parse(grant.expiresAt) > now)
  );
}

/**
 * The rule turn admission uses, read for one workspace.
 *
 * - Logins and plans: always on in your Personal workspace; elsewhere on where
 *   a standing shared-chat grant exists (D-53, D-54; migrations 1151, 1152).
 * - Machines: on where a standing grant exists in either chat context, and
 *   in your Personal workspace and the workspace it was connected from until
 *   you turn it off there (`personal_machine_on_in_workspace_v1`, 1142).
 *   A machine's authority records the workspace it was made yours from,
 *   which is where it was connected.
 */
function onHere(
  authority: UserResourceAuthoritySummary,
  workspaceId: string,
  kind: OwnResourceReachKind,
  personal: boolean,
  now: number,
): boolean {
  const standing = standingGrants(authority, workspaceId, kind);
  if (kind === "connected_machine") {
    if (standing.some((grant) => liveGrant(grant, now))) return true;
    const onByDefault = personal || authority.originWorkspaceId === workspaceId;
    return onByDefault && !standing.some((grant) => grant.status === "revoked");
  }
  if (personal) return true;
  return standing.some((grant) => grant.context === "workspace_shared" && liveGrant(grant, now));
}

function mayTurnOn(authorization: AccessGrantAuthorization, kind: OwnResourceReachKind): boolean {
  if (authorization.canonicalLocalHumanSession) return false;
  return [...ISSUE_PERMISSIONS[kind], "sessions:create" as const].every((permission) =>
    hasPermission(authorization.grant.permissions, permission),
  );
}

function ownResourceHere(
  authorization: AccessGrantAuthorization,
  authority: UserResourceAuthoritySummary,
  workspaceId: string,
  kind: OwnResourceReachKind,
  personal: boolean,
  now: number,
): OwnResourceHere {
  const on = onHere(authority, workspaceId, kind, personal, now);
  const alwaysOn = personal && kind !== "connected_machine";
  return {
    personal,
    on,
    alwaysOn,
    canChange: !alwaysOn && (on || mayTurnOn(authorization, kind)),
  };
}

/**
 * Whether your own login, plan or machine works in this workspace for your
 * own messages. Null when it isn't yours or you can't see it here.
 */
export async function getOwnResourceHere(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  input: OwnResourceInput,
): Promise<OwnResourceHere | null> {
  requireOwnerAuthority(authorization, workspaceId, LIST_PERMISSIONS[input.resourceKind]);
  return await readOwnResourceHere(deps, authorization, workspaceId, input);
}

async function readOwnResourceHere(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  input: OwnResourceInput,
): Promise<OwnResourceHere | null> {
  const authority = await findOwnAuthority(deps, authorization, workspaceId, input);
  if (!authority) return null;
  const personal = await isSubjectOwnPersonalWorkspace(deps.db, {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
  });
  return ownResourceHere(
    authorization,
    authority,
    workspaceId,
    input.resourceKind,
    personal,
    Date.now(),
  );
}

/** One of your own things as one workspace sees it. */
export type OwnResourceInWorkspace = OwnResourceInput &
  OwnResourceHere & {
    /** Where it was added or connected from. */
    originWorkspaceId: string | null;
  };

/**
 * Every one of your own logins, plans and machines you can see in this
 * workspace, with whether each works here for your own messages. A kind you
 * may not list here is left out.
 */
export async function listOwnResourcesHere(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): Promise<OwnResourceInWorkspace[]> {
  requireOwnerAuthority(authorization, workspaceId, []);
  const kinds = OWN_RESOURCE_KINDS.filter((kind) =>
    LIST_PERMISSIONS[kind].every((permission) =>
      hasPermission(authorization.grant.permissions, permission),
    ),
  );
  if (kinds.length === 0) return [];
  const personal = await isSubjectOwnPersonalWorkspace(deps.db, {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
  });
  const now = Date.now();
  const resources: OwnResourceInWorkspace[] = [];
  for (const resourceKind of kinds) {
    for (const authority of await listOwnAuthorities(
      deps,
      authorization,
      workspaceId,
      resourceKind,
    )) {
      resources.push({
        resourceKind,
        resourceId: authority.resourceId,
        originWorkspaceId: authority.originWorkspaceId,
        ...ownResourceHere(authorization, authority, workspaceId, resourceKind, personal, now),
      });
    }
  }
  return resources;
}

/** What one of your own things is called. */
export type OwnResourceName = {
  /** A login's or plan's account (its email when known), or a machine's name. */
  name: string;
  /** A login's provider domain or a plan's provider id; null for a machine. */
  provider: string | null;
  /** A plan's reported plan, when known. */
  plan: string | null;
};

export function ownResourceKey(resource: OwnResourceInput): string {
  return `${resource.resourceKind}:${resource.resourceId}`;
}

/**
 * What your own logins, plans and machines are called, keyed by
 * {@link ownResourceKey}, read from this workspace. A machine this workspace
 * doesn't list is read from the workspace it was connected from. A thing
 * that can't be read is left out.
 */
export async function nameOwnResources(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  resources: readonly (OwnResourceInput & { originWorkspaceId: string | null })[],
): Promise<Map<string, OwnResourceName>> {
  requireOwnerAuthority(authorization, workspaceId, []);
  const owner = {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
  };
  const wanted = (kind: OwnResourceReachKind) =>
    new Set(
      resources
        .filter((resource) => resource.resourceKind === kind)
        .map((resource) => resource.resourceId),
    );
  const names = new Map<string, OwnResourceName>();

  const logins = wanted("connection");
  if (logins.size > 0) {
    const connections = await listOwnConnectionMetadata(deps.db, {
      ...owner,
      reach: "anywhere",
      includeInactive: true,
      connectionIds: logins,
    });
    for (const connection of connections) {
      names.set(ownResourceKey({ resourceKind: "connection", resourceId: connection.id }), {
        name: connectionAccountIdentityLabel(connection.metadata, connection.providerDomain),
        provider: connection.providerDomain,
        plan: null,
      });
    }
  }

  const plans = wanted("subscription_connection");
  if (plans.size > 0) {
    for (const plan of await listOwnSubscriptionCoreConnections(deps.db, owner)) {
      if (!plans.has(plan.connectionId)) continue;
      names.set(
        ownResourceKey({ resourceKind: "subscription_connection", resourceId: plan.connectionId }),
        {
          name: plan.accountEmail ?? plan.label ?? plan.provider,
          provider: plan.provider,
          plan: plan.planType,
        },
      );
    }
  }

  const machines = wanted("connected_machine");
  if (machines.size > 0) {
    const nameMachines = async (from: string) => {
      for (const enrollment of await listEnrollments(deps.db, { ...owner, workspaceId: from })) {
        if (!machines.has(enrollment.id)) continue;
        names.set(
          ownResourceKey({ resourceKind: "connected_machine", resourceId: enrollment.id }),
          {
            name: enrollment.sandboxName ?? `${enrollment.os} machine`,
            provider: null,
            plan: null,
          },
        );
      }
    };
    await nameMachines(workspaceId);
    const origins = new Set(
      resources.flatMap((resource) =>
        resource.resourceKind === "connected_machine" &&
        resource.originWorkspaceId &&
        resource.originWorkspaceId !== workspaceId &&
        !names.has(ownResourceKey(resource))
          ? [resource.originWorkspaceId]
          : [],
      ),
    );
    for (const origin of origins) {
      try {
        await nameMachines(origin);
      } catch (error) {
        // A workspace you have left can't be read; its machine is left out.
        if (nestedPostgresSqlState(error) !== "42501") throw error;
      }
    }
  }
  return names;
}

/** Your own login, plan or machine isn't yours, or isn't visible here. */
export class OwnResourceNotFoundError extends Error {
  readonly name = "OwnResourceNotFoundError";
  constructor() {
    super("This isn't one of your own things in this workspace.");
  }
}

/** Logins and plans always work in your Personal workspace. */
export class OwnResourceAlwaysOnError extends Error {
  readonly name = "OwnResourceAlwaysOnError";
  constructor() {
    super("Your logins and plans always work in your Personal workspace.");
  }
}

/**
 * Turn your own login, plan or machine on or off for your own messages in
 * this workspace. On is one standing grant (a machine gets one per chat
 * context, as connecting it does); off takes back every standing grant here.
 * Grants for one chat are left alone. Returns the new state.
 */
export async function setOwnResourceHere(
  deps: Pick<UserResourceGrantDependencies, "db">,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  input: OwnResourceInput & { on: boolean },
): Promise<OwnResourceHere> {
  if (input.on) {
    if (authorization.canonicalLocalHumanSession) {
      throw new SessionTenancyManagedHumanRequiredError();
    }
    await requireOwnerProductGate(deps, authorization, workspaceId, [
      ...ISSUE_PERMISSIONS[input.resourceKind],
      "sessions:create",
    ]);
  } else {
    // Turning off narrows authority. It needs no permission that may have
    // been removed since it was turned on.
    await requireOwnerProductGate(deps, authorization, workspaceId, []);
  }
  const owner = {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
  };
  const authority = await findOwnAuthority(deps, authorization, workspaceId, input);
  if (!authority) throw new OwnResourceNotFoundError();
  const personal = await isSubjectOwnPersonalWorkspace(deps.db, owner);
  const kind = input.resourceKind;
  const machine = kind === "connected_machine";
  if (personal && !machine && !input.on) throw new OwnResourceAlwaysOnError();
  const now = Date.now();
  const standing = standingGrants(authority, workspaceId, kind);
  const issue = async (context: "user_private" | "workspace_shared") =>
    await issueSelfUserResourceGrant(deps.db, {
      ...owner,
      authorityId: authority.authorityId,
      resourceKind: kind,
      mode: "always",
      context,
      workspaceSharedAcknowledged: context === "workspace_shared",
    });

  if (input.on && !onHere(authority, workspaceId, kind, personal, now)) {
    const contexts = machine
      ? (["user_private", "workspace_shared"] as const)
      : (["workspace_shared"] as const);
    for (const context of contexts) {
      if (standing.some((grant) => grant.context === context && liveGrant(grant, now))) continue;
      await issue(context);
    }
  } else if (!input.on) {
    const live = standing.filter((grant) => liveGrant(grant, now));
    for (const grant of live) {
      await revokeSelfUserResourceGrant(deps.db, { ...owner, grantId: grant.grantId });
    }
    // A machine is on by default in your Personal workspace and where it was
    // connected. With nothing to take back there, a standing grant is
    // recorded and taken back at once, so the workspace remembers it is off.
    if (machine && live.length === 0 && onHere(authority, workspaceId, kind, personal, now)) {
      const recorded = await issue("user_private");
      await revokeSelfUserResourceGrant(deps.db, { ...owner, grantId: recorded.grantId });
    }
  }

  const after = await readOwnResourceHere(deps, authorization, workspaceId, input);
  if (!after) throw new OwnResourceNotFoundError();
  return after;
}
