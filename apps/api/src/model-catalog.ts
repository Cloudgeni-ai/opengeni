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
  type WorkspaceModelCatalogResponse as WorkspaceModelCatalogResponseType,
  type WorkspaceModelPolicyContract,
} from "@opengeni/contracts";

export type ModelAvailabilityObservation = {
  status: "available" | "degraded" | "unavailable";
  reason: "not_entitled" | "provider_unhealthy" | null;
  checkedAt: string;
};

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

function availabilityFor(input: {
  model: ConfiguredModel;
  credentialReady: boolean;
  policy: WorkspaceModelPolicyContract | null;
  observation?: ModelAvailabilityObservation | undefined;
}): ModelAvailabilityV1 {
  if (!modelDefinitionRunnable(input.model)) {
    return {
      status: "unavailable",
      selectable: false,
      reason: "unsupported",
      checkedAt: input.observation?.checkedAt ?? null,
    };
  }
  if (!input.credentialReady) {
    return {
      status: "unavailable",
      selectable: false,
      reason: "missing_credential",
      checkedAt: input.observation?.checkedAt ?? null,
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
      checkedAt: input.observation?.checkedAt ?? null,
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
 * by the existing metadata-only DB seam. Health/entitlement observations are
 * optional typed inputs owned by OPE-32/OPE-24 and are never fabricated.
 */
export function buildWorkspaceModelCatalog(input: {
  settings: Settings;
  policy: WorkspaceModelPolicyContract | null;
  codexSubscriptionActive: boolean;
  observations?: Readonly<Record<string, ModelAvailabilityObservation>> | undefined;
}): WorkspaceModelCatalogResponseType {
  const catalogSettings = input.settings.codexSubscriptionEnabled
    ? withCodexCatalogProvider(input.settings)
    : input.settings;
  const providers = new Map(
    configuredProviders(catalogSettings).map((provider) => [provider.id, provider]),
  );
  const models = configuredModels(catalogSettings).map((model) => {
    const provider = providers.get(model.providerId);
    const credentialReady =
      model.credentialSource.kind === "connected_subscription"
        ? input.codexSubscriptionActive
        : model.credentialSource.kind === "deployment"
          ? Boolean(provider?.apiKey)
          : false;
    return {
      ...projectClientModel(model),
      availability: availabilityFor({
        model,
        credentialReady,
        policy: input.policy,
        observation: input.observations?.[model.definitionVersion],
      }),
    };
  });
  return WorkspaceModelCatalogResponse.parse({ models });
}
