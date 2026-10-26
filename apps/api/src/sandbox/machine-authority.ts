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
import { hasPermission, type AccessGrantAuthorization } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { isPersonalConnectionOwnerPrincipal } from "../connection-ownership";

export type MachineAction = "connect" | "change";

const NO_MACHINE_ACCESS = "You don't have access to this workspace's machines.";

const REFUSALS: Record<ResourceAuthorityScope, Record<MachineAction, string>> = {
  user: {
    connect: "Sign in to Opengeni to connect a machine that only you can use.",
    change: "Sign in to Opengeni to change a machine that only you can use.",
  },
  workspace: {
    connect:
      "Only workspace admins can connect a machine for the whole workspace. Choose Only me to connect your own.",
    change: "Only workspace admins can change a machine shared with the whole workspace.",
  },
  organization: {
    connect: "Only organization admins can connect a machine for the whole organization.",
    change: "Only organization admins can change a machine shared with the whole organization.",
  },
};

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
  if (!manage) return REFUSALS[scope][action];
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
