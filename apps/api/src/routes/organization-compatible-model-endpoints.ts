import {
  CreateOrganizationCompatibleEndpointModelRequest,
  CreateOrganizationCompatibleEndpointRequest,
  DeleteOrganizationProviderCustomModelRequest,
  OrganizationCompatibleEndpoint,
  OrganizationCompatibleEndpointsResponse,
  OrganizationProviderCustomModel,
  ReplaceOrganizationCompatibleEndpointKeyRequest,
  RevokeOrganizationModelProviderConnectionRequest,
  type CompatibleModelApi,
} from "@opengeni/contracts";
import {
  requireEnvironmentEncryption,
  verifyDirectModelAccess,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createOrganizationCompatibleEndpoint,
  createOrganizationCompatibleEndpointModel,
  encryptEnvironmentValue,
  listOrganizationCompatibleEndpointModels,
  listOrganizationCompatibleEndpoints,
  loadOrganizationCompatibleEndpointCredentialForAdministrator,
  organizationModelProviderCredentialDigest,
  OrganizationModelProviderConflictError,
  OrganizationModelProviderLimitError,
  replaceOrganizationCompatibleEndpointKey,
  retireOrganizationCompatibleEndpointModel,
  revokeOrganizationCompatibleEndpoint,
  type OrganizationCompatibleEndpoint as StoredEndpoint,
  type OrganizationCompatibleEndpointModel as StoredModel,
} from "@opengeni/db";
import { pinnedFetch } from "@opengeni/network";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireOrganizationCodexHuman } from "./codex";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { parseRequestBody } from "../http/request-body";

// An organization's own OpenAI-compatible endpoints, connected like its other
// model accounts (same administrators, same origin check, same workspace
// access policy through the model-connections access routes), except that an
// organization can connect several: each is addressed by its connection id.
// Every model and key is checked with a short request to the endpoint before
// it is saved; that request, like every later model call, is DNS-pinned to
// public addresses and refuses redirects.

const BASE = "/v1/organizations/:organizationId/model-providers/openai_compatible/endpoints";

function uuidParam(c: Context, name: string, notFound: string): string {
  const parsed = z.string().uuid().safeParse(c.req.param(name));
  if (!parsed.success) throw new HTTPException(404, { message: notFound });
  return parsed.data;
}

async function jsonBody<T>(c: Context, schema: z.ZodType<T>, message: string): Promise<T> {
  return parseRequestBody(schema, await c.req.json().catch(() => null), { status: 422, message });
}

function modelJson(model: StoredModel) {
  return OrganizationProviderCustomModel.parse({
    id: model.id,
    upstreamModelId: model.upstreamModelId,
    label: model.label,
    version: model.version,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  });
}

function endpointJson(endpoint: StoredEndpoint, models: readonly StoredModel[]) {
  return OrganizationCompatibleEndpoint.parse({
    id: endpoint.id,
    status: endpoint.status,
    version: endpoint.version,
    baseUrl: endpoint.baseUrl,
    api: endpoint.api,
    label: endpoint.label,
    models: models.map(modelJson),
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  });
}

function conflict(error: unknown, limitMessage: string): never {
  if (error instanceof OrganizationModelProviderConflictError)
    throw new HTTPException(409, {
      message: "This endpoint changed or was disconnected. Reload and try again.",
    });
  if (error instanceof OrganizationModelProviderLimitError)
    throw new HTTPException(409, { message: limitMessage });
  throw error;
}

export function registerOrganizationCompatibleModelEndpointRoutes(
  app: Hono,
  deps: ApiRouteDeps,
): void {
  /** Send one short test request to the endpoint, DNS-pinned like every call to it. */
  async function verify(
    endpoint: { baseUrl: string; api: CompatibleModelApi },
    model: string,
    apiKey: string,
  ): Promise<void> {
    await verifyDirectModelAccess(
      { provider: "openai_compatible", baseUrl: endpoint.baseUrl, api: endpoint.api, model },
      apiKey,
      deps.directModelFetch ??
        (((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          pinnedFetch(input as string | URL | Request, init, deps.settings, {
            label: "Model endpoint",
            requireHttpsOutsideLocalTest: true,
          })) as typeof fetch),
    );
  }

  async function administrator(c: Context, mutate: boolean) {
    c.header("cache-control", "private, no-store");
    if (mutate) requireSameOriginBrowserMutation(c, deps);
    const organizationId = uuidParam(c, "organizationId", "organization not found");
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    return { organizationId, actorSubjectId: human.subjectId };
  }

  async function activeEndpoint(
    actor: { organizationId: string; actorSubjectId: string },
    connectionId: string,
  ) {
    const active = await loadOrganizationCompatibleEndpointCredentialForAdministrator(
      deps.db,
      deps.settings,
      { ...actor, connectionId },
    );
    if (!active) throw new HTTPException(404, { message: "Endpoint not found" });
    return active;
  }

  app.get(BASE, async (c) => {
    const actor = await administrator(c, false);
    const endpoints = await listOrganizationCompatibleEndpoints(deps.db, actor);
    return c.json(
      OrganizationCompatibleEndpointsResponse.parse({
        endpoints: endpoints.map(({ endpoint, models }) => endpointJson(endpoint, models)),
      }),
    );
  });

  app.post(BASE, async (c) => {
    const actor = await administrator(c, true);
    const payload = await jsonBody(
      c,
      CreateOrganizationCompatibleEndpointRequest,
      "Enter the endpoint’s public HTTPS base URL, an API key and a model ID",
    );
    const key = requireEnvironmentEncryption(deps.settings);
    await verify(payload, payload.model, payload.apiKey);
    try {
      const { endpoint, model } = await createOrganizationCompatibleEndpoint(deps.db, {
        ...actor,
        credentialEncrypted: encryptEnvironmentValue(key, payload.apiKey),
        credentialDigest: organizationModelProviderCredentialDigest(payload.apiKey),
        baseUrl: payload.baseUrl,
        api: payload.api,
        label: payload.label ?? null,
        upstreamModelId: payload.model,
        operationId: payload.operationId,
      });
      return c.json(endpointJson(endpoint, [model]), 201);
    } catch (error) {
      conflict(error, "This organization has connected the most endpoints it can.");
    }
  });

  app.put(`${BASE}/:connectionId/key`, async (c) => {
    const actor = await administrator(c, true);
    const connectionId = uuidParam(c, "connectionId", "Endpoint not found");
    const payload = await jsonBody(
      c,
      ReplaceOrganizationCompatibleEndpointKeyRequest,
      "Enter the endpoint’s new API key",
    );
    const key = requireEnvironmentEncryption(deps.settings);
    const { endpoint } = await activeEndpoint(actor, connectionId);
    // Check the new key with one of the endpoint's models.
    const [model] = await listOrganizationCompatibleEndpointModels(deps.db, {
      ...actor,
      connectionId,
    });
    if (model) await verify(endpoint, model.upstreamModelId, payload.apiKey);
    try {
      const updated = await replaceOrganizationCompatibleEndpointKey(deps.db, {
        ...actor,
        connectionId,
        credentialEncrypted: encryptEnvironmentValue(key, payload.apiKey),
        credentialDigest: organizationModelProviderCredentialDigest(payload.apiKey),
        operationId: payload.operationId,
        expectedVersion: payload.expectedVersion,
      });
      const models = await listOrganizationCompatibleEndpointModels(deps.db, {
        ...actor,
        connectionId,
      });
      return c.json(endpointJson(updated, models));
    } catch (error) {
      conflict(error, "This endpoint can’t take another change right now.");
    }
  });

  app.delete(`${BASE}/:connectionId`, async (c) => {
    const actor = await administrator(c, true);
    const connectionId = uuidParam(c, "connectionId", "Endpoint not found");
    const payload = await jsonBody(
      c,
      RevokeOrganizationModelProviderConnectionRequest,
      "invalid endpoint disconnect",
    );
    try {
      const revoked = await revokeOrganizationCompatibleEndpoint(deps.db, {
        ...actor,
        connectionId,
        ...payload,
      });
      return c.json(endpointJson(revoked, []));
    } catch (error) {
      conflict(error, "This endpoint can’t take another change right now.");
    }
  });

  app.post(`${BASE}/:connectionId/models`, async (c) => {
    const actor = await administrator(c, true);
    const connectionId = uuidParam(c, "connectionId", "Endpoint not found");
    const payload = await jsonBody(
      c,
      CreateOrganizationCompatibleEndpointModelRequest,
      "Enter a model ID exactly as your provider lists it",
    );
    const { endpoint, apiKey } = await activeEndpoint(actor, connectionId);
    await verify(endpoint, payload.upstreamModelId, apiKey);
    try {
      const model = await createOrganizationCompatibleEndpointModel(deps.db, {
        ...actor,
        connectionId,
        upstreamModelId: payload.upstreamModelId,
        operationId: payload.operationId,
      });
      return c.json(modelJson(model), 201);
    } catch (error) {
      conflict(error, "This endpoint has the most models it can have.");
    }
  });

  app.delete(`${BASE}/:connectionId/models/:customModelId`, async (c) => {
    const actor = await administrator(c, true);
    const connectionId = uuidParam(c, "connectionId", "Endpoint not found");
    const customModelId = uuidParam(c, "customModelId", "Model not found");
    const payload = await jsonBody(
      c,
      DeleteOrganizationProviderCustomModelRequest,
      "invalid endpoint model removal",
    );
    try {
      const model = await retireOrganizationCompatibleEndpointModel(deps.db, {
        ...actor,
        connectionId,
        customModelId,
        ...payload,
      });
      return c.json(modelJson(model));
    } catch (error) {
      conflict(error, "This endpoint can’t take another change right now.");
    }
  });
}
