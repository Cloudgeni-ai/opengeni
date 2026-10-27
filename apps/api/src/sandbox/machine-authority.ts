// Who may connect a Connected Machine, and who may change one. Every enrollment
// and per-machine write route asks this one question with the machine's scope:
//
//   * Only me (`user`): the signed-in person, for themselves, with
//     enrollments:read (every teammate). Anyone holding enrollments:manage keeps
//     the access it had.
//   * This workspace (`workspace`): enrollments:manage.
//   * Organization (`organization`): enrollments:manage plus account:admin.
//
// Why this is safe for Only me machines: the owner is always the caller's own
// organization membership (finalize_scoped_enrollment derives it from the
// request subject, never from a field), and list_scoped_enrollments returns a
// user-scope machine only to its owner, so a per-machine route that found the
// machine through that listing is acting on the caller's own machine. Credentials
// acting for a person (delegated bearers, connected agents, organization keys
// acting as a user) carry their own permission ceiling, so they keep needing
// enrollments:manage: a read-only delegation never becomes a machine write.
// Keys, services and agents acting as themselves are refused as before.

import type { ResourceAuthorityScope } from "@opengeni/contracts";
import {
  hasPermission,
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { isPersonalConnectionOwnerPrincipal } from "../connection-ownership";

export type MachineAction = "connect" | "change";

const NO_MACHINE_ACCESS = "You don't have access to this workspace's machines.";

const REFUSALS: Record<ResourceAuthorityScope, Record<MachineAction, string>> = {
  user: {
    connect:
      "Only you can connect a machine for yourself, signed in to Opengeni; a key, agent or app acting for you needs permission to manage machines.",
    change:
      "Only you can change your own machine, signed in to Opengeni; a key, agent or app acting for you needs permission to manage machines.",
  },
  workspace: {
    connect: "Only workspace admins can connect a machine for the whole workspace.",
    change: "Only workspace admins can change a machine shared with the whole workspace.",
  },
  organization: {
    connect: "Only organization admins can connect a machine for the whole organization.",
    change: "Only organization admins can change a machine shared with the whole organization.",
  },
};

const CHOOSE_ONLY_ME = " Choose Only me to connect your own.";

/** Who can use a machine is decided by workspace machine managers. */
export const MACHINE_AUDIENCE_REFUSAL = "Only workspace admins can change who can use a machine.";

/**
 * The machine routes' access check: requireAccessGrantAuthorization with
 * enrollments:read, or enrollments:manage for grants that hold only that
 * (it does not imply read), refusing a caller with neither with a sentence
 * instead of the raw permission name. The permission stays inside the
 * authorization, so a refused request never provisions a first-use membership.
 */
export async function requireMachineAccessGrant(
  c: Context,
  deps: Parameters<typeof requireAccessGrantAuthorization>[1],
  workspaceId: string,
  permission: "enrollments:read",
): Promise<AccessGrantAuthorization> {
  const missing = (error: unknown, needed: string) =>
    error instanceof HTTPException &&
    error.status === 403 &&
    error.message === `missing permission: ${needed}`;
  try {
    return await requireAccessGrantAuthorization(c, deps, workspaceId, permission);
  } catch (error) {
    if (!missing(error, permission)) throw error;
  }
  try {
    return await requireAccessGrantAuthorization(c, deps, workspaceId, "enrollments:manage");
  } catch (error) {
    if (missing(error, "enrollments:manage")) {
      throw new HTTPException(403, { message: NO_MACHINE_ACCESS });
    }
    throw error;
  }
}

/** The signed-in person themself, whose permissions are their own membership's. */
export function isSignedInMachineOwner(authorization: AccessGrantAuthorization): boolean {
  return (
    (authorization.canonicalManagedHumanSession || authorization.canonicalLocalHumanSession) &&
    isPersonalConnectionOwnerPrincipal(authorization)
  );
}

function holds(authorization: AccessGrantAuthorization, permission: "enrollments:manage") {
  const { grant } = authorization;
  return hasPermission(grant.permissions, permission, grant.permissionMode);
}

/** Why this caller may not connect or change a machine of this scope, or null. */
export function machineScopeRefusal(
  authorization: AccessGrantAuthorization,
  scope: ResourceAuthorityScope,
  action: MachineAction,
): string | null {
  const manage = holds(authorization, "enrollments:manage");
  if (scope === "user") {
    const read = hasPermission(
      authorization.grant.permissions,
      "enrollments:read",
      authorization.grant.permissionMode,
    );
    if (manage) return null;
    if (!isSignedInMachineOwner(authorization)) return REFUSALS.user[action];
    return read ? null : NO_MACHINE_ACCESS;
  }
  if (!manage) {
    // Point a signed-in teammate at what they can do instead.
    return scope === "workspace" && action === "connect" && isSignedInMachineOwner(authorization)
      ? REFUSALS.workspace.connect + CHOOSE_ONLY_ME
      : REFUSALS[scope][action];
  }
  if (
    scope === "organization" &&
    authorization.accountGrant?.permissions.includes("account:admin") !== true
  ) {
    return REFUSALS.organization[action];
  }
  return null;
}

/** Refuse with a clear 403 unless the caller may connect or change this machine. */
export function requireMachineScopeAuthority(
  authorization: AccessGrantAuthorization,
  scope: ResourceAuthorityScope,
  action: MachineAction,
): void {
  const refusal = machineScopeRefusal(authorization, scope, action);
  if (refusal) throw new HTTPException(403, { message: refusal });
}

/** Changing who can use a machine stays with workspace machine managers. */
export function requireMachineAudienceAuthority(authorization: AccessGrantAuthorization): void {
  if (!holds(authorization, "enrollments:manage")) {
    throw new HTTPException(403, { message: MACHINE_AUDIENCE_REFUSAL });
  }
}
