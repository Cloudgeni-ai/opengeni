import {
  configuredModelPricingSchedules,
  organizationCompatibleConnectionIdOf,
  type Settings,
  type ResolvedModelProvider,
} from "@opengeni/config";
import { AgentTitleInstructions, TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  getOrganizationModelProviderExecutionConnectionId,
  getWorkspaceProviderApiKeyConnectionMetadata,
  loadConnectionCredentialForBroker,
  loadDirectModelProviderConnection,
  loadOrganizationCompatibleEndpointApiKey,
  loadOrganizationModelProviderApiKey,
  loadOrganizationModelProviderCredential,
  workspaceProviderApiKeyConnectionSpec,
  type Database,
} from "@opengeni/db";
import { z } from "zod";
import { sessionTitleReasoningEffort, type SessionTitleRoute } from "./agent-turn/session-title";

/** Private opener plus non-secret accepted routing/accounting facts, encrypted at rest. */
export const SessionTitleRequest = z.object({
  version: z.literal(1),
  prompt: z.string().max(16_000),
  /** The host's `agent.titleInstructions`; requests admitted before it existed omit it. */
  titleInstructions: AgentTitleInstructions.optional(),
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
  /** Served by the person's own API key (pays the platform fee); older requests omit it. */
  byok: z.boolean().optional(),
  pricingJson: z.string(),
  serviceTier: z.enum(["fast", "priority", "ultrafast"]).optional(),
  /**
   * Processing residency of the accepted title route, recorded on the title's
   * usage event and fact. Read with `parseModelCallProcessingResidency`;
   * requests admitted before it existed omit it and record unknown.
   */
  processingResidency: z.unknown().optional(),
});
export type SessionTitleRequest = z.infer<typeof SessionTitleRequest>;

export class SessionTitleRouteUnavailableError extends Error {}

export type SessionTitleFailureStage =
  | "admission"
  | "provider_request"
  | "response"
  | "billing"
  | "settlement";

const PROVIDER_ERROR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/u;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * A bounded, content-free reason for a failed title: the stage, the error's
 * class name, and the provider's HTTP status and error code/type when the
 * provider refused the request. Never a message, body or prompt.
 */
export function sessionTitleFailureDiagnostic(
  error: unknown,
  stage: SessionTitleFailureStage,
): Record<string, string | number> {
  const diagnostic: Record<string, string | number> = {
    errorClass: "IndependentSessionTitleError",
    errorCode: `independent_session_title_${stage}_failed`,
    origin: "worker",
  };
  try {
    if (error instanceof Error && ERROR_NAME.test(error.name))
      diagnostic.sessionTitleErrorName = error.name;
    // Status, code and type are the provider's only for the provider request;
    // elsewhere a `code` is a database or runtime code, not the provider's.
    if (stage !== "provider_request" || !error || typeof error !== "object") return diagnostic;
    const fields = error as { status?: unknown; code?: unknown; type?: unknown };
    const status = Number(fields.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.status = status;
    if (typeof fields.code === "string" && PROVIDER_ERROR_TOKEN.test(fields.code))
      diagnostic.providerErrorCode = fields.code;
    if (typeof fields.type === "string" && PROVIDER_ERROR_TOKEN.test(fields.type))
      diagnostic.providerErrorType = fields.type;
  } catch {
    // Diagnostics are best-effort and never replace the failure itself.
  }
  return diagnostic;
}

/**
 * The retained title usage is validated field by field, never all or nothing:
 * the title was already billed from the provider's raw usage, so a value this
 * schema cannot keep must not fail the title. Chat-compatible providers report
 * unset counters as null (for example `audio_tokens: null`), and raw usage is
 * passed through unchecked for the shared normalizer. A null, non-finite or
 * non-numeric count carries no count and is dropped; the normalizer treats an
 * absent value the same, so billing and telemetry do not change. A malformed
 * per-request slot is kept as an empty record so it still reads as unknown.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finiteCount = z.preprocess(
  (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
  z.number().finite().optional(),
);
const tokenDetails = z.preprocess(
  (value) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isFinite(entry[1]),
          ),
        )
      : {},
  z.record(z.string(), z.number().finite()),
);
const tokenDetailsField = z.preprocess(
  (value) => (isRecord(value) || Array.isArray(value) ? value : undefined),
  z.union([z.array(tokenDetails), tokenDetails]).optional(),
);
const optionalTokenDetails = z.preprocess(
  (value) => (isRecord(value) ? value : undefined),
  tokenDetails.optional(),
);
const tokenCounts = {
  inputTokens: finiteCount,
  outputTokens: finiteCount,
  totalTokens: finiteCount,
};
/** Only finite provider usage and the normalized title are retained for settlement. */
export const SessionTitleResponse = z.object({
  title: z.string().nullable(),
  usage: z
    .object({
      responseId: z.string().optional(),
      serviceTier: z.string().optional(),
      webSearchRequests: finiteCount,
      gatewayBilling: z
        .object({ finalProvider: z.string(), inferenceCostUsd: z.string() })
        .optional(),
      usage: z.object({
        ...tokenCounts,
        inputTokensDetails: tokenDetailsField,
        outputTokensDetails: tokenDetailsField,
        requestUsageEntries: z.preprocess(
          (value) =>
            Array.isArray(value) ? value.map((entry) => (isRecord(entry) ? entry : {})) : undefined,
          z
            .array(
              z.object({
                ...tokenCounts,
                input_tokens: finiteCount,
                output_tokens: finiteCount,
                total_tokens: finiteCount,
                inputTokensDetails: optionalTokenDetails,
                outputTokensDetails: optionalTokenDetails,
                input_tokens_details: optionalTokenDetails,
                output_tokens_details: optionalTokenDetails,
              }),
            )
            .optional(),
        ),
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
  if (
    provider.kind === "direct-openai-workspace" ||
    provider.kind === "direct-azure-workspace" ||
    provider.kind === "direct-compatible-workspace"
  ) {
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
  if (provider.kind === "direct-compatible-organization") {
    // One of the organization's own endpoints: pin that exact connection.
    const connectionId = organizationCompatibleConnectionIdOf(provider.id);
    const apiKey =
      connectionId &&
      (await loadOrganizationCompatibleEndpointApiKey(db, settings, {
        accountId,
        workspaceId,
        connectionId,
      }));
    if (!connectionId || !apiKey || apiKey !== provider.apiKey)
      throw new SessionTitleRouteUnavailableError("Title model connection changed");
    return connectionId;
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
    if (!id || !(await organizationCredentialUnchanged(db, settings, scope, provider))) {
      throw new SessionTitleRouteUnavailableError("Title model connection changed");
    }
    return id;
  }
  return null;
}

/** Whether the active organization row still holds the credential the route resolved. */
async function organizationCredentialUnchanged(
  db: Database,
  settings: Settings,
  scope: {
    accountId: string;
    workspaceId: string;
    providerKind: (typeof providerKinds)[keyof typeof providerKinds];
  },
  provider: ResolvedModelProvider,
): Promise<boolean> {
  if (scope.providerKind !== "azure_openai" || !provider.azureEntra)
    return (await loadOrganizationModelProviderApiKey(db, settings, scope)) === provider.apiKey;
  // Microsoft Entra ID sign-in: the same method and app, secret included.
  const credential = await loadOrganizationModelProviderCredential(db, settings, {
    ...scope,
    providerKind: "azure_openai",
  });
  return (
    credential !== null &&
    "azureEntra" in credential &&
    JSON.stringify(credential.azureEntra) === JSON.stringify(provider.azureEntra)
  );
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
