import {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateOrganizationApiKeyRequest,
  UpdateOrganizationApiKeyRequest,
  normalizeOrganizationAccessPolicy,
  type OrganizationAccessPolicy,
  DEVELOPER_SETUP_API_KEY_PRESET,
  Permission,
  type AccessContext,
  type ApiKey,
  type OrganizationApiKeyAccess,
} from "@opengeni/contracts";
import {
  createApiKey,
  createOrganizationApiKey as createOrganizationApiKeyRecord,
  listApiKeys,
  listOrganizationApiKeys,
  getOrganizationApiKey,
  updateOrganizationApiKey,
  OrganizationApiKeyWorkspaceScopeError,
  OrganizationApiKeyLimitExceededError,
  revokeApiKey,
  revokeOrganizationApiKey,
} from "@opengeni/db";
import { configuredStaticUsageLimits } from "@opengeni/config";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  accountScopedApiKeyWorkspaceAuthority,
  organizationApiKeyAccess,
  hasPermission,
  organizationWorkspaceInScope,
  requireAccessContext,
  requireAccessGrantAuthorization,
  requireApiKeyManagementContext,
  requireExplicitPermissionDelegation,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import { requireLimit } from "@opengeni/core";

export { organizationApiKeyAccess } from "@opengeni/core";

/** Permissions minted onto a `full` organization API key. */
export const organizationApiKeyPermissions: Permission[] = [
  "account:read",
  "workspace:create",
  "workspace:read",
  "workspace:admin",
  "api_keys:manage",
];

/**
 * Permissions minted onto a `read` organization API key. The key inventories
 * shared workspaces and reads their sessions, events, and files; it holds no
 * `workspace:admin` wildcard, so every control, create, and key-management
 * route denies it, and no `api_keys:manage`, so it cannot mint keys.
 */
export const organizationReadApiKeyPermissions: Permission[] = [
  "account:read",
  "workspace:read",
  "sessions:read",
  "files:read",
];

export function organizationApiKeyPermissionsForAccess(
  access: OrganizationApiKeyAccess,
): Permission[] {
  return access === "developer_setup"
    ? [...DEVELOPER_SETUP_API_KEY_PRESET.permissions]
    : access === "read"
      ? [...organizationReadApiKeyPermissions]
      : [...organizationApiKeyPermissions];
}

/** Existing callers retain their expiry; setup keys default to one day. */
export function organizationApiKeyExpiryDate(
  request: Pick<CreateOrganizationApiKeyRequest, "preset" | "expiresAt"> &
    Partial<Pick<CreateOrganizationApiKeyRequest, "access">>,
  now: Date = new Date(),
): Date | null {
  if (request.expiresAt !== undefined) return new Date(request.expiresAt);
  return request.preset === "developer_setup" || request.access === "developer_setup"
    ? new Date(now.getTime() + DEVELOPER_SETUP_API_KEY_PRESET.defaultExpiryHours * 60 * 60 * 1000)
    : null;
}

function withOrganizationApiKeyAccess(apiKey: ApiKey): ApiKey {
  const workspaceScope = apiKey.workspaceScope ?? { kind: "all" as const };
  return {
    ...apiKey,
    access: organizationApiKeyAccess(apiKey.permissions),
    workspaceScope,
    policy: normalizeOrganizationAccessPolicy({
      preset: "custom",
      permissions: apiKey.permissions,
      workspaceScope,
    }),
  };
}

export function registerApiKeyRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/api-keys", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireWorkspaceApiKeyControl(c, deps, workspaceId);
    return c.json({ apiKeys: await listApiKeys(deps.db, workspaceId) });
  });

  app.post(
    "/v1/workspaces/:workspaceId/api-keys",
    zValidator("json", CreateApiKeyRequest.omit({ workspaceId: true })),
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireWorkspaceApiKeyControl(c, deps, workspaceId);
      const grant = authorization.grant;
      const body = c.req.valid("json");
      const permissions: Permission[] =
        body.permissions.length > 0 ? (body.permissions as Permission[]) : ["workspace:read"];
      ensureDelegablePermissions(authorization, permissions);
      await requireLimit(deps, {
        accountId: grant.accountId,
        workspaceId,
        action: "api_key:create",
        quantity: 1,
      });
      const token = generateApiKeyToken();
      const prefix = token.slice(0, 14);
      const apiKey = await createApiKey(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        name: body.name,
        description: body.description ?? null,
        prefix,
        keyHash: await sha256Hex(token),
        permissions,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      return c.json(CreateApiKeyResponse.parse({ apiKey, token }), 201);
    },
  );

  app.delete("/v1/workspaces/:workspaceId/api-keys/:apiKeyId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireWorkspaceApiKeyControl(c, deps, workspaceId);
    return c.json(await revokeApiKey(deps.db, workspaceId, c.req.param("apiKeyId")));
  });

  app.get("/v1/organizations/:organizationId/api-keys", async (c) => {
    const organizationId = c.req.param("organizationId");
    const context = await requireAccessContext(c, deps);
    requireOrganizationApiKeyControlPermission(context, organizationId);
    return c.json({
      apiKeys: (await listOrganizationApiKeys(deps.db, organizationId)).map(
        withOrganizationApiKeyAccess,
      ),
    });
  });

  app.post(
    "/v1/organizations/:organizationId/api-keys",
    zValidator("json", CreateOrganizationApiKeyRequest),
    async (c) => {
      const organizationId = c.req.param("organizationId");
      const context = await requireAccessContext(c, deps);
      requireOrganizationApiKeyControlPermission(context, organizationId);
      const body = c.req.valid("json");
      const rawBody: Record<string, unknown> = await c.req.json();
      if (body.policy && (rawBody.access !== undefined || rawBody.preset !== undefined))
        throw new HTTPException(400, {
          message: "Choose either a policy or a legacy access tier/preset",
        });
      const token = generateApiKeyToken();
      const permissions =
        body.policy?.permissions ??
        (body.preset === "developer_setup"
          ? [...DEVELOPER_SETUP_API_KEY_PRESET.permissions]
          : organizationApiKeyPermissionsForAccess(body.access));
      ensureOrganizationPolicyDelegable(
        context,
        body.policy ?? {
          preset: "custom",
          permissions,
          workspaceScope: { kind: "all" },
        },
        !body.policy,
      );
      try {
        const apiKey = await createOrganizationApiKeyRecord(deps.db, {
          accountId: organizationId,
          name: body.name,
          description: body.description ?? null,
          prefix: token.slice(0, 14),
          keyHash: await sha256Hex(token),
          permissions,
          ...(body.policy ? { policy: body.policy } : {}),
          expiresAt: organizationApiKeyExpiryDate(body),
          maxActiveKeys: organizationApiKeyLimit(deps),
          rotationSourceApiKeyId: authenticatedApiKeyId(context),
        });
        return c.json(
          CreateApiKeyResponse.parse({ apiKey: withOrganizationApiKeyAccess(apiKey), token }),
          201,
        );
      } catch (error) {
        if (error instanceof OrganizationApiKeyLimitExceededError) {
          throw new HTTPException(429, { message: error.message });
        }
        if (error instanceof OrganizationApiKeyWorkspaceScopeError)
          throw new HTTPException(400, { message: error.message });
        throw error;
      }
    },
  );

  app.get("/v1/organizations/:organizationId/api-keys/:apiKeyId", async (c) => {
    const organizationId = c.req.param("organizationId");
    requireOrganizationApiKeyControlPermission(await requireAccessContext(c, deps), organizationId);
    const apiKey = await getOrganizationApiKey(deps.db, organizationId, c.req.param("apiKeyId"));
    if (!apiKey) throw new HTTPException(404, { message: "API key not found" });
    return c.json(withOrganizationApiKeyAccess(apiKey));
  });

  app.patch(
    "/v1/organizations/:organizationId/api-keys/:apiKeyId",
    zValidator("json", UpdateOrganizationApiKeyRequest),
    async (c) => {
      const organizationId = c.req.param("organizationId");
      const context = await requireAccessContext(c, deps);
      requireOrganizationApiKeyControlPermission(context, organizationId);
      const body = c.req.valid("json");
      if (body.policy) ensureOrganizationPolicyDelegable(context, body.policy);
      try {
        const apiKey = await updateOrganizationApiKey(
          deps.db,
          organizationId,
          c.req.param("apiKeyId"),
          body,
        );
        if (!apiKey) throw new HTTPException(404, { message: "API key not found" });
        return c.json(withOrganizationApiKeyAccess(apiKey));
      } catch (error) {
        if (error instanceof OrganizationApiKeyWorkspaceScopeError)
          throw new HTTPException(400, { message: error.message });
        throw error;
      }
    },
  );

  app.delete("/v1/organizations/:organizationId/api-keys/:apiKeyId", async (c) => {
    const organizationId = c.req.param("organizationId");
    const context = await requireAccessContext(c, deps);
    requireOrganizationApiKeyControlPermission(context, organizationId);
    const apiKey = await revokeOrganizationApiKey(deps.db, organizationId, c.req.param("apiKeyId"));
    if (!apiKey) {
      throw new HTTPException(404, { message: "API key not found" });
    }
    return c.json(withOrganizationApiKeyAccess(apiKey));
  });
}

function requireAccountPermission(
  context: AccessContext,
  accountId: string,
  permission: Permission,
): void {
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (
    !grant ||
    (!grant.permissions.includes(permission) && !grant.permissions.includes("account:admin"))
  ) {
    throw new HTTPException(403, { message: `missing permission: ${permission}` });
  }
}

function ensureDelegablePermissions(
  authorization: AccessGrantAuthorization,
  requested: Permission[],
): void {
  requireExplicitPermissionDelegation(authorization.grant, requested);
  const grantPermissions = authorization.grant.permissions;
  if (
    grantPermissions.includes("workspace:admin") &&
    authorization.grant.permissionMode !== "explicit"
  ) {
    const accountLiteralPermissions = new Set<Permission>([
      "account:read",
      "account:admin",
      "workspace:create",
      "billing:read",
      "billing:manage",
    ]);
    const workspaceLiteralPermissions = new Set<Permission>(["members:manage", "secrets:read"]);
    const highTrustMissing = requested.filter(
      (permission) =>
        (accountLiteralPermissions.has(permission) &&
          !authorization.accountGrant?.permissions.includes(permission)) ||
        (workspaceLiteralPermissions.has(permission) && !grantPermissions.includes(permission)),
    );
    if (highTrustMissing.length === 0) return;
    throw new HTTPException(403, {
      message: `cannot delegate missing literal permissions: ${highTrustMissing.join(", ")}`,
    });
  }
  const missing = requested.filter((permission) => !grantPermissions.includes(permission));
  if (missing.length > 0) {
    throw new HTTPException(403, {
      message: `cannot delegate missing permissions: ${missing.join(", ")}`,
    });
  }
}

/** Key management is not a way for a policy credential to amplify itself. */
function ensureOrganizationPolicyDelegable(
  context: AccessContext,
  policy: OrganizationAccessPolicy,
  legacy = false,
): void {
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  const source = context.credential?.policy;
  if (!authority || authority.permissionMode !== "explicit" || !source) return;
  const requested = legacy
    ? Permission.options.filter((permission) => hasPermission(policy.permissions, permission))
    : policy.permissions;
  if (requested.some((permission) => !source.permissions.includes(permission)))
    throw new HTTPException(403, {
      message: "cannot delegate permissions beyond organization key policy",
    });
  if (
    source.workspaceScope.kind === "selected" &&
    (policy.workspaceScope.kind === "all" ||
      policy.workspaceScope.workspaceIds.some(
        (id) => !organizationWorkspaceInScope(source.workspaceScope, id),
      ))
  )
    throw new HTTPException(403, {
      message: "cannot delegate workspaces beyond organization key scope",
    });
}

export function requireOrganizationApiKeyControlPermission(
  context: AccessContext,
  organizationId: string,
): void {
  requireApiKeyManagementContext(context);
  requireAccountPermission(context, organizationId, "api_keys:manage");
  if (!context.subjectId.startsWith("api_key:")) return;
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  if (
    !authority ||
    authority.accountId !== organizationId ||
    (!authority.permissions.includes("api_keys:manage") &&
      !context.accountGrants.some(
        (grant) =>
          grant.accountId === organizationId && grant.permissions.includes("account:admin"),
      ))
  ) {
    throw new HTTPException(403, { message: "organization API key authority required" });
  }
}

async function requireWorkspaceApiKeyControl(
  c: Parameters<typeof requireAccessContext>[0],
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<AccessGrantAuthorization> {
  requireApiKeyManagementContext(await requireAccessContext(c, deps));
  return await requireAccessGrantAuthorization(c, deps, workspaceId, "api_keys:manage");
}

function authenticatedApiKeyId(context: AccessContext): string | null {
  return context.subjectId.startsWith("api_key:")
    ? context.subjectId.slice("api_key:".length)
    : null;
}

function organizationApiKeyLimit(deps: ApiRouteDeps): number | null {
  if (deps.settings.usageLimitsMode !== "static" && deps.settings.usageLimitsMode !== "managed") {
    return null;
  }
  return configuredStaticUsageLimits(deps.settings).maxApiKeysPerWorkspace ?? null;
}

function generateApiKeyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `ogk_${secret}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
