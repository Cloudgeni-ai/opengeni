import {
  configuredModels,
  configuredProviders,
  withCodexCatalogProvider,
  withWorkspaceGatewayCatalogProvider,
  type ConfiguredModel,
  type Settings,
} from "@opengeni/config";
import {
  ClientModel,
  WorkspaceModelCatalogResponse,
  evaluateWorkspaceModelPolicy,
  type ModelAvailabilityV1,
  type ModelCredentialReadinessV1,
  type WorkspaceModelCatalogResponse as WorkspaceModelCatalogResponseType,
  type WorkspaceModelPolicyContract,
} from "@opengeni/contracts";

export type ModelAvailabilityObservation = {
  status: "available" | "degraded" | "unavailable";
  reason: "not_entitled" | "provider_unhealthy" | null;
  checkedAt: string;
};

export type ModelCredentialReadinessObservation =
  | { status: "ready"; checkedAt: string }
  | {
      status: "not_ready";
      reason: "prerequisites_missing" | "needs_reauth";
      checkedAt: string;
    }
  | { status: "error"; reason: "resolver_error"; checkedAt: string };

export const MODEL_CREDENTIAL_READINESS_OBSERVATION_MAX_AGE_MS = 5 * 60_000;

/** Static, client-safe definition projection. No provider secret is reachable. */
export function projectClientModel(model: ConfiguredModel): ClientModel {
  const source =
    model.credentialSource.kind === "connected_subscription"
      ? "codex"
      : model.credentialSource.kind === "workspace_connection"
        ? "workspace_gateway"
        : "opengeni";
  const publicProvider =
    source === "codex"
      ? { provider: "codex", providerLabel: "Codex" }
      : source === "workspace_gateway"
        ? { provider: "workspace-gateway", providerLabel: "Your Gateway" }
        : { provider: "opengeni", providerLabel: "OpenGeni" };
  return ClientModel.parse({
    id: model.id,
    label: model.label,
    ...publicProvider,
    source,
    api: model.api,
    ...(model.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.contextWindowTokens }),
    schemaVersion: model.schemaVersion,
    aliases: model.aliases,
    executionLimits: model.executionLimits,
    billing: model.billing,
    capabilities: model.capabilities,
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    definitionVersion: model.definitionVersion,
  });
}

function modelDefinitionRunnable(model: ConfiguredModel): boolean {
  return (
    model.capabilities.inputModalities.includes("text") &&
    model.capabilities.outputModalities.includes("text") &&
    model.capabilities.transports.sse.runnable
  );
}

function observedCredentialReadiness(input: {
  observation: ModelCredentialReadinessObservation | undefined;
  basis: "connection" | "resolver";
  nowMs: number;
  maxAgeMs: number;
}): ModelCredentialReadinessV1 {
  if (!input.observation) {
    return {
      status: "not_ready",
      reason: "prerequisites_missing",
      basis: input.basis,
      checkedAt: null,
    };
  }
  const checkedAtMs = Date.parse(input.observation.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return {
      status: "error",
      reason: "resolver_error",
      basis: input.basis,
      checkedAt: null,
    };
  }
  const checkedAt = new Date(checkedAtMs).toISOString();
  if (Math.abs(input.nowMs - checkedAtMs) > input.maxAgeMs) {
    return {
      status: "not_ready",
      reason: "observation_stale",
      basis: input.basis,
      checkedAt,
    };
  }
  if (input.observation.status === "ready") {
    return { status: "ready", reason: null, basis: input.basis, checkedAt };
  }
  if (input.observation.status === "not_ready") {
    return {
      status: "not_ready",
      reason:
        input.observation.reason === "needs_reauth" ? "needs_reauth" : "prerequisites_missing",
      basis: input.basis,
      checkedAt,
    };
  }
  return {
    status: "error",
    reason: "resolver_error",
    basis: input.basis,
    checkedAt,
  };
}

function credentialReadinessFor(input: {
  model: ConfiguredModel;
  provider: ReturnType<typeof configuredProviders>[number] | undefined;
  codexSubscriptionActive: boolean;
  workspaceGatewayConnectionActive: boolean;
  observation: ModelCredentialReadinessObservation | undefined;
  nowMs: number;
  maxAgeMs: number;
}): ModelCredentialReadinessV1 {
  const source = input.model.credentialSource;
  if (source.kind === "connected_subscription") {
    return input.codexSubscriptionActive
      ? { status: "ready", reason: null, basis: "connection", checkedAt: null }
      : {
          status: "not_ready",
          reason: "needs_reauth",
          basis: "connection",
          checkedAt: null,
        };
  }
  if (source.kind === "workspace_connection") {
    return input.workspaceGatewayConnectionActive
      ? { status: "ready", reason: null, basis: "connection", checkedAt: null }
      : {
          status: "not_ready",
          reason: "needs_reauth",
          basis: "connection",
          checkedAt: null,
        };
  }
  if (source.kind === "deployment" && source.mechanism === "api_key") {
    return input.provider?.apiKey
      ? { status: "ready", reason: null, basis: "configuration", checkedAt: null }
      : {
          status: "not_ready",
          reason: "missing_credential",
          basis: "configuration",
          checkedAt: null,
        };
  }
  return observedCredentialReadiness({
    observation: input.observation,
    basis: "resolver",
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
  });
}

function isXaiGrokModel(model: ConfiguredModel): boolean {
  return model.providerId === "xai" && model.id.startsWith("xai/grok-");
}

function observationTimestamp(observation: ModelAvailabilityObservation | undefined): {
  checkedAt: string | null;
  checkedAtMs: number | null;
} {
  if (!observation || typeof observation.checkedAt !== "string") {
    return { checkedAt: null, checkedAtMs: null };
  }
  const checkedAtMs = Date.parse(observation.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return { checkedAt: null, checkedAtMs: null };
  }
  return { checkedAt: new Date(checkedAtMs).toISOString(), checkedAtMs };
}

function xaiGrokAvailabilityFor(input: {
  observation: ModelAvailabilityObservation | undefined;
  nowMs: number;
  maxAgeMs: number;
}): ModelAvailabilityV1 {
  const { checkedAt, checkedAtMs } = observationTimestamp(input.observation);
  const freshSuccessfulObservation =
    input.observation?.status === "available" &&
    input.observation.reason === null &&
    checkedAtMs !== null &&
    checkedAtMs <= input.nowMs &&
    input.nowMs - checkedAtMs <= input.maxAgeMs;

  if (freshSuccessfulObservation) {
    return {
      status: "available",
      selectable: true,
      reason: null,
      checkedAt,
    };
  }

  return {
    status: "unavailable",
    selectable: false,
    reason:
      input.observation?.status === "unavailable"
        ? (input.observation.reason ?? "provider_unhealthy")
        : "provider_unhealthy",
    checkedAt,
  };
}

function availabilityFor(input: {
  model: ConfiguredModel;
  credentialReadiness: ModelCredentialReadinessV1;
  policy: WorkspaceModelPolicyContract | null;
  observation?: ModelAvailabilityObservation | undefined;
  nowMs: number;
  maxAgeMs: number;
}): ModelAvailabilityV1 {
  if (!modelDefinitionRunnable(input.model)) {
    return {
      status: "unavailable",
      selectable: false,
      reason: "unsupported",
      checkedAt: null,
    };
  }
  if (input.credentialReadiness.status !== "ready") {
    return {
      status: "unavailable",
      selectable: false,
      reason:
        input.credentialReadiness.reason === "missing_credential"
          ? "missing_credential"
          : input.credentialReadiness.reason === "needs_reauth"
            ? "needs_reauth"
            : "credential_not_ready",
      checkedAt: input.credentialReadiness.checkedAt,
    };
  }
  if (
    !evaluateWorkspaceModelPolicy(input.policy, {
      providerId: input.model.providerId,
      modelId: input.model.id,
    }).allowed
  ) {
    return {
      status: "unavailable",
      selectable: false,
      reason: "policy_blocked",
      checkedAt: null,
    };
  }
  if (isXaiGrokModel(input.model)) {
    return xaiGrokAvailabilityFor({
      observation: input.observation,
      nowMs: input.nowMs,
      maxAgeMs: input.maxAgeMs,
    });
  }
  if (!input.observation) {
    // Credential readiness and policy are known-good, but no current
    // provider-health observation is available. Unknown is intentionally
    // selectable; the execution boundary rechecks all authoritative gates.
    return { status: "unknown", selectable: true, reason: null, checkedAt: null };
  }
  if (input.observation.status === "unavailable") {
    return {
      status: "unavailable",
      selectable: false,
      reason: input.observation.reason ?? "provider_unhealthy",
      checkedAt: input.observation.checkedAt,
    };
  }
  return {
    status: input.observation.status,
    selectable: true,
    reason: null,
    checkedAt: input.observation.checkedAt,
  };
}

/**
 * Authenticated workspace catalog. Codex definitions are included only when
 * the deployment enables that connection type; concrete readiness is supplied
 * by the existing metadata-only DB seam. API-key presence establishes only
 * local configuration readiness. Federated/token credentials require a fresh,
 * successful typed resolver observation; credential health and provider health
 * are separate inputs and neither is fabricated.
 */
export function buildWorkspaceModelCatalog(input: {
  settings: Settings;
  policy: WorkspaceModelPolicyContract | null;
  codexSubscriptionActive: boolean;
  workspaceGatewayConnectionActive?: boolean;
  credentialReadinessObservations?:
    | Readonly<Record<string, ModelCredentialReadinessObservation>>
    | undefined;
  observations?: Readonly<Record<string, ModelAvailabilityObservation>> | undefined;
  now?: Date | undefined;
  credentialReadinessMaxAgeMs?: number | undefined;
}): WorkspaceModelCatalogResponseType {
  const codexSettings = input.settings.codexSubscriptionEnabled
    ? withCodexCatalogProvider(input.settings)
    : input.settings;
  const catalogSettings = withWorkspaceGatewayCatalogProvider(codexSettings);
  const providers = new Map(
    configuredProviders(catalogSettings).map((provider) => [provider.id, provider]),
  );
  const requestedNowMs = input.now?.getTime();
  const nowMs =
    typeof requestedNowMs === "number" && Number.isFinite(requestedNowMs)
      ? requestedNowMs
      : Date.now();
  const maxAgeMs =
    typeof input.credentialReadinessMaxAgeMs === "number" &&
    Number.isFinite(input.credentialReadinessMaxAgeMs) &&
    input.credentialReadinessMaxAgeMs >= 0
      ? input.credentialReadinessMaxAgeMs
      : MODEL_CREDENTIAL_READINESS_OBSERVATION_MAX_AGE_MS;
  const models = configuredModels(catalogSettings).map((model) => {
    const provider = providers.get(model.providerId);
    const credentialReadiness = credentialReadinessFor({
      model,
      provider,
      codexSubscriptionActive: input.codexSubscriptionActive,
      workspaceGatewayConnectionActive: input.workspaceGatewayConnectionActive === true,
      observation: input.credentialReadinessObservations?.[model.definitionVersion],
      nowMs,
      maxAgeMs,
    });
    return {
      ...projectClientModel(model),
      credentialReadiness,
      availability: availabilityFor({
        model,
        credentialReadiness,
        policy: input.policy,
        observation: input.observations?.[model.definitionVersion],
        nowMs,
        maxAgeMs,
      }),
    };
  });
  return WorkspaceModelCatalogResponse.parse({ models });
}
