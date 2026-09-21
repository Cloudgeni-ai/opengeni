import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CapabilityCatalogItem, type PluginDiscoveryItem } from "@opengeni/contracts";
import { ConnectionCatalog, ConnectionLogo, SkillDiscovery } from "@opengeni/react/connect";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { PluginDiscovery } from "../src/components/capabilities/plugin-discovery";
import { CapabilityDetailSheet } from "../src/components/capabilities/capability-detail-sheet";
import "@opengeni/react/connect.css";
import "../src/styles.css";

const plugin: PluginDiscoveryItem = {
  id: "openai:research",
  name: "research",
  displayName: "Research",
  description: "Find evidence and prepare clear research summaries.",
  longDescription: "Research workflows and tools for your workspace.",
  provider: "openai",
  category: "research",
  logoUrl: null,
  darkLogoUrl: null,
  sourceUrl: "https://github.com/example/research",
  author: { name: "Example" },
  version: "1.0.0",
  skills: [
    { name: "Research notes", sourceUrl: "https://github.com/example/research/skills/notes" },
  ],
  mcpServers: [],
  components: ["skills"],
  installation: "available",
};
const client = {
  discoverPlugins: async () => ({ items: [plugin], total: 1, nextOffset: null }),
  listCapabilities: async () => ({ items: [] }),
  searchPublicSkills: async () => ({
    items: [
      {
        id: "research",
        name: "Research notes",
        source: "example/research",
        installs: 10,
        url: "https://github.com/example/research/skills/notes",
      },
      {
        id: "review",
        name: "Review changes",
        source: "example/review",
        installs: 5,
        url: "https://github.com/example/review",
      },
    ],
    nextCursor: null,
  }),
} as unknown as OpenGeniBrowserClient;

function Fixture() {
  const opener = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState<CapabilityCatalogItem | null>(null);
  function open(name: string, kind: "skill" | "mcp" = "mcp") {
    opener.current = document.activeElement as HTMLElement;
    setSelected(
      CapabilityCatalogItem.parse({
        id: `${kind}:${name.toLowerCase().replaceAll(" ", "-")}`,
        kind,
        name,
        source: "manual",
        category: "productivity",
        enabled: false,
        description:
          kind === "skill"
            ? "Review the instructions and source before installing."
            : "Search and work with the information in your connected account.",
        ...(kind === "mcp"
          ? {
              endpointUrl: "https://example.test/mcp",
              authKind: "oauth2",
              metadata: { authDiscovery: "oauth2" },
            }
          : {}),
        actions: ["connect", "inspect"],
      }),
    );
  }
  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 sm:p-12">
      <header>
        <h1 className="text-2xl font-semibold">Capabilities</h1>
        <p className="mt-2 text-sm text-fg-muted">Bring your tools and workflows into OpenGeni.</p>
      </header>
      <section aria-label="Connections">
        <h2 className="mb-3 text-sm font-semibold">Connections</h2>
        <ConnectionCatalog
          columns={2}
          services={[
            {
              id: "notion",
              name: "Notion",
              logo: <ConnectionLogo src={null} name="Notion" />,
              options: [
                {
                  id: "notion",
                  name: "Notion",
                  description: "Research, meeting notes, and project knowledge.",
                  status: "Not connected",
                  state: "available",
                  connected: false,
                  onOpen: () => open("Notion"),
                },
              ],
            },
            {
              id: "github",
              name: "GitHub",
              logo: <ConnectionLogo src={null} name="GitHub" />,
              options: [
                {
                  id: "github",
                  name: "GitHub",
                  description: "Repositories, issues, and pull requests.",
                  status: "Connected",
                  state: "added",
                  connected: true,
                  onOpen: () => open("GitHub"),
                },
              ],
            },
          ]}
        />
      </section>
      <SkillDiscovery
        client={client}
        workspaceId="fixture"
        query="research"
        canManage
        installedSkills={[
          {
            name: "Review changes",
            repositoryUrl: "https://github.com/example/review",
            sourceUrl: "https://github.com/example/review",
          },
        ]}
        onImport={() => open("Research notes", "skill")}
      />
      <PluginDiscovery client={client} workspaceId="fixture" query="" canManage />
      <CapabilityDetailSheet
        open={selected !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setSelected(null);
        }}
        restoreFocusRef={opener}
        item={selected}
        health={{ state: "none" }}
        logoSrc={null}
        busy={false}
        errorMessage={null}
        onAction={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
