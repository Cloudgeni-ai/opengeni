import {
  CLAUDE_CONNECTION_KINDS,
  environmentsEncryptionKeyBytes,
  claudeProviderId,
  withClaudeConnectionCatalog,
  withClaudeConnectionCredential,
  withDirectModelProviders,
  type Settings,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
  withCodexCatalogProvider,
  withWorkspaceGatewayCatalogProvider,
  withWorkspaceGatewayCredential,
  withWorkspaceOpenRouterCatalogProvider,
  withWorkspaceOpenRouterCredential,
  withOrganizationGatewayCatalogProvider,
  withOrganizationGatewayCredential,
  withOrganizationOpenRouterCatalogProvider,
  withOrganizationOpenRouterCredential,
  ORGANIZATION_GATEWAY_MODEL_ID_PREFIX,
  ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX,
  ORGANIZATION_OPPER_MODEL_ID_PREFIX,
  WORKSPACE_OPPER_MODEL_ID_PREFIX,
  organizationDirectModelIdPrefix,
  withOrganizationDirectCatalogProvider,
  withOrganizationDirectCredential,
  withOrganizationAzureOpenAIEntraCredential,
  withOrganizationOpperCatalogProvider,
  withOrganizationOpperCredential,
  withWorkspaceOpperCatalogProvider,
  withWorkspaceOpperCredential,
  withXaiSubscriptionCatalogProvider,
} from "@opengeni/config";
import {
  getWorkspaceGatewayCustomModelForExecution,
  getWorkspaceOpenRouterCustomModelForExecution,
  listWorkspaceGatewayCustomModels,
  listWorkspaceOpenRouterCustomModels,
  loadDirectModelProviderConnection,
  workspaceCodexSubscriptionActive,
  loadWorkspaceVercelAiGatewayApiKey,
  loadWorkspaceOpenRouterApiKey,
  loadWorkspaceOpperApiKey,
  listOrganizationModelProviderCustomModelsForWorkspace,
  getOrganizationModelProviderCustomModelForExecution,
  loadOrganizationModelProviderApiKey,
  loadOrganizationModelProviderCredential,
  getOrganizationModelProviderCatalogForWorkspace,
  listWorkspaceProviderCustomModels,
  getWorkspaceProviderCustomModelForExecution,
  loadWorkspaceProviderApiKey,
  type Database,
  isWorkspaceEuOnly,
  loadModelProviderExecutionInputs,
  type ModelProviderExecutionInputs,
} from "@opengeni/db";

/**
 * Execution-time provider overlays for one workspace: subscription catalog
 * providers plus the decrypted workspace and organization provider keys a
 * model call needs. Agent turns (worker claim) and stateless single model
 * calls (API) apply the same overlays, so both resolve a model to the same
 * provider and credential.
 */

/**
 * When the workspace has an active Codex subscription connected and the feature
 * is enabled, inject a synthetic "codex-subscription" registry provider so a
 * `codex/<slug>` model id routes through the ChatGPT backend. No secrets touch
 * this overlay (metadata-only read); the per-request bearer is resolved later via
 * codexRequestStorage. Idempotent and a no-op when not applicable.
 */
export async function settingsWithCodexCredential(
  db: Database,
  workspaceId: string,
  settings: Settings,
  activeOverride?: boolean,
): Promise<Settings> {
  // Same active-credential predicate the billing bypass uses, so provider
  // injection and billing can never disagree on what an "active codex" turn is.
  // The caller may pass `activeOverride` (a single, shared read; P2-b) so routing
  // and billing decide from the exact same observation, immune to a concurrent
  // disconnect/reconnect landing between two independent reads.
  const active =
    activeOverride ?? (await workspaceCodexSubscriptionActive(db, settings, workspaceId));
  if (!active) {
    return settings; // disabled / not connected / needs_relogin / error -> leave settings unchanged
  }
  const withProvider = withCodexProvider(settings);
  return withProvider;
}

/** Pure: append the synthetic codex-subscription provider, idempotently. */
export function withCodexProvider(settings: Settings): Settings {
  return withCodexCatalogProvider(settings);
}

/**
 * Pure: append the synthetic SuperGrok/xAI subscription provider,
 * idempotently. The overlay is catalogue metadata only; the exact account,
 * authority snapshot, and bearer remain frozen later at turn admission.
 */
export function withXaiSubscriptionProvider(settings: Settings): Settings {
  return withXaiSubscriptionCatalogProvider(settings);
}

export async function settingsWithWorkspaceGatewayCredential(
  db: Database,
  accountId: string,
  workspaceId: string,
  settings: Settings,
  retainedProductModelId?: string | null,
  prepared?: ModelProviderExecutionInputs,
): Promise<Settings> {
  const activeCustomModels =
    prepared?.workspaceModels.vercel_gateway ??
    (await listWorkspaceGatewayCustomModels(db, {
      accountId,
      workspaceId,
    }));
  const retainedUpstreamModelId = retainedProductModelId?.startsWith(
    WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  )
    ? retainedProductModelId.slice(WORKSPACE_GATEWAY_MODEL_ID_PREFIX.length)
    : null;
  const retainedCustomModel = retainedUpstreamModelId
    ? await getWorkspaceGatewayCustomModelForExecution(db, {
        accountId,
        workspaceId,
        upstreamModelId: retainedUpstreamModelId,
      })
    : null;
  const customModels =
    retainedCustomModel &&
    !activeCustomModels.some(
      (model) => model.upstreamModelId === retainedCustomModel.upstreamModelId,
    )
      ? [...activeCustomModels, retainedCustomModel]
      : activeCustomModels;
  const catalogSettings = withWorkspaceGatewayCatalogProvider(settings, customModels);
  const apiKey = await loadWorkspaceVercelAiGatewayApiKey(
    db,
    settings,
    workspaceId,
    retainedProductModelId,
    prepared?.workspaceConnections,
  );
  return apiKey
    ? withWorkspaceGatewayCredential(catalogSettings, apiKey, customModels)
    : catalogSettings;
}

export async function settingsWithWorkspaceOpenRouterCredential(
  db: Database,
  accountId: string,
  workspaceId: string,
  settings: Settings,
  retainedProductModelId?: string | null,
  prepared?: ModelProviderExecutionInputs,
): Promise<Settings> {
  const activeCustomModels =
    prepared?.workspaceModels.openrouter ??
    (await listWorkspaceOpenRouterCustomModels(db, {
      accountId,
      workspaceId,
    }));
  const retainedUpstreamModelId = retainedProductModelId?.startsWith(
    WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
  )
    ? retainedProductModelId.slice(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX.length)
    : null;
  const retainedCustomModel = retainedUpstreamModelId
    ? await getWorkspaceOpenRouterCustomModelForExecution(db, {
        accountId,
        workspaceId,
        upstreamModelId: retainedUpstreamModelId,
      })
    : null;
  const customModels =
    retainedCustomModel &&
    !activeCustomModels.some(
      (model) => model.upstreamModelId === retainedCustomModel.upstreamModelId,
    )
      ? [...activeCustomModels, retainedCustomModel]
      : activeCustomModels;
  const catalogSettings = withWorkspaceOpenRouterCatalogProvider(settings, customModels);
  const apiKey = await loadWorkspaceOpenRouterApiKey(
    db,
    settings,
    workspaceId,
    retainedProductModelId,
    prepared?.workspaceConnections,
  );
  return apiKey
    ? withWorkspaceOpenRouterCredential(catalogSettings, apiKey, customModels)
    : catalogSettings;
}

/** Overlay the workspace Opper catalog and, when active, its decrypted key. */
export async function settingsWithWorkspaceOpperCredential(
  db: Database,
  accountId: string,
  workspaceId: string,
  settings: Settings,
  retainedProductModelId?: string | null,
  prepared?: ModelProviderExecutionInputs,
): Promise<Settings> {
  const activeCustomModels =
    prepared?.workspaceModels.opper ??
    (await listWorkspaceProviderCustomModels(db, {
      accountId,
      workspaceId,
      providerKind: "opper",
    }));
  const retainedUpstreamModelId = retainedProductModelId?.startsWith(
    WORKSPACE_OPPER_MODEL_ID_PREFIX,
  )
    ? retainedProductModelId.slice(WORKSPACE_OPPER_MODEL_ID_PREFIX.length)
    : null;
  const retainedCustomModel = retainedUpstreamModelId
    ? await getWorkspaceProviderCustomModelForExecution(db, {
        accountId,
        workspaceId,
        providerKind: "opper",
        upstreamModelId: retainedUpstreamModelId,
      })
    : null;
  const customModels =
    retainedCustomModel &&
    !activeCustomModels.some(
      (model) => model.upstreamModelId === retainedCustomModel.upstreamModelId,
    )
      ? [...activeCustomModels, retainedCustomModel]
      : activeCustomModels;
  const catalogSettings = withWorkspaceOpperCatalogProvider(settings, customModels);
  const apiKey = await loadWorkspaceOpperApiKey(
    db,
    settings,
    workspaceId,
    retainedProductModelId,
    prepared?.workspaceConnections,
  );
  return apiKey
    ? withWorkspaceOpperCredential(catalogSettings, apiKey, customModels)
    : catalogSettings;
}

export async function settingsWithOrganizationProviderCredentials(
  db: Database,
  accountId: string,
  workspaceId: string,
  settings: Settings,
  retainedProductModelId?: string | null,
  prepared?: ModelProviderExecutionInputs,
): Promise<Settings> {
  if (prepared && prepared.claudeSubscriptionEnabled !== settings.claudeSubscriptionEnabled) {
    throw new Error("Prepared provider catalog does not match subscription settings");
  }
  const buildModels = async (
    providerKind:
      | "vercel_gateway"
      | "openrouter"
      | "anthropic"
      | "claude_subscription"
      | "opper"
      | "openai"
      | "azure_openai",
    prefix: string,
  ) => {
    const active =
      prepared?.organizationModels[providerKind] ??
      (await listOrganizationModelProviderCustomModelsForWorkspace(db, {
        accountId,
        workspaceId,
        providerKind,
      }));
    const upstreamModelId = retainedProductModelId?.startsWith(prefix)
      ? retainedProductModelId.slice(prefix.length)
      : null;
    const retained = upstreamModelId
      ? await getOrganizationModelProviderCustomModelForExecution(db, {
          accountId,
          workspaceId,
          providerKind,
          upstreamModelId,
        })
      : null;
    return retained && !active.some((model) => model.id === retained.id)
      ? [...active, retained]
      : active;
  };
  const gatewayModels = await buildModels("vercel_gateway", ORGANIZATION_GATEWAY_MODEL_ID_PREFIX);
  const openRouterModels = await buildModels("openrouter", ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX);
  const gatewayKey = await loadOrganizationModelProviderApiKey(
    db,
    settings,
    {
      accountId,
      workspaceId,
      providerKind: "vercel_gateway",
    },
    prepared,
  );
  const gatewaySettings = gatewayKey
    ? withOrganizationGatewayCredential(settings, gatewayKey, gatewayModels)
    : withOrganizationGatewayCatalogProvider(settings, gatewayModels);
  const openRouterKey = await loadOrganizationModelProviderApiKey(
    db,
    settings,
    {
      accountId,
      workspaceId,
      providerKind: "openrouter",
    },
    prepared,
  );
  const openRouterSettings = openRouterKey
    ? withOrganizationOpenRouterCredential(gatewaySettings, openRouterKey, openRouterModels)
    : withOrganizationOpenRouterCatalogProvider(gatewaySettings, openRouterModels);
  const opperModels = await buildModels("opper", ORGANIZATION_OPPER_MODEL_ID_PREFIX);
  const opperKey = await loadOrganizationModelProviderApiKey(
    db,
    settings,
    {
      accountId,
      workspaceId,
      providerKind: "opper",
    },
    prepared,
  );
  const opperSettings = opperKey
    ? withOrganizationOpperCredential(openRouterSettings, opperKey, opperModels)
    : withOrganizationOpperCatalogProvider(openRouterSettings, opperModels);
  // Organization OpenAI and Azure OpenAI: the decrypted key or Azure's
  // Microsoft Entra ID sign-in (and Azure's endpoint) come from the same
  // active row; without one the catalog keeps Azure's non-secret endpoint of
  // the last connection and the turn fails closed in the runtime. Never a
  // deployment credential, except the deployment identity an operator
  // explicitly offered to organizations.
  let result = opperSettings;
  for (const provider of ["openai", "azure_openai"] as const) {
    const models = await buildModels(provider, organizationDirectModelIdPrefix(provider));
    const credential = await loadOrganizationModelProviderCredential(
      db,
      settings,
      { accountId, workspaceId, providerKind: provider },
      prepared,
    );
    if (credential && (provider === "openai" || credential.endpoint)) {
      result =
        "azureEntra" in credential
          ? provider === "azure_openai"
            ? withOrganizationAzureOpenAIEntraCredential(result, credential.azureEntra, {
                endpoint: credential.endpoint,
                models,
              })
            : withOrganizationDirectCatalogProvider(result, provider, { endpoint: null, models })
          : withOrganizationDirectCredential(result, provider, credential.apiKey, {
              endpoint: credential.endpoint,
              models,
            });
      continue;
    }
    result = withOrganizationDirectCatalogProvider(result, provider, {
      endpoint:
        provider === "openai" || models.length === 0
          ? null
          : (
              await getOrganizationModelProviderCatalogForWorkspace(db, {
                accountId,
                workspaceId,
                providerKinds: ["azure_openai"],
              })
            ).azure_openai.endpoint,
      models,
    });
  }
  for (const kind of CLAUDE_CONNECTION_KINDS) {
    if (kind === "claude_subscription" && !settings.claudeSubscriptionEnabled) continue;
    const models = await buildModels(kind, claudeProviderId(kind) + "/");
    result = withClaudeConnectionCatalog(result, { [kind]: { models } });
    const credential =
      kind === "claude_subscription"
        ? null
        : await loadOrganizationModelProviderApiKey(
            db,
            settings,
            {
              accountId,
              workspaceId,
              providerKind: kind,
            },
            prepared,
          );
    if (credential)
      result = withClaudeConnectionCredential(result, kind, credential, "organization", undefined);
    const workspaceModels = prepared
      ? [...prepared.workspaceModels[kind]]
      : await listWorkspaceProviderCustomModels(db, {
          accountId,
          workspaceId,
          providerKind: kind,
        });
    const workspacePrefix = claudeProviderId(kind, "workspace") + "/";
    const workspaceModelId = retainedProductModelId?.startsWith(workspacePrefix)
      ? retainedProductModelId
      : null;
    if (workspaceModelId) {
      const retained = await getWorkspaceProviderCustomModelForExecution(db, {
        accountId,
        workspaceId,
        providerKind: kind,
        upstreamModelId: workspaceModelId.slice(workspacePrefix.length),
      });
      if (retained && !workspaceModels.some((model) => model.id === retained.id))
        workspaceModels.push(retained);
    }
    result = withClaudeConnectionCatalog(
      result,
      { [kind]: { models: workspaceModels } },
      "workspace",
    );
    const workspaceCredential =
      kind === "claude_subscription"
        ? null
        : await loadWorkspaceProviderApiKey(
            db,
            settings,
            workspaceId,
            kind,
            workspaceModelId,
            prepared?.workspaceConnections,
          );
    if (workspaceCredential)
      result = withClaudeConnectionCredential(
        result,
        kind,
        workspaceCredential,
        "workspace",
        undefined,
      );
  }
  return result;
}

/**
 * EU-only inference: when the workspace is EU-only, every model route the run
 * resolves must be EU (`requiredModelGeography`). A failed read throws, so a
 * run never proceeds without knowing. Narrowing only: an EU requirement
 * already on the settings is kept.
 */
export async function settingsWithInferenceResidency(
  db: Database,
  input: { accountId: string; workspaceId: string; settings: Settings },
): Promise<Settings> {
  if (input.settings.requiredModelGeography === "eu") return input.settings;
  const euOnly = await isWorkspaceEuOnly(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  });
  return euOnly ? { ...input.settings, requiredModelGeography: "eu" } : input.settings;
}

/**
 * Apply every execution overlay in the order the worker claim uses, then
 * install the selected customer direct connection when the model names one.
 * `codexSubscriptionActive` is the caller's single readiness observation, so
 * routing and billing decide from the same read.
 */
export async function settingsWithModelProviderCredentials(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    settings: Settings;
    productModelId: string | null | undefined;
    codexSubscriptionActive: boolean;
  },
): Promise<Settings> {
  const { accountId, workspaceId, productModelId } = input;
  const residencySettings = await settingsWithInferenceResidency(db, {
    accountId,
    workspaceId,
    settings: input.settings,
  });
  const codexSettings = await settingsWithCodexCredential(
    db,
    workspaceId,
    residencySettings,
    input.codexSubscriptionActive,
  );
  const xaiSettings = codexSettings.supergrokSubscriptionEnabled
    ? withXaiSubscriptionProvider(codexSettings)
    : codexSettings;
  const prepared = await loadModelProviderExecutionInputs(db, {
    accountId,
    workspaceId,
    claudeSubscriptionEnabled: xaiSettings.claudeSubscriptionEnabled,
    loadOrganizationCredentials: environmentsEncryptionKeyBytes(xaiSettings) !== null,
  });
  const gatewaySettings = await settingsWithWorkspaceGatewayCredential(
    db,
    accountId,
    workspaceId,
    xaiSettings,
    productModelId,
    prepared,
  );
  const openRouterSettings = await settingsWithWorkspaceOpenRouterCredential(
    db,
    accountId,
    workspaceId,
    gatewaySettings,
    productModelId,
    prepared,
  );
  const workspaceProviderSettings = await settingsWithWorkspaceOpperCredential(
    db,
    accountId,
    workspaceId,
    openRouterSettings,
    productModelId,
    prepared,
  );
  const capabilitySettings = await settingsWithOrganizationProviderCredentials(
    db,
    accountId,
    workspaceId,
    workspaceProviderSettings,
    productModelId,
    prepared,
  );
  const direct = await loadDirectModelProviderConnection(
    db,
    capabilitySettings,
    workspaceId,
    productModelId ?? "",
    prepared.workspaceConnections,
  );
  return direct ? withDirectModelProviders(capabilitySettings, [direct]) : capabilitySettings;
}
