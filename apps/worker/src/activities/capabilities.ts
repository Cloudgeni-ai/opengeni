import { environmentsEncryptionKeyBytes, parseModelProvidersJson, type RegistryProvider, type Settings } from "@opengeni/config";
import {
  CODEX_APPS_MCP_SERVER_ID,
  CODEX_APPS_MCP_SERVER_NAME,
  CODEX_APPS_MCP_URL,
  CODEX_APPS_REQUIRED_SCOPES,
  CODEX_APPS_STARTUP_TIMEOUT_MS,
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
  const withProvider = withCodexProvider(settings);
  // Additive: append the synthetic codex_apps connectors MCP server ONLY when
  // the credential also carries the connector scopes (no-op otherwise). The
  // bearer is NOT baked here — it is injected dynamically at connect time from
  // codexRequestStorage (runtime/codexAppsMcpRequestInit).
  return withCodexAppsMcpServer(withProvider, status.scopes);
}

/**
 * True only when BOTH connector scopes were granted (browser-authorize path).
 * Device-code logins generally lack them, so this returns false and the apps
 * MCP stays off. Tolerant of extra scopes and arbitrary whitespace delimiters.
 */
export function codexConnectorsAvailable(scopes: string | null | undefined): boolean {
  if (!scopes) {
    return false;
  }
  const granted = new Set(scopes.split(/\s+/).filter(Boolean));
  return CODEX_APPS_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

/**
 * Pure: append the synthetic codex_apps MCP server, idempotently, ONLY when the
 * connector scopes are present. No secrets here — the refreshing bearer is
 * injected at connect time from codexRequestStorage (runtime/mcpServerRequestInit).
 * The connectors backend tolerates serial and parallel tool invocation, so no
 * per-server serialization is enforced (the SDK exposes no per-server
 * parallel-tool-calls flag in @openai/agents 0.11.6).
 */
export function withCodexAppsMcpServer(settings: Settings, scopes: string | null | undefined): Settings {
  if (!codexConnectorsAvailable(scopes)) {
    return settings;
  }
  if (settings.mcpServers.some((server) => server.id === CODEX_APPS_MCP_SERVER_ID)) {
    return settings; // already injected
  }
  return {
    ...settings,
    mcpServers: [
      ...settings.mcpServers,
      {
        id: CODEX_APPS_MCP_SERVER_ID,
        name: CODEX_APPS_MCP_SERVER_NAME,
        url: CODEX_APPS_MCP_URL,
        timeoutMs: CODEX_APPS_STARTUP_TIMEOUT_MS,
        // Connector availability is per-credential and must re-discover each
        // run; never poison a process-global tools-list cache.
        cacheToolsList: false,
        // deliberately NO `headers` — the refreshing bearer is dynamic
      },
    ],
  };
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
