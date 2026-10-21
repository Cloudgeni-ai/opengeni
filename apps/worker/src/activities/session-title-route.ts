import {
  configuredModelPricingSchedules,
  type Settings,
  type ResolvedModelProvider,
} from "@opengeni/config";
import { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  getOrganizationModelProviderExecutionConnectionId,
  getWorkspaceProviderApiKeyConnectionMetadata,
  loadConnectionCredentialForBroker,
  loadDirectModelProviderConnection,
  loadOrganizationModelProviderApiKey,
  workspaceProviderApiKeyConnectionSpec,
  type Database,
} from "@opengeni/db";
import { z } from "zod";
import { sessionTitleReasoningEffort, type SessionTitleRoute } from "./agent-turn/session-title";

/** Private opener plus non-secret accepted routing/accounting facts, encrypted at rest. */
export const SessionTitleRequest = z.object({
  version: z.literal(1),
  prompt: z.string().max(16_000),
  policy: TurnExecutionPolicyV1,
  providerId: z.string(),
  modelId: z.string(),
  upstreamModelId: z.string(),
  definitionVersion: z.string(),
  apiConnectionId: z.string().nullable(),
  expectedTitle: z.object({
    title: z.string().nullable(),
    source: z.enum(["agent", "user"]).nullable(),
  }),
  creditPolicyRevision: z.number().int().optional(),
  externallyBilled: z.boolean(),
  chargesOpenGeniCredits: z.boolean(),
  countsTowardTokenCap: z.boolean(),
  pricingJson: z.string(),
  serviceTier: z.enum(["fast", "priority", "ultrafast"]).optional(),
});
export type SessionTitleRequest = z.infer<typeof SessionTitleRequest>;

export class SessionTitleRouteUnavailableError extends Error {}

const tokenDetails = z.record(z.string(), z.number().finite());
const tokenCounts = {
  inputTokens: z.number().finite().optional(),
  outputTokens: z.number().finite().optional(),
  totalTokens: z.number().finite().optional(),
};
/** Only finite provider usage and the normalized title are retained for settlement. */
export const SessionTitleResponse = z.object({
  title: z.string().nullable(),
  usage: z
    .object({
      responseId: z.string().optional(),
      serviceTier: z.string().optional(),
      webSearchRequests: z.number().finite().optional(),
      gatewayBilling: z
        .object({ finalProvider: z.string(), inferenceCostUsd: z.string() })
        .optional(),
      usage: z.object({
        ...tokenCounts,
        inputTokensDetails: z.union([tokenDetails, z.array(tokenDetails)]).optional(),
        outputTokensDetails: z.union([tokenDetails, z.array(tokenDetails)]).optional(),
        requestUsageEntries: z
          .array(
            z.object({
              ...tokenCounts,
              input_tokens: z.number().finite().optional(),
              output_tokens: z.number().finite().optional(),
              total_tokens: z.number().finite().optional(),
              inputTokensDetails: tokenDetails.optional(),
              outputTokensDetails: tokenDetails.optional(),
              input_tokens_details: tokenDetails.optional(),
              output_tokens_details: tokenDetails.optional(),
            }),
          )
          .optional(),
      }),
    })
    .nullable(),
});

const providerKinds = {
  "vercel-gateway-workspace": "vercel_gateway",
  "vercel-gateway-organization": "vercel_gateway",
  "openrouter-workspace": "openrouter",
  "openrouter-organization": "openrouter",
  "opper-workspace": "opper",
  "opper-organization": "opper",
  "anthropic-workspace": "anthropic",
  "anthropic-organization": "anthropic",
  "direct-openai-organization": "openai",
  "direct-azure-organization": "azure_openai",
} as const;

/** Pin the exact materialized customer-key connection, never merely its provider. */
export async function sessionTitleApiConnectionId(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  productModelId: string;
  provider: ResolvedModelProvider;
}): Promise<string | null> {
  const { db, settings, provider, workspaceId, accountId } = input;
  if (
    !("mechanism" in provider.credentialSource) ||
    provider.credentialSource.mechanism !== "api_key"
  )
    return null;
  if (provider.kind === "direct-openai-workspace" || provider.kind === "direct-azure-workspace") {
    const connection = await loadDirectModelProviderConnection(
      db,
      settings,
      workspaceId,
      input.productModelId,
    );
    if (!connection || connection.apiKey !== provider.apiKey)
      throw new SessionTitleRouteUnavailableError("Title model connection changed");
    return connection.id;
  }
  const kind = providerKinds[provider.kind as keyof typeof providerKinds];
  if (provider.credentialSource.kind === "workspace_connection") {
    if (!kind || kind === "openai" || kind === "azure_openai")
      throw new SessionTitleRouteUnavailableError("Title workspace provider is unsupported");
    const metadata = await getWorkspaceProviderApiKeyConnectionMetadata(db, workspaceId, kind);
    const spec = workspaceProviderApiKeyConnectionSpec(kind);
    const connection =
      metadata &&
      (await loadConnectionCredentialForBroker(db, settings, {
        workspaceId,
        connectionId: metadata.connectionId,
        providerDomain: spec.providerDomain,
        kind: "api_key",
        allowSubjectOwned: false,
      }));
    if (!connection || connection.credential.apiKey !== provider.apiKey)
      throw new SessionTitleRouteUnavailableError("Title model connection changed");
    return connection.id;
  }
  if (provider.credentialSource.kind === "organization_connection") {
    if (!kind)
      throw new SessionTitleRouteUnavailableError("Title organization provider is unsupported");
    const scope = { accountId, workspaceId, providerKind: kind };
    const id = await getOrganizationModelProviderExecutionConnectionId(db, scope);
    if (
      !id ||
      (await loadOrganizationModelProviderApiKey(db, settings, scope)) !== provider.apiKey
    ) {
      throw new SessionTitleRouteUnavailableError("Title model connection changed");
    }
    return id;
  }
  return null;
}

export function sessionTitleRouteIdentity(route: SessionTitleRoute) {
  if (!route.resolvedModel)
    throw new SessionTitleRouteUnavailableError(
      "Independent title requires an accepted model route",
    );
  return {
    providerId: route.resolvedModel.provider.id,
    modelId: route.resolvedModel.configured.id,
    upstreamModelId: route.modelName,
    definitionVersion: route.resolvedModel.configured.definitionVersion,
  };
}

export function assertSessionTitleRoute(
  request: SessionTitleRequest,
  route: SessionTitleRoute,
): void {
  const actual = sessionTitleRouteIdentity(route);
  if (
    Object.entries(actual).some(([key, value]) => request[key as keyof typeof actual] !== value)
  ) {
    throw new SessionTitleRouteUnavailableError("Accepted title model route changed");
  }
}

export function titlePricingJson(settings: Settings, modelId: string): string {
  const pricing = configuredModelPricingSchedules(settings)[modelId];
  return JSON.stringify(pricing ? { [modelId]: pricing } : {});
}

export { sessionTitleReasoningEffort };
