import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import {
  verifyDelegatedAccessToken,
  type AccountGrant,
  type AccessContext,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  ensureManagedAccessForUser,
  findActiveApiKeyByHash,
  getWorkspaceGrant,
  requireWorkspace,
  type Database,
} from "@opengeni/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ManagedAuth } from "../managed-auth-type";
import { getManagedSession } from "../managed-session";

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

export type AccessDeps = {
  db: Database;
  settings: Settings;
  managedAuth?: ManagedAuth | null;
};

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
  return {
    grant,
    accountGrant: contextIntegrity ? matchingAccountGrants[0]! : null,
    authenticatedSubjectId: context.subjectId,
    contextIntegrity,
    canonicalManagedHumanSession: isCanonicalManagedHumanSession(context, grant),
  };
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

async function accessGrantAuthorization(
  context: AccessContext,
  deps: AccessDeps,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessGrantAuthorization> {
  const principalKind = hostedHumanSessionPrincipalKind(context);
  const grant =
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
    throw new HTTPException(403, { message: "workspace access denied" });
  }
  if (permission) {
    requirePermission(grant, permission);
  }
  return accessGrantAuthorizationFromContext(context, grant);
}

/**
 * May this grant use the owner-only managed personal-workspace exception?
 *
 * A managed human's personal workspace has no `workspace_memberships` row
 * (migration 0219), so seams that fence on one must consult the
 * `organization_memberships.personal_workspace_id` pointer instead. `AGENTS.md`
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
  return permissions.includes(permission);
}

export function hasPermission(permissions: Permission[], permission: Permission): boolean {
  if (permission === "secrets:read") {
    return permissions.includes("secrets:read");
  }
  // Variable-set metadata, plaintext read, write/rotation, attachment, and
  // runtime use are independent capabilities. Deprecated broad permissions
  // remain parseable but do not imply any of the exact permissions.
  return permissions.includes(permission) || permissions.includes("workspace:admin");
}

async function resolveAccessContext(c: Context, deps: AccessDeps): Promise<AccessContext | null> {
  if (deps.settings.productAccessMode === "local") {
    const delegated = await delegatedAccessContext(c, deps, "local");
    if (delegated) {
      return delegated;
    }
    return await bootstrapWorkspace(deps.db, {
      accountExternalSource: "opengeni:local",
      accountExternalId: "default",
      accountName: "Local",
      workspaceExternalSource: "opengeni:local",
      workspaceExternalId: "default",
      workspaceName: "Local",
      subjectId: "dev",
      subjectLabel: "Local dev",
    });
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
    const session = await getManagedSession(c, deps.managedAuth, { db: deps.db });
    if (session?.user) {
      // THE canonical managed-cookie (Better Auth) branch, and the only place
      // that may stamp a context as such. Every `return` above this point leaves
      // its context unstamped, so the owner-only personal-workspace exception
      // fails closed for them without depending on an exclusion list.
      const context = await ensureManagedAccessForUser(deps.db, {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
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
  const subjectId = `api_key:${apiKey.id}`;
  const accountPermissions = apiKey.workspaceId
    ? apiKey.permissions.filter(
        (permission) => permission === "billing:read" || permission === "billing:manage",
      )
    : apiKey.permissions;
  return {
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
