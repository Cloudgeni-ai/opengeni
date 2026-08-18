import { describe, expect, test } from "bun:test";

import {
  bundleAccessibleDetail,
  bundleMonogram,
  bundleRowDescription,
  catalogSkillBundleRow,
  filterBundleRows,
  importedSkillBundleRow,
  packBundleChip,
  packBundleProvenance,
  packBundleRow,
  pluginBundleRow,
  sortBundleRows,
  type BundleRow,
} from "./bundles";
import { isConnectorCatalogItem } from "@/lib/capabilities";
import type {
  CapabilityCatalogItem,
  CapabilityPack,
  InstalledSkillSummary,
  PackInstallation,
  PluginInstallationSummary,
} from "@/types";

describe("bundle rows", () => {
  test("maps all three provenances onto one uniform row", () => {
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
      packBundleRow(pack(), {
        installation: null,
        provenance: "admin_registered",
        busy: false,
      }),
    ]);

    // Packs first, then Plugins, then Skills; every row carries the same shape.
    expect(rows.map((row) => row.kind)).toEqual(["pack", "plugin", "skill", "skill"]);
    for (const row of rows) {
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
      expect(row.mark).toBeDefined();
      expect(row.chip.label.length).toBeGreaterThan(0);
    }

    expect(rows.map((row) => row.provenance)).toEqual([
      "admin_registered",
      "installed_from_source",
      "installed_from_source",
      "built_in",
    ]);
    // Every provenance is named on the row itself, never left implicit.
    expect(rows[0]!.description).toContain("Pack · Registered in this workspace");
    expect(rows[1]!.description).toContain("Plugin · Imported from source");
    expect(rows[2]!.description).toContain("Skill · Imported from source");
    expect(rows[3]!.description).toContain("Skill · Curated by OpenGeni");
  });

  test("Skills and Plugins open the sheet while Packs open the Pack dialog", () => {
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
    expect(
      packBundleRow(pack(), { installation: null, provenance: "built_in", busy: false }).detail
        .kind,
    ).toBe("pack-dialog");
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
    expect(packBundleChip(null)).toEqual({ label: "Not installed", tone: "idle" });
    expect(packBundleChip(installation("active"))).toEqual({ label: "Installed", tone: "ok" });
    expect(packBundleChip(installation("installing"))).toEqual({
      label: "Installing",
      tone: "plain",
    });
    expect(packBundleChip(installation("disabled"))).toEqual({
      label: "Not installed",
      tone: "idle",
    });
  });

  test("an installing Pack row is busy so its indicator is never a dead plus", () => {
    const row = packBundleRow(pack(), {
      installation: installation("installing"),
      provenance: "built_in",
      busy: false,
    });
    expect(row.busy).toBe(true);
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

  test("Pack provenance is read from the catalog, never guessed", () => {
    const items = [
      packItem("infra-ops", "manual"),
      packItem("openg-ops", "built_in"),
    ] as CapabilityCatalogItem[];
    expect(packBundleProvenance("infra-ops", items)).toBe("admin_registered");
    expect(packBundleProvenance("openg-ops", items)).toBe("built_in");
    // Packs and the catalog load independently. A Pack with no catalog row yet
    // is unknown, not "curated by OpenGeni".
    expect(packBundleProvenance("unknown", items)).toBeNull();
    expect(packBundleProvenance("infra-ops", [])).toBeNull();
    expect(packBundleProvenance("infra-ops", null)).toBeNull();
  });

  test("an unknown provenance is omitted from the row rather than claimed", () => {
    const row = packBundleRow(pack(), { installation: null, provenance: null, busy: false });
    expect(row.description).toBe("Pack · Pinned infrastructure automation capabilities.");
    expect(row.description).not.toContain("Curated by OpenGeni");
    expect(row.accessibleDetail).toBe("Pack");
  });

  test("every row carries its taxonomy as a spoken accessible detail", () => {
    // The row button's aria-label overrides its own contents, so the kind and
    // provenance the visible line carries have to arrive through this field or
    // a screen reader never hears either.
    expect(
      packBundleRow(pack(), { installation: null, provenance: "built_in", busy: false })
        .accessibleDetail,
    ).toBe("Pack, curated by OpenGeni");
    expect(
      packBundleRow(pack(), { installation: null, provenance: "admin_registered", busy: false })
        .accessibleDetail,
    ).toBe("Pack, registered in this workspace");
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
    packBundleRow(pack(), { installation: null, provenance: "built_in", busy: false }),
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
    expect(filterBundleRows(rows(), "infrastructure automation").map((row) => row.kind)).toEqual([
      "pack",
    ]);
  });

  test("an empty query keeps every row and a miss keeps none", () => {
    expect(filterBundleRows(rows(), "   ")).toHaveLength(3);
    expect(filterBundleRows(rows(), "nothing matches this")).toHaveLength(0);
  });

  test("finds a bundle by its kind word, singular or plural", () => {
    expect(filterBundleRows(rows(), "pack").map((row) => row.kind)).toEqual(["pack"]);
    expect(filterBundleRows(rows(), "Packs").map((row) => row.kind)).toEqual(["pack"]);
    expect(filterBundleRows(rows(), "plugin").map((row) => row.kind)).toEqual(["plugin"]);
  });

  test("the kind word is a discrete token, so `pack` never matches a `package`", () => {
    // A Plugin that supplied no description of its own used to default to
    // "Portable Plugin package", which substring-matched every search for
    // Packs.
    const describedByDefault = pluginBundleRow(installedPlugin({ description: "" }), {
      canManage: true,
      busy: false,
      onUpdate: () => {},
      onRemove: () => {},
    });
    expect(describedByDefault.description).toContain("A portable set of tools and instructions.");
    expect(filterBundleRows([describedByDefault], "pack")).toHaveLength(0);
    expect(filterBundleRows([describedByDefault], "plugin")).toHaveLength(1);
  });
});

describe("connector scoping", () => {
  test("Skills, Plugins, and Packs never reach the Connectors projections", () => {
    expect(isConnectorCatalogItem(curatedSkillItem())).toBe(false);
    expect(isConnectorCatalogItem(packItem("infra-ops", "manual"))).toBe(false);
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

  test("a bundle with no description still gets a truthful row line", () => {
    expect(bundleRowDescription("pack", "built_in", "  ")).toBe("Pack · Curated by OpenGeni");
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

function packItem(packId: string, source: "built_in" | "manual"): CapabilityCatalogItem {
  return catalogItem({
    id: `pack:${packId}`,
    kind: "pack",
    source,
    name: packId,
    description: "A pack",
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

function installation(status: PackInstallation["status"]): PackInstallation {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    accountId: "44444444-4444-4444-8444-444444444444",
    workspaceId: "55555555-5555-4555-8555-555555555555",
    packId: "infra-ops",
    status,
    version: 3,
    manifestSnapshot: pack(),
    manifestDigest: "d".repeat(64),
    selectedRigId: null,
    installedBySubjectId: "user:test",
    metadata: {},
    enabledAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}
