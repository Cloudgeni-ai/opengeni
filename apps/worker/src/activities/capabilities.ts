import {
  environmentsEncryptionKeyBytes,
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
  withXaiSubscriptionCatalogProvider,
} from "@opengeni/config";
import { settingsWithEnabledCapabilityMcpServers } from "@opengeni/core";
import {
  getWorkspaceGatewayCustomModelForExecution,
  getWorkspaceOpenRouterCustomModelForExecution,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  listWorkspaceGatewayCustomModels,
  listWorkspaceOpenRouterCustomModels,
  workspaceCodexSubscriptionActive,
  loadWorkspaceVercelAiGatewayApiKey,
  loadWorkspaceOpenRouterApiKey,
  listOrganizationModelProviderCustomModelsForWorkspace,
  getOrganizationModelProviderCustomModelForExecution,
  loadOrganizationModelProviderApiKey,
  type Database,
  type SessionMcpServerForRun,
} from "@opengeni/db";

export { settingsWithEnabledCapabilityMcpServers };

export async function settingsWithSessionMcpServersForRun(
  db: Database,
  workspaceId: string,
  sessionId: string,
  attemptId: string,
  settings: Settings,
  options?: {
    onResolvedServers?: (servers: readonly SessionMcpServerForRun[]) => void;
  },
): Promise<Settings> {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) {
    const metadata = await listSessionMcpServerMetadata(db, workspaceId, sessionId);
    if (metadata.length === 0) {
      return settings;
    }
    if (metadata.some((server) => server.headerNames.length > 0)) {
      throw new Error(
        "session MCP server credentials require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
      );
    }
  }
  const servers = await listSessionMcpServersForRun(
    db,
    workspaceId,
    sessionId,
    attemptId,
    encryptionKey ?? null,
  );
  // Keep credential provenance coupled to the exact decrypted rows that are
  // overlaid into settings. A session projection read earlier in the turn can
  // be stale after a concurrent mcpCredentialUpdates renewal.
  options?.onResolvedServers?.(servers);
  return settingsWithSessionMcpServers(settings, servers);
}

export function settingsWithSessionMcpServers(
  settings: Settings,
  servers: SessionMcpServerForRun[],
): Settings {
  if (servers.length === 0) {
    return settings;
  }
  const sessionIds = new Set(servers.map((server) => server.id));
  return {
    ...settings,
    mcpServers: [
      ...settings.mcpServers.filter((server) => !sessionIds.has(server.id)),
      ...servers.map((server) => ({
        id: server.id,
        ...(server.name ? { name: server.name } : {}),
        url: server.url,
        ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        cacheToolsList: server.cacheToolsList ?? false,
        ...(server.requireApproval !== undefined
          ? { requireApproval: server.requireApproval }
          : {}),
        ...(server.connectionRef ? { connectionRef: server.connectionRef } : {}),
        headers: server.headers,
      })),
    ],
  };
}

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
  const activeCustomModels = await listWorkspaceGatewayCustomModels(db, { accountId, workspaceId });
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
  const apiKey = await loadWorkspaceVercelAiGatewayApiKey(db, settings, workspaceId);
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
  const apiKey = await loadWorkspaceOpenRouterApiKey(db, settings, workspaceId);
  return apiKey
    ? withWorkspaceOpenRouterCredential(catalogSettings, apiKey, customModels)
    : catalogSettings;
}

export async function settingsWithOrganizationProviderCredentials(
  db: Database,
  accountId: string,
  workspaceId: string,
  settings: Settings,
  retainedProductModelId?: string | null,
): Promise<Settings> {
  const buildModels = async (providerKind: "vercel_gateway" | "openrouter", prefix: string) => {
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
  return openRouterKey
    ? withOrganizationOpenRouterCredential(gatewaySettings, openRouterKey, openRouterModels)
    : withOrganizationOpenRouterCatalogProvider(gatewaySettings, openRouterModels);
}
