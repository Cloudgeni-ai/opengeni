import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import {
  ExternalActorSelection,
  ExternalActorAttribution,
  type ExternalActorContinuation,
  type ExternalIdentity,
} from "@opengeni/contracts/external-identities";
import {
  verifyDelegatedAccessToken,
  type AccountGrant,
  type AccessContext,
  type AccessGrant,
  Permission,
  type Workspace,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  ensureManagedAccessForUser,
  ensureExternalIdentity,
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
import type { ManagedAuth } from "../managed-auth-type";
import { getManagedSession } from "../managed-session";
import type { ManagedAuthSessionAdapter } from "../managed-auth-session-sets";

const bearerPrefix = "Bearer ";
const accessContextByRequest = new WeakMap<Request, Promise<AccessContext | null>>();

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

/** Dedicated owning-user proof. External admission never sets the native
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
    externalAttributionForAuthorization(authorization, authorization.grant) !== null
  );
}
const accountScopedApiKeyContexts = new WeakMap<
  AccessContext,
  Readonly<{ accountId: string; permissions: readonly Permission[] }>
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
]);
const accountScopedApiKeyWorkspaceExcludedPermissions = new Set<Permission>([
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
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
   * session that OWNS this grant's subject? The single input to the owner-only
   * managed personal-workspace exception; see `isCanonicalManagedHumanSession`.
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
      identityReference: {
        externalId: external.identity.externalId,
        source: external.identity.source,
      },
      attribution: attributionForExternalContext(context),
    });
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
 * canonical managed-cookie owner may configure their Personal workspace, but
 * never acquires the admin wildcard (and its membership/delegation powers).
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
  if (
    authorization.canonicalManagedHumanSession &&
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
 * May this grant use the owner-only managed personal-workspace exception?
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
      return context;
    }
  }

  return null;
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
      identity = await ensureExternalIdentity(deps.db, {
        accountId: apiKey.accountId,
        ...selection.identity,
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
  const context = {
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
          },
        ]
      : [],
    defaultAccountId: apiKey.accountId,
    defaultWorkspaceId: apiKey.workspaceId,
  } satisfies AccessContext;
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
  return {
    mode,
    subjectId: payload.subjectId,
    ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
    accountGrants: [
      {
        accountId: payload.accountId,
        subjectId: payload.subjectId,
        ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
        permissions: payload.permissions,
      },
    ],
    workspaceGrants: [
      {
        workspaceId: payload.workspaceId,
        accountId: payload.accountId,
        subjectId: payload.subjectId,
        ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
        permissions: payload.permissions,
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
