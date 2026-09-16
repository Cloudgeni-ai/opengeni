import type {
  IssueUserResourceGrantRequest,
  Permission,
  SessionAuthorizationSurface,
  UserResourceKind,
} from "@opengeni/contracts";
import {
  issueSelfUserResourceGrant,
  issueSelfLocalConnectionUseGrant,
  listSelfUserResourceAuthorities,
  revokeSelfUserResourceGrant,
  sessionTenancyProductActivated,
  SessionTenancyNotActivatedError,
} from "@opengeni/db";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import type { AppDependencies } from "../dependencies";
import { requireSessionAuthorization } from "../session-authorization";
import {
  requireVerifiedOwningUser,
  SessionTenancyManagedHumanRequiredError,
} from "./session-tenancy";

type UserResourceGrantDependencies = Pick<AppDependencies, "db" | "sessionAuthorization">;

const LIST_PERMISSIONS = {
  connection: ["connections:read"],
  document: ["documents:search"],
  variable_set: ["variable-sets:list"],
  rig: ["rigs:use"],
  connected_machine: ["enrollments:read"],
} as const satisfies Record<UserResourceKind, readonly Permission[]>;

const ISSUE_PERMISSIONS = {
  connection: ["connections:read"],
  document: ["documents:search"],
  variable_set: ["variable-sets:list", "variable-sets:attach", "variable-sets:use"],
  rig: ["rigs:use"],
  connected_machine: ["enrollments:read"],
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
  if (!(await sessionTenancyProductActivated(deps.db, workspaceId))) {
    throw new SessionTenancyNotActivatedError();
  }
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
  // Connection runtime and explicit standing consent are independent of private
  // session activation. Other resource discovery retains its empty preactivation answer.
  // This keeps ordinary workspace-owned Rig/Variable Set selection independent
  // from an optional personal-resource product that is not enabled.
  if (
    input.resourceKind !== "connection" &&
    !(await sessionTenancyProductActivated(deps.db, workspaceId))
  ) {
    return { authorities: [], nextCursor: null };
  }
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
    requireOwnerAuthority(authorization, workspaceId, [
      ...ISSUE_PERMISSIONS[request.resourceKind],
      "sessions:create",
    ]);
    if (request.resourceKind !== "connection" || request.mode !== "always") {
      throw new SessionTenancyManagedHumanRequiredError();
    }
    return await issueSelfLocalConnectionUseGrant(deps.db, {
      accountId: authorization.grant.accountId,
      workspaceId,
      subjectId: authorization.grant.subjectId,
      authorityId,
      context: request.context,
      workspaceSharedAcknowledged: request.workspaceSharedAcknowledged,
    });
  }
  const independentConnectionConsent =
    request.resourceKind === "connection" &&
    (request.mode === "session" ||
      (request.mode === "always" && request.context === "workspace_shared"));
  if (independentConnectionConsent) {
    requireOwnerAuthority(authorization, workspaceId, [
      ...ISSUE_PERMISSIONS.connection,
      ...modePermissions,
    ]);
  } else {
    await requireOwnerProductGate(deps, authorization, workspaceId, [
      ...ISSUE_PERMISSIONS[request.resourceKind],
      ...modePermissions,
    ]);
  }

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
  requireOwnerAuthority(authorization, workspaceId, []);
  // The lifecycle admits only self-owned exact-session or standing shared Connection revocation
  // before product activation; other grant kinds remain gated there.
  return await revokeSelfUserResourceGrant(deps.db, {
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
    grantId,
  });
}
