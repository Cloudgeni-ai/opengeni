import type { Settings } from "@opengeni/config";
import {
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
  const existingIds = new Set(settings.mcpServers.map((server) => server.id));
  const dynamicServers = enabled
    .filter((server) => !existingIds.has(server.id))
    .map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
      ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
      cacheToolsList: server.cacheToolsList ?? false,
    }));
  return dynamicServers.length ? { ...settings, mcpServers: [...settings.mcpServers, ...dynamicServers] } : settings;
}
