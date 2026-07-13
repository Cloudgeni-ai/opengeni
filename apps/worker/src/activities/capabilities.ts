import {
  environmentsEncryptionKeyBytes,
  parseModelProvidersJson,
  type RegistryProvider,
  type Settings,
} from "@opengeni/config";
import { settingsWithMcpCapabilityServers } from "@opengeni/core";
import {
  CODEX_APPS_MCP_SERVER_ID,
  CODEX_APPS_MCP_SERVER_NAME,
  CODEX_APPS_MCP_URL,
  CODEX_APPS_STARTUP_TIMEOUT_MS,
  CODEX_FALLBACK_MODEL_SLUGS,
  CODEX_MODEL_CONTEXT_WINDOW_TOKENS,
  CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
  CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  CODEX_MODEL_ID_PREFIX,
  CODEX_PROVIDER_BASE_URL,
  CODEX_PROVIDER_ID,
} from "@opengeni/codex";
import {
  listEnabledMcpCapabilityServers,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  workspaceCodexSubscriptionActive,
  type Database,
  type SessionMcpServerForRun,
} from "@opengeni/db";

export async function settingsWithEnabledCapabilityMcpServers(
  db: Database,
  workspaceId: string,
  settings: Settings,
): Promise<Settings> {
  const enabled = await listEnabledMcpCapabilityServers(db, workspaceId);
  return settingsWithMcpCapabilityServers(settings, enabled);
}

export async function settingsWithSessionMcpServersForRun(
  db: Database,
  workspaceId: string,
  sessionId: string,
  settings: Settings,
): Promise<Settings> {
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey) {
    const metadata = await listSessionMcpServerMetadata(db, workspaceId, sessionId);
    if (metadata.length === 0) {
      return settings;
    }
    throw new Error("session MCP server credentials require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  }
  return settingsWithSessionMcpServers(
    settings,
    await listSessionMcpServersForRun(db, workspaceId, sessionId, encryptionKey),
  );
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
  // Additive: append the synthetic codex_apps connectors MCP server for ANY
  // active credential. Connector access is gated SERVER-SIDE per ChatGPT account
  // (via chatgpt-account-id), NOT by token scopes — confirmed live: a `pro` token
  // whose only scopes are openid/profile/email/offline_access still lists all 217
  // connector tools at .../ps/mcp. So we inject unconditionally and let
  // runtime-discovery decide: an account with no connectors yields an empty
  // tools/list, and a connect failure best-effort-drops the server without
  // failing the turn. The bearer is injected dynamically at connect time
  // (runtime/codexAppsMcpRequestInit).
  return withCodexAppsMcpServer(withProvider);
}

/**
 * Pure: append the synthetic codex_apps MCP server, idempotently. Connector
 * access is gated SERVER-SIDE per ChatGPT account (chatgpt-account-id), not by
 * token scopes, so we inject for any active credential and let runtime-discovery
 * resolve the actual tool set (empty list / dropped server when unavailable).
 * No secrets here — the refreshing bearer is injected at connect time from
 * codexRequestStorage (runtime/codexAppsMcpRequestInit). The connectors backend
 * tolerates serial and parallel tool invocation, so no per-server serialization
 * is enforced (the SDK exposes no per-server parallel-tool-calls flag in
 * @openai/agents 0.11.6).
 */
export function withCodexAppsMcpServer(settings: Settings): Settings {
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
    models: CODEX_FALLBACK_MODEL_SLUGS.map((slug) => ({
      id: `${CODEX_MODEL_ID_PREFIX}${slug}`,
      label: slug,
      reasoningEffort: true,
      // These three values are the live Codex CLI catalog policy, kept distinct
      // so proactive compaction and the effective input guard match Codex core.
      contextWindowTokens: CODEX_MODEL_CONTEXT_WINDOW_TOKENS,
      effectiveContextWindowTokens: CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
      autoCompactTokenLimit: CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
    })),
  };
  return { ...settings, modelProvidersJson: JSON.stringify([...providers, codexProvider]) };
}
