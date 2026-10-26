import {
  azureOpenAIDeploymentIdentityAvailable,
  claudeProviderId,
  opperCredentialProblem,
  type AzureEntraProviderCredential,
} from "@opengeni/config";
import {
  CreateOrganizationProviderCustomModelRequest,
  DirectModelName,
  DeleteOrganizationProviderCustomModelRequest,
  OrganizationModelProviderConnectionResponse,
  type OrganizationModelProviderEntraAuthentication,
  OrganizationModelProviderKind,
  OrganizationProviderCustomModel,
  OrganizationProviderCustomModelsResponse,
  RevokeOrganizationModelProviderConnectionRequest,
  UpsertOrganizationModelProviderConnectionRequest,
} from "@opengeni/contracts";
import {
  organizationAzureEntraSetupToken,
  requireEnvironmentEncryption,
  verifyOrganizationDirectModel,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createOrganizationModelProviderCustomModel,
  encryptEnvironmentValue,
  getOrganizationModelProviderConnection,
  listOrganizationModelProviderCustomModels,
  loadOrganizationModelProviderCredentialForAdministrator,
  organizationModelProviderCredentialDigest,
  organizationModelProviderCredentialPlaintext,
  OrganizationModelProviderConflictError,
  OrganizationModelProviderLimitError,
  retireOrganizationModelProviderCustomModel,
  revokeOrganizationModelProviderConnection,
  upsertOrganizationModelProviderConnection,
  type OrganizationModelProviderConnection,
  type OrganizationModelProviderCredential,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { offerClaudeDefaultModels } from "../claude-default-models";
import { requireOrganizationCodexHuman } from "./codex";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { parseRequestBody } from "../http/request-body";

const OrganizationId = z.string().uuid();

function parseOrganizationId(value: string): string {
  const parsed = OrganizationId.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: "organization not found" });
  return parsed.data;
}

async function jsonBody<T>(c: Context, schema: z.ZodType<T>, message: string): Promise<T> {
  const parsed = parseRequestBody(schema, await c.req.json().catch(() => null), {
    status: 422,
    message: message,
  });
  return parsed;
}

function providerKind(value: string) {
  const parsed = OrganizationModelProviderKind.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: "model provider not found" });
  return parsed.data;
}

/** Providers whose organization key runs models the organization can add by ID. */
function modelProviderKind(value: string) {
  const kind = providerKind(value);
  if (kind === "elevenlabs") throw new HTTPException(404, { message: "model provider not found" });
  return kind;
}

function connectionJson(connection: OrganizationModelProviderConnection) {
  // Metadata only: the encrypted key or client secret never leaves the
  // database layer. Azure's resource endpoint and sign-in method are
  // non-secret configuration and are returned.
  const { endpoint, authMethod, ...rest } = connection;
  return OrganizationModelProviderConnectionResponse.parse({
    ...rest,
    ...(endpoint ? { endpoint } : {}),
    ...(connection.providerKind === "azure_openai" ? { authMethod } : {}),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  });
}

function azureEntraCredential(
  authentication: OrganizationModelProviderEntraAuthentication,
): AzureEntraProviderCredential {
  return authentication.method === "entra_client_secret"
    ? {
        source: "client_secret",
        tenantId: authentication.tenantId,
        clientId: authentication.clientId,
        clientSecret: authentication.clientSecret,
      }
    : { source: "deployment_identity" };
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
    if (c.req.param("providerKind") === "claude_subscription")
      throw new HTTPException(410, { message: "Claude subscriptions use individual accounts." });
    const connection = await getOrganizationModelProviderConnection(deps.db, {
      organizationId,
      actorSubjectId: human.subjectId,
      providerKind: providerKind(c.req.param("providerKind")),
    });
    return connection ? c.json(connectionJson(connection)) : c.json(null);
  });
  const usagePath = "/v1/organizations/:organizationId/model-providers/:providerKind/usage";
  async function usageScope(c: Context) {
    c.header("cache-control", "private, no-store");
    if (providerKind(c.req.param("providerKind")!) !== "claude_subscription")
      throw new HTTPException(404, { message: "Usage not available for this provider" });
    const organizationId = parseOrganizationId(c.req.param("organizationId")!);
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    return {
      accountId: organizationId,
      workspaceId: null,
      scope: "organization" as const,
      actorSubjectId: human.subjectId,
    };
  }
  app.get(usagePath, async (c) => {
    await usageScope(c);
    throw new HTTPException(410, { message: "Check usage on the individual Claude account." });
  });
  app.post(`${usagePath}/refresh`, async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    await usageScope(c);
    throw new HTTPException(410, { message: "Check usage on the individual Claude account." });
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
    if (kind === "claude_subscription")
      throw new HTTPException(410, { message: "Claude subscriptions use individual accounts." });
    const authentication = payload.authentication;
    if (authentication && kind !== "azure_openai")
      throw new HTTPException(422, {
        message: "Only an Azure OpenAI connection signs in with Microsoft Entra ID.",
      });
    const apiKey = payload.apiKey ?? "";
    if (kind === "anthropic" && !/^sk-ant-api[0-9]+-\S+$/.test(apiKey))
      throw new HTTPException(422, {
        message: "Enter an Anthropic API key. Use Claude subscription for setup tokens.",
      });
    const opperProblem = kind === "opper" ? opperCredentialProblem(apiKey) : null;
    if (opperProblem) throw new HTTPException(422, { message: opperProblem });
    if (kind === "azure_openai" && !payload.endpoint)
      throw new HTTPException(422, {
        message: "Enter your Azure OpenAI resource endpoint (https://RESOURCE.openai.azure.com).",
      });
    if (kind !== "azure_openai" && payload.endpoint !== undefined)
      throw new HTTPException(422, {
        message: "An endpoint is only valid for an Azure OpenAI connection.",
      });
    if (payload.claudeIdentity)
      throw new HTTPException(422, {
        message: "Claude identity is only valid for subscription connections.",
      });
    // The deployment's own identity serves organizations only when its
    // operator offers it; no organization can claim it otherwise.
    if (
      authentication?.method === "entra_deployment_identity" &&
      !azureOpenAIDeploymentIdentityAvailable(deps.settings)
    )
      throw new HTTPException(422, {
        message: "This deployment doesn’t offer its own identity for Azure OpenAI.",
      });
    // Sign in once before saving, so a wrong tenant, app or secret is caught
    // here instead of on the first turn. The token itself is not kept.
    if (authentication)
      await organizationAzureEntraSetupToken(
        deps.settings,
        azureEntraCredential(authentication),
        deps.directModelFetch,
      );
    const stored: OrganizationModelProviderCredential =
      authentication?.method === "entra_client_secret"
        ? {
            method: "entra_client_secret",
            tenantId: authentication.tenantId,
            clientId: authentication.clientId,
            clientSecret: authentication.clientSecret,
          }
        : authentication?.method === "entra_deployment_identity"
          ? { method: "entra_deployment_identity" }
          : { method: "api_key", apiKey };
    const { authMethod, plaintext: credential } =
      organizationModelProviderCredentialPlaintext(stored);
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
        ...(kind === "azure_openai" ? { endpoint: payload.endpoint ?? null } : {}),
        ...(authMethod === "api_key" ? {} : { authMethod }),
        operationId: payload.operationId,
        ...(payload.expectedVersion === undefined
          ? {}
          : { expectedVersion: payload.expectedVersion }),
      });
      if (kind === "anthropic")
        await offerClaudeDefaultModels(deps, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: kind,
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
      if (c.req.param("providerKind") === "claude_subscription")
        throw new HTTPException(410, { message: "Claude subscriptions use individual accounts." });
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
        providerKind: modelProviderKind(c.req.param("providerKind")),
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
      const kind = modelProviderKind(c.req.param("providerKind"));
      if (
        (kind === "anthropic" || kind === "claude_subscription") &&
        `${claudeProviderId(kind)}/${payload.upstreamModelId}`.length > 256
      )
        throw new HTTPException(422, { message: "Claude model ID is too long" });
      if (kind === "openai" || kind === "azure_openai") {
        // The upstream id is the exact OpenAI model or Azure deployment name.
        // Check that the organization's own key (and Azure endpoint) can call
        // it before saving, with the same short Responses request as workspace
        // direct setup and the same model-name rule.
        const title = kind === "openai" ? "OpenAI" : "Azure OpenAI";
        if (!DirectModelName.safeParse(payload.upstreamModelId).success)
          throw new HTTPException(422, {
            message:
              kind === "openai"
                ? "Enter the exact OpenAI model ID."
                : "Enter the exact Azure OpenAI deployment name.",
          });
        const credential = await loadOrganizationModelProviderCredentialForAdministrator(
          deps.db,
          deps.settings,
          { organizationId, actorSubjectId: human.subjectId, providerKind: kind },
        );
        if (!credential || (kind === "azure_openai" && !credential.endpoint))
          throw new HTTPException(409, {
            message: `Connect ${title} for the organization before adding ${kind === "openai" ? "models" : "deployments"}.`,
          });
        await verifyOrganizationDirectModel(
          kind === "openai"
            ? { provider: "openai", model: payload.upstreamModelId }
            : {
                provider: "azure_openai",
                model: payload.upstreamModelId,
                endpoint: credential.endpoint!,
              },
          "azureEntra" in credential
            ? await organizationAzureEntraSetupToken(
                deps.settings,
                credential.azureEntra,
                deps.directModelFetch,
              )
            : credential.apiKey,
          deps.directModelFetch,
        );
      }
      try {
        const model = await createOrganizationModelProviderCustomModel(deps.db, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: modelProviderKind(c.req.param("providerKind")),
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
          providerKind: modelProviderKind(c.req.param("providerKind")),
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
