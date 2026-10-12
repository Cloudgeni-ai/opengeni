import { modelAllowedByConnections, type ConnectionModelRestrictions } from "@opengeni/db";
import {
  withDirectModelProviders,
  applyModelCatalogDocument,
  CLAUDE_CONNECTION_KINDS,
  claudeProviderId,
  withClaudeConnectionCatalog,
  type ClaudeConnectionCatalog,
  configuredGatewayWorkspaceProductModelIds,
  configuredGatewayOrganizationProductModelIds,
  configuredModels,
  isModelAvailableForNewSelection,
  configuredModelNotes,
  configuredOpenRouterWorkspaceProductModelIds,
  configuredOpenRouterOrganizationProductModelIds,
  configuredOpperWorkspaceProductModelIds,
  configuredOpperOrganizationProductModelIds,
  configuredProviders,
  validateModelCatalogSettings,
  withCodexCatalogProvider,
  withOrganizationGatewayCatalogProvider,
  withOrganizationOpenRouterCatalogProvider,
  withOrganizationOpperCatalogProvider,
  withWorkspaceGatewayCatalogProvider,
  withWorkspaceOpenRouterCatalogProvider,
  withWorkspaceOpperCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
  WORKSPACE_OPENROUTER_PROVIDER_ID,
  ORGANIZATION_OPENROUTER_PROVIDER_ID,
  ORGANIZATION_GATEWAY_MODEL_ID_PREFIX,
  ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX,
  WORKSPACE_OPPER_MODEL_ID_PREFIX,
  WORKSPACE_OPPER_PROVIDER_ID,
  ORGANIZATION_OPPER_MODEL_ID_PREFIX,
  ORGANIZATION_OPPER_PROVIDER_ID,
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
  listConnectionsMetadata,
  getDeploymentModelCatalog,
  listWorkspaceProviderCustomModelsByKind,
  getWorkspaceProviderCustomModelForExecution,
  lockActiveWorkspaceProviderCustomModelForAdmission,
  getWorkspaceGatewayCustomModelForExecution,
  getWorkspaceOpenRouterCustomModelForExecution,
  getOrganizationModelProviderCustomModelForExecution,
  getOrganizationModelProviderCatalogForWorkspace,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  type OrganizationClaudeModelAdmissionAuthority,
  type Database,
  type WorkspaceCustomModelProviderKind,
  type WorkspaceGatewayCustomModel,
  type WorkspaceOpenRouterCustomModel,
} from "@opengeni/db";

export type ResolvedCatalogSettings = {
  settings: Settings;
  source: "code" | "database";
  version: number | null;
  modelNotes: Record<string, string>;
};

/**
 * Curated workspace Gateway products and workspace-owned custom slugs share
 * one public prefix. Only the latter have a mutable catalog row whose active
 * generation must be rechecked at a fresh acceptance commit boundary.
 */
export function isWorkspaceGatewayCustomModelId(settings: Settings, modelId: string): boolean {
  return (
    modelId.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX) &&
    !configuredGatewayWorkspaceProductModelIds(settings).includes(modelId)
  );
}

export function isWorkspaceOpenRouterCustomModelId(settings: Settings, modelId: string): boolean {
  return (
    modelId.startsWith(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX) &&
    !configuredOpenRouterWorkspaceProductModelIds(settings).includes(modelId)
  );
}

export function isWorkspaceOpperCustomModelId(settings: Settings, modelId: string): boolean {
  return (
    modelId.startsWith(WORKSPACE_OPPER_MODEL_ID_PREFIX) &&
    !configuredOpperWorkspaceProductModelIds(settings).includes(modelId)
  );
}

export type WorkspaceCustomModelReference = {
  scope: "workspace" | "organization";
  providerKind: "vercel_gateway" | "openrouter" | "anthropic" | "claude_subscription" | "opper";
  upstreamModelId: string;
};

export function workspaceCustomModelReference(
  settings: Settings,
  modelId: string,
): WorkspaceCustomModelReference | null {
  for (const scope of ["workspace", "organization"] as const)
    for (const kind of CLAUDE_CONNECTION_KINDS) {
      const prefix = claudeProviderId(kind, scope) + "/";
      if (modelId.startsWith(prefix))
        return {
          scope,
          providerKind: kind,
          upstreamModelId: modelId.slice(prefix.length),
        };
    }
  if (isWorkspaceGatewayCustomModelId(settings, modelId)) {
    return {
      scope: "workspace",
      providerKind: "vercel_gateway",
      upstreamModelId: modelId.slice(WORKSPACE_GATEWAY_MODEL_ID_PREFIX.length),
    };
  }
  if (isWorkspaceOpenRouterCustomModelId(settings, modelId)) {
    return {
      scope: "workspace",
      providerKind: "openrouter",
      upstreamModelId: modelId.slice(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX.length),
    };
  }
  if (isWorkspaceOpperCustomModelId(settings, modelId)) {
    return {
      scope: "workspace",
      providerKind: "opper",
      upstreamModelId: modelId.slice(WORKSPACE_OPPER_MODEL_ID_PREFIX.length),
    };
  }
  if (
    modelId.startsWith(ORGANIZATION_OPPER_MODEL_ID_PREFIX) &&
    !configuredOpperOrganizationProductModelIds(settings).includes(modelId)
  ) {
    return {
      scope: "organization",
      providerKind: "opper",
      upstreamModelId: modelId.slice(ORGANIZATION_OPPER_MODEL_ID_PREFIX.length),
    };
  }
  if (
    modelId.startsWith(ORGANIZATION_GATEWAY_MODEL_ID_PREFIX) &&
    !configuredGatewayOrganizationProductModelIds(settings).includes(modelId)
  ) {
    return {
      scope: "organization",
      providerKind: "vercel_gateway",
      upstreamModelId: modelId.slice(ORGANIZATION_GATEWAY_MODEL_ID_PREFIX.length),
    };
  }
  if (
    modelId.startsWith(ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX) &&
    !configuredOpenRouterOrganizationProductModelIds(settings).includes(modelId)
  ) {
    return {
      scope: "organization",
      providerKind: "openrouter",
      upstreamModelId: modelId.slice(ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX.length),
    };
  }
  return null;
}

export function isWorkspaceCustomModelId(settings: Settings, modelId: string): boolean {
  return workspaceCustomModelReference(settings, modelId) !== null;
}

export async function lockActiveCustomModelForAdmission(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    reference: WorkspaceCustomModelReference;
    claudeAuthority?: OrganizationClaudeModelAdmissionAuthority;
  },
): Promise<boolean> {
  if (input.reference.scope === "organization") {
    return Boolean(
      await lockActiveOrganizationModelProviderCustomModelForAdmission(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        providerKind: input.reference.providerKind,
        upstreamModelId: input.reference.upstreamModelId,
        ...(input.claudeAuthority ? { claudeAuthority: input.claudeAuthority } : {}),
      }),
    );
  }
  return Boolean(
    await lockActiveWorkspaceProviderCustomModelForAdmission(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      providerKind: input.reference.providerKind,
      upstreamModelId: input.reference.upstreamModelId,
    }),
  );
}

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
  input: {
    accountId: string;
    workspaceId: string;
    retainedProductModelId?: string | null;
    retainedProductModelIds?: readonly (string | null | undefined)[];
  },
): Promise<ResolvedCatalogSettings> {
  // A few pure catalog tests inject the historical minimal DB port and mock the
  // workspace model helpers directly. Real/injected runtime databases always
  // expose transactions; keep that narrow test port compatible.
  const supportsOrganizationProviderReads =
    typeof (db as Database & { transaction?: unknown }).transaction === "function";
  const retainedProductModelIds = [
    ...(input.retainedProductModelIds ?? []),
    input.retainedProductModelId,
  ];
  const retainedGatewayUpstreamModelIds = retainedProductModelIds.flatMap((productModelId) =>
    productModelId?.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)
      ? [productModelId.slice(WORKSPACE_GATEWAY_MODEL_ID_PREFIX.length)]
      : [],
  );
  const retainedOpenRouterUpstreamModelIds = retainedProductModelIds.flatMap((productModelId) =>
    productModelId?.startsWith(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX)
      ? [productModelId.slice(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX.length)]
      : [],
  );
  const retainedOrganizationGatewayUpstreamModelIds = retainedProductModelIds.flatMap(
    (productModelId) =>
      productModelId?.startsWith(ORGANIZATION_GATEWAY_MODEL_ID_PREFIX)
        ? [productModelId.slice(ORGANIZATION_GATEWAY_MODEL_ID_PREFIX.length)]
        : [],
  );
  const retainedOrganizationOpenRouterUpstreamModelIds = retainedProductModelIds.flatMap(
    (productModelId) =>
      productModelId?.startsWith(ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX)
        ? [productModelId.slice(ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX.length)]
        : [],
  );
  const retainedOpperUpstreamModelIds = retainedProductModelIds.flatMap((productModelId) =>
    productModelId?.startsWith(WORKSPACE_OPPER_MODEL_ID_PREFIX)
      ? [productModelId.slice(WORKSPACE_OPPER_MODEL_ID_PREFIX.length)]
      : [],
  );
  const retainedOrganizationOpperUpstreamModelIds = retainedProductModelIds.flatMap(
    (productModelId) =>
      productModelId?.startsWith(ORGANIZATION_OPPER_MODEL_ID_PREFIX)
        ? [productModelId.slice(ORGANIZATION_OPPER_MODEL_ID_PREFIX.length)]
        : [],
  );
  // One scoped read per catalog family instead of one scoped transaction per
  // provider kind. The batched readers keep each provider's filters, bound and
  // overflow error. The Claude subscription flag is env-only (the catalog
  // document never changes it), so it decides the requested kinds up front.
  const workspaceCustomModelKinds: WorkspaceCustomModelProviderKind[] = [
    "vercel_gateway",
    "openrouter",
    "opper",
    ...(supportsOrganizationProviderReads
      ? CLAUDE_CONNECTION_KINDS.filter(
          (kind) => kind !== "claude_subscription" || envSettings.claudeSubscriptionEnabled,
        )
      : []),
  ];
  const [
    resolved,
    workspaceCustomModels,
    retainedGatewayCustomModels,
    retainedOpenRouterCustomModels,
    organizationProviders,
    retainedOrganizationGatewayCustomModels,
    retainedOrganizationOpenRouterCustomModels,
    directConnections,
    retainedOpperCustomModels,
    retainedOrganizationOpperCustomModels,
  ] = await Promise.all([
    resolveCatalogSettings(db, envSettings),
    listWorkspaceProviderCustomModelsByKind(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      providerKinds: workspaceCustomModelKinds,
    }),
    Promise.all(
      [...new Set(retainedGatewayUpstreamModelIds)].map(
        async (upstreamModelId) =>
          await getWorkspaceGatewayCustomModelForExecution(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            upstreamModelId,
          }),
      ),
    ),
    Promise.all(
      [...new Set(retainedOpenRouterUpstreamModelIds)].map(
        async (upstreamModelId) =>
          await getWorkspaceOpenRouterCustomModelForExecution(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            upstreamModelId,
          }),
      ),
    ),
    supportsOrganizationProviderReads
      ? getOrganizationModelProviderCatalogForWorkspace(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          providerKinds: ["vercel_gateway", "openrouter", "opper", ...CLAUDE_CONNECTION_KINDS],
        })
      : null,
    supportsOrganizationProviderReads
      ? Promise.all(
          [...new Set(retainedOrganizationGatewayUpstreamModelIds)].map(
            async (upstreamModelId) =>
              await getOrganizationModelProviderCustomModelForExecution(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                providerKind: "vercel_gateway",
                upstreamModelId,
              }),
          ),
        )
      : Promise.resolve([]),
    supportsOrganizationProviderReads
      ? Promise.all(
          [...new Set(retainedOrganizationOpenRouterUpstreamModelIds)].map(
            async (upstreamModelId) =>
              await getOrganizationModelProviderCustomModelForExecution(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                providerKind: "openrouter",
                upstreamModelId,
              }),
          ),
        )
      : Promise.resolve([]),
    supportsOrganizationProviderReads
      ? listConnectionsMetadata(db, input.workspaceId, null)
      : Promise.resolve([]),
    Promise.all(
      [...new Set(retainedOpperUpstreamModelIds)].map(
        async (upstreamModelId) =>
          await getWorkspaceProviderCustomModelForExecution(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            providerKind: "opper",
            upstreamModelId,
          }),
      ),
    ),
    supportsOrganizationProviderReads
      ? Promise.all(
          [...new Set(retainedOrganizationOpperUpstreamModelIds)].map(
            async (upstreamModelId) =>
              await getOrganizationModelProviderCustomModelForExecution(db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                providerKind: "opper",
                upstreamModelId,
              }),
          ),
        )
      : Promise.resolve([]),
  ]);
  const includeRetainedModels = <T extends { upstreamModelId: string }>(
    activeModels: readonly T[],
    retainedModels: readonly (T | null)[],
  ): T[] => {
    const customModels = [...activeModels];
    const includedUpstreamModelIds = new Set(activeModels.map((model) => model.upstreamModelId));
    for (const retainedCustomModel of retainedModels) {
      if (
        retainedCustomModel &&
        !includedUpstreamModelIds.has(retainedCustomModel.upstreamModelId)
      ) {
        customModels.push(retainedCustomModel);
        includedUpstreamModelIds.add(retainedCustomModel.upstreamModelId);
      }
    }
    return customModels;
  };
  const gatewayCustomModels = includeRetainedModels(
    workspaceCustomModels.vercel_gateway as WorkspaceGatewayCustomModel[],
    retainedGatewayCustomModels,
  );
  const openRouterCustomModels = includeRetainedModels(
    workspaceCustomModels.openrouter as WorkspaceOpenRouterCustomModel[],
    retainedOpenRouterCustomModels,
  );
  const organizationGatewayModels = includeRetainedModels(
    organizationProviders?.vercel_gateway.models ?? [],
    retainedOrganizationGatewayCustomModels,
  );
  const organizationOpenRouterModels = includeRetainedModels(
    organizationProviders?.openrouter.models ?? [],
    retainedOrganizationOpenRouterCustomModels,
  );
  const opperCustomModels = includeRetainedModels(
    workspaceCustomModels.opper ?? [],
    retainedOpperCustomModels,
  );
  const organizationOpperModels = includeRetainedModels(
    organizationProviders?.opper.models ?? [],
    retainedOrganizationOpperCustomModels,
  );
  const claudeConnections: ClaudeConnectionCatalog = {};
  if (organizationProviders)
    for (const kind of CLAUDE_CONNECTION_KINDS) {
      const models = [...organizationProviders[kind].models];
      const prefix = claudeProviderId(kind) + "/";
      for (const productId of retainedProductModelIds)
        if (productId?.startsWith(prefix)) {
          const retained = await getOrganizationModelProviderCustomModelForExecution(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            providerKind: kind,
            upstreamModelId: productId.slice(prefix.length),
          });
          if (retained && !models.some((model) => model.id === retained.id)) models.push(retained);
        }
      claudeConnections[kind] = { models };
    }
  const workspaceClaudeConnections: ClaudeConnectionCatalog = {};
  if (supportsOrganizationProviderReads)
    for (const kind of CLAUDE_CONNECTION_KINDS) {
      if (kind === "claude_subscription" && !resolved.settings.claudeSubscriptionEnabled) continue;
      const models = [...workspaceCustomModels[kind]];
      const prefix = claudeProviderId(kind, "workspace") + "/";
      for (const productId of retainedProductModelIds) {
        if (!productId?.startsWith(prefix)) continue;
        const retained = await getWorkspaceProviderCustomModelForExecution(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          providerKind: kind,
          upstreamModelId: productId.slice(prefix.length),
        });
        if (retained && !models.some((model) => model.id === retained.id)) models.push(retained);
      }
      workspaceClaudeConnections[kind] = { models };
    }
  return {
    ...resolved,
    settings: withDirectModelProviders(
      withClaudeConnectionCatalog(
        withClaudeConnectionCatalog(
          withOrganizationOpperCatalogProvider(
            withWorkspaceOpperCatalogProvider(
              withOrganizationOpenRouterCatalogProvider(
                withOrganizationGatewayCatalogProvider(
                  withWorkspaceOpenRouterCatalogProvider(
                    withWorkspaceGatewayCatalogProvider(resolved.settings, gatewayCustomModels),
                    openRouterCustomModels,
                  ),
                  organizationGatewayModels,
                ),
                organizationOpenRouterModels,
              ),
              opperCustomModels,
            ),
            organizationOpperModels,
          ),
          claudeConnections,
        ),
        workspaceClaudeConnections,
        "workspace",
      ),
      directConnections,
    ),
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
  connectionModelRestrictions?: ConnectionModelRestrictions;
  settings: Settings;
  policy: WorkspaceModelPolicyContract | null;
  codexSubscriptionActive: boolean;
  xaiSubscriptionActive?: boolean;
  workspaceGatewayConnectionActive?: boolean;
  workspaceOpenRouterConnectionActive?: boolean;
  workspaceOpperConnectionActive?: boolean;
  claudeConnections?: ClaudeConnectionCatalog;
  workspaceClaudeConnections?: ClaudeConnectionCatalog;
  organizationGatewayConnectionActive?: boolean;
  organizationOpenRouterConnectionActive?: boolean;
  organizationOpperConnectionActive?: boolean;
  workspaceGatewayCustomModels?: readonly {
    upstreamModelId: string;
    label?: string | null;
  }[];
  workspaceOpenRouterCustomModels?: readonly {
    upstreamModelId: string;
    label?: string | null;
  }[];
  organizationGatewayCustomModels?: readonly {
    upstreamModelId: string;
    label?: string | null;
  }[];
  organizationOpenRouterCustomModels?: readonly {
    upstreamModelId: string;
    label?: string | null;
  }[];
  workspaceOpperCustomModels?: readonly {
    upstreamModelId: string;
    label?: string | null;
  }[];
  organizationOpperCustomModels?: readonly {
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

/**
 * Stable fresh-selection admission, independent of transient observations.
 * Missing catalog membership is handled by the caller's lookup. Resolver-based
 * deployment credentials (Azure AD/managed identity) are resolved at execution;
 * absent, stale or failed observations cannot make their definition uncreatable.
 */
export function isWorkspaceModelAdmissible(selection: WorkspaceModelSelection): boolean {
  if (!modelDefinitionRunnable(selection.model) || !selection.policyAllowed) return false;
  const source = selection.model.credentialSource;
  if (source.kind === "deployment") {
    return source.mechanism !== "api_key" || selection.credentialReadiness.status === "ready";
  }
  // Connected subscriptions and workspace/organization connections have a
  // durable active/reauth prerequisite, unlike deployment credential resolvers.
  return selection.credentialReadiness.status === "ready";
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
  workspaceOpenRouterConnectionActive: boolean;
  workspaceOpperConnectionActive: boolean;
  claudeConnections?: ClaudeConnectionCatalog | undefined;
  workspaceClaudeConnections?: ClaudeConnectionCatalog | undefined;
  organizationGatewayConnectionActive: boolean;
  organizationOpenRouterConnectionActive: boolean;
  organizationOpperConnectionActive: boolean;
  observation: ModelCredentialReadinessObservation | undefined;
  nowMs: number;
  maxAgeMs: number;
}): ModelCredentialReadinessV1 {
  const source = input.model.credentialSource;
  if (source.kind === "connected_subscription") {
    const active =
      source.provider === "xai"
        ? input.xaiSubscriptionActive
        : source.provider === "claude"
          ? (input.model.providerId === claudeProviderId("claude_subscription", "workspace")
              ? input.workspaceClaudeConnections
              : input.claudeConnections
            )?.claude_subscription?.active === true
          : input.codexSubscriptionActive;
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
    const claudeKind = CLAUDE_CONNECTION_KINDS.find(
      (kind) => claudeProviderId(kind, "workspace") === input.model.providerId,
    );
    const connectionActive =
      input.provider?.kind === "direct-openai-workspace" ||
      input.provider?.kind === "direct-azure-workspace"
        ? true
        : claudeKind
          ? input.workspaceClaudeConnections?.[claudeKind]?.active === true
          : input.model.providerId === WORKSPACE_OPENROUTER_PROVIDER_ID
            ? input.workspaceOpenRouterConnectionActive
            : input.model.providerId === WORKSPACE_OPPER_PROVIDER_ID
              ? input.workspaceOpperConnectionActive
              : input.workspaceGatewayConnectionActive;
    return connectionActive
      ? { status: "ready", reason: null, basis: "connection", checkedAt: null }
      : {
          status: "not_ready",
          reason: "needs_reauth",
          basis: "connection",
          checkedAt: null,
        };
  }
  if (source.kind === "organization_connection") {
    const claudeKind = CLAUDE_CONNECTION_KINDS.find(
      (kind) => claudeProviderId(kind) === input.model.providerId,
    );
    const connectionActive = claudeKind
      ? input.claudeConnections?.[claudeKind]?.active === true
      : input.model.providerId === ORGANIZATION_OPENROUTER_PROVIDER_ID
        ? input.organizationOpenRouterConnectionActive
        : input.model.providerId === ORGANIZATION_OPPER_PROVIDER_ID
          ? input.organizationOpperConnectionActive
          : input.organizationGatewayConnectionActive;
    return connectionActive
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
  /** Blocked only because the workspace turned Opengeni credits off. */
  creditsDisabled?: boolean;
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
      reason: input.creditsDisabled ? "credits_disabled" : "policy_blocked",
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
  const catalogSettings = withClaudeConnectionCatalog(
    withClaudeConnectionCatalog(
      withOrganizationOpperCatalogProvider(
        withWorkspaceOpperCatalogProvider(
          withOrganizationOpenRouterCatalogProvider(
            withOrganizationGatewayCatalogProvider(
              withWorkspaceOpenRouterCatalogProvider(
                withWorkspaceGatewayCatalogProvider(
                  xaiSettings,
                  input.workspaceGatewayCustomModels ?? [],
                ),
                input.workspaceOpenRouterCustomModels ?? [],
              ),
              input.organizationGatewayCustomModels ?? [],
            ),
            input.organizationOpenRouterCustomModels ?? [],
          ),
          input.workspaceOpperCustomModels ?? [],
        ),
        input.organizationOpperCustomModels ?? [],
      ),
      input.claudeConnections ?? {},
    ),
    input.workspaceClaudeConnections ?? {},
    "workspace",
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

  return configuredModels(catalogSettings)
    .filter((model) => isModelAvailableForNewSelection(catalogSettings, model.id))
    .map((model) => {
      const provider = providers.get(model.providerId);
      const verdict = evaluateWorkspaceModelPolicy(input.policy, {
        providerId: model.providerId,
        modelId: model.id,
        chargesCredits: model.cost === "credits",
      });
      const allowedByConnections = modelAllowedByConnections(
        input.connectionModelRestrictions ?? {},
        model.id,
      );
      const policyAllowed = verdict.allowed && allowedByConnections;
      // Name the credit switch only when it is the sole reason; an allowlist
      // or connection restriction keeps the generic policy reason.
      const creditsDisabled =
        !verdict.allowed &&
        verdict.reason === "credits" &&
        allowedByConnections &&
        input.policy != null &&
        evaluateWorkspaceModelPolicy(
          { ...input.policy, allowCreditModels: true },
          { providerId: model.providerId, modelId: model.id, chargesCredits: true },
        ).allowed;
      const credentialReadiness = credentialReadinessFor({
        model,
        provider,
        codexSubscriptionActive: input.codexSubscriptionActive,
        xaiSubscriptionActive: input.xaiSubscriptionActive === true,
        workspaceGatewayConnectionActive: input.workspaceGatewayConnectionActive === true,
        workspaceOpenRouterConnectionActive: input.workspaceOpenRouterConnectionActive === true,
        workspaceOpperConnectionActive: input.workspaceOpperConnectionActive === true,
        claudeConnections: input.claudeConnections,
        workspaceClaudeConnections: input.workspaceClaudeConnections,
        organizationGatewayConnectionActive: input.organizationGatewayConnectionActive === true,
        organizationOpenRouterConnectionActive:
          input.organizationOpenRouterConnectionActive === true,
        organizationOpperConnectionActive: input.organizationOpperConnectionActive === true,
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
          creditsDisabled,
          observation: input.observations?.[model.definitionVersion],
          nowMs,
          maxAgeMs,
        }),
      };
    });
}
