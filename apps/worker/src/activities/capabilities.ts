import { environmentsEncryptionKeyBytes, parseModelProvidersJson, type RegistryProvider, type Settings } from "@opengeni/config";
import {
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_BASE_URL,
  CODEX_PROVIDER_ID,
} from "@opengeni/codex";
import {
  decryptedCapabilityHeaders,
  getCodexCredentialStatus,
  listEnabledMcpCapabilityServers,
  type Database,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";

export async function settingsWithEnabledCapabilityMcpServers(db: Database, workspaceId: string, settings: Settings): Promise<Settings> {
  const enabled = await listEnabledMcpCapabilityServers(db, workspaceId);
  return settingsWithMcpCapabilityServers(settings, enabled);
}

/**
 * When the workspace has an active Codex subscription connected and the feature
 * is enabled, inject a synthetic "codex-subscription" registry provider so a
 * `codex/<slug>` model id routes through the ChatGPT backend. No secrets touch
 * this overlay (metadata-only read); the per-request bearer is resolved later via
 * codexRequestStorage. Idempotent and a no-op when not applicable.
 */
export async function settingsWithCodexCredential(db: Database, workspaceId: string, settings: Settings): Promise<Settings> {
  if (!settings.codexSubscriptionEnabled) {
    return settings;
  }
  const status = await getCodexCredentialStatus(db, workspaceId);
  if (!status || status.status !== "active") {
    return settings; // not connected / needs_relogin / error -> leave settings unchanged
  }
  return withCodexProvider(settings);
}

/** Pure: append the synthetic codex-subscription provider, idempotently. */
export function withCodexProvider(settings: Settings): Settings {
  const providers = parseModelProvidersJson(settings.modelProvidersJson);
  if (providers.some((provider) => provider.id === CODEX_PROVIDER_ID)) {
    return settings; // already injected
  }
  const codexProvider: RegistryProvider = {
    kind: "codex-subscription",
    id: CODEX_PROVIDER_ID,
    label: "Codex (ChatGPT subscription)",
    api: "responses",
    baseUrl: CODEX_PROVIDER_BASE_URL,
    models: CODEX_FALLBACK_MODEL_SLUGS.map((slug) => ({ id: `${CODEX_MODEL_ID_PREFIX}${slug}`, label: slug, reasoningEffort: true })),
  };
  return { ...settings, modelProvidersJson: JSON.stringify([...providers, codexProvider]) };
}

function settingsWithMcpCapabilityServers(settings: Settings, enabled: EnabledMcpCapabilityServer[]): Settings {
  if (enabled.length === 0) {
    return settings;
  }
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  const existingIds = new Set(settings.mcpServers.map((server) => server.id));
  const dynamicServers = enabled
    .filter((server) => !existingIds.has(server.id))
    .flatMap((server) => {
      const headers = decryptedCapabilityHeaders(server, encryptionKey);
      if (headers === "unavailable") {
        // Without its credential headers this server can only fail auth at
        // connect time and break agent turns; leave it out of the run.
        return [];
      }
      return [{
        id: server.id,
        name: server.name,
        url: server.url,
        ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        cacheToolsList: server.cacheToolsList ?? false,
        ...(headers ? { headers } : {}),
      }];
    });
  return dynamicServers.length ? { ...settings, mcpServers: [...settings.mcpServers, ...dynamicServers] } : settings;
}
