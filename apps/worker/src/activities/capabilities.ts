import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  settingsWithCodexCredential as coreSettingsWithCodexCredential,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithOrganizationProviderCredentials as coreSettingsWithOrganizationProviderCredentials,
  settingsWithWorkspaceGatewayCredential as coreSettingsWithWorkspaceGatewayCredential,
  settingsWithWorkspaceOpenRouterCredential as coreSettingsWithWorkspaceOpenRouterCredential,
  settingsWithWorkspaceOpperCredential as coreSettingsWithWorkspaceOpperCredential,
  withCodexProvider as coreWithCodexProvider,
  withXaiSubscriptionProvider as coreWithXaiSubscriptionProvider,
} from "@opengeni/core";
import {
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  getSessionAttemptMcpApprovalPolicies,
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
  let policies: Awaited<ReturnType<typeof getSessionAttemptMcpApprovalPolicies>>;
  let resolvedServers: SessionMcpServerForRun[] | undefined;
  if (encryptionKey && typeof (db as Database & { rollback?: unknown }).rollback !== "function") {
    // Both readers independently fence this exact active attempt. The server
    // read must remain fresh for credential renewal; it does not consume the
    // policy read's result. Root-pool RLS transactions may overlap, whereas
    // nested scopes on a transaction handle must retain serial savepoints.
    const [policyResult, serverResult] = await Promise.allSettled([
      (async () =>
        await getSessionAttemptMcpApprovalPolicies(db, workspaceId, sessionId, attemptId))(),
      (async () =>
        await listSessionMcpServersForRun(db, workspaceId, sessionId, attemptId, encryptionKey))(),
    ]);
    // Observe both reads before returning or propagating an error. Preserve the
    // previous policy-first diagnostic priority, including synchronous ports.
    if (policyResult.status === "rejected") throw policyResult.reason;
    if (serverResult.status === "rejected") throw serverResult.reason;
    policies = policyResult.value;
    resolvedServers = serverResult.value;
  } else {
    policies = await getSessionAttemptMcpApprovalPolicies(db, workspaceId, sessionId, attemptId);
  }
  const policySettings = {
    ...settings,
    mcpServers: settings.mcpServers.map((server) =>
      Object.hasOwn(policies, server.id)
        ? { ...server, requireApproval: policies[server.id] }
        : server,
    ),
  };
  if (!encryptionKey) {
    const metadata = await listSessionMcpServerMetadata(db, workspaceId, sessionId);
    if (metadata.length === 0) {
      return policySettings;
    }
    if (metadata.some((server) => server.headerNames.length > 0)) {
      throw new Error(
        "session MCP server credentials require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
      );
    }
  }
  const servers =
    resolvedServers ??
    (await listSessionMcpServersForRun(
      db,
      workspaceId,
      sessionId,
      attemptId,
      encryptionKey ?? null,
    ));
  // Keep credential provenance coupled to the exact decrypted rows that are
  // overlaid into settings. A session projection read earlier in the turn can
  // be stale after a concurrent mcpCredentialUpdates renewal.
  options?.onResolvedServers?.(servers);
  return settingsWithSessionMcpServers(policySettings, servers);
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

// Provider credential overlays live in core so stateless single model calls
// resolve providers exactly like agent turns. These module-local bindings keep
// the claim's call sites (and their test seams) unchanged.
export const settingsWithCodexCredential = coreSettingsWithCodexCredential;
export const withCodexProvider = coreWithCodexProvider;
export const withXaiSubscriptionProvider = coreWithXaiSubscriptionProvider;
export const settingsWithWorkspaceGatewayCredential = coreSettingsWithWorkspaceGatewayCredential;
export const settingsWithWorkspaceOpenRouterCredential =
  coreSettingsWithWorkspaceOpenRouterCredential;
export const settingsWithWorkspaceOpperCredential = coreSettingsWithWorkspaceOpperCredential;
export const settingsWithOrganizationProviderCredentials =
  coreSettingsWithOrganizationProviderCredentials;
