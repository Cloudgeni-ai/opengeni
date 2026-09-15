import { createRoot } from "react-dom/client";
import type { PluginDiscoveryItem, PluginInstallationSummary } from "@opengeni/contracts";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { PluginDiscovery } from "../src/components/capabilities/plugin-discovery";
import "@opengeni/react/connect.css";
import "../src/styles.css";

const params = new URLSearchParams(window.location.search);
const long = params.has("long");
const item: PluginDiscoveryItem = {
  id: "openai:research",
  name: "research",
  displayName: "Research suite",
  description: "Find evidence, compare sources, and prepare research with your workspace tools.",
  longDescription: "Research tools for your workspace. ".repeat(long ? 150 : 1),
  provider: "openai",
  category: "research",
  logoUrl: null,
  darkLogoUrl: null,
  sourceUrl: "https://github.com/example/research",
  author: { name: "Example" },
  version: "1.0.0",
  skills: Array.from({ length: long ? 25 : 1 }, (_, index) => ({
    name: `Research skill ${index + 1}`,
    sourceUrl: `https://github.com/example/research/skills/${index}/SKILL.md`,
  })),
  mcpServers: [
    { name: "Research MCP", transport: "http", endpoint: "https://example.com/mcp" },
    { name: "Local helper", transport: "stdio", endpoint: null },
  ],
  components: ["skills", "mcp"],
  installation: "available",
};
const installed: PluginInstallationSummary = {
  pluginKey: "marketplace/openai/research",
  name: item.displayName,
  description: item.description,
  sourceUrl: item.sourceUrl,
  version: "1.0.0",
  category: "research",
  tags: [],
  componentCount: 2,
  manifestDigest: "a".repeat(64),
  installationVersion: 1,
  status: "active",
  installedAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:00Z",
};
const client = {
  discoverPlugins: async () => ({ items: [item], total: 1, nextOffset: null }),
  listCapabilities: async () => ({ items: [] }),
  getInstalledPluginDetails: async () => item,
  previewPlugin: async () => ({
    manifestDigest: "a".repeat(64),
    components: [],
    installationVersion: null,
  }),
  installPlugin: async () => ({}),
} as unknown as OpenGeniBrowserClient;

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-5xl p-6 sm:p-12">
    <h1 className="mb-2 text-xl font-semibold">Capabilities</h1>
    <p className="mb-8 text-sm text-fg-muted">Extend OpenGeni with skills and plugins.</p>
    <PluginDiscovery
      client={client}
      workspaceId="workspace"
      query=""
      canManage={!params.has("readonly")}
      installedPlugins={params.has("installed") ? [installed] : []}
      onOpenConnection={() => {}}
    />
  </main>,
);
