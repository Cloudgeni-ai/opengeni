import {
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateOrganizationApiKeyRequest,
  Permission,
  type AccessContext,
} from "@opengeni/contracts";
import {
  createApiKey,
  createOrganizationApiKey as createOrganizationApiKeyRecord,
  listApiKeys,
  listOrganizationApiKeys,
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
  requireAccessContext,
  requireAccessGrant,
} from "@opengeni/core";
import { requireLimit } from "@opengeni/core";

export const organizationApiKeyPermissions: Permission[] = [
  "account:read",
  "workspace:create",
  "workspace:read",
  "workspace:admin",
  "api_keys:manage",
];

export function registerApiKeyRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/api-keys", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "api_keys:manage");
    return c.json({ apiKeys: await listApiKeys(deps.db, workspaceId) });
  });

  app.post(
    "/v1/workspaces/:workspaceId/api-keys",
    zValidator("json", CreateApiKeyRequest.omit({ workspaceId: true })),
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "api_keys:manage");
      const body = c.req.valid("json");
      const permissions: Permission[] =
        body.permissions.length > 0 ? (body.permissions as Permission[]) : ["workspace:read"];
      ensureDelegablePermissions(grant.permissions, permissions);
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
    await requireAccessGrant(c, deps, workspaceId, "api_keys:manage");
    return c.json(await revokeApiKey(deps.db, workspaceId, c.req.param("apiKeyId")));
  });

  app.get("/v1/organizations/:organizationId/api-keys", async (c) => {
    const organizationId = c.req.param("organizationId");
    const context = await requireAccessContext(c, deps);
    requireOrganizationApiKeyControlPermission(context, organizationId);
    return c.json({ apiKeys: await listOrganizationApiKeys(deps.db, organizationId) });
  });

  app.post(
    "/v1/organizations/:organizationId/api-keys",
    zValidator("json", CreateOrganizationApiKeyRequest),
    async (c) => {
      const organizationId = c.req.param("organizationId");
      const context = await requireAccessContext(c, deps);
      requireOrganizationApiKeyControlPermission(context, organizationId);
      const body = c.req.valid("json");
      const token = generateApiKeyToken();
      try {
        const apiKey = await createOrganizationApiKeyRecord(deps.db, {
          accountId: organizationId,
          name: body.name,
          description: body.description ?? null,
          prefix: token.slice(0, 14),
          keyHash: await sha256Hex(token),
          permissions: organizationApiKeyPermissions,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          maxActiveKeys: organizationApiKeyLimit(deps),
          rotationSourceApiKeyId: authenticatedApiKeyId(context),
        });
        return c.json(CreateApiKeyResponse.parse({ apiKey, token }), 201);
      } catch (error) {
        if (error instanceof OrganizationApiKeyLimitExceededError) {
          throw new HTTPException(429, { message: error.message });
        }
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
    return c.json(apiKey);
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

function ensureDelegablePermissions(grantPermissions: Permission[], requested: Permission[]): void {
  if (grantPermissions.includes("workspace:admin")) {
    const literalOnlyPermissions = new Set<Permission>([
      "account:read",
      "account:admin",
      "members:manage",
      "workspace:create",
      "billing:read",
      "billing:manage",
      "secrets:read",
    ]);
    const highTrustMissing = requested.filter(
      (permission) =>
        literalOnlyPermissions.has(permission) && !grantPermissions.includes(permission),
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

function requireOrganizationApiKeyControlPermission(
  context: AccessContext,
  organizationId: string,
): void {
  requireAccountPermission(context, organizationId, "api_keys:manage");
  if (!context.subjectId.startsWith("api_key:")) return;
  const authority = accountScopedApiKeyWorkspaceAuthority(context);
  if (
    !authority ||
    authority.accountId !== organizationId ||
    !authority.permissions.includes("api_keys:manage")
  ) {
    throw new HTTPException(403, { message: "organization API key authority required" });
  }
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
