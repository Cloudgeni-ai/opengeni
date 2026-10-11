import {
  CreatePersonalApiKeyRequest,
  CreatePersonalApiKeyResponse,
  ListPersonalApiKeysResponse,
  PersonalApiKey,
  type AccessContext,
} from "@opengeni/contracts";
import {
  createPersonalApiKey,
  getManagedUserProfilesByIds,
  listPersonalApiKeys,
  PersonalApiKeyLimitExceededError,
  PersonalApiKeyWorkspaceScopeError,
  revokePersonalApiKey,
  type PersonalApiKeyRecord,
} from "@opengeni/db";
import {
  hasPermission,
  PERSONAL_API_KEY_TOKEN_PREFIX,
  requireAccessContext,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { isAgentActingAsPerson, requireFullAccessIfAgent } from "../http/acting-person";
import { requireSameOriginBrowserMutation } from "./codex";

/* ----------------------------------------------------------------------------
   Personal API keys: keys that act as the person who created them. A script
   or agent holding one does what that person can do in this organization,
   capped by the key's access setting, and shows up as them. Every request
   rechecks the person's live access, so a removed or narrowed role applies at
   once; leaving the organization revokes the keys.

   Everyone manages their own; owners and admins also see everyone's and can
   revoke them. An agent acting as the person can do this only with their full
   access, so a limited agent or key can never mint a broader one.
   -------------------------------------------------------------------------- */

export function registerPersonalApiKeyRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/organizations/:organizationId/personal-api-keys", async (c) => {
    const { context, organizationId, admin } = await requireOrganizationPerson(c, deps, false);
    const keys = await listPersonalApiKeys(deps.db, {
      accountId: organizationId,
      ...(admin ? {} : { ownerSubjectId: context.subjectId }),
    });
    c.header("cache-control", "no-store");
    return c.json(
      ListPersonalApiKeysResponse.parse({
        apiKeys: await projectKeys(deps, keys),
        canManageAll: admin,
      }),
    );
  });

  app.post("/v1/organizations/:organizationId/personal-api-keys", async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const { context, organizationId } = await requireOrganizationPerson(c, deps, true);
    const parsed = CreatePersonalApiKeyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "invalid personal API key",
      });
    }
    const body = parsed.data;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new HTTPException(400, { message: "Choose an expiry date in the future." });
    }
    const token = generatePersonalApiKeyToken();
    try {
      const apiKey = await createPersonalApiKey(deps.db, {
        accountId: organizationId,
        ownerSubjectId: context.subjectId,
        name: body.name,
        description: body.description ?? null,
        prefix: token.slice(0, 14),
        keyHash: await sha256Hex(token),
        access: body.access,
        expiresAt,
      });
      const [projected] = await projectKeys(deps, [apiKey]);
      c.header("cache-control", "no-store");
      return c.json(CreatePersonalApiKeyResponse.parse({ apiKey: projected, token }), 201);
    } catch (error) {
      if (error instanceof PersonalApiKeyWorkspaceScopeError)
        throw new HTTPException(400, { message: error.message });
      if (error instanceof PersonalApiKeyLimitExceededError)
        throw new HTTPException(429, { message: error.message });
      throw error;
    }
  });

  app.delete("/v1/organizations/:organizationId/personal-api-keys/:apiKeyId", async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const { context, organizationId, admin } = await requireOrganizationPerson(c, deps, true);
    const apiKeyId = c.req.param("apiKeyId");
    if (!z.string().uuid().safeParse(apiKeyId).success) {
      throw new HTTPException(404, { message: "API key not found" });
    }
    const [existing] = await listPersonalApiKeys(deps.db, { accountId: organizationId, apiKeyId });
    if (!existing || (existing.ownerSubjectId !== context.subjectId && !admin)) {
      throw new HTTPException(404, { message: "API key not found" });
    }
    await revokePersonalApiKey(deps.db, { accountId: organizationId, apiKeyId });
    return c.body(null, 204);
  });
}

/**
 * A member of the organization signed in in this browser, or an agent (or
 * personal key) acting as them. Changes need the person's full access.
 */
async function requireOrganizationPerson(
  c: Context,
  deps: ApiRouteDeps,
  mutation: boolean,
): Promise<{ context: AccessContext; organizationId: string; admin: boolean }> {
  if (deps.settings.productAccessMode !== "managed") {
    throw new HTTPException(404, { message: "Personal API keys need Opengeni sign-in." });
  }
  if (isAgentActingAsPerson(c)) {
    if (mutation) requireFullAccessIfAgent(c, "Managing personal API keys");
  } else if (!c.req.header("cookie") || c.req.header("authorization")) {
    throw new HTTPException(403, {
      message: "Manage personal API keys in the Opengeni app in your browser.",
    });
  }
  const context = await requireAccessContext(c, deps);
  const organizationId = c.req.param("organizationId") ?? "";
  const grant = context.accountGrants.find((each) => each.accountId === organizationId);
  if (context.mode !== "managed" || !context.subjectId.startsWith("user:") || !grant) {
    throw new HTTPException(404, { message: "organization not found" });
  }
  return { context, organizationId, admin: hasPermission(grant.permissions, "account:admin") };
}

async function projectKeys(
  deps: ApiRouteDeps,
  keys: PersonalApiKeyRecord[],
): Promise<PersonalApiKey[]> {
  const userIds = [...new Set(keys.map((key) => key.ownerSubjectId.slice("user:".length)))];
  const profiles = new Map(
    (await getManagedUserProfilesByIds(deps.db, userIds)).map((profile) => [
      `user:${profile.id}`,
      profile,
    ]),
  );
  return keys.map((key) => {
    const profile = profiles.get(key.ownerSubjectId);
    return PersonalApiKey.parse({
      id: key.id,
      organizationId: key.accountId,
      name: key.name,
      description: key.description,
      prefix: key.prefix,
      access: key.access,
      owner: {
        subjectId: key.ownerSubjectId,
        name: profile?.name?.trim() || profile?.email || "Someone",
      },
      expiresAt: key.expiresAt?.toISOString() ?? null,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    });
  });
}

function generatePersonalApiKeyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${PERSONAL_API_KEY_TOKEN_PREFIX}${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
