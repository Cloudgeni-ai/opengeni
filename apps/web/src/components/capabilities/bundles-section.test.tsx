import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { usePacks } from "@opengeni/react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { BundlesSection } from "./bundles-section";
import { PluginDiscovery } from "./plugin-discovery";
import type {
  CapabilityCatalogItem,
  CapabilityPack,
  InstalledSkillSummary,
  PluginInstallationSummary,
} from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("BundlesSection", () => {
  test("filters all bundle kinds using the page query without a second search input", async () => {
    for (const [query, expected] of [
      [" RESEARCH ", "plugin:example/research"],
      ["Terraform", "skill:terraform"],
      ["Infrastructure operations", "pack:infra-ops"],
      ["release-operator", "imported:skill:release-operator-abc123"],
    ] as const) {
      const rendered = await renderSection({ query });
      try {
        if (expected.startsWith("plugin:")) {
          expect(
            rendered.container
              .querySelector("[data-installed-plugin]")
              ?.getAttribute("data-installed-plugin"),
          ).toBe("example/research");
          expect(rowIds(rendered.container)).toEqual([]);
        } else {
          expect(rowIds(rendered.container)).toEqual([expected]);
          expect(count(rendered.container)).toBe("1 results");
        }
        expect(rendered.container.querySelector('input[type="search"]')).toBeNull();
      } finally {
        await rendered.unmount();
      }
    }
  });

  test("reports no matches for an unrelated page query", async () => {
    const rendered = await renderSection({ query: "unmatched-connector" });
    try {
      expect(rowIds(rendered.container)).toEqual([]);
      expect(count(rendered.container)).toBe("0 results");
    } finally {
      await rendered.unmount();
    }
  });
  test("lists skills and workflow templates alongside installed plugins", async () => {
    const rendered = await renderSection();
    try {
      const heading = rendered.container.querySelector("#bundles-heading");
      expect(heading?.textContent).toBe("Skills & plugins");
      expect(rendered.container.textContent).toContain(
        "Skills and connections installed together.",
      );

      const rows = rowIds(rendered.container);
      expect(rows).toEqual([
        "pack:infra-ops",
        "imported:skill:release-operator-abc123",
        "skill:terraform",
      ]);
      // Skill and template rows preserve their provenance in the accessible name.
      expect(rendered.container.querySelector("[data-installed-plugin]")?.textContent).toContain(
        "Research suite",
      );
      expect(rowNames(rendered.container)).toEqual([
        "Infrastructure operations. Workflow template, registered in this workspace. Not installed",
        "release-operator. Skill, imported from source. Installed",
        "Terraform. Skill, curated by OpenGeni. Installed",
      ]);
      // A Bundle is never "Connected" - that word belongs to a connection.
      expect(rendered.container.textContent).not.toContain("Connected");
    } finally {
      await rendered.unmount();
    }
  });

  test("no bundle row offers the quick-connect fast path", async () => {
    const rendered = await renderSection();
    try {
      const connect = [...rendered.container.querySelectorAll("button")].filter(
        (candidate) => candidate.getAttribute("aria-label") === "Connect",
      );
      expect(connect).toHaveLength(0);
    } finally {
      await rendered.unmount();
    }
  });

  // React's onChange never fires for a controlled input in this DOM shim, so
  // typing into the bundle search is proven by the browser acceptance spec.
  // The filter itself is covered exhaustively in `bundles.test.ts`.
  test("reports how much of the bundle list the search is showing", async () => {
    const rendered = await renderSection();
    try {
      expect(count(rendered.container)).toBe("3 results");
      expect(rendered.container.querySelectorAll("[data-installed-plugin]")).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("says so plainly when nothing is installed", async () => {
    const rendered = await renderSection({ empty: true });
    try {
      expect(rowIds(rendered.container)).toEqual([]);
      expect(rendered.container.textContent).toContain("No skills or plugins yet");
      expect(count(rendered.container)).toBe("0 results");
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed load is reported as a failure, never as an empty inventory", async () => {
    const rendered = await renderSection({ empty: true, loadError: true });
    try {
      expect(rendered.container.textContent).toContain(
        "Couldn't load installed Skills and Plugins",
      );
      // The banner above already owns this state; claiming nothing is installed
      // would contradict it.
      expect(rendered.container.textContent).not.toContain("No skills or plugins yet");
      expect(rowIds(rendered.container)).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed Pack load is reported the same way", async () => {
    const rendered = await renderSection({ empty: true, packsError: true });
    try {
      expect(rendered.container.textContent).toContain("Couldn't load Packs");
      expect(rendered.container.textContent).not.toContain("No skills or plugins yet");
    } finally {
      await rendered.unmount();
    }
  });

  test("a catalog Skill row opens the catalog detail sheet rather than a second frame", async () => {
    const onOpenCatalogItem = mock((_item: CapabilityCatalogItem) => {});
    const rendered = await renderSection({ onOpenCatalogItem });
    try {
      const row = rendered.container.querySelector<HTMLElement>(
        '[data-integration-row="skill:terraform"] button',
      );
      await act(async () => row!.click());
      expect(onOpenCatalogItem).toHaveBeenCalledTimes(1);
      expect(onOpenCatalogItem.mock.calls[0]![0]!.id).toBe("skill:terraform");
    } finally {
      await rendered.unmount();
    }
  });

  test("plugin import and manifest registration entry points stay reachable", async () => {
    const rendered = await renderSection({ section: "plugins" });
    try {
      const labels = [...rendered.container.querySelectorAll("button")].map(
        (candidate) => candidate.textContent ?? "",
      );
      expect(labels.some((label) => label.includes("Import plugin"))).toBe(true);
      expect(labels.some((label) => label.includes("Add workflow template"))).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("an installed plugin card loads its exact installed identity before management", async () => {
    const getInstalledPluginDetails = mock(async (_workspaceId: string, _pluginKey: string) => ({
      id: "example:research",
      name: "research",
      displayName: "Research suite",
      description: "Research tools",
      longDescription: "Research tools",
      provider: "custom",
      category: null,
      logoUrl: null,
      darkLogoUrl: null,
      sourceUrl: installedPlugin().sourceUrl,
      author: null,
      version: "2.0.0",
      skills: [],
      mcpServers: [],
      components: [],
      installation: "installed",
    }));
    const rendered = await render(
      <PluginDiscovery
        client={Object.assign(stubClient(false), { getInstalledPluginDetails })}
        workspaceId="00000000-0000-4000-8000-000000000001"
        query=""
        installedPlugins={[installedPlugin()]}
      />,
    );
    try {
      const card = rendered.container.querySelector<HTMLButtonElement>(".og-plugin-discovery-row");
      expect(card?.textContent).toContain("Research suite");
      await act(async () => card!.click());
      expect(getInstalledPluginDetails).toHaveBeenCalledTimes(1);
      expect(getInstalledPluginDetails).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000001",
        "example/research",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("a viewer without administrator authority is told so, not shown live buttons", async () => {
    const rendered = await renderSection({ canManage: false });
    try {
      expect(rendered.container.textContent).toContain(
        "Workspace administrators can install, update, and remove these items.",
      );
      // Every header action is a workspace-administrator action; none of them
      // may sit live directly under the sentence that says so.
      for (const label of ["Import plugin", "Add workflow template"]) {
        const button = [...rendered.container.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.includes(label),
        );
        expect(button?.disabled).toBe(true);
      }
    } finally {
      await rendered.unmount();
    }
  });
});

function rowIds(container: ParentNode): string[] {
  return [...container.querySelectorAll("[data-integration-row]")].map(
    (row) => row.getAttribute("data-integration-row") ?? "",
  );
}

function rowNames(container: ParentNode): string[] {
  return [...container.querySelectorAll("[data-integration-row] > button")].map(
    (row) => row.getAttribute("aria-label") ?? "",
  );
}

function count(container: ParentNode): string {
  return container.querySelector("[data-bundle-count]")?.textContent ?? "";
}

async function renderSection(
  options: {
    section?: "skills" | "plugins" | "all";
    canManage?: boolean;
    empty?: boolean;
    loadError?: boolean;
    packsError?: boolean;
    query?: string;
    onOpenCatalogItem?: (item: CapabilityCatalogItem) => void;
  } = {},
) {
  const rendered = await render(
    <BundlesSection
      section={options.section ?? "all"}
      query={options.query ?? ""}
      client={stubClient(options.empty ?? false, options.loadError ?? false)}
      workspaceId="00000000-0000-4000-8000-000000000001"
      connections={[]}
      canManage={options.canManage ?? true}
      items={options.empty ? [] : catalogItems()}
      logoUrl={() => null}
      busyCatalogId={null}
      onOpenCatalogItem={options.onOpenCatalogItem ?? (() => {})}
      packs={packsState(options.empty ?? false, options.packsError ?? false)}
      variableSets={[]}
      rigs={[]}
      busyPackId={null}
      onRegisterPack={async () => true}
      onPreviewPackInstall={async () => null}
      onInstallPack={async () => true}
      onPreviewPackUninstall={async () => null}
      onUninstallPack={async () => true}
      onUnregisterPack={async () => true}
      onStartPackSession={() => {}}
      onChanged={() => {}}
    />,
  );
  // The installed Skill/Plugin load resolves after mount.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return rendered;
}

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

function stubClient(empty: boolean, failed = false): OpenGeniBrowserClient {
  if (failed) {
    return {
      listCapabilities: async () => ({ items: [], installations: [] }),
      searchPublicSkills: async () => ({ items: [] }),
      discoverPlugins: async () => ({ items: [], total: 0, nextOffset: null }),
      listInstalledSkills: async () => {
        throw new Error("network is down");
      },
      listInstalledPlugins: async () => {
        throw new Error("network is down");
      },
    } as unknown as OpenGeniBrowserClient;
  }
  return {
    searchPublicSkills: async () => ({ items: [] }),
    listCapabilities: async () => ({ items: empty ? [] : catalogItems(), installations: [] }),
    discoverPlugins: async () => ({ items: [], total: 0, nextOffset: null }),
    listInstalledSkills: async () => ({ skills: empty ? [] : [importedSkill()] }),
    listInstalledPlugins: async () => ({ plugins: empty ? [] : [installedPlugin()] }),
  } as unknown as OpenGeniBrowserClient;
}

function packsState(empty: boolean, failed = false): ReturnType<typeof usePacks> {
  return {
    packs: empty ? [] : [pack()],
    installations: [],
    installationFor: () => null,
    loading: false,
    error: failed ? new Error("network is down") : null,
    refresh: async () => {},
    register: async () => null,
    enable: async () => null,
    previewInstallation: async () => null,
    install: async () => null,
    previewUninstall: async () => null,
    uninstall: async () => null,
    remove: async () => false,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
  };
}

function catalogItems(): CapabilityCatalogItem[] {
  return [
    catalogItem({
      id: "skill:terraform",
      kind: "skill",
      source: "library",
      name: "Terraform",
      description: "Plan and apply infrastructure safely.",
    }),
    catalogItem({
      id: "mcp:linear",
      kind: "mcp",
      source: "built_in",
      name: "Linear",
      description: "Issue tracking.",
    }),
    catalogItem({
      id: "pack:infra-ops",
      kind: "pack",
      source: "manual",
      name: "Infrastructure operations",
      description: "Pinned infrastructure automation capabilities.",
    }),
  ];
}

function catalogItem(patch: Partial<CapabilityCatalogItem>): CapabilityCatalogItem {
  return {
    id: "skill:terraform",
    kind: "skill",
    source: "library",
    name: "Terraform",
    description: "Plan and apply infrastructure safely.",
    category: "skills",
    tags: [],
    homepageUrl: null,
    endpointUrl: null,
    installUrl: null,
    authModel: null,
    providerDomain: null,
    surfaceType: null,
    authKind: "none",
    tools: [],
    runtime: { available: true, notes: null },
    enabled: true,
    enabledReason: null,
    provenance: null,
    actions: [],
    logoAssetPath: null,
    metadata: {},
    ...patch,
  } as unknown as CapabilityCatalogItem;
}

function importedSkill(): InstalledSkillSummary {
  return {
    capabilityId: "skill:release-operator-abc123",
    pluginKey: "skill/github/acme/skills/release-operator",
    installationVersion: 2,
    name: "release-operator",
    description: "Release safely",
    category: "skills",
    tags: ["skill", "imported"],
    provenance: "workspace_import",
    source: "github",
    version: "a".repeat(40),
    sourceUrl: "https://github.com/acme/skills/tree/aaaaaaaa/release-operator",
    repositoryUrl: "https://github.com/acme/skills",
    sourceCommit: "a".repeat(40),
    sourcePath: "release-operator",
    contentSha256: "b".repeat(64),
    fileCount: 1,
    totalBytes: 128,
    license: null,
    installedAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    owners: [{ kind: "direct", id: "skill:release-operator-abc123", removable: true }],
  };
}

function installedPlugin(): PluginInstallationSummary {
  return {
    pluginKey: "example/research",
    version: "2.0.0",
    name: "Research suite",
    description: "Research tools",
    category: "plugins",
    tags: ["research"],
    sourceUrl: "https://plugins.example.test/research.json",
    manifestDigest: "c".repeat(64),
    installationVersion: 2,
    componentCount: 2,
    status: "active",
    installedAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function pack(): CapabilityPack {
  return {
    id: "infra-ops",
    name: "Infrastructure operations",
    description: "Pinned infrastructure automation capabilities.",
    role: "infrastructure",
    category: "operations",
    version: "2.0.0",
    skills: [],
    components: [],
    tools: [],
    connectors: [],
    knowledge: [],
    scheduledTaskTemplates: [],
    metadata: {},
  };
}
