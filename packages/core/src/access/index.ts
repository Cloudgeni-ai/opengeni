import type { Settings } from "@opengeni/config";
import { verifyDelegatedAccessToken, type AccessContext, type AccessGrant, type Permission } from "@opengeni/contracts";
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

export async function requireAccessGrant(c: Context, deps: AccessDeps, workspaceId: string, permission?: Permission): Promise<AccessGrant> {
  const context = await requireAccessContext(c, deps);
  const grant = context.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId)
    ?? await getWorkspaceGrant(deps.db, context.subjectId, workspaceId);
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
  return grant;
}

export function requirePermission(grant: AccessGrant, permission: Permission): void {
  if (!hasPermission(grant.permissions, permission)) {
    throw new HTTPException(403, { message: `missing permission: ${permission}` });
  }
}

export function hasPermission(permissions: Permission[], permission: Permission): boolean {
  const aliases: Partial<Record<Permission, Permission[]>> = {
    "variable-sets:use": ["environments:use" as Permission],
    "variable-sets:manage": ["environments:manage" as Permission],
  };
  return permissions.includes(permission)
    || (aliases[permission]?.some((alias) => permissions.includes(alias)) ?? false)
    || permissions.includes("workspace:admin");
}

async function resolveAccessContext(c: Context, deps: AccessDeps): Promise<AccessContext | null> {
  if (deps.settings.productAccessMode === "local") {
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
    const apiKey = await findActiveApiKeyByHash(deps.db, await sha256Hex(bearer));
    if (apiKey) {
      const accountPermissions = apiKey.workspaceId
        ? apiKey.permissions.filter((permission) => permission === "billing:read" || permission === "billing:manage")
        : apiKey.permissions;
      return {
        mode: "managed",
        subjectId: `api_key:${apiKey.id}`,
        subjectLabel: apiKey.name,
        accountGrants: [{
          accountId: apiKey.accountId,
          subjectId: `api_key:${apiKey.id}`,
          subjectLabel: apiKey.name,
          permissions: accountPermissions,
        }],
        workspaceGrants: apiKey.workspaceId ? [{
          workspaceId: apiKey.workspaceId,
          accountId: apiKey.accountId,
          subjectId: `api_key:${apiKey.id}`,
          subjectLabel: apiKey.name,
          permissions: apiKey.permissions,
        }] : [],
        defaultAccountId: apiKey.accountId,
        defaultWorkspaceId: apiKey.workspaceId,
      } satisfies AccessContext;
    }
  }

  if (deps.managedAuth) {
    const session = await deps.managedAuth.api.getSession({ headers: c.req.raw.headers });
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

async function delegatedAccessContext(c: Context, deps: AccessDeps, mode: "configured" | "managed", token = bearerToken(c)): Promise<AccessContext | null> {
  if (!token || !deps.settings.delegationSecret) {
    return null;
  }
  const payload = await verifyDelegatedAccessToken(deps.settings.delegationSecret, token);
  if (!payload) {
    return null;
  }
  return {
    mode,
    subjectId: payload.subjectId,
    ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
    accountGrants: [{
      accountId: payload.accountId,
      subjectId: payload.subjectId,
      ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
      permissions: payload.permissions,
    }],
    workspaceGrants: [{
      workspaceId: payload.workspaceId,
      accountId: payload.accountId,
      subjectId: payload.subjectId,
      ...(payload.subjectLabel ? { subjectLabel: payload.subjectLabel } : {}),
      permissions: payload.permissions,
      // sessionId is worker-asserted (HMAC-signed token claim), not agent
      // controlled; it scopes session-bound MCP tools such as goal management.
      metadata: { delegated: true, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}) },
    }],
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
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
