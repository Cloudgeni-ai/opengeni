import {
  environmentsEncryptionKeyBytes,
  type Settings,
  withCodexCatalogProvider,
} from "@opengeni/config";
import { settingsWithEnabledCapabilityMcpServers } from "@opengeni/core";
import {
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  workspaceCodexSubscriptionActive,
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
