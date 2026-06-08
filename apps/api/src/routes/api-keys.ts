import { CreateApiKeyRequest, CreateApiKeyResponse, Permission } from "@opengeni/contracts";
import { createApiKey, listApiKeys, revokeApiKey } from "@opengeni/db";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";
import { requireAccessGrant } from "../access";
import { requireLimit } from "../billing/limits";

export function registerApiKeyRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/api-keys", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "api_keys:manage");
    return c.json({ apiKeys: await listApiKeys(deps.db, workspaceId) });
  });

  app.post("/v1/workspaces/:workspaceId/api-keys", zValidator("json", CreateApiKeyRequest.omit({ workspaceId: true })), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "api_keys:manage");
    const body = c.req.valid("json");
    const permissions: Permission[] = body.permissions.length > 0 ? body.permissions as Permission[] : ["workspace:read"];
    ensureDelegablePermissions(grant.permissions, permissions);
    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "api_key:create", quantity: 1 });
    const token = generateApiKeyToken();
    const prefix = token.slice(0, 14);
    const apiKey = await createApiKey(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: body.name,
      prefix,
      keyHash: await sha256Hex(token),
      permissions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    return c.json(CreateApiKeyResponse.parse({ apiKey, token }), 201);
  });

  app.delete("/v1/workspaces/:workspaceId/api-keys/:apiKeyId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "api_keys:manage");
    return c.json(await revokeApiKey(deps.db, workspaceId, c.req.param("apiKeyId")));
  });
}

function ensureDelegablePermissions(grantPermissions: Permission[], requested: Permission[]): void {
  if (grantPermissions.includes("workspace:admin")) {
    return;
  }
  const missing = requested.filter((permission) => !grantPermissions.includes(permission));
  if (missing.length > 0) {
    throw new HTTPException(403, { message: `cannot delegate missing permissions: ${missing.join(", ")}` });
  }
}

function generateApiKeyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ogk_${secret}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
