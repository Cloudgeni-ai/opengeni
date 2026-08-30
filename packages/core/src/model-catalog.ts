import {
  applyModelCatalogDocument,
  configuredModels,
  configuredModelNotes,
  configuredProviders,
  validateModelCatalogSettings,
  withCodexCatalogProvider,
  withWorkspaceGatewayCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type ConfiguredModel,
  type Settings,
} from "@opengeni/config";
import {
  evaluateWorkspaceModelPolicy,
  type ModelAvailabilityV1,
  type ModelCredentialReadinessV1,
  type WorkspaceModelPolicyContract,
} from "@opengeni/contracts";
import {
  getDeploymentModelCatalog,
  getWorkspaceGatewayCustomModelForExecution,
  listWorkspaceGatewayCustomModels,
  type Database,
} from "@opengeni/db";

export type ResolvedCatalogSettings = {
  settings: Settings;
  source: "code" | "database";
  version: number | null;
  modelNotes: Record<string, string>;
};

/**
 * Resolve the deployment catalog without making synchronous env settings read
 * Postgres. Database mode fails closed when the singleton is absent or invalid;
 * code mode preserves the already-validated env catalog.
 */
export async function resolveCatalogSettings(
  db: Database,
  envSettings: Settings,
): Promise<ResolvedCatalogSettings> {
  if (envSettings.modelCatalogSource === "code") {
    validateModelCatalogSettings(envSettings);
    return {
      settings: envSettings,
      source: "code",
      version: null,
      modelNotes: configuredModelNotes(envSettings),
    };
  }

  const row = await getDeploymentModelCatalog(db);
  if (!row) {
    throw new Error("database model catalog source is configured but the singleton row is missing");
  }
  const settings = applyModelCatalogDocument(envSettings, row.document);
  validateModelCatalogSettings(settings);
  return {
    settings,
    source: "database",
    version: row.version,
    modelNotes: configuredModelNotes(settings),
  };
}

/**
 * Resolve the deployment catalog and add only the custom Gateway slugs owned by
 * one workspace. Use this at model-bearing workspace boundaries; public config
 * and deployment-operator surfaces must continue to use `resolveCatalogSettings`.
 */
export async function resolveWorkspaceCatalogSettings(
  db: Database,
  envSettings: Settings,
  input: { accountId: string; workspaceId: string; retainedProductModelId?: string | null },
): Promise<ResolvedCatalogSettings> {
  const retainedUpstreamModelId = input.retainedProductModelId?.startsWith("workspace-gateway/")
    ? input.retainedProductModelId.slice("workspace-gateway/".length)
    : null;
  const [resolved, activeCustomModels, retainedCustomModel] = await Promise.all([
    resolveCatalogSettings(db, envSettings),
    listWorkspaceGatewayCustomModels(db, input),
    retainedUpstreamModelId
      ? getWorkspaceGatewayCustomModelForExecution(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          upstreamModelId: retainedUpstreamModelId,
        })
      : null,
  ]);
  const customModels =
    retainedCustomModel &&
    !activeCustomModels.some(
      (model) => model.upstreamModelId === retainedCustomModel.upstreamModelId,
    )
      ? [...activeCustomModels, retainedCustomModel]
      : activeCustomModels;
  return {
    ...resolved,
    settings: withWorkspaceGatewayCatalogProvider(resolved.settings, customModels),
  };
}

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

export type WorkspaceModelSelectionInput = {
  settings: Settings;
  policy: WorkspaceModelPolicyContract | null;
  codexSubscriptionActive: boolean;
  xaiSubscriptionActive?: boolean;
  workspaceGatewayConnectionActive?: boolean;
  workspaceGatewayCustomModels?: readonly {
    upstreamModelId: string;
    label?: string | null;
  }[];
  credentialReadinessObservations?:
    | Readonly<Record<string, ModelCredentialReadinessObservation>>
    | undefined;
  observations?: Readonly<Record<string, ModelAvailabilityObservation>> | undefined;
  now?: Date | undefined;
  credentialReadinessMaxAgeMs?: number | undefined;
};

export type WorkspaceModelSelection = {
  model: ConfiguredModel;
  credentialReadiness: ModelCredentialReadinessV1;
  policyAllowed: boolean;
  availability: ModelAvailabilityV1;
};

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
  xaiSubscriptionActive: boolean;
  workspaceGatewayConnectionActive: boolean;
  observation: ModelCredentialReadinessObservation | undefined;
  nowMs: number;
  maxAgeMs: number;
}): ModelCredentialReadinessV1 {
  const source = input.model.credentialSource;
  if (source.kind === "connected_subscription") {
    const active =
      source.provider === "xai" ? input.xaiSubscriptionActive : input.codexSubscriptionActive;
    return active
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
  if (source.kind === "deployment" && source.mechanism === "none") {
    return { status: "ready", reason: null, basis: "configuration", checkedAt: null };
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
  policyAllowed: boolean;
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
  if (!input.policyAllowed) {
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
 * One shared picker/tool decision. Catalog membership, credential readiness,
 * workspace policy, and optional provider-health observations are evaluated in
 * configured catalog order so every consumer exposes the same selectable set.
 */
export function resolveWorkspaceModelSelection(
  input: WorkspaceModelSelectionInput,
): WorkspaceModelSelection[] {
  const codexSettings = input.settings.codexSubscriptionEnabled
    ? withCodexCatalogProvider(input.settings)
    : input.settings;
  const xaiSettings = input.settings.supergrokSubscriptionEnabled
    ? withXaiSubscriptionCatalogProvider(codexSettings)
    : codexSettings;
  const catalogSettings = withWorkspaceGatewayCatalogProvider(
    xaiSettings,
    input.workspaceGatewayCustomModels ?? [],
  );
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

  return configuredModels(catalogSettings).map((model) => {
    const provider = providers.get(model.providerId);
    const policyAllowed = evaluateWorkspaceModelPolicy(input.policy, {
      providerId: model.providerId,
      modelId: model.id,
    }).allowed;
    const credentialReadiness = credentialReadinessFor({
      model,
      provider,
      codexSubscriptionActive: input.codexSubscriptionActive,
      xaiSubscriptionActive: input.xaiSubscriptionActive === true,
      workspaceGatewayConnectionActive: input.workspaceGatewayConnectionActive === true,
      observation: input.credentialReadinessObservations?.[model.definitionVersion],
      nowMs,
      maxAgeMs,
    });
    return {
      model,
      credentialReadiness,
      policyAllowed,
      availability: availabilityFor({
        model,
        credentialReadiness,
        policyAllowed,
        observation: input.observations?.[model.definitionVersion],
        nowMs,
        maxAgeMs,
      }),
    };
  });
}
