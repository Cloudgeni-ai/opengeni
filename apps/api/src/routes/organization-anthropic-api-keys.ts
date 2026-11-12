import {
  AddOrganizationAnthropicApiKeyRequest,
  OrganizationAnthropicApiKey,
  OrganizationAnthropicApiKeysResponse,
  UpdateOrganizationAnthropicApiKeyRequest,
} from "@opengeni/contracts";
import { requireEnvironmentEncryption, type ApiRouteDeps } from "@opengeni/core";
import {
  addOrganizationAnthropicApiKey,
  clearOrganizationAnthropicApiKeyCreditRefusal,
  encryptEnvironmentValue,
  listOrganizationAnthropicApiKeys,
  loadOrganizationModelProviderCredentialForAdministrator,
  organizationModelProviderCredentialDigest,
  OrganizationModelProviderConflictError,
  OrganizationModelProviderLimitError,
  relabelOrganizationAnthropicApiKey,
  removeOrganizationAnthropicApiKey,
  type OrganizationAnthropicApiKey as StoredKey,
  type OrganizationAnthropicApiKeys as StoredKeys,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { assertAnthropicApiKey } from "../claude-workspace-connection";
import { requireOrganizationCodexHuman } from "./codex";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { parseRequestBody } from "../http/request-body";

// An organization's Anthropic API connection can hold several API keys, for
// its `organization-anthropic/` models only (never Claude subscription
// models). The connection's own key is the first; the others are added here
// by the same administrators. Each session keeps one key while it serves, and
// a key Anthropic refuses for lack of credits is left out until an
// administrator lets it serve again. Key values are never returned.

const BASE = "/v1/organizations/:organizationId/model-providers/anthropic/api-keys";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

function keyJson(key: StoredKey) {
  return OrganizationAnthropicApiKey.parse({
    ...key,
    creditRefusedAt: key.creditRefusedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  });
}

function keysJson(keys: StoredKeys) {
  return OrganizationAnthropicApiKeysResponse.parse({
    connectionVersion: keys.connectionVersion,
    keys: keys.keys.map(keyJson),
  });
}

function keyIdParam(c: Context): string {
  const parsed = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/)
    .safeParse(c.req.param("keyId"));
  if (!parsed.success) throw new HTTPException(404, { message: "API key not found" });
  return parsed.data;
}

const NO_CONNECTION =
  "Connect the organization's Anthropic API key first; further keys are added beside it.";

/**
 * Check a key with Anthropic's free model listing and read the Anthropic
 * organization it belongs to. Sends no model request and costs nothing.
 */
export async function anthropicApiKeyOrganization(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HTTPException(502, {
      message: "Couldn't reach Anthropic to check the API key. Try again.",
    });
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403)
    throw new HTTPException(422, {
      message: "Anthropic didn't accept this API key. Check it in the Claude Console.",
    });
  if (!response.ok)
    throw new HTTPException(502, {
      message: "Anthropic couldn't check the API key just now. Try again.",
    });
  const organization = response.headers.get("anthropic-organization-id")?.trim() ?? "";
  return /^[A-Za-z0-9-]{1,128}$/.test(organization) ? organization : null;
}

export function registerOrganizationAnthropicApiKeyRoutes(app: Hono, deps: ApiRouteDeps): void {
  async function administrator(c: Context, mutate: boolean) {
    c.header("cache-control", "private, no-store");
    if (mutate) requireSameOriginBrowserMutation(c, deps);
    const parsed = z.string().uuid().safeParse(c.req.param("organizationId"));
    if (!parsed.success) throw new HTTPException(404, { message: "organization not found" });
    const human = await requireOrganizationCodexHuman(c, deps, parsed.data);
    return { organizationId: parsed.data, actorSubjectId: human.subjectId };
  }

  function limit(error: unknown): never {
    if (error instanceof OrganizationModelProviderLimitError)
      throw new HTTPException(409, {
        message: "This Anthropic API connection holds the most keys it can.",
      });
    if (error instanceof OrganizationModelProviderConflictError)
      throw new HTTPException(409, {
        message: "Replace or disconnect the connection's own key on the connection itself.",
      });
    throw error;
  }

  app.get(BASE, async (c) => {
    const actor = await administrator(c, false);
    const keys = await listOrganizationAnthropicApiKeys(deps.db, actor);
    if (!keys) throw new HTTPException(404, { message: NO_CONNECTION });
    return c.json(keysJson(keys));
  });

  app.post(BASE, async (c) => {
    const actor = await administrator(c, true);
    const payload = parseRequestBody(
      AddOrganizationAnthropicApiKeyRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "Enter an Anthropic API key and a name for it" },
    );
    const encryption = requireEnvironmentEncryption(deps.settings);
    const apiKey = assertAnthropicApiKey(payload.apiKey);
    const connection = await loadOrganizationModelProviderCredentialForAdministrator(
      deps.db,
      deps.settings,
      { ...actor, providerKind: "anthropic" },
    );
    if (!connection) throw new HTTPException(404, { message: NO_CONNECTION });
    if ("apiKey" in connection && connection.apiKey === apiKey)
      throw new HTTPException(409, { message: "This is already the connection's own key." });
    const anthropicOrganizationId = await anthropicApiKeyOrganization(apiKey, deps.claudeFetch);
    try {
      const added = await addOrganizationAnthropicApiKey(deps.db, {
        ...actor,
        label: payload.label,
        credentialEncrypted: encryptEnvironmentValue(encryption, apiKey),
        credentialDigest: organizationModelProviderCredentialDigest(apiKey),
        anthropicOrganizationId,
      });
      if (!added) throw new HTTPException(404, { message: NO_CONNECTION });
      return c.json(keyJson(added.key), added.added ? 201 : 200);
    } catch (error) {
      limit(error);
    }
  });

  app.patch(`${BASE}/:keyId`, async (c) => {
    const actor = await administrator(c, true);
    const keyId = keyIdParam(c);
    const payload = parseRequestBody(
      UpdateOrganizationAnthropicApiKeyRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "Enter a name for the key" },
    );
    const key = await relabelOrganizationAnthropicApiKey(deps.db, {
      ...actor,
      keyId,
      label: payload.label,
    });
    if (!key) throw new HTTPException(404, { message: "API key not found" });
    return c.json(keyJson(key));
  });

  app.delete(`${BASE}/:keyId`, async (c) => {
    const actor = await administrator(c, true);
    const keyId = keyIdParam(c);
    try {
      await removeOrganizationAnthropicApiKey(deps.db, { ...actor, keyId });
    } catch (error) {
      limit(error);
    }
    return c.body(null, 204);
  });

  // After credits were added to a key's Anthropic organization: let it serve
  // again. If it is still out of credits, the next refused request marks it.
  app.post(`${BASE}/:keyId/serve-again`, async (c) => {
    const actor = await administrator(c, true);
    const keyId = keyIdParam(c);
    const key = await clearOrganizationAnthropicApiKeyCreditRefusal(deps.db, { ...actor, keyId });
    if (!key) throw new HTTPException(404, { message: "API key not found" });
    return c.json(keyJson(key));
  });
}
