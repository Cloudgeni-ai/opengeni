import type { Permission } from "@opengeni/contracts";
import {
  accessGrantAuthorizationFromContext,
  accountScopedApiKeyWorkspaceAuthority,
  getManagedSession,
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  isDeveloperSetupApiKeyContext,
  isVerifiedDelegatedHumanAuthorization,
  isVerifiedOrganizationServiceAuthorization,
  requireAccessContext,
  requireCanonicalLocalAccountAdministrator,
  requireResolvedAccessGrantAuthorization,
  requireVerifiedDelegatedHumanContext,
  verifiedDelegatedHumanAuthorizationForRequest,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireSameOriginBrowserMutation } from "../routes/codex";

/** User profile only: delegation never manufactures a browser session/id/hash. */
export async function requireManagedHumanRouteIdentity(
  context: Context,
  deps: ApiRouteDeps,
  permission: Permission = ["GET", "HEAD"].includes(context.req.method)
    ? "account:read"
    : "account:admin",
): Promise<{
  subjectId: string;
  user: { id: string; name: string; email: string; emailVerified: boolean };
}> {
  const delegated = verifiedDelegatedHumanAuthorizationForRequest(context.req.raw);
  if (delegated) {
    const { context: access, user: profile } = await requireVerifiedDelegatedHumanContext(
      context,
      deps,
    );
    const account = access.accountGrants.find(
      (grant) =>
        grant.accountId === delegated.organizationId && grant.subjectId === delegated.subjectId,
    );
    if (
      !account ||
      !account.permissions.includes(permission) ||
      !delegated.permissions.includes(permission)
    )
      throw new HTTPException(403, { message: `Delegation lacks permission: ${permission}` });
    const requestedOrganization = context.req.param("organizationId");
    if (requestedOrganization && requestedOrganization !== delegated.organizationId)
      throw new HTTPException(403, { message: "Delegation belongs to another organization" });
    const user = {
      ...profile,
      name: profile.name ?? "",
      emailVerified: profile.emailVerified === true,
    };
    return { subjectId: access.subjectId, user };
  }
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !context.req.header("cookie") ||
    context.req.header("authorization")
  )
    throw new HTTPException(401, { message: "managed human session required" });
  const session = await getManagedSession(context, deps.managedAuth, {
    db: deps.db,
    sessionAdapter: deps.managedAuthSessionAdapter,
    sessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
  if (!session?.user) throw new HTTPException(401, { message: "managed human session required" });
  return { subjectId: `user:${session.user.id}`, user: session.user };
}

/** CSRF is a cookie transport boundary, not a requirement for a bearer to invent Origin. */
export async function requireNonCookieOrSameOriginMutation(
  context: Context,
  deps: ApiRouteDeps,
): Promise<void> {
  const delegated = verifiedDelegatedHumanAuthorizationForRequest(context.req.raw);
  if (delegated || context.req.header("authorization")) {
    // A header only selects authentication; it is never proof. In particular,
    // an invalid bearer that falls back to a cookie still needs browser CSRF.
    const access = await requireAccessContext(context, deps);
    if (
      delegated &&
      access.subjectId === delegated.subjectId &&
      access.defaultAccountId === delegated.organizationId
    )
      return;
    if (accountScopedApiKeyWorkspaceAuthority(access)) return;
    const grant = access.workspaceGrants[0];
    if (grant) {
      const authorization = accessGrantAuthorizationFromContext(access, grant);
      if (
        authorization.contextIntegrity &&
        !authorization.canonicalManagedHumanSession &&
        !authorization.canonicalLocalHumanSession
      )
        return;
    }
  }
  requireSameOriginBrowserMutation(context, deps);
}

/** Native authentication, fresh identity consent and payment ceremonies never delegate. */
export function requirePersonPresentRouteAuthorization(
  authorization: AccessGrantAuthorization,
): void {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  if (
    isVerifiedOrganizationServiceAuthorization(authorization) ||
    isVerifiedDelegatedHumanAuthorization(authorization) ||
    !(authorization.canonicalManagedHumanSession || authorization.canonicalLocalHumanSession) ||
    grant.principalKind !== "human_session" ||
    grant.metadata?.delegated === true ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext
  )
    throw new HTTPException(403, { message: "Finish this action in your signed-in browser" });
}

/** A consenting user's decision, not a password/identity/payment ceremony. */
export function requireDelegableHumanRouteAuthorization(
  authorization: AccessGrantAuthorization,
): void {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  if (
    grant.principalKind === "human_session" &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext &&
    (hasVerifiedOwningUserAuthorization(authorization) || authorization.canonicalLocalHumanSession)
  )
    return;
  throw new HTTPException(403, { message: "Verified owning-user authority required" });
}

/** Verified route administration; live DB lifecycles still recheck the actor's role. */
export async function requireOrganizationRouteAdministrator(
  context: Context,
  deps: ApiRouteDeps,
  organizationId: string,
  permission: Permission,
): Promise<{ subjectId: string }> {
  const access = await requireAccessContext(context, deps);
  const service = accountScopedApiKeyWorkspaceAuthority(access);
  if (service) {
    const account = access.accountGrants.find(
      (candidate) =>
        candidate.accountId === organizationId && candidate.subjectId === access.subjectId,
    );
    const permitted = permission.startsWith("account:")
      ? account?.permissions.includes(permission)
      : hasPermission(service.permissions, permission);
    if (service.accountId !== organizationId || !permitted || isDeveloperSetupApiKeyContext(access))
      throw new HTTPException(403, { message: "Organization administration is not authorized" });
    return { subjectId: access.subjectId };
  }
  if (deps.settings.productAccessMode === "local") {
    return requireCanonicalLocalAccountAdministrator(context, deps, organizationId);
  }
  const delegated = verifiedDelegatedHumanAuthorizationForRequest(context.req.raw);
  if (delegated && permission.startsWith("account:")) {
    const verified = await requireVerifiedDelegatedHumanContext(context, deps);
    const account = verified.context.accountGrants.find(
      (candidate) =>
        candidate.accountId === organizationId && candidate.subjectId === delegated.subjectId,
    );
    if (
      delegated.organizationId === organizationId &&
      delegated.permissions.includes(permission) &&
      account?.permissions.includes(permission)
    )
      return { subjectId: verified.subjectId };
    throw new HTTPException(403, { message: "Organization administration is not authorized" });
  }
  const grant = access.workspaceGrants.find((candidate) => candidate.accountId === organizationId);
  if (!grant)
    throw new HTTPException(403, { message: "Organization administration is not authorized" });
  const authorization = accessGrantAuthorizationFromContext(access, grant);
  if (authorization.canonicalManagedHumanSession) return { subjectId: access.subjectId };
  if (isVerifiedDelegatedHumanAuthorization(authorization)) {
    const proof = verifiedDelegatedHumanAuthorizationForRequest(context.req.raw)!;
    // Account capabilities remain literal. Workspace admin never expands to
    // organization ownership, billing or key administration.
    const accountPermission = permission.startsWith("account:")
      ? permission
      : ["GET", "HEAD"].includes(context.req.method)
        ? "account:read"
        : "account:admin";
    const accountAllowed =
      authorization.accountGrant?.permissions.includes(accountPermission) &&
      proof.permissions.includes(accountPermission);
    const permitted =
      accountAllowed &&
      (permission.startsWith("account:") ||
        (hasPermission([...proof.permissions], permission) &&
          hasPermission(grant.permissions, permission)));
    if (proof.organizationId === organizationId && permitted)
      return { subjectId: access.subjectId };
  }
  throw new HTTPException(403, { message: "Verified organization administration required" });
}

/** Shared policy administration allows verified org services, not human-shaped tokens. */
export function requireUserOrOrganizationRouteAuthorization(
  authorization: AccessGrantAuthorization,
): void {
  requireResolvedAccessGrantAuthorization(authorization, authorization.grant.workspaceId);
  if (
    authorization.canonicalManagedHumanSession ||
    authorization.canonicalLocalHumanSession ||
    isVerifiedDelegatedHumanAuthorization(authorization) ||
    isVerifiedOrganizationServiceAuthorization(authorization)
  )
    return;
  throw new HTTPException(403, { message: "Verified user or organization authority required" });
}
