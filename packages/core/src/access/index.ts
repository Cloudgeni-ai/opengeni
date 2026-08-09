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

export type AccessDeps = {
  db: Database;
  settings: Settings;
  managedAuth?: ManagedAuth | null;
};

export async function requireAccessContext(c: Context, deps: AccessDeps): Promise<AccessContext> {
  const context = await resolveAccessContext(c, deps);
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

export type AccessGrantAuthorization = {
  grant: AccessGrant;
  accountGrant: AccountGrant | null;
  authenticatedSubjectId: string;
  contextIntegrity: boolean;
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
  };
}

export async function requireAccessGrantAuthorization(
  c: Context,
  deps: AccessDeps,
  workspaceId: string,
  permission?: Permission,
): Promise<AccessGrantAuthorization> {
  const context = await requireAccessContext(c, deps);
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
  const aliases: Partial<Record<Permission, Permission[]>> = {
    "variable-sets:use": ["environments:use" as Permission],
    "variable-sets:manage": ["environments:manage" as Permission],
    "variable-sets:list": [
      "variable-sets:use",
      "variable-sets:manage",
      "environments:use" as Permission,
      "environments:manage" as Permission,
    ],
    "variable-sets:read": [
      "variable-sets:use",
      "variable-sets:manage",
      "environments:use" as Permission,
      "environments:manage" as Permission,
    ],
    "variable-sets:write": ["variable-sets:manage", "environments:manage" as Permission],
    "secrets:list": [
      "variable-sets:use",
      "variable-sets:manage",
      "environments:use" as Permission,
      "environments:manage" as Permission,
    ],
    "secrets:write": ["variable-sets:manage", "environments:manage" as Permission],
  };
  return (
    permissions.includes(permission) ||
    (aliases[permission]?.some((alias) => permissions.includes(alias)) ?? false) ||
    permissions.includes("workspace:admin")
  );
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
    const session = await getManagedSession(c, deps.managedAuth);
    if (session?.user) {
      return await ensureManagedAccessForUser(deps.db, {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
      });
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
