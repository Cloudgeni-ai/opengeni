import {
  CLAUDE_CONNECTION_KINDS,
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
  listWorkspaceProviderCustomModels,
  getWorkspaceProviderCustomModelForExecution,
  loadWorkspaceProviderApiKey,
  type Database,
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
): Promise<Settings> {
  const activeCustomModels = await listWorkspaceGatewayCustomModels(db, {
    accountId,
    workspaceId,
  });
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
): Promise<Settings> {
  const activeCustomModels = await listWorkspaceOpenRouterCustomModels(db, {
    accountId,
    workspaceId,
  });
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
): Promise<Settings> {
  const activeCustomModels = await listWorkspaceProviderCustomModels(db, {
    accountId,
    workspaceId,
    providerKind: "opper",
  });
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
  const apiKey = await loadWorkspaceOpperApiKey(db, settings, workspaceId, retainedProductModelId);
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
): Promise<Settings> {
  const buildModels = async (
    providerKind: "vercel_gateway" | "openrouter" | "anthropic" | "claude_subscription" | "opper",
    prefix: string,
  ) => {
    const active = await listOrganizationModelProviderCustomModelsForWorkspace(db, {
      accountId,
      workspaceId,
      providerKind,
    });
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
  const gatewayKey = await loadOrganizationModelProviderApiKey(db, settings, {
    accountId,
    workspaceId,
    providerKind: "vercel_gateway",
  });
  const gatewaySettings = gatewayKey
    ? withOrganizationGatewayCredential(settings, gatewayKey, gatewayModels)
    : withOrganizationGatewayCatalogProvider(settings, gatewayModels);
  const openRouterKey = await loadOrganizationModelProviderApiKey(db, settings, {
    accountId,
    workspaceId,
    providerKind: "openrouter",
  });
  const openRouterSettings = openRouterKey
    ? withOrganizationOpenRouterCredential(gatewaySettings, openRouterKey, openRouterModels)
    : withOrganizationOpenRouterCatalogProvider(gatewaySettings, openRouterModels);
  const opperModels = await buildModels("opper", ORGANIZATION_OPPER_MODEL_ID_PREFIX);
  const opperKey = await loadOrganizationModelProviderApiKey(db, settings, {
    accountId,
    workspaceId,
    providerKind: "opper",
  });
  let result = opperKey
    ? withOrganizationOpperCredential(openRouterSettings, opperKey, opperModels)
    : withOrganizationOpperCatalogProvider(openRouterSettings, opperModels);
  for (const kind of CLAUDE_CONNECTION_KINDS) {
    if (kind === "claude_subscription" && !settings.claudeSubscriptionEnabled) continue;
    const models = await buildModels(kind, claudeProviderId(kind) + "/");
    result = withClaudeConnectionCatalog(result, { [kind]: { models } });
    const credential =
      kind === "claude_subscription"
        ? null
        : await loadOrganizationModelProviderApiKey(db, settings, {
            accountId,
            workspaceId,
            providerKind: kind,
          });
    if (credential)
      result = withClaudeConnectionCredential(result, kind, credential, "organization", undefined);
    const workspaceModels = await listWorkspaceProviderCustomModels(db, {
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
        : await loadWorkspaceProviderApiKey(db, settings, workspaceId, kind, workspaceModelId);
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
  const codexSettings = await settingsWithCodexCredential(
    db,
    workspaceId,
    input.settings,
    input.codexSubscriptionActive,
  );
  const xaiSettings = codexSettings.supergrokSubscriptionEnabled
    ? withXaiSubscriptionProvider(codexSettings)
    : codexSettings;
  const gatewaySettings = await settingsWithWorkspaceGatewayCredential(
    db,
    accountId,
    workspaceId,
    xaiSettings,
    productModelId,
  );
  const openRouterSettings = await settingsWithWorkspaceOpenRouterCredential(
    db,
    accountId,
    workspaceId,
    gatewaySettings,
    productModelId,
  );
  const workspaceProviderSettings = await settingsWithWorkspaceOpperCredential(
    db,
    accountId,
    workspaceId,
    openRouterSettings,
    productModelId,
  );
  const capabilitySettings = await settingsWithOrganizationProviderCredentials(
    db,
    accountId,
    workspaceId,
    workspaceProviderSettings,
    productModelId,
  );
  const direct = await loadDirectModelProviderConnection(
    db,
    capabilitySettings,
    workspaceId,
    productModelId ?? "",
  );
  return direct ? withDirectModelProviders(capabilitySettings, [direct]) : capabilitySettings;
}
