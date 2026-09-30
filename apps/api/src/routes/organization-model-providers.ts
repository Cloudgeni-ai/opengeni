import { claudeProviderId } from "@opengeni/config";
import {
  CreateOrganizationProviderCustomModelRequest,
  DeleteOrganizationProviderCustomModelRequest,
  OrganizationModelProviderConnectionResponse,
  OrganizationModelProviderKind,
  OrganizationProviderCustomModel,
  OrganizationProviderCustomModelsResponse,
  RevokeOrganizationModelProviderConnectionRequest,
  UpsertOrganizationModelProviderConnectionRequest,
} from "@opengeni/contracts";
import { requireEnvironmentEncryption, type ApiRouteDeps } from "@opengeni/core";
import {
  createOrganizationModelProviderCustomModel,
  encryptEnvironmentValue,
  getOrganizationModelProviderConnection,
  listOrganizationModelProviderCustomModels,
  organizationModelProviderCredentialDigest,
  OrganizationModelProviderConflictError,
  OrganizationModelProviderLimitError,
  retireOrganizationModelProviderCustomModel,
  revokeOrganizationModelProviderConnection,
  upsertOrganizationModelProviderConnection,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireOrganizationCodexHuman, requireSameOriginBrowserMutation } from "./codex";

const OrganizationId = z.string().uuid();

function parseOrganizationId(value: string): string {
  const parsed = OrganizationId.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: "organization not found" });
  return parsed.data;
}

async function jsonBody<T>(c: Context, schema: z.ZodType<T>, message: string): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message });
  return parsed.data;
}

function providerKind(value: string) {
  const parsed = OrganizationModelProviderKind.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: "model provider not found" });
  return parsed.data;
}

function connectionJson(connection: {
  providerKind: "vercel_gateway" | "openrouter" | "anthropic" | "claude_subscription";
  status: "active" | "revoked";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return OrganizationModelProviderConnectionResponse.parse({
    ...connection,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  });
}

function modelJson(model: {
  id: string;
  upstreamModelId: string;
  label: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return OrganizationProviderCustomModel.parse({
    ...model,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  });
}

function conflict(error: unknown): never {
  if (error instanceof OrganizationModelProviderConflictError) {
    throw new HTTPException(409, { message: "organization model provider version conflict" });
  }
  if (error instanceof OrganizationModelProviderLimitError) {
    throw new HTTPException(409, { message: "organization custom model limit reached" });
  }
  throw error;
}

export function registerOrganizationModelProviderRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.use("/v1/organizations/:organizationId/model-providers/:providerKind", async (c, next) => {
    if (
      c.req.param("providerKind") === "claude_subscription" &&
      !deps.settings.claudeSubscriptionEnabled
    )
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    await next();
  });
  app.use("/v1/organizations/:organizationId/model-providers/:providerKind/*", async (c, next) => {
    if (
      c.req.param("providerKind") === "claude_subscription" &&
      !deps.settings.claudeSubscriptionEnabled
    )
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    await next();
  });
  app.get("/v1/organizations/:organizationId/model-providers/:providerKind", async (c) => {
    c.header("cache-control", "private, no-store");
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const connection = await getOrganizationModelProviderConnection(deps.db, {
      organizationId,
      actorSubjectId: human.subjectId,
      providerKind: providerKind(c.req.param("providerKind")),
    });
    return connection ? c.json(connectionJson(connection)) : c.json(null);
  });

  app.put("/v1/organizations/:organizationId/model-providers/:providerKind", async (c) => {
    c.header("cache-control", "private, no-store");
    requireSameOriginBrowserMutation(c, deps);
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const payload = await jsonBody(
      c,
      UpsertOrganizationModelProviderConnectionRequest,
      "invalid organization model provider connection",
    );
    const kind = providerKind(c.req.param("providerKind"));
    if (kind === "anthropic" && !/^sk-ant-api[0-9]+-\S+$/.test(payload.apiKey))
      throw new HTTPException(422, {
        message: "Enter an Anthropic API key. Use Claude subscription for setup tokens.",
      });
    if (kind === "claude_subscription" && !/^sk-ant-oat[0-9]+-\S+$/.test(payload.apiKey))
      throw new HTTPException(422, { message: "Enter the setup token from claude setup-token." });
    if (kind === "claude_subscription" && !payload.claudeIdentity)
      throw new HTTPException(422, {
        message: "Enter the Claude account UUID and device ID from your Claude Code configuration.",
      });
    if (kind !== "claude_subscription" && payload.claudeIdentity)
      throw new HTTPException(422, {
        message: "Claude identity is only valid for subscription connections.",
      });
    const credential =
      kind === "claude_subscription"
        ? JSON.stringify({ version: 1, token: payload.apiKey, identity: payload.claudeIdentity })
        : payload.apiKey;
    try {
      const connection = await upsertOrganizationModelProviderConnection(deps.db, {
        organizationId,
        actorSubjectId: human.subjectId,
        providerKind: providerKind(c.req.param("providerKind")),
        credentialEncrypted: encryptEnvironmentValue(
          requireEnvironmentEncryption(deps.settings),
          credential,
        ),
        credentialDigest: organizationModelProviderCredentialDigest(credential),
        operationId: payload.operationId,
        ...(payload.expectedVersion === undefined
          ? {}
          : { expectedVersion: payload.expectedVersion }),
      });
      return c.json(connectionJson(connection));
    } catch (error) {
      conflict(error);
    }
  });

  app.delete("/v1/organizations/:organizationId/model-providers/:providerKind", async (c) => {
    c.header("cache-control", "private, no-store");
    requireSameOriginBrowserMutation(c, deps);
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const payload = await jsonBody(
      c,
      RevokeOrganizationModelProviderConnectionRequest,
      "invalid organization model provider disconnect",
    );
    try {
      const connection = await revokeOrganizationModelProviderConnection(deps.db, {
        organizationId,
        actorSubjectId: human.subjectId,
        providerKind: providerKind(c.req.param("providerKind")),
        ...payload,
      });
      return c.json(connectionJson(connection));
    } catch (error) {
      conflict(error);
    }
  });

  app.get(
    "/v1/organizations/:organizationId/model-providers/:providerKind/custom-models",
    async (c) => {
      c.header("cache-control", "private, no-store");
      const organizationId = parseOrganizationId(c.req.param("organizationId"));
      const human = await requireOrganizationCodexHuman(c, deps, organizationId);
      const models = await listOrganizationModelProviderCustomModels(deps.db, {
        organizationId,
        actorSubjectId: human.subjectId,
        providerKind: providerKind(c.req.param("providerKind")),
      });
      return c.json(
        OrganizationProviderCustomModelsResponse.parse({ models: models.map(modelJson) }),
      );
    },
  );

  app.post(
    "/v1/organizations/:organizationId/model-providers/:providerKind/custom-models",
    async (c) => {
      c.header("cache-control", "private, no-store");
      requireSameOriginBrowserMutation(c, deps);
      const organizationId = parseOrganizationId(c.req.param("organizationId"));
      const human = await requireOrganizationCodexHuman(c, deps, organizationId);
      const payload = await jsonBody(
        c,
        CreateOrganizationProviderCustomModelRequest,
        "invalid organization custom model",
      );
      const kind = providerKind(c.req.param("providerKind"));
      if (
        (kind === "anthropic" || kind === "claude_subscription") &&
        `${claudeProviderId(kind)}/${payload.upstreamModelId}`.length > 256
      )
        throw new HTTPException(422, { message: "Claude model ID is too long" });
      try {
        const model = await createOrganizationModelProviderCustomModel(deps.db, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: providerKind(c.req.param("providerKind")),
          operationId: payload.operationId,
          upstreamModelId: payload.upstreamModelId,
          ...(payload.label === undefined ? {} : { label: payload.label }),
        });
        return c.json(modelJson(model), 201);
      } catch (error) {
        conflict(error);
      }
    },
  );

  app.delete(
    "/v1/organizations/:organizationId/model-providers/:providerKind/custom-models/:customModelId",
    async (c) => {
      c.header("cache-control", "private, no-store");
      requireSameOriginBrowserMutation(c, deps);
      const organizationId = parseOrganizationId(c.req.param("organizationId"));
      const human = await requireOrganizationCodexHuman(c, deps, organizationId);
      const payload = await jsonBody(
        c,
        DeleteOrganizationProviderCustomModelRequest,
        "invalid organization custom model deletion",
      );
      const customModelId = z.string().uuid().safeParse(c.req.param("customModelId"));
      if (!customModelId.success) {
        throw new HTTPException(422, { message: "invalid organization custom model id" });
      }
      try {
        const model = await retireOrganizationModelProviderCustomModel(deps.db, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: providerKind(c.req.param("providerKind")),
          customModelId: customModelId.data,
          ...payload,
        });
        return c.json(modelJson(model));
      } catch (error) {
        conflict(error);
      }
    },
  );
}
