import snapshot from "../../../../data/catalog/plugins-snapshot.json";
import { PluginManifest, pluginMcpUnavailableReason } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/** Adapt only indexed portable components. Never silently drop required components. */
export function marketplacePlugin(url: string) {
  const source = snapshot.sources.find(candidate => candidate.entries.some(item => item.sourceUrl === url));
  const item = source?.entries.find(candidate => candidate.sourceUrl === url);
  if (!item || !source) return null;
  if (!item.skills || !item.mcpServers) throw new HTTPException(422, { message: "This external plugin must be indexed before it can be installed." });
  const servers = item.mcpServers.filter(server => pluginMcpUnavailableReason(server) === null).map((server, index) => ({ id: "marketplace-" + source.provider + "-" + item.name + "-" + index, name: server.name, url: server.endpoint!, cacheToolsList: true }));
  if (!item.skills.length && !servers.length) throw new HTTPException(422, { message: "This plugin has no skills or remote MCP servers that OpenGeni can install." });
  const manifest = PluginManifest.parse({
    schemaVersion: 1, pluginKey: "marketplace/" + source.provider + "/" + item.name,
    name: item.displayName, description: item.description.slice(0, 4000), version: item.version || source.revision,
    components: [
      ...item.skills.map((skill, index) => ({ key: "skill-" + index, kind: "skill", url: skill.sourceUrl })),
      ...servers.map((server, index) => ({ key: "mcp-" + index, kind: "mcp", serverId: server.id })),
    ],
  });
  return { manifest, servers, discovery: { ...item, provider: source.provider } };
}
