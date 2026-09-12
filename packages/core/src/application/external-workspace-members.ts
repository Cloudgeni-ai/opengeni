import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AddExternalWorkspaceMemberRequest,
  ExternalIdentityReference,
  CancelExternalWorkspaceMemberGrantRequest,
  type ExternalIdentity,
} from "@opengeni/contracts/external-identities";
import {
  ensureExternalIdentity,
  grantWorkspaceAccess,
  listWorkspaceMembers,
  lockExternalWorkspaceMembershipLifecycle,
  requireWorkspace,
  setRlsContext,
  withWorkspaceSubjectRls,
  addExternalWorkspaceMemberOperation,
  cancelExternalWorkspaceMemberGrant,
  lookupExternalIdentity,
  nestedPostgresSqlState,
} from "@opengeni/db";
import { organizationMembershipHttpStatus } from "../domain/organization-membership-lifecycle";
import {
  accountScopedApiKeyWorkspaceAuthority,
  hasPermission,
  requireAccessContext,
  requireFreshAccessGrant,
  type AccessDeps,
} from "../access";

/** Explicit host onboarding. Ordinary asUser reads never call this operation.
 * Existing memberships are not overwritten, including reduced permissions. */
export async function addExternalWorkspaceMemberForRequest(
  c: Context,
  deps: AccessDeps,
  workspaceId: string,
  input: unknown,
): Promise<ExternalIdentity> {
  const payload = AddExternalWorkspaceMemberRequest.parse(input);
  const context = await requireAccessContext(c, deps);
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  if (!authority)
    throw new HTTPException(403, {
      message: "external onboarding requires an organization service key",
    });
  const grant = await requireFreshAccessGrant(c, deps, workspaceId, "members:manage");
  if (
    grant.accountId !== authority.accountId ||
    payload.permissions.some((permission) => !hasPermission(grant.permissions, permission))
  ) {
    throw new HTTPException(403, { message: "membership exceeds key authority" });
  }
  if (payload.operationId) {
    try {
      return await addExternalWorkspaceMemberOperation(
        deps.db,
        {
          organizationId: authority.accountId,
          workspaceId,
          actorSubjectId: grant.subjectId,
        },
        { ...payload, operationId: payload.operationId },
      );
    } catch (error) {
      rethrowExternalWorkspaceOperation(error);
    }
  }
  return withWorkspaceSubjectRls(deps.db, workspaceId, grant.subjectId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, grant.accountId);
    const live = await requireFreshAccessGrant(
      c,
      { ...deps, db: tx },
      workspaceId,
      "members:manage",
    );
    if (
      live.accountId !== grant.accountId ||
      live.subjectId !== grant.subjectId ||
      payload.permissions.some((permission) => !hasPermission(live.permissions, permission))
    ) {
      throw new HTTPException(403, { message: "membership authority changed" });
    }
    const workspace = await requireWorkspace(tx, workspaceId);
    if (workspace.kind !== "shared" || workspace.accountId !== authority.accountId)
      throw new HTTPException(403, {
        message: "external onboarding requires a shared organization workspace",
      });
    const identity = await ensureExternalIdentity(tx, {
      accountId: authority.accountId,
      ...payload.identity,
    });
    await setRlsContext(tx, { accountId: authority.accountId, workspaceId });
    const existing = (await listWorkspaceMembers(tx, workspaceId)).find(
      (member) => member.subjectId === identity.subjectId,
    );
    const permissions = [...new Set(payload.permissions)];
    if (existing) {
      if (
        existing.permissions.length !== permissions.length ||
        existing.permissions.some((permission) => !permissions.includes(permission))
      ) {
        throw new HTTPException(409, {
          message: "existing membership differs; onboarding does not overwrite permissions",
        });
      }
      return identity;
    }
    await grantWorkspaceAccess(tx, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: identity.subjectId,
      role: "member",
      permissions,
    });
    return identity;
  });
}

function rethrowExternalWorkspaceOperation(error: unknown): never {
  const status = organizationMembershipHttpStatus(nestedPostgresSqlState(error));
  if (status)
    throw new HTTPException(status, {
      message:
        status === 409
          ? "External membership operation changed or was cancelled"
          : "External membership operation is not available",
    });
  throw error;
}

async function externalService(c: Context, deps: AccessDeps, organizationId: string) {
  const context = await requireAccessContext(c, deps);
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  if (
    !authority ||
    authority.accountId !== organizationId ||
    !hasPermission(authority.permissions, "members:manage")
  ) {
    throw new HTTPException(403, {
      message: "External membership operation requires an organization service key",
    });
  }
  return { organizationId, actorSubjectId: context.subjectId };
}

export async function lookupExternalIdentityForRequest(
  c: Context,
  deps: AccessDeps,
  organizationId: string,
  input: unknown,
) {
  const service = await externalService(c, deps, organizationId);
  const identity = ExternalIdentityReference.safeParse(input);
  if (!identity.success)
    throw new HTTPException(422, { message: "Invalid external identity reference" });
  try {
    return await lookupExternalIdentity(deps.db, service, identity.data);
  } catch (error) {
    rethrowExternalWorkspaceOperation(error);
  }
}

export async function cancelExternalWorkspaceMemberGrantForRequest(
  c: Context,
  deps: AccessDeps,
  organizationId: string,
  workspaceId: string,
  membershipId: string,
  input: unknown,
) {
  const service = await externalService(c, deps, organizationId);
  const request = CancelExternalWorkspaceMemberGrantRequest.safeParse(input);
  if (!request.success)
    throw new HTTPException(422, { message: "Invalid external grant cancellation" });
  try {
    return await cancelExternalWorkspaceMemberGrant(
      deps.db,
      { ...service, workspaceId, membershipId },
      request.data,
    );
  } catch (error) {
    rethrowExternalWorkspaceOperation(error);
  }
}
