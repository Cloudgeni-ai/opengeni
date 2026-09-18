import { describe, expect, test } from "bun:test";

import {
  bundleAccessibleDetail,
  bundleMonogram,
  bundleRowDescription,
  catalogSkillBundleRow,
  filterBundleRows,
  importedSkillBundleRow,
  pluginBundleRow,
  sortBundleRows,
  type BundleRow,
} from "./bundles";
import { isConnectorCatalogItem } from "@/lib/capabilities";
import type {
  CapabilityCatalogItem,
  InstalledSkillSummary,
  PluginInstallationSummary,
} from "@/types";

describe("bundle rows", () => {
  test("maps installed and curated items onto one uniform row", () => {
    const rows = sortBundleRows([
      catalogSkillBundleRow(curatedSkillItem(), {
        logoSrc: null,
        busy: false,
        provenance: "built_in",
      }),
      importedSkillBundleRow(importedSkill(), {
        canManage: true,
        busy: false,
        onUpdate: () => {},
        onRemove: () => {},
      }),
      pluginBundleRow(installedPlugin(), {
        canManage: true,
        busy: false,
        onUpdate: () => {},
        onRemove: () => {},
      }),
    ]);

    // Plugins first, then Skills; every row carries the same shape.
    expect(rows.map((row) => row.kind)).toEqual(["plugin", "skill", "skill"]);
    for (const row of rows) {
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
      expect(row.mark).toBeDefined();
      expect(row.chip.label.length).toBeGreaterThan(0);
    }

    expect(rows.map((row) => row.provenance)).toEqual([
      "installed_from_source",
      "installed_from_source",
      "built_in",
    ]);
    // Keep provenance as structured metadata and in details, not catalog copy.
    for (const row of rows) {
      expect(row.description).not.toMatch(/^(Plugin|Skill) ·/);
      expect(row.accessibleDetail).toBeTruthy();
    }
  });

  test("Skills and Plugins open their appropriate detail sheet", () => {
    expect(
      importedSkillBundleRow(importedSkill(), {
        canManage: true,
        busy: false,
        onUpdate: () => {},
        onRemove: () => {},
      }).detail.kind,
    ).toBe("sheet");
    expect(
      pluginBundleRow(installedPlugin(), {
        canManage: true,
        busy: false,
        onUpdate: () => {},
        onRemove: () => {},
      }).detail.kind,
    ).toBe("sheet");

    // A curated library Skill is a catalog row and keeps the catalog detail
    // sheet that already owns its reviewed identity and install/remove.
    expect(
      catalogSkillBundleRow(curatedSkillItem(), {
        logoSrc: null,
        busy: false,
        provenance: "built_in",
      }).detail.kind,
    ).toBe("catalog-sheet");
  });

  test("bundle chips never say Connected, and reflect real installation state", () => {
    expect(
      catalogSkillBundleRow(curatedSkillItem({ enabled: false }), {
        logoSrc: null,
        busy: false,
        provenance: "built_in",
      }).chip,
    ).toEqual({ label: "Not installed", tone: "idle" });
    expect(
      catalogSkillBundleRow(curatedSkillItem({ updateAvailable: true }), {
        logoSrc: null,
        busy: false,
        provenance: "built_in",
      }).chip,
    ).toEqual({ label: "Update available", tone: "warn" });
    expect(
      pluginBundleRow(installedPlugin({ status: "needs_attention" }), {
        canManage: true,
        busy: false,
        onUpdate: () => {},
        onRemove: () => {},
      }).chip,
    ).toEqual({ label: "Needs attention", tone: "warn" });
  });

  test("a viewer without administrator authority gets the locked footer, not dead buttons", () => {
    const row = importedSkillBundleRow(importedSkill(), {
      canManage: false,
      busy: false,
      onUpdate: () => {},
      onRemove: () => {},
    });
    if (row.detail.kind !== "sheet") throw new Error("expected a sheet detail");
    expect(row.detail.model.footer.kind).toBe("locked");
  });

  test("a Plugin with no retained source URL explains why its update is unavailable", () => {
    const row = pluginBundleRow(installedPlugin({ sourceUrl: null }), {
      canManage: true,
      busy: false,
      onUpdate: () => {},
      onRemove: () => {},
    });
    if (row.detail.kind !== "sheet") throw new Error("expected a sheet detail");
    const footer = row.detail.model.footer;
    if (footer.kind !== "actions") throw new Error("expected an actions footer");
    expect(footer.primary?.disabled).toBe(true);
    expect(footer.primary?.unavailableReason).toContain("did not retain a source URL");
  });

  test("every row carries its taxonomy as a spoken accessible detail", () => {
    // The row button's aria-label overrides its own contents, so the kind and
    // provenance the visible line carries have to arrive through this field or
    // a screen reader never hears either.

    expect(
      pluginBundleRow(installedPlugin(), {
        canManage: true,
        busy: false,
        onUpdate: () => {},
        onRemove: () => {},
      }).accessibleDetail,
    ).toBe("Plugin, imported from source");
    expect(
      catalogSkillBundleRow(curatedSkillItem(), {
        logoSrc: null,
        busy: false,
        provenance: "built_in",
      }).accessibleDetail,
    ).toBe("Skill, curated by OpenGeni");
    expect(bundleAccessibleDetail("skill", null)).toBe("Skill");
  });
});

describe("bundle search", () => {
  const rows = (): BundleRow[] => [
    pluginBundleRow(installedPlugin(), {
      canManage: true,
      busy: false,
      onUpdate: () => {},
      onRemove: () => {},
    }),
    importedSkillBundleRow(importedSkill(), {
      canManage: true,
      busy: false,
      onUpdate: () => {},
      onRemove: () => {},
    }),
  ];

  test("matches name and description, case-insensitively", () => {
    expect(filterBundleRows(rows(), "RESEARCH").map((row) => row.kind)).toEqual(["plugin"]);
    expect(filterBundleRows(rows(), "release safely").map((row) => row.kind)).toEqual(["skill"]);
  });

  test("an empty query keeps every row and a miss keeps none", () => {
    expect(filterBundleRows(rows(), "   ")).toHaveLength(2);
    expect(filterBundleRows(rows(), "nothing matches this")).toHaveLength(0);
  });

  test("finds a bundle by its kind word, singular or plural", () => {
    expect(filterBundleRows(rows(), "skill").map((row) => row.kind)).toEqual(["skill"]);
    expect(filterBundleRows(rows(), "Skills").map((row) => row.kind)).toEqual(["skill"]);
    expect(filterBundleRows(rows(), "plugin").map((row) => row.kind)).toEqual(["plugin"]);
  });

  test("default descriptions explain the plugin without obsolete package terminology", () => {
    // A Plugin that supplied no description of its own used to default to
    // "Portable Plugin package", which was unclear in search results.
    const describedByDefault = pluginBundleRow(installedPlugin({ description: "" }), {
      canManage: true,
      busy: false,
      onUpdate: () => {},
      onRemove: () => {},
    });
    expect(describedByDefault.description).toContain("A portable set of tools and instructions.");
    expect(filterBundleRows([describedByDefault], "package")).toHaveLength(0);
    expect(filterBundleRows([describedByDefault], "plugin")).toHaveLength(1);
  });
});

describe("connector scoping", () => {
  test("Skills and Plugins never reach the Connectors projections", () => {
    expect(isConnectorCatalogItem(curatedSkillItem())).toBe(false);

    expect(isConnectorCatalogItem(catalogItem({ id: "plugin:x", kind: "plugin" }))).toBe(false);
    expect(isConnectorCatalogItem(catalogItem({ id: "mcp:x", kind: "mcp" }))).toBe(true);
    expect(isConnectorCatalogItem(catalogItem({ id: "api:fiken", kind: "api" }))).toBe(true);
  });
});

describe("bundle monogram", () => {
  test("uses initials, then a two-letter prefix, and never renders empty", () => {
    expect(bundleMonogram("Research suite")).toBe("RS");
    expect(bundleMonogram("release-operator")).toBe("RO");
    expect(bundleMonogram("Terraform")).toBe("TE");
    expect(bundleMonogram("   ")).toBe("?");
  });

  test("a bundle with no description does not invent a metadata line", () => {
    expect(bundleRowDescription("skill", "built_in", "  ")).toBe("");
  });
});

function catalogItem(patch: Partial<CapabilityCatalogItem>): CapabilityCatalogItem {
  return {
    id: "skill:release-operator",
    kind: "skill",
    source: "library",
    name: "release-operator",
    description: "Release safely",
    category: "skills",
    tags: ["skill"],
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

function curatedSkillItem(
  options: { enabled?: boolean; updateAvailable?: boolean } = {},
): CapabilityCatalogItem {
  return catalogItem({
    enabled: options.enabled ?? true,
    metadata: options.updateAvailable ? { updateAvailable: true } : {},
  });
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

function installedPlugin(
  patch: Partial<PluginInstallationSummary> = {},
): PluginInstallationSummary {
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
    ...patch,
  };
}
