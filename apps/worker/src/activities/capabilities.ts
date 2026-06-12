import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  decryptedCapabilityHeaders,
  listEnabledMcpCapabilityServers,
  type Database,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";

export async function settingsWithEnabledCapabilityMcpServers(db: Database, workspaceId: string, settings: Settings): Promise<Settings> {
  const enabled = await listEnabledMcpCapabilityServers(db, workspaceId);
  return settingsWithMcpCapabilityServers(settings, enabled);
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
