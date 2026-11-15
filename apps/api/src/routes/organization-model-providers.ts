import {
  azureOpenAIDeploymentIdentityAvailable,
  claudeProviderId,
  connectedModelPriceBasisFromReportedModel,
  connectedModelPriceBasisModelIds,
  opperCredentialProblem,
  organizationConnectedModelListPrice,
  type AzureEntraProviderCredential,
  type Settings,
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
  SetOrganizationCustomModelListPriceRequest,
  UpsertOrganizationModelProviderConnectionRequest,
  type ConnectedModelListPrice,
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
  setOrganizationModelProviderCustomModelListPrice,
  upsertOrganizationModelProviderConnection,
  type ConnectedModelListPricing,
  type OrganizationModelProviderConnection,
  type OrganizationModelProviderCredential,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { offerClaudeDefaultModels } from "../claude-default-models";
import { assertAnthropicApiKey } from "../claude-workspace-connection";
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

/** Organization models whose provider reports no cost, so their price is declared. */
export type ListPricedModelKind = "openai" | "azure_openai" | "openai_compatible";

export function isListPricedModelKind(kind: string): kind is ListPricedModelKind {
  return kind === "openai" || kind === "azure_openai" || kind === "openai_compatible";
}

/**
 * The price an administrator asked for, checked: a base model must have a
 * known list rate, or the model would silently stay unpriced.
 */
export function acceptedListPrice(
  settings: Settings,
  price: ConnectedModelListPrice | null,
):
  | { basis: "model"; modelId: string }
  | { basis: "custom"; pricing: ConnectedModelListPricing }
  | null {
  if (
    price?.basis === "model" &&
    !connectedModelPriceBasisModelIds(settings).includes(price.modelId)
  )
    throw new HTTPException(422, {
      message: "Choose a base model with a known price, or enter the price yourself.",
    });
  return price;
}

/** The base model Azure reported serving, as a price for a new deployment. */
export function detectedListPrice(
  settings: Settings,
  reportedModel: string | null,
): { basis: "model"; modelId: string } | undefined {
  const modelId = connectedModelPriceBasisFromReportedModel(settings, reportedModel);
  return modelId ? { basis: "model", modelId } : undefined;
}

export function modelJson(
  model: {
    id: string;
    upstreamModelId: string;
    label: string | null;
    listPricingModelId?: string | null;
    listPricing?: ConnectedModelListPricing | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  },
  pricing?: { settings: Settings; kind: string },
) {
  return OrganizationProviderCustomModel.parse({
    ...model,
    ...(pricing && isListPricedModelKind(pricing.kind)
      ? organizationConnectedModelListPrice(pricing.settings, pricing.kind, model)
      : {}),
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
    const apiKey =
      kind === "anthropic" ? assertAnthropicApiKey(payload.apiKey ?? "") : (payload.apiKey ?? "");
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
    if (payload.models && kind !== "openai" && kind !== "azure_openai")
      throw new HTTPException(422, {
        message: "Only an OpenAI or Azure OpenAI connection saves models with its key.",
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
    const entraToken = authentication
      ? await organizationAzureEntraSetupToken(
          deps.settings,
          azureEntraCredential(authentication),
          deps.directModelFetch,
        )
      : null;
    // Models saved with the key are checked with it first, with the same
    // short request as adding one later, so nothing is saved if one fails.
    // Azure answers with each deployment's base model, which prices its usage.
    const modelListPrices: Record<string, { basis: "model"; modelId: string }> = {};
    for (const model of new Set(payload.models ?? [])) {
      const { reportedModel } = await verifyOrganizationDirectModel(
        kind === "openai"
          ? { provider: "openai", model }
          : { provider: "azure_openai", model, endpoint: payload.endpoint! },
        entraToken ?? apiKey,
        deps.directModelFetch,
      );
      const detected = detectedListPrice(deps.settings, reportedModel);
      if (detected) modelListPrices[model] = detected;
    }
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
        ...(payload.models ? { models: payload.models, modelListPrices } : {}),
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
      const kind = modelProviderKind(c.req.param("providerKind"));
      const models = await listOrganizationModelProviderCustomModels(deps.db, {
        organizationId,
        actorSubjectId: human.subjectId,
        providerKind: kind,
      });
      return c.json(
        OrganizationProviderCustomModelsResponse.parse({
          models: models.map((model) => modelJson(model, { settings: deps.settings, kind })),
          ...(kind === "openai" || kind === "azure_openai"
            ? { priceBasisModelIds: connectedModelPriceBasisModelIds(deps.settings) }
            : {}),
        }),
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
      let listPrice: ReturnType<typeof detectedListPrice>;
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
        // Azure answers with the deployment's base model, which prices its usage.
        const { reportedModel } = await verifyOrganizationDirectModel(
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
        listPrice = detectedListPrice(deps.settings, reportedModel);
      }
      try {
        const model = await createOrganizationModelProviderCustomModel(deps.db, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: kind,
          operationId: payload.operationId,
          upstreamModelId: payload.upstreamModelId,
          ...(payload.label === undefined ? {} : { label: payload.label }),
          ...(listPrice ? { listPrice } : {}),
        });
        return c.json(modelJson(model, { settings: deps.settings, kind }), 201);
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
        const kind = modelProviderKind(c.req.param("providerKind"));
        const model = await retireOrganizationModelProviderCustomModel(deps.db, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: kind,
          customModelId: customModelId.data,
          ...payload,
        });
        return c.json(modelJson(model, { settings: deps.settings, kind }));
      } catch (error) {
        conflict(error);
      }
    },
  );

  // Set what an OpenAI model's or Azure deployment's usage costs: a base
  // model's list rate, the administrator's own rate, or null for unknown.
  app.put(
    "/v1/organizations/:organizationId/model-providers/:providerKind/custom-models/:customModelId/list-price",
    async (c) => {
      c.header("cache-control", "private, no-store");
      requireSameOriginBrowserMutation(c, deps);
      const organizationId = parseOrganizationId(c.req.param("organizationId"));
      const human = await requireOrganizationCodexHuman(c, deps, organizationId);
      const kind = modelProviderKind(c.req.param("providerKind"));
      if (kind !== "openai" && kind !== "azure_openai")
        throw new HTTPException(404, {
          message: "This provider reports its own cost, so its models have no price to set.",
        });
      const payload = await jsonBody(
        c,
        SetOrganizationCustomModelListPriceRequest,
        "Choose a base model or enter a price",
      );
      const customModelId = z.string().uuid().safeParse(c.req.param("customModelId"));
      if (!customModelId.success) {
        throw new HTTPException(422, { message: "invalid organization custom model id" });
      }
      const price = acceptedListPrice(deps.settings, payload.listPrice);
      try {
        const model = await setOrganizationModelProviderCustomModelListPrice(deps.db, {
          organizationId,
          actorSubjectId: human.subjectId,
          providerKind: kind,
          customModelId: customModelId.data,
          expectedVersion: payload.expectedVersion,
          price,
        });
        return c.json(modelJson(model, { settings: deps.settings, kind }));
      } catch (error) {
        conflict(error);
      }
    },
  );
}
