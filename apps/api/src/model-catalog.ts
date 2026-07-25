import {
  configuredModels,
  configuredProviders,
  withCodexCatalogProvider,
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
  return ClientModel.parse({
    id: model.id,
    label: model.label,
    provider: model.providerId,
    providerLabel: model.providerLabel,
    api: model.api,
    ...(model.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.contextWindowTokens }),
    schemaVersion: model.schemaVersion,
    aliases: model.aliases,
    deployment: model.deployment,
    executionLimits: model.executionLimits,
    credentialSource: model.credentialSource,
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
    basis: source.kind === "workspace_connection" ? "connection" : "resolver",
    nowMs: input.nowMs,
    maxAgeMs: input.maxAgeMs,
  });
}

function availabilityFor(input: {
  model: ConfiguredModel;
  credentialReadiness: ModelCredentialReadinessV1;
  policy: WorkspaceModelPolicyContract | null;
  observation?: ModelAvailabilityObservation | undefined;
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
  if (!input.observation) {
    // Credential readiness and policy are known-good, but OPE-32 has exposed no
    // current provider-health observation. Unknown is intentionally selectable;
    // the execution boundary rechecks all authoritative gates.
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
  credentialReadinessObservations?:
    | Readonly<Record<string, ModelCredentialReadinessObservation>>
    | undefined;
  observations?: Readonly<Record<string, ModelAvailabilityObservation>> | undefined;
  now?: Date | undefined;
  credentialReadinessMaxAgeMs?: number | undefined;
}): WorkspaceModelCatalogResponseType {
  const catalogSettings = input.settings.codexSubscriptionEnabled
    ? withCodexCatalogProvider(input.settings)
    : input.settings;
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
      }),
    };
  });
  return WorkspaceModelCatalogResponse.parse({ models });
}
