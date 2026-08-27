import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { usePacks } from "@opengeni/react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { BundlesSection } from "./bundles-section";
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
  test("lists every provenance through one uniform row under one heading", async () => {
    const rendered = await renderSection();
    try {
      const heading = rendered.container.querySelector("#bundles-heading");
      expect(heading?.textContent).toBe("Bundles");
      expect(rendered.container.textContent).toContain(
        "A named collection of tools and instructions, not a live connection to anything.",
      );

      const rows = rowIds(rendered.container);
      expect(rows).toEqual([
        "pack:infra-ops",
        "plugin:example/research",
        "imported:skill:release-operator-abc123",
        "skill:terraform",
      ]);
      // Every one of them is the same component, and the aria-label overrides
      // the visible line inside the button, so the taxonomy the row shows is
      // spoken between the name and the state rather than lost.
      expect(rowNames(rendered.container)).toEqual([
        "Infrastructure operations. Pack, registered in this workspace. Not installed",
        "Research suite. Plugin, imported from source. Installed",
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
      expect(count(rendered.container)).toBe("4 of 4");
    } finally {
      await rendered.unmount();
    }
  });

  test("says so plainly when nothing is installed", async () => {
    const rendered = await renderSection({ empty: true });
    try {
      expect(rowIds(rendered.container)).toEqual([]);
      expect(rendered.container.textContent).toContain("No bundles yet");
      expect(count(rendered.container)).toBe("0 of 0");
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
      expect(rendered.container.textContent).not.toContain("No bundles yet");
      expect(rowIds(rendered.container)).toEqual([]);
    } finally {
      await rendered.unmount();
    }
  });

  test("a failed Pack load is reported the same way", async () => {
    const rendered = await renderSection({ empty: true, packsError: true });
    try {
      expect(rendered.container.textContent).toContain("Couldn't load Packs");
      expect(rendered.container.textContent).not.toContain("No bundles yet");
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

  test("the source import and manifest registration entry points stay reachable", async () => {
    const rendered = await renderSection();
    try {
      const labels = [...rendered.container.querySelectorAll("button")].map(
        (candidate) => candidate.textContent ?? "",
      );
      expect(labels.some((label) => label.includes("Import Skill"))).toBe(true);
      expect(labels.some((label) => label.includes("Install Plugin"))).toBe(true);
      expect(labels.some((label) => label.includes("Add manifest"))).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("a viewer without administrator authority is told so, not shown live buttons", async () => {
    const rendered = await renderSection({ canManage: false });
    try {
      expect(rendered.container.textContent).toContain(
        "Workspace administrators can install, update, and remove Bundles.",
      );
      // Every header action is a workspace-administrator action; none of them
      // may sit live directly under the sentence that says so.
      for (const label of ["Import Skill", "Install Plugin", "Add manifest"]) {
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
    canManage?: boolean;
    empty?: boolean;
    loadError?: boolean;
    packsError?: boolean;
    onOpenCatalogItem?: (item: CapabilityCatalogItem) => void;
  } = {},
) {
  const rendered = await render(
    <BundlesSection
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
      listInstalledSkills: async () => {
        throw new Error("network is down");
      },
      listInstalledPlugins: async () => {
        throw new Error("network is down");
      },
    } as unknown as OpenGeniBrowserClient;
  }
  return {
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
