import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import {
  ExternalActorSelection,
  ExternalActorAttribution,
  type ExternalActorContinuation,
  type ExternalIdentity,
} from "@opengeni/contracts/external-identities";
import { OrganizationWorkspaceScope } from "@opengeni/contracts/organization-access";
import {
  verifyDelegatedAccessToken,
  type AccountGrant,
  type AccessContext,
  type AccessGrant,
  type OrganizationApiKeyAccess,
  OPENGENI_USER_ACTIVITY_ACTIVE,
  OPENGENI_USER_ACTIVITY_HEADER,
  Permission,
  type Workspace,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  ensureManagedAccessForUser,
  getManagedUserProfilesByIds,
  ensureExternalIdentity,
  lockExternalWorkspaceMembershipLifecycle,
  resolveExternalIdentityLink,
  managedPersonalWorkspacePermissions,
  nestedPostgresSqlState,
  withWorkspaceSubjectRls,
  withAccountRls,
  listWorkspacesForSubject,
  findActiveApiKeyByHash,
  getWorkspaceGrant,
  requireWorkspace,
  resolveNamedManagedPersonalWorkspaceGrant,
  type Database,
} from "@opengeni/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ManagedAuth } from "../managed-auth-type";
import { getManagedSession } from "../managed-session";
import type { ManagedAuthSessionAdapter } from "../managed-auth-session-sets";
import type { UserPresenceRecorder } from "../user-presence";
import { serviceInitiatorFromHeaders } from "./service-initiator";

const bearerPrefix = "Bearer ";
const accessContextByRequest = new WeakMap<Request, Promise<AccessContext | null>>();
const accessResolvedRequests = new WeakSet<Request>();
const developerSetupApiKeyContexts = new WeakSet<AccessContext>();
const developerSetupAuthorizations = new WeakMap<AccessGrantAuthorization, AccessGrant>();
const developerSetupGrants = new WeakSet<AccessGrant>();

/** Only canonical authentication can prove setup-key provenance. */
export function isDeveloperSetupApiKeyContext(context: AccessContext): boolean {
  return (
    developerSetupApiKeyContexts.has(context) &&
    accountScopedApiKeyWorkspaceAuthority(context) !== null
  );
}

/** Provenance from canonical raw-key or verified restricted-token authentication. */
export function isDeveloperSetupAuthorization(
  authorization: AccessGrantAuthorization | undefined,
): boolean {
  return (
    authorization !== undefined &&
    developerSetupAuthorizations.get(authorization) === authorization.grant
  );
}

/** Exact grant objects resolved under authenticated setup-only provenance. */
export function isDeveloperSetupGrant(grant: AccessGrant): boolean {
  return developerSetupGrants.has(grant);
}

/** Setup-derived credentials cannot carry literal organization or key authority. */
export function isDeveloperSetupDelegatedPermissionAllowed(permission: Permission): boolean {
  return (
    permission !== "secrets:read" &&
    permission !== "api_keys:manage" &&
    !accountScopedApiKeyWorkspaceExcludedPermissions.has(permission)
  );
}

/** Canonical authentication provenance, including the backing key of asUser. */
export function requireApiKeyManagementContext(context: AccessContext): void {
  if (developerSetupApiKeyContexts.has(context)) {
    throw new HTTPException(403, { message: "Developer setup keys cannot manage API keys" });
  }
}

/** Membership is not an escape hatch for minting durable credentials. */
export function requireApiKeyDelegationContext(
  context: AccessContext,
  permissions: Permission[],
): void {
  if (
    (hasPermission(permissions, "api_keys:manage") ||
      hasPermission(permissions, "members:manage")) &&
    developerSetupApiKeyContexts.has(context)
  ) {
    throw new HTTPException(403, {
      message: "Setup credentials cannot delegate API key management",
    });
  }
}

/**
 * Contexts that were authenticated by a verified canonical managed cookie
 * (Better Auth session), stamped at the single branch of
 * {@link resolveAccessContext} that performs that verification.
 *
 * This is provenance — HOW the request authenticated — not a shape check on a
 * value. It cannot be forged by a token claim, and it FAILS CLOSED by default:
 * membership is only ever added at that one branch, so every other path
 * (delegated bearer, API key, local bootstrap, configured key, and any path
 * added later) is absent from the set without anyone maintaining a list. A
 * request that never resolves an access context has no context to test at all.
 *
 * Keyed on the resolved `AccessContext` object identity, deliberately NOT on
 * the `Request`: a reused, wrapped, or retried request object can therefore
 * never carry a stale positive into a differently-authenticated resolution, and
 * the non-cached `requireFreshAccessGrant` path is stamped correctly too. Each
 * resolution produces a fresh context object, so the mark travels with exactly
 * the value the cookie branch produced.
 */
const canonicalManagedCookieContexts = new WeakSet<AccessContext>();
const canonicalLocalHumanContexts = new WeakSet<AccessContext>();

export type DelegatedHumanAuthorization = Readonly<{
  organizationId: string;
  /** Exact native person subject, never an external identity or service. */
  subjectId: string;
  permissions: Permission[];
  workspaceScope: OrganizationWorkspaceScope;
}>;

const delegatedHumanAuthorizationSchema = z.object({
  organizationId: z.string().uuid(),
  subjectId: z
    .string()
    .max(1024)
    .regex(/^user:[^\s\u0000-\u001f\u007f]+$/),
  permissions: z.array(Permission),
  workspaceScope: OrganizationWorkspaceScope,
});

const delegatedHumanRequests = new WeakMap<Request, DelegatedHumanAuthorization>();
const delegatedHumanContexts = new WeakMap<AccessContext, DelegatedHumanAuthorization>();
const delegatedHumanProfileSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  emailVerified: z.boolean().optional(),
});

export type VerifiedDelegatedHumanContext = Readonly<{
  /** Native identity projection only, never a browser/auth session. Absence of
   * emailVerified means the native lookup did not prove email verification. */
  user: Readonly<z.infer<typeof delegatedHumanProfileSchema>>;
  subjectId: string;
  authorization: DelegatedHumanAuthorization;
  context: AccessContext;
}>;

const delegatedHumanProfiles = new WeakMap<AccessContext, VerifiedDelegatedHumanContext["user"]>();
const verifiedDelegatedHumanAuthorizations = new WeakMap<
  AccessGrantAuthorization,
  {
    proof: DelegatedHumanAuthorization;
    grant: AccessGrant;
    accountGrant: AccountGrant;
  }
>();

/**
 * TRUSTED OAUTH VERIFIED DISPATCH ONLY. Before each stamp the in-process caller
 * must validate the live OAuth grant, revocation, exact native person subject,
 * organization, permission ceilings and workspace scope. This API does not
 * verify OAuth and must NEVER be called with headers, metadata, token claims,
 * a previous request's proof, or other unverified caller input.
 *
 * Stamp the exact raw Request that the actions dispatcher will pass to routes,
 * before any access resolution. Cloning/wrapping a Request does not copy proof.
 * The resolver reloads the real native person's live access on this request
 * (and on fresh reauthorization); no session or cached grant is fabricated or
 * transplanted. This proof never becomes managed-cookie/person-present proof.
 */
export function stampDelegatedHumanAuthorization(
  request: Request,
  input: DelegatedHumanAuthorization,
): void {
  if (delegatedHumanRequests.has(request) || accessResolvedRequests.has(request)) {
    throw new HTTPException(403, { message: "request access authorization already resolved" });
  }
  const parsed = delegatedHumanAuthorizationSchema.safeParse(input);
  if (!parsed.success) {
    throw new HTTPException(403, { message: "invalid delegated human authorization" });
  }
  const verified = parsed.data;
  const workspaceScope: DelegatedHumanAuthorization["workspaceScope"] =
    verified.workspaceScope.kind === "all"
      ? { kind: "all" }
      : { kind: "selected", workspaceIds: [...verified.workspaceScope.workspaceIds] };
  if (workspaceScope.kind === "selected") Object.freeze(workspaceScope.workspaceIds);
  Object.freeze(workspaceScope);
  const proof: DelegatedHumanAuthorization = {
    organizationId: verified.organizationId,
    subjectId: verified.subjectId,
    permissions: [...new Set(verified.permissions)],
    workspaceScope,
  };
  Object.freeze(proof.permissions);
  delegatedHumanRequests.set(request, Object.freeze(proof));
}

/** Immutable verified dispatch bounds for this exact raw Request, not a grant. */
export function verifiedDelegatedHumanAuthorizationForRequest(
  request: Request,
): DelegatedHumanAuthorization | null {
  return delegatedHumanRequests.get(request) ?? null;
}

/**
 * Resolve the exact verified OAuth-dispatch person and constrained live native
 * access for this raw Request. Unstamped requests (even browser cookies) fail
 * closed; callers must not fall back to a service or subject-shaped identity.
 * Uses the same request-local native resolution as requireAccessContext.
 *
 * No session, session id or managed-cookie proof is created. emailVerified is
 * forwarded only when the native profile lookup supplies it; missing is not
 * verified and must never be filled from OAuth claims, headers or metadata.
 */
export async function requireVerifiedDelegatedHumanContext(
  c: Context,
  deps: AccessDeps,
): Promise<VerifiedDelegatedHumanContext> {
  const authorization = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  if (!authorization) {
    throw new HTTPException(401, { message: "verified delegated human authorization required" });
  }
  const context = await requireAccessContext(c, deps);
  const user = delegatedHumanProfiles.get(context);
  if (delegatedHumanContexts.get(context) !== authorization || !user) {
    throw new HTTPException(403, { message: "delegated native person authority is unavailable" });
  }
  return Object.freeze({ user, subjectId: context.subjectId, authorization, context });
}

/** Exact resolved owning-person authorization; clones and service claims fail.
 * Supplying the raw Request additionally binds proof to that exact dispatch,
 * not another request with the same native person and authorization bounds. */
export function isVerifiedDelegatedHumanAuthorization(
  authorization: AccessGrantAuthorization,
  request?: Request,
): boolean {
  const verified = verifiedDelegatedHumanAuthorizations.get(authorization);
  return Boolean(
    verified &&
    (request === undefined || verified.proof === delegatedHumanRequests.get(request)) &&
    authorization.contextIntegrity &&
    !authorization.canonicalManagedHumanSession &&
    !authorization.canonicalLocalHumanSession &&
    authorization.grant === verified.grant &&
    authorization.accountGrant === verified.accountGrant &&
    authorization.authenticatedSubjectId === verified.proof.subjectId &&
    verified.grant.subjectId === verified.proof.subjectId &&
    verified.grant.accountId === verified.proof.organizationId &&
    delegatedHumanWorkspaceAllowed(verified.proof, verified.grant.workspaceId),
  );
}

function delegatedHumanWorkspaceAllowed(
  proof: DelegatedHumanAuthorization,
  workspaceId: string,
): boolean {
  return (
    proof.workspaceScope.kind === "all" || proof.workspaceScope.workspaceIds.includes(workspaceId)
  );
}
const externalActorContexts = new WeakMap<
  AccessContext,
  {
    identity: ExternalIdentity;
    keyId: string;
    permissions: Permission[];
    linked?: NonNullable<Awaited<ReturnType<typeof resolveExternalIdentityLink>>>;
  }
>();
function attributionForExternalContext(context: AccessContext): ExternalActorAttribution {
  const external = externalActorContexts.get(context);
  if (!external) throw new Error("Verified external context required");
  return ExternalActorAttribution.parse({
    accountId: external.identity.accountId,
    authenticatingApiKeyId: external.keyId,
    externalIdentityId: external.identity.id,
    externalSubjectId: external.identity.subjectId,
    externalAuthorizationRevision: external.identity.authorizationRevision,
    effectiveSubjectId: context.subjectId,
    actingMode: external.linked ? "linked_native" : "external",
    ...(external.linked
      ? { linkId: external.linked.link.id, linkRevision: external.linked.link.revision }
      : {}),
  });
}
const resolvedAccessGrantAuthorizations = new WeakSet<object>();
const verifiedExternalAuthorizations = new WeakMap<
  AccessGrantAuthorization,
  {
    grant: AccessGrant;
    workspaceId: string;
    workspaceSettingsCeiling: boolean;
    identityReference: { externalId: string; source: string };
    attribution: ExternalActorAttribution;
  }
>();

/** Creation audit only, never an authentication or delegation token. Metadata
 * claiming to be external is insufficient; the exact resolver proof is needed. */
export function externalAttributionForAuthorization(
  authorization: AccessGrantAuthorization | undefined,
  grant: AccessGrant,
): ExternalActorAttribution | null {
  if (!authorization || authorization.grant !== grant) return null;
  const verified = verifiedExternalAuthorizations.get(authorization);
  if (
    !verified ||
    verified.grant !== grant ||
    verified.workspaceId !== grant.workspaceId ||
    verified.attribution.accountId !== grant.accountId ||
    verified.attribution.effectiveSubjectId !== grant.subjectId
  )
    return null;
  return structuredClone(verified.attribution);
}

export function externalActorContinuationForAuthorization(
  authorization: AccessGrantAuthorization,
): ExternalActorContinuation | null {
  const actor = externalAttributionForAuthorization(authorization, authorization.grant);
  const verified = verifiedExternalAuthorizations.get(authorization);
  return actor && verified ? { actor, identity: { ...verified.identityReference } } : null;
}

/** Dedicated owning-user proof. External/OAuth admission never sets the native
 * cookie stamp. The resource/session layer still checks the exact owner. */
export function hasVerifiedOwningUserAuthorization(
  authorization: AccessGrantAuthorization,
): boolean {
  if (
    !authorization.contextIntegrity ||
    authorization.authenticatedSubjectId !== authorization.grant.subjectId
  )
    return false;
  return (
    authorization.canonicalManagedHumanSession ||
    externalAttributionForAuthorization(authorization, authorization.grant) !== null ||
    isVerifiedDelegatedHumanAuthorization(authorization)
  );
}
const accountScopedApiKeyContexts = new WeakMap<
  AccessContext,
  Readonly<{ accountId: string; permissions: readonly Permission[] }>
>();
const apiKeyServiceContexts = new WeakMap<
  AccessContext,
  Pick<AccessGrant, "serviceInitiator" | "serviceInitiatorContext">
>();
const verifiedOrganizationServiceAuthorizations = new WeakMap<
  AccessGrantAuthorization,
  AccessGrant
>();

/** Request-local organization service-key proof, not a principal-kind claim. */
export function isVerifiedOrganizationServiceAuthorization(
  authorization: AccessGrantAuthorization,
): boolean {
  return (
    verifiedOrganizationServiceAuthorizations.has(authorization) &&
    verifiedOrganizationServiceAuthorizations.get(authorization) === authorization.grant
  );
}

const accountScopedApiKeyAccountPermissions = new Set<Permission>([
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "api_keys:manage",
  "usage_allowances:manage",
]);
const accountScopedApiKeyWorkspaceExcludedPermissions = new Set<Permission>([
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "usage_allowances:manage",
]);

export type AccountScopedApiKeyWorkspaceAuthority = Readonly<{
  accountId: string;
  permissions: Permission[];
}>;

/**
 * Return account-scoped API-key workspace authority only for the exact
 * AccessContext object stamped by successful API-key authentication. Subject
 * shape alone is deliberately insufficient.
 */
export function accountScopedApiKeyWorkspaceAuthority(
  context: AccessContext,
): AccountScopedApiKeyWorkspaceAuthority | null {
  const authority = accountScopedApiKeyContexts.get(context);
  if (!authority) return null;
  const matchingAccountGrants = context.accountGrants.filter(
    (grant) => grant.accountId === authority.accountId && grant.subjectId === context.subjectId,
  );
  if (
    !context.subjectId.startsWith("api_key:") ||
    matchingAccountGrants.length !== 1 ||
    context.defaultAccountId !== authority.accountId ||
    context.defaultWorkspaceId !== null
  ) {
    return null;
  }
  return {
    accountId: authority.accountId,
    permissions: [...authority.permissions],
  };
}

/** Classify stored scopes without changing the legacy full/read permission sets. */
export function organizationApiKeyAccess(permissions: Permission[]): OrganizationApiKeyAccess {
  if (
    permissions.includes("workspace:admin") &&
    permissions.includes("usage_allowances:manage") &&
    !permissions.includes("api_keys:manage")
  )
    return "developer_setup";
  return permissions.includes("workspace:admin") ? "full" : "read";
}

/**
 * Opaque, request-local proof that the canonical access resolver authorized the
 * exact account administrator named by the stamp. The random id is audit and
 * replay provenance only; object identity is what prevents a caller from
 * manufacturing this proof inside the API process.
 */
export type AccountAdminAuthorizationStamp = Readonly<{
  authorizationId: string;
  accountId: string;
  actorSubjectId: string;
  permission: "account:admin";
}>;

export type AccessDeps = {
  db: Database;
  settings: Settings;
  managedAuth?: ManagedAuth | null;
  managedAuthSessionAdapter?: ManagedAuthSessionAdapter | null;
  /** Analytics only: notes canonical managed-cookie activity, never authority. */
  userPresence?: UserPresenceRecorder | null;
};

/** null means this is not an authenticated external lane; [] means that lane
 * has no readable inventory. Callers must not fall back from [] to service or
 * bare-subject discovery. */
export async function listExternalActorWorkspaces(
  context: AccessContext,
  deps: AccessDeps,
): Promise<Workspace[] | null> {
  const actor = externalActorContexts.get(context);
  if (!actor) return null;
  if (
    !hasPermission(actor.permissions, "workspace:read") ||
    (actor.linked && !hasPermission(actor.linked.link.permissions, "workspace:read"))
  )
    return [];
  const candidates = await withAccountRls(deps.db, actor.identity.accountId, (tx) =>
    listWorkspacesForSubject(tx, context.subjectId),
  );
  const authorized: Workspace[] = [];
  const personal = await withAccountRls(deps.db, actor.identity.accountId, (tx) =>
    requireWorkspace(tx, actor.linked?.personalWorkspaceId ?? actor.identity.personalWorkspaceId),
  );
  if (personal.accountId === actor.identity.accountId && personal.kind === "personal")
    authorized.push(personal);
  for (const workspace of candidates) {
    if (workspace.accountId !== actor.identity.accountId || workspace.kind !== "shared") continue;
    const grant = await withWorkspaceSubjectRls(deps.db, workspace.id, context.subjectId, (tx) =>
      getWorkspaceGrant(tx, context.subjectId, workspace.id),
    );
    if (grant && hasPermission(grant.permissions, "workspace:read")) authorized.push(workspace);
  }
  return authorized;
}

export async function requireAccessContext(c: Context, deps: AccessDeps): Promise<AccessContext> {
  let pending = accessContextByRequest.get(c.req.raw);
  if (!pending) {
    pending = resolveAccessContext(c, deps);
    accessContextByRequest.set(c.req.raw, pending);
  }
  const context = await pending;
  if (!context) {
    throw new HTTPException(401, { message: "authentication required" });
  }
  return context;
}

export async function requireAccessGrant(
  c: Context,
  deps: AccessDeps,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessGrant> {
  return (await requireAccessGrantAuthorization(c, deps, workspaceId, permission)).grant;
}

/**
 * Re-resolve the authenticated principal and its current grants without using
 * the request-local access cache. Long-lived responses use this to ensure a
 * membership suspension or revocation takes effect while the connection is
 * still open.
 */
export async function requireFreshAccessGrant(
  c: Context,
  deps: AccessDeps,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessGrant> {
  const context = await resolveAccessContext(c, deps);
  if (!context) {
    throw new HTTPException(401, { message: "authentication required" });
  }
  return (await accessGrantAuthorization(context, deps, workspaceId, permission)).grant;
}

export type AccessGrantAuthorization = {
  grant: AccessGrant;
  accountGrant: AccountGrant | null;
  authenticatedSubjectId: string;
  contextIntegrity: boolean;
  /**
   * Did this request authenticate as the canonical managed-cookie (Better Auth)
   * session that OWNS this grant's subject? Cookie/person-present ceremonies
   * retain this strict gate; owning-user boundaries use
   * `hasVerifiedOwningUserAuthorization` instead.
   * False for every bearer, API-key, delegated, service, local, and configured
   * principal, and for any future path that does not verify a cookie.
   */
  canonicalManagedHumanSession: boolean;
  /** Exact in-process single-user local bootstrap, never a delegated bearer. */
  canonicalLocalHumanSession: boolean;
};

export function accessGrantAuthorizationFromContext(
  context: AccessContext,
  grant: AccessGrant,
): AccessGrantAuthorization {
  const matchingAccountGrants = context.accountGrants.filter(
    (candidate) => candidate.accountId === grant.accountId,
  );
  const delegated = grant.metadata?.delegated === true;
  const contextIntegrity =
    context.subjectId === grant.subjectId &&
    context.accountGrants.every((candidate) => candidate.subjectId === context.subjectId) &&
    context.workspaceGrants.every(
      (candidate) =>
        candidate.subjectId === context.subjectId &&
        candidate.principalKind === grant.principalKind &&
        (candidate.metadata?.delegated === true) === delegated &&
        Boolean(candidate.serviceInitiator) === Boolean(grant.serviceInitiator) &&
        Boolean(candidate.serviceInitiatorContext) === Boolean(grant.serviceInitiatorContext) &&
        context.accountGrants.filter(
          (accountGrant) => accountGrant.accountId === candidate.accountId,
        ).length === 1,
    ) &&
    matchingAccountGrants.length === 1 &&
    matchingAccountGrants[0]?.subjectId === context.subjectId;
  const authorization: AccessGrantAuthorization = {
    grant,
    accountGrant: contextIntegrity ? matchingAccountGrants[0]! : null,
    authenticatedSubjectId: context.subjectId,
    contextIntegrity,
    canonicalManagedHumanSession: isCanonicalManagedHumanSession(context, grant),
    canonicalLocalHumanSession: isCanonicalLocalHumanSession(context, grant),
  };
  resolvedAccessGrantAuthorizations.add(authorization);
  if (contextIntegrity && developerSetupApiKeyContexts.has(context)) {
    developerSetupAuthorizations.set(authorization, grant);
    developerSetupGrants.add(grant);
  }
  if (
    contextIntegrity &&
    accountScopedApiKeyWorkspaceAuthority(context)?.accountId === grant.accountId &&
    grant.principalKind === "api_key"
  ) {
    verifiedOrganizationServiceAuthorizations.set(authorization, grant);
  }
  const external = externalActorContexts.get(context);
  if (external && contextIntegrity && grant.accountId === external.identity.accountId) {
    verifiedExternalAuthorizations.set(authorization, {
      grant,
      workspaceId: grant.workspaceId,
      workspaceSettingsCeiling:
        hasPermission(external.permissions, "workspace:admin") &&
        (!external.linked || hasPermission(external.linked.link.permissions, "workspace:admin")),
      identityReference: {
        externalId: external.identity.externalId,
        source: external.identity.source,
      },
      attribution: attributionForExternalContext(context),
    });
  }
  const delegatedHuman = delegatedHumanContexts.get(context);
  if (
    delegatedHuman &&
    contextIntegrity &&
    context.workspaceGrants.includes(grant) &&
    grant.accountId === delegatedHuman.organizationId &&
    grant.subjectId === delegatedHuman.subjectId &&
    grant.principalKind === "human_session" &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext &&
    delegatedHumanWorkspaceAllowed(delegatedHuman, grant.workspaceId)
  ) {
    verifiedDelegatedHumanAuthorizations.set(authorization, {
      proof: delegatedHuman,
      grant,
      accountGrant: matchingAccountGrants[0]!,
    });
    // Keep the exact proof-bearing value immutable: changing a cookie flag,
    // subject or grant in place must not manufacture browser authentication.
    Object.freeze(authorization);
  }
  return authorization;
}

/**
 * Mint the capability passed to an account-admin database lifecycle.
 *
 * This deliberately accepts every canonical access mode (managed,
 * local/configured, and signed delegation). Organization-membership rows are
 * one possible source of account authority, not the definition of it. A plain
 * object with matching fields is rejected because only values returned by the
 * access resolver are present in `resolvedAccessGrantAuthorizations`.
 */
export function requireAccountAdminAuthorizationStamp(
  authorization: AccessGrantAuthorization,
): AccountAdminAuthorizationStamp {
  const { grant, accountGrant } = authorization;
  if (
    !resolvedAccessGrantAuthorizations.has(authorization) ||
    !authorization.contextIntegrity ||
    authorization.authenticatedSubjectId !== grant.subjectId ||
    accountGrant?.accountId !== grant.accountId ||
    accountGrant.subjectId !== grant.subjectId ||
    !accountGrant.permissions.includes("account:admin")
  ) {
    throw new HTTPException(403, { message: "missing permission: account:admin" });
  }
  return Object.freeze({
    authorizationId: crypto.randomUUID(),
    accountId: grant.accountId,
    actorSubjectId: grant.subjectId,
    permission: "account:admin" as const,
  });
}

/**
 * Verify that an access authorization was minted by the canonical request
 * resolver for this exact subject and workspace.
 *
 * This is the protocol-neutral boundary for request-local services that need
 * the authenticated grant rather than a caller-supplied grant-shaped object.
 * Object identity is intentional: matching fields alone are not proof that the
 * request authenticated the named subject.
 */
export function requireResolvedAccessGrantAuthorization(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): AccessGrant {
  const { grant } = authorization;
  if (
    !resolvedAccessGrantAuthorizations.has(authorization) ||
    !authorization.contextIntegrity ||
    authorization.authenticatedSubjectId !== grant.subjectId ||
    grant.workspaceId !== workspaceId
  ) {
    throw new HTTPException(403, { message: "workspace access authorization is invalid" });
  }
  return grant;
}

/**
 * Resolve the exact built-in single-user local administrator for an account.
 *
 * This is intentionally narrower than checking `context.mode === "local"` or
 * the `dev` subject name. Only the in-process local bootstrap branch can place
 * the resolved context in `canonicalLocalHumanContexts`, so delegated bearer
 * tokens and caller-constructed contexts cannot borrow this authority.
 */
export async function requireCanonicalLocalAccountAdministrator(
  c: Context,
  deps: AccessDeps,
  accountId: string,
): Promise<{ subjectId: string; authorization: AccessGrantAuthorization }> {
  if (c.req.header("authorization")) {
    throw new HTTPException(401, { message: "organization administrator session required" });
  }
  const context = await requireAccessContext(c, deps);
  const grant = context.workspaceGrants.find((candidate) => candidate.accountId === accountId);
  if (!grant) {
    throw new HTTPException(403, {
      message: "local organization administration is not authorized",
    });
  }
  const authorization = accessGrantAuthorizationFromContext(context, grant);
  if (!authorization.canonicalLocalHumanSession) {
    throw new HTTPException(401, { message: "organization administrator session required" });
  }
  requireAccountAdminAuthorizationStamp(authorization);
  return { subjectId: context.subjectId, authorization };
}

export async function requireAccessGrantAuthorization(
  c: Context,
  deps: AccessDeps,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessGrantAuthorization> {
  const context = await requireAccessContext(c, deps);
  return await accessGrantAuthorization(context, deps, workspaceId, permission);
}

/**
 * Settings administration is narrower than workspace administration. The
 * verified owning user may configure their Personal workspace, but
 * never acquires the admin wildcard (and its membership/delegation powers).
 * Delegated owners also need workspace:admin in their verified dispatch/key
 * ceiling: a read-only delegation cannot turn ownership into a settings write.
 * Only use this boundary for workspace configuration, not access management.
 */
export async function requireWorkspaceSettingsGrant(
  c: Context,
  deps: AccessDeps,
  workspaceId: string,
): Promise<AccessGrant> {
  const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
  const grant = requireResolvedAccessGrantAuthorization(authorization, workspaceId);
  if (hasPermission(grant.permissions, "workspace:admin")) return grant;
  const delegatedHuman = verifiedDelegatedHumanAuthorizations.get(authorization);
  const ownerSettingsCeiling =
    authorization.canonicalManagedHumanSession ||
    verifiedExternalAuthorizations.get(authorization)?.workspaceSettingsCeiling === true ||
    (delegatedHuman !== undefined && delegatedHuman.proof.permissions.includes("workspace:admin"));
  if (
    hasVerifiedOwningUserAuthorization(authorization) &&
    ownerSettingsCeiling &&
    hasPermission(grant.permissions, "workspace:read") &&
    (await resolveNamedManagedPersonalWorkspaceGrant(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: authorization.authenticatedSubjectId,
    }))
  ) {
    return grant;
  }
  throw new HTTPException(403, {
    message: "workspace settings require a workspace administrator or Personal workspace owner",
  });
}

async function accessGrantAuthorization(
  context: AccessContext,
  deps: AccessDeps,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessGrantAuthorization> {
  // No named-subject or organization-key fallback may widen verified OAuth
  // bounds. These grants came from this resolution's live native access only.
  if (delegatedHumanContexts.has(context)) {
    const grant = context.workspaceGrants.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (!grant)
      throw new HTTPException(403, { message: "delegated human workspace access denied" });
    if (permission) requirePermission(grant, permission);
    return accessGrantAuthorizationFromContext(context, grant);
  }
  const external = externalActorContexts.get(context);
  if (external) {
    const grant: AccessGrant | null =
      workspaceId ===
      (external.linked?.personalWorkspaceId ?? external.identity.personalWorkspaceId)
        ? {
            accountId: external.identity.accountId,
            workspaceId,
            subjectId: context.subjectId,
            principalKind: "human_session",
            permissions: [...managedPersonalWorkspacePermissions],
          }
        : await withWorkspaceSubjectRls(deps.db, workspaceId, context.subjectId, (tx) =>
            getWorkspaceGrant(tx, context.subjectId, workspaceId, {
              principalKind: "human_session",
            }),
          );
    if (!grant || grant.accountId !== external.identity.accountId) {
      throw new HTTPException(403, { message: "external workspace access denied" });
    }
    // Intersect effective permissions using the existing wildcard/literal
    // semantics on each side independently. Never return workspace:admin
    // unless both sides hold it, and never infer literal secrets:read.
    grant.permissions = Permission.options.filter(
      (value) =>
        hasPermission(grant.permissions, value) &&
        hasPermission(external.permissions, value) &&
        (!external.linked || hasPermission(external.linked.link.permissions, value)),
    );
    grant.metadata = {
      ...grant.metadata,
      externalActor: attributionForExternalContext(context),
    };
    if (permission) requirePermission(grant, permission);
    return accessGrantAuthorizationFromContext(context, grant);
  }
  const principalKind = hostedHumanSessionPrincipalKind(context);
  let grant =
    context.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId) ??
    (await getWorkspaceGrant(
      deps.db,
      context.subjectId,
      workspaceId,
      principalKind ? { principalKind } : undefined,
    ));
  if (grant && isDeveloperSetupApiKeyContext(context)) {
    const authority = accountScopedApiKeyWorkspaceAuthority(context);
    const workspace = await requireWorkspace(deps.db, workspaceId);
    if (!authority || workspace.accountId !== authority.accountId || workspace.kind !== "shared") {
      throw new HTTPException(403, {
        message: "Developer setup requires a shared organization workspace",
      });
    }
    // A persisted creator/membership grant cannot widen the authenticated key
    // ceiling, including literal secret reads and inherited session authority.
    const storedPermissions = grant.permissions;
    grant = {
      ...grant,
      permissions: Permission.options.filter(
        (value) =>
          value !== "api_keys:manage" &&
          !accountScopedApiKeyWorkspaceExcludedPermissions.has(value) &&
          hasPermission(storedPermissions, value) &&
          hasPermission(authority.permissions, value),
      ),
    };
  }
  if (!grant) {
    const workspace = await requireWorkspace(deps.db, workspaceId).catch(() => null);
    if (!workspace) {
      throw new HTTPException(404, { message: "workspace not found" });
    }
    const authority = accountScopedApiKeyWorkspaceAuthority(context);
    const requiredWorkspacePermission = permission ?? "workspace:read";
    if (
      authority &&
      workspace.accountId === authority.accountId &&
      workspace.kind === "shared" &&
      hasPermission(authority.permissions, requiredWorkspacePermission)
    ) {
      grant = {
        workspaceId: workspace.id,
        accountId: workspace.accountId,
        subjectId: context.subjectId,
        ...(context.subjectLabel ? { subjectLabel: context.subjectLabel } : {}),
        permissions: authority.permissions,
        principalKind: "api_key",
        ...apiKeyServiceContexts.get(context),
      };
    } else {
      throw new HTTPException(403, { message: "workspace access denied" });
    }
  }
  if (permission) {
    requirePermission(grant, permission);
  }
  return accessGrantAuthorizationFromContext(context, grant);
}

/**
 * Did the managed cookie authenticate this exact native person?
 *
 * A managed human's personal workspace carries no `workspace_memberships` row,
 * so seams that fence on one must consult the
 * `organization_memberships.personal_workspace_id` pointer instead. That is a
 * runtime property, not a schema one: migration 0219's `42501` is a
 * precondition inside the provisioning function rather than a constraint, and
 * the parity report records `personal_workspace_has_no_membership_row` as
 * `basis: "runtime"` - its own term for something nothing in the schema
 * prevents. It holds because every membership writer requires `members:manage`
 * on the target, which a personal-workspace grant deliberately omits. `AGENTS.md`
 * scopes that exception tightly: it "derives an owner-only personal-workspace
 * grant only for the canonical managed-cookie (Better Auth) session", and
 * "Bearer/delegated principals, API keys, and account or organization
 * administrators receive no personal-workspace access through that exception."
 *
 * This asks about PROVENANCE, not shape. Inspecting a grant's `principalKind`,
 * `metadata.delegated`, or `serviceInitiator` is not sufficient: a delegated
 * bearer chooses every one of those claims inside its own host-signed token and
 * can name any subject, including the owner's. So the answer comes from
 * {@link canonicalManagedCookieContexts}, stamped only where a Better Auth
 * cookie was actually verified.
 *
 * The subject equality is the second half: the exception is OWNER-only, so the
 * grant must belong to the authenticated human itself, not to some other
 * subject reached from an authenticated session. `user:` excludes machine
 * principals, which can never own an organization membership.
 */
function isCanonicalManagedHumanSession(context: AccessContext, grant: AccessGrant): boolean {
  return (
    canonicalManagedCookieContexts.has(context) &&
    grant.subjectId === context.subjectId &&
    grant.subjectId.startsWith("user:")
  );
}

function isCanonicalLocalHumanSession(context: AccessContext, grant: AccessGrant): boolean {
  return (
    canonicalLocalHumanContexts.has(context) &&
    context.mode === "local" &&
    context.subjectId === "dev" &&
    grant.subjectId === context.subjectId &&
    grant.principalKind === "human_session" &&
    grant.metadata?.delegated !== true &&
    !grant.serviceInitiator
  );
}

function hostedHumanSessionPrincipalKind(context: AccessContext): "human_session" | undefined {
  if (context.mode !== "managed" || context.workspaceGrants.length === 0) {
    return undefined;
  }
  return context.workspaceGrants.every(
    (grant) =>
      grant.principalKind === "human_session" &&
      grant.metadata?.delegated !== true &&
      !grant.serviceInitiator,
  )
    ? "human_session"
    : undefined;
}

export function requirePermission(grant: AccessGrant, permission: Permission): void {
  if (!hasPermission(grant.permissions, permission)) {
    if (permission === "variable-sets:use") {
      throw new HTTPException(403, {
        message: "missing permission: variable-sets:use (deprecated alias: environments:use)",
      });
    }
    if (permission === "variable-sets:manage") {
      throw new HTTPException(403, {
        message: "missing permission: variable-sets:manage (deprecated alias: environments:manage)",
      });
    }
    throw new HTTPException(403, {
      message: `missing permission: ${permission}`,
    });
  }
}

/**
 * Require a permission to be present literally on the grant. This deliberately
 * does not expand workspace:admin or deprecated aliases and is reserved for
 * authorities, such as plaintext secret reads, that old broad grants must not
 * acquire implicitly.
 */
export function requireLiteralPermission(grant: AccessGrant, permission: Permission): void {
  if (!hasLiteralPermission(grant.permissions, permission)) {
    throw new HTTPException(403, {
      message: `missing literal permission: ${permission}`,
    });
  }
}

export function hasLiteralPermission(permissions: Permission[], permission: Permission): boolean {
  if (!Array.isArray(permissions)) return false;
  return permissions.includes(permission);
}

export function hasPermission(permissions: Permission[], permission: Permission): boolean {
  if (!Array.isArray(permissions)) return false;
  if (permission === "secrets:read") {
    return permissions.includes("secrets:read");
  }
  // Variable-set metadata, plaintext read, write/rotation, attachment, and
  // runtime use are independent capabilities. Deprecated broad permissions
  // remain parseable but do not imply any of the exact permissions.
  return permissions.includes(permission) || permissions.includes("workspace:admin");
}

async function resolveAccessContext(c: Context, deps: AccessDeps): Promise<AccessContext | null> {
  accessResolvedRequests.add(c.req.raw);
  const delegatedHuman = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  if (delegatedHuman) return resolveDelegatedHumanAccessContext(deps, delegatedHuman);
  const service = serviceInitiatorFromHeaders(c.req.raw.headers);
  if (service) {
    if (deps.settings.productAccessMode === "local") {
      throw new HTTPException(422, {
        message: "service initiator headers require an organization or workspace API key",
      });
    }
    const context = await apiKeyAccessContext(c, deps, deps.settings.productAccessMode);
    if (!context) {
      throw new HTTPException(422, {
        message: "service initiator headers require an organization or workspace API key",
      });
    }
    return context;
  }
  if (c.req.header("x-opengeni-external-actor") !== undefined) {
    if (deps.settings.productAccessMode === "local") {
      throw new HTTPException(401, {
        message: "external actors require organization key authentication",
      });
    }
    return apiKeyAccessContext(c, deps, deps.settings.productAccessMode);
  }
  if (deps.settings.productAccessMode === "local") {
    const delegated = await delegatedAccessContext(c, deps, "local");
    if (delegated) {
      return delegated;
    }
    const context = await bootstrapWorkspace(deps.db, {
      accountExternalSource: "opengeni:local",
      accountExternalId: "default",
      accountName: "Local",
      workspaceExternalSource: "opengeni:local",
      workspaceExternalId: "default",
      workspaceName: "Local",
      subjectId: "dev",
      subjectLabel: "Local dev",
    });
    canonicalLocalHumanContexts.add(context);
    return context;
  }

  if (deps.settings.productAccessMode === "configured") {
    const delegated = await delegatedAccessContext(c, deps, "configured");
    if (delegated) {
      return delegated;
    }
    const apiKey = await apiKeyAccessContext(c, deps, "configured");
    if (apiKey) {
      return apiKey;
    }
    if (deps.settings.delegationSecret) {
      return null;
    }
    return await bootstrapWorkspace(deps.db, {
      accountExternalSource: "opengeni:configured",
      accountExternalId: "default",
      accountName: "Configured",
      workspaceExternalSource: "opengeni:configured",
      workspaceExternalId: "default",
      workspaceName: "Configured",
      subjectId: configuredSubject(c),
      subjectLabel: "Configured key",
    });
  }

  const bearer = bearerToken(c);
  if (bearer) {
    const delegated = await delegatedAccessContext(c, deps, "managed", bearer);
    if (delegated) {
      return delegated;
    }
    const apiKey = await apiKeyAccessContext(c, deps, "managed");
    if (apiKey) {
      return apiKey;
    }
  }

  if (deps.managedAuth) {
    const session = await getManagedSession(c, deps.managedAuth, {
      db: deps.db,
      sessionSetMode: deps.settings.managedAuthSessionSetMode,
      sessionAdapter: deps.managedAuthSessionAdapter,
    });
    if (session?.user) {
      // THE canonical managed-cookie (Better Auth) branch, and the only place
      // that may stamp a context as such. Every `return` above this point leaves
      // its context unstamped, so the owner-only personal-workspace exception
      // fails closed for them without depending on an exclusion list.
      const context = await ensureManagedAccessForUser(deps.db, {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
        provisionFallbackOrganization: false,
        bindPendingInvitations: false,
      });
      canonicalManagedCookieContexts.add(context);
      recordUserPresence(c, deps, context.subjectId);
      return context;
    }
  }

  return null;
}

async function resolveDelegatedHumanAccessContext(
  deps: AccessDeps,
  proof: DelegatedHumanAuthorization,
): Promise<AccessContext> {
  if (deps.settings.productAccessMode === "local") {
    throw new HTTPException(403, {
      message: "delegated humans require native organization access",
    });
  }
  const userId = proof.subjectId.slice("user:".length);
  const profiles = await getManagedUserProfilesByIds(deps.db, [userId]);
  const parsedProfile = delegatedHumanProfileSchema.safeParse(
    profiles.length === 1 && profiles[0]?.id === userId ? profiles[0] : null,
  );
  if (!parsedProfile.success)
    throw new HTTPException(403, { message: "delegated native person is unavailable" });
  const profile = parsedProfile.data;
  const live = await ensureManagedAccessForUser(deps.db, {
    userId: profile.id,
    email: profile.email,
    name: profile.name ?? "",
    provisionFallbackOrganization: false,
    bindPendingInvitations: false,
  });
  const accounts = live.accountGrants.filter((grant) => grant.accountId === proof.organizationId);
  if (
    live.mode !== "managed" ||
    live.subjectId !== proof.subjectId ||
    accounts.length !== 1 ||
    live.accountGrants.some((grant) => grant.subjectId !== proof.subjectId) ||
    live.workspaceGrants.some(
      (grant) =>
        grant.subjectId !== proof.subjectId ||
        grant.principalKind !== "human_session" ||
        grant.metadata?.delegated === true ||
        grant.serviceInitiator ||
        grant.serviceInitiatorContext,
    )
  ) {
    throw new HTTPException(403, { message: "delegated native person authority is unavailable" });
  }
  const verifiedPermissions = [...proof.permissions];
  const intersectWorkspacePermissions = (permissions: Permission[]) =>
    Permission.options.filter(
      (permission) =>
        hasPermission(permissions, permission) && hasPermission(verifiedPermissions, permission),
    );
  const accountGrant: AccountGrant = {
    ...accounts[0]!,
    // Organization/billing authority must be literal on BOTH sides. A
    // workspace:admin ceiling is never an account:admin or billing grant.
    permissions: Permission.options.filter(
      (permission) =>
        hasLiteralPermission(accounts[0]!.permissions, permission) &&
        hasLiteralPermission(verifiedPermissions, permission),
    ),
  };
  const workspaceGrants = live.workspaceGrants
    .filter(
      (grant) =>
        grant.accountId === proof.organizationId &&
        delegatedHumanWorkspaceAllowed(proof, grant.workspaceId),
    )
    .map((grant) => ({
      ...grant,
      permissions: intersectWorkspacePermissions(grant.permissions),
    }));
  // Proof-bearing authority cannot be changed in place and then reused as if
  // the resolver had authenticated a different subject, scope or ceiling.
  for (const grant of [accountGrant, ...workspaceGrants]) {
    Object.freeze(grant.permissions);
    Object.freeze(grant);
  }
  const context: AccessContext = {
    mode: "managed",
    subjectId: proof.subjectId,
    ...(live.subjectLabel ? { subjectLabel: live.subjectLabel } : {}),
    accountGrants: [accountGrant],
    workspaceGrants,
    defaultAccountId: proof.organizationId,
    defaultWorkspaceId:
      workspaceGrants.find((grant) => grant.workspaceId === live.defaultWorkspaceId)?.workspaceId ??
      workspaceGrants[0]?.workspaceId ??
      null,
  };
  Object.freeze(context.accountGrants);
  Object.freeze(context.workspaceGrants);
  Object.freeze(context);
  delegatedHumanContexts.set(context, proof);
  delegatedHumanProfiles.set(context, Object.freeze(profile));
  return context;
}

/**
 * Presence counts people, so only the verified managed browser-session branch
 * reports it, and only for a request the console marked as human activity (a
 * visible tab with recent interaction). Each request counts once: an SSE
 * stream's periodic reauthorization reuses its original request.
 */
const presenceRecordedRequests = new WeakSet<Request>();
function recordUserPresence(c: Context, deps: AccessDeps, subjectId: string): void {
  if (!deps.userPresence) return;
  if (c.req.header(OPENGENI_USER_ACTIVITY_HEADER) !== OPENGENI_USER_ACTIVITY_ACTIVE) return;
  if (presenceRecordedRequests.has(c.req.raw)) return;
  presenceRecordedRequests.add(c.req.raw);
  deps.userPresence.touch(subjectId);
}

async function apiKeyAccessContext(
  c: Context,
  deps: AccessDeps,
  mode: "configured" | "managed",
): Promise<AccessContext | null> {
  const bearer = bearerToken(c);
  if (!bearer) {
    return null;
  }
  const apiKey = await findActiveApiKeyByHash(deps.db, await sha256Hex(bearer));
  if (!apiKey) {
    return null;
  }
  const externalHeader = c.req.header("x-opengeni-external-actor");
  const service = serviceInitiatorFromHeaders(c.req.raw.headers);
  if (
    service &&
    apiKey.credentialKind !== "organization" &&
    apiKey.credentialKind !== "workspace"
  ) {
    throw new HTTPException(422, {
      message: "service initiator headers require an organization or workspace API key",
    });
  }
  if (externalHeader !== undefined) {
    if (apiKey.workspaceId !== null || apiKey.credentialKind !== "organization") {
      throw new HTTPException(403, { message: "external actors require an organization key" });
    }
    let selection: ExternalActorSelection;
    try {
      if (externalHeader.length > 16384) throw new Error("oversize");
      selection = ExternalActorSelection.parse(JSON.parse(decodeURIComponent(externalHeader)));
    } catch {
      throw new HTTPException(400, { message: "invalid external actor selection" });
    }
    let identity: ExternalIdentity;
    try {
      identity = await withAccountRls(deps.db, apiKey.accountId, async (tx) => {
        // Provisioning locks the live membership after its identity lock.
        // Claim the lifecycle prefix first so a membership-fenced session
        // writer can recheck that identity without a lock inversion.
        await lockExternalWorkspaceMembershipLifecycle(tx, apiKey.accountId);
        return await ensureExternalIdentity(tx, {
          accountId: apiKey.accountId,
          ...selection.identity,
        });
      });
    } catch (error) {
      if (nestedPostgresSqlState(error) === "42501") {
        throw new HTTPException(403, { message: "external identity is unavailable" });
      }
      throw new HTTPException(503, { message: "external identity authority is unavailable" });
    }
    const linked =
      selection.mode === "linked_native"
        ? await resolveExternalIdentityLink(deps.db, {
            identity,
            linkId: selection.linkId,
            expectedRevision: selection.expectedLinkRevision,
          })
        : null;
    if (selection.mode === "linked_native" && !linked)
      throw new HTTPException(403, { message: "Native identity link is unavailable or changed" });
    const effectiveSubjectId = linked?.link.nativeSubjectId ?? identity.subjectId;
    const context: AccessContext = {
      mode,
      subjectId: effectiveSubjectId,
      accountGrants: [
        { accountId: identity.accountId, subjectId: effectiveSubjectId, permissions: [] },
      ],
      workspaceGrants: [],
      defaultAccountId: identity.accountId,
      defaultWorkspaceId: null,
    };
    externalActorContexts.set(context, {
      identity,
      keyId: apiKey.id,
      permissions: [...apiKey.permissions],
      ...(linked ? { linked } : {}),
    });
    if (organizationApiKeyAccess(apiKey.permissions) === "developer_setup") {
      developerSetupApiKeyContexts.add(context);
    }
    return context;
  }
  const subjectId = `api_key:${apiKey.id}`;
  const accountPermissions = apiKey.workspaceId
    ? apiKey.permissions.filter(
        (permission) => permission === "billing:read" || permission === "billing:manage",
      )
    : apiKey.permissions.filter((permission) =>
        accountScopedApiKeyAccountPermissions.has(permission),
      );
  const context: AccessContext = {
    mode,
    subjectId,
    subjectLabel: apiKey.name,
    accountGrants: [
      {
        accountId: apiKey.accountId,
        subjectId,
        subjectLabel: apiKey.name,
        permissions: accountPermissions,
      },
    ],
    workspaceGrants: apiKey.workspaceId
      ? [
          {
            workspaceId: apiKey.workspaceId,
            accountId: apiKey.accountId,
            subjectId,
            subjectLabel: apiKey.name,
            permissions: apiKey.permissions,
            principalKind: "api_key",
            ...service,
          },
        ]
      : [],
    defaultAccountId: apiKey.accountId,
    defaultWorkspaceId: apiKey.workspaceId,
  };
  if (service) apiKeyServiceContexts.set(context, service);
  if (
    apiKey.credentialKind === "organization" &&
    organizationApiKeyAccess(apiKey.permissions) === "developer_setup"
  ) {
    developerSetupApiKeyContexts.add(context);
  }
  if (apiKey.workspaceId === null && apiKey.credentialKind === "organization") {
    accountScopedApiKeyContexts.set(
      context,
      Object.freeze({
        accountId: apiKey.accountId,
        permissions: Object.freeze(
          apiKey.permissions.filter(
            (permission) => !accountScopedApiKeyWorkspaceExcludedPermissions.has(permission),
          ),
        ),
      }),
    );
  }
  // Report the exact stamped authority consumed by accessGrantAuthorization,
  // rather than re-deriving organization-key permissions from a separate rule.
  // This projection is never an authorization input, and the asUser branch
  // above deliberately omits it instead of advertising the service's authority.
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  const workspaceGrant =
    apiKey.credentialKind === "workspace" ? context.workspaceGrants[0] : undefined;
  const workspacePermissions = authority?.permissions ?? workspaceGrant?.permissions;
  if (workspacePermissions) {
    context.credential = {
      kind: authority ? "organization_api_key" : "workspace_api_key",
      ...(authority ? { access: organizationApiKeyAccess(apiKey.permissions) } : {}),
      accountId: apiKey.accountId,
      workspaceId: apiKey.workspaceId,
      effectiveWorkspacePermissions: Permission.options.filter(
        (permission) =>
          !(developerSetupApiKeyContexts.has(context) && permission === "api_keys:manage") &&
          !accountScopedApiKeyWorkspaceExcludedPermissions.has(permission) &&
          hasPermission(workspacePermissions, permission),
      ),
      note: authority
        ? "These permissions apply to every shared workspace in this organization, not Personal workspaces. workspaceGrants need not enumerate them; accountGrants report organization-level permissions. asUser requests also require user authority."
        : "These permissions apply only to the workspace identified by workspaceId; they grant no organization-wide workspace authority.",
    };
  }
  return context;
}

async function delegatedAccessContext(
  c: Context,
  deps: AccessDeps,
  mode: "local" | "configured" | "managed",
  token = bearerToken(c),
): Promise<AccessContext | null> {
  const delegationSecret = resolveFirstPartyDelegationSecret(deps.settings);
  if (!token || !delegationSecret) {
    return null;
  }
  const payload = await verifyDelegatedAccessToken(delegationSecret, token);
  if (!payload) {
    return null;
  }
  const restricted = payload.credentialRestriction === "developer_setup";
  const workspacePermissions = restricted
    ? payload.permissions.filter(isDeveloperSetupDelegatedPermissionAllowed)
    : payload.permissions;
  const context: AccessContext = {
    mode,
    subjectId: payload.subjectId,
    ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
    accountGrants: [
      {
        accountId: payload.accountId,
        subjectId: payload.subjectId,
        ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
        permissions: restricted ? [] : payload.permissions,
      },
    ],
    workspaceGrants: [
      {
        workspaceId: payload.workspaceId,
        accountId: payload.accountId,
        subjectId: payload.subjectId,
        ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
        permissions: workspacePermissions,
        principalKind: payload.principalKind,
        // sessionId is worker-asserted (HMAC-signed token claim), not agent
        // controlled; it scopes session-bound MCP tools such as goal management.
        metadata: {
          delegated: true,
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
          ...(payload.firstPartyMcpTools !== undefined
            ? { firstPartyMcpTools: payload.firstPartyMcpTools }
            : {}),
          ...(payload.nestedAgentDepth !== undefined
            ? { nestedAgentDepth: payload.nestedAgentDepth }
            : {}),
          ...(payload.effectiveMaxNestedAgentDepth !== undefined
            ? { effectiveMaxNestedAgentDepth: payload.effectiveMaxNestedAgentDepth }
            : {}),
          // Caller identity: the turn that minted this token. Tools classify the
          // CALLER from this instead of re-reading the live active pointer.
          ...(payload.turnId ? { turnId: payload.turnId } : {}),
          ...(payload.attemptId ? { attemptId: payload.attemptId } : {}),
          ...(payload.executionGeneration
            ? { executionGeneration: payload.executionGeneration }
            : {}),
        },
        ...(payload.serviceInitiator ? { serviceInitiator: payload.serviceInitiator } : {}),
        ...(payload.serviceInitiatorContext
          ? { serviceInitiatorContext: payload.serviceInitiatorContext }
          : {}),
      },
    ],
    defaultAccountId: payload.accountId,
    defaultWorkspaceId: payload.workspaceId,
  };
  if (restricted) developerSetupApiKeyContexts.add(context);
  return context;
}

function configuredSubject(c: Context): string {
  const header = c.req.header("x-opengeni-subject");
  return header && header.trim().length > 0 ? `configured:${header.trim()}` : "configured:key";
}

function bearerToken(c: Context): string | null {
  const authorization = c.req.header("authorization");
  return authorization?.startsWith(bearerPrefix) ? authorization.slice(bearerPrefix.length) : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
