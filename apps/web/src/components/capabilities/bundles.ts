/**
 * Bundles: the third kind of thing on the Capabilities page.
 *
 * A Bundle is a named collection of tools and instructions - a Skill, a Plugin,
 * or a Pack - not a live connection to another product. Integrations and
 * Connectors both hold an identity somewhere else; a Bundle holds none, so it
 * gets its own section rather than being mixed into the Connectors
 * Enabled/Browse grid.
 *
 * Three provenances coexist and are all named honestly on the row:
 *
 * - `built_in`: the reviewed curated Skill library OpenGeni ships, plus the
 *   Packs OpenGeni ships (`source: "built_in"` catalog rows).
 * - `admin_registered`: a Pack manifest a workspace admin registered here
 *   (`registerPackManifest`, `source: "manual"` catalog rows).
 * - `installed_from_source`: a Skill imported from GitHub/skills.sh, or a
 *   Plugin installed from a manifest URL.
 *
 * This module is pure: it maps each source's own summary onto one uniform row
 * and one discriminated detail action. Rendering, data loading, and mutations
 * live in `bundles-section.tsx` and the hooks it composes, exactly as provider
 * logic lives in the `use-*-integration.tsx` adapters rather than in
 * `integration-row.tsx`.
 */

import type {
  IntegrationChip,
  IntegrationMark,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import type { InstalledSourceSkill } from "@/components/capabilities/source-import-flow";
import type {
  CapabilityCatalogItem,
  CapabilityPack,
  PackInstallation,
  PluginInstallationSummary,
} from "@/types";

export type BundleKind = "skill" | "plugin" | "pack";

export type BundleProvenance = "built_in" | "admin_registered" | "installed_from_source";

/**
 * What opening a row does. Skills and Plugins imported from source share the
 * four-block `IntegrationSheet`; a curated library Skill keeps the catalog
 * detail sheet that already owns its install/update/remove and immutable
 * provenance panel; a Pack opens its own dialog, because picking a Rig and a
 * Variable Set genuinely does not compress into four blocks.
 */
export type BundleDetail =
  | { kind: "sheet"; model: IntegrationViewModel }
  | { kind: "catalog-sheet"; item: CapabilityCatalogItem }
  | { kind: "pack-dialog"; pack: CapabilityPack };

export type BundleRow = {
  /** Stable across reloads; unique across all three sources. */
  id: string;
  kind: BundleKind;
  provenance: BundleProvenance;
  name: string;
  /** The kind, the provenance, then the bundle's own one-line description. */
  description: string;
  mark: IntegrationMark;
  chip: IntegrationChip;
  /** True while this row's own mutation is in flight, from its source's state. */
  busy: boolean;
  detail: BundleDetail;
  /** Everything the bundle-scoped search matches against, already lowercased. */
  searchText: string;
};

export function bundleKindLabel(kind: BundleKind): string {
  switch (kind) {
    case "skill":
      return "Skill";
    case "plugin":
      return "Plugin";
    case "pack":
      return "Pack";
  }
}

export function bundleProvenanceLabel(provenance: BundleProvenance): string {
  switch (provenance) {
    case "built_in":
      return "Curated by OpenGeni";
    case "admin_registered":
      return "Registered in this workspace";
    case "installed_from_source":
      return "Imported from source";
  }
}

/**
 * The row's single description line. The taxonomy leads because it is what a
 * reader scans for and it never truncates away; the bundle's own sentence
 * follows and is the part that truncates. The full text stays in the detail.
 */
export function bundleRowDescription(
  kind: BundleKind,
  provenance: BundleProvenance,
  description: string,
): string {
  const prefix = `${bundleKindLabel(kind)} · ${bundleProvenanceLabel(provenance)}`;
  const trimmed = description.trim();
  return trimmed ? `${prefix} · ${trimmed}` : prefix;
}

/** Up to two letters from the bundle's own name; the last-resort mark. */
export function bundleMonogram(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

function mark(name: string, logoSrc: string | null): IntegrationMark {
  const monogram = bundleMonogram(name);
  return logoSrc ? { logoSrc, monogram } : { monogram };
}

function searchText(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

export function sourceHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/**
 * A Skill that is a catalog row - the curated reviewed library OpenGeni ships,
 * and any other directly owned Skill the catalog projects. It keeps the catalog
 * detail sheet: that sheet already owns install/update/remove under the
 * reviewed library identity plus the immutable provenance panel, and
 * reimplementing either onto the four-block frame would lose facts rather than
 * add any.
 */
export function catalogSkillBundleRow(
  item: CapabilityCatalogItem,
  options: { logoSrc: string | null; busy: boolean; provenance: BundleProvenance },
): BundleRow {
  const updateAvailable = item.metadata.updateAvailable === true;
  const chip: IntegrationChip = item.enabled
    ? updateAvailable
      ? { label: "Update available", tone: "warn" }
      : { label: "Installed", tone: "ok" }
    : { label: "Not installed", tone: "idle" };
  const description = item.description ?? "";
  return {
    id: item.id,
    kind: "skill",
    provenance: options.provenance,
    name: item.name,
    description: bundleRowDescription("skill", options.provenance, description),
    mark: mark(item.name, options.logoSrc),
    chip,
    busy: options.busy,
    detail: { kind: "catalog-sheet", item },
    searchText: searchText([item.name, description, item.category, ...item.tags, "skill"]),
  };
}

/**
 * A Skill imported from GitHub or skills.sh. Its facts are its immutable pinned
 * identity; its verbs are update and remove, so the sheet footer is `actions`
 * rather than connect/disconnect.
 */
export function importedSkillBundleRow(
  skill: InstalledSourceSkill,
  options: {
    canManage: boolean;
    busy: boolean;
    onUpdate: () => void;
    onRemove: () => void;
  },
): BundleRow {
  const chip: IntegrationChip = { label: "Installed", tone: "ok" };
  const name = skill.name;
  const rawDescription = skill.description ?? "";
  const description = bundleRowDescription("skill", "installed_from_source", rawDescription);
  return {
    // Namespaced so it can never collide with the catalog Skill row of the
    // same capability id.
    id: `imported:${skill.capabilityId}`,
    kind: "skill",
    provenance: "installed_from_source",
    name,
    description,
    mark: mark(name, null),
    chip,
    busy: options.busy,
    detail: {
      kind: "sheet",
      model: {
        id: `bundle-skill-${skill.capabilityId}`,
        name,
        description: rawDescription,
        mark: mark(name, null),
        chip,
        connection: [
          { label: "Source", value: sourceHost(skill.sourceUrl) },
          { label: "Pinned commit", value: skill.sourceCommit.slice(0, 12) },
          { label: "Content digest", value: skill.contentSha256.slice(0, 12) },
          { label: "Reviewed files", value: String(skill.fileCount) },
          { label: "Installation version", value: String(skill.installationVersion) },
        ],
        options: [],
        footer: options.canManage
          ? {
              kind: "actions",
              primary: { label: "Check for update", onClick: options.onUpdate },
              secondary: { label: "Remove", onClick: options.onRemove, destructive: true },
              busy: options.busy,
            }
          : {
              kind: "locked",
              message:
                "Workspace administrators can install, update, and remove imported Skills and Plugins.",
            },
      },
    },
    searchText: searchText([
      name,
      rawDescription,
      skill.category,
      ...skill.tags,
      skill.sourceUrl,
      "skill",
    ]),
  };
}

/** A Plugin installed from a reviewed manifest URL. */
export function pluginBundleRow(
  plugin: PluginInstallationSummary,
  options: {
    canManage: boolean;
    busy: boolean;
    onUpdate: () => void;
    onRemove: () => void;
  },
): BundleRow {
  const active = plugin.status === "active";
  const chip: IntegrationChip = active
    ? { label: "Installed", tone: "ok" }
    : { label: "Needs attention", tone: "warn" };
  const rawDescription = plugin.description || "Portable Plugin package";
  const sourceAvailable = plugin.sourceUrl !== null;
  return {
    id: `plugin:${plugin.pluginKey}`,
    kind: "plugin",
    provenance: "installed_from_source",
    name: plugin.name,
    description: bundleRowDescription("plugin", "installed_from_source", rawDescription),
    mark: mark(plugin.name, null),
    chip,
    busy: options.busy,
    detail: {
      kind: "sheet",
      model: {
        id: `bundle-plugin-${plugin.pluginKey}`,
        name: plugin.name,
        description: rawDescription,
        mark: mark(plugin.name, null),
        chip,
        connection: [
          { label: "Version", value: `v${plugin.version}` },
          {
            label: "Components",
            value: `${plugin.componentCount} owned by this Plugin`,
          },
          { label: "Manifest digest", value: plugin.manifestDigest.slice(0, 12) },
          {
            label: "Source",
            value: plugin.sourceUrl ? sourceHost(plugin.sourceUrl) : "Source unavailable",
          },
          { label: "Installation version", value: String(plugin.installationVersion) },
        ],
        options: [],
        footer: options.canManage
          ? {
              kind: "actions",
              primary: {
                label: "Review update",
                onClick: options.onUpdate,
                disabled: !sourceAvailable,
                ...(sourceAvailable
                  ? {}
                  : { unavailableReason: "This installed Plugin did not retain a source URL." }),
              },
              secondary: { label: "Remove", onClick: options.onRemove, destructive: true },
              busy: options.busy,
            }
          : {
              kind: "locked",
              message:
                "Workspace administrators can install, update, and remove imported Skills and Plugins.",
            },
        ...(active
          ? {}
          : {
              notice: {
                tone: "waiting" as const,
                title: "This Plugin installation needs attention",
                description:
                  "Review its manifest again to repair the installation, or remove it if it is no longer wanted.",
              },
            }),
      },
    },
    searchText: searchText([
      plugin.name,
      rawDescription,
      plugin.category,
      plugin.pluginKey,
      ...plugin.tags,
      plugin.sourceUrl,
      "plugin",
    ]),
  };
}

/** The Pack's chip. A Pack is installed or not; it is never "connected". */
export function packBundleChip(installation: PackInstallation | null): IntegrationChip {
  if (!installation || installation.status === "disabled") {
    return { label: "Not installed", tone: "idle" };
  }
  if (installation.status === "active") return { label: "Installed", tone: "ok" };
  if (installation.status === "installing") return { label: "Installing", tone: "plain" };
  return { label: "Needs attention", tone: "warn" };
}

/**
 * A Pack. Its row is identical to every other bundle row; only its detail
 * differs, because installing one means choosing a Rig and a Variable Set and
 * reviewing an exact component plan.
 */
export function packBundleRow(
  pack: CapabilityPack,
  options: {
    installation: PackInstallation | null;
    provenance: BundleProvenance;
    busy: boolean;
  },
): BundleRow {
  const chip = packBundleChip(options.installation);
  return {
    id: `pack:${pack.id}`,
    kind: "pack",
    provenance: options.provenance,
    name: pack.name,
    description: bundleRowDescription("pack", options.provenance, pack.description),
    mark: mark(pack.name, null),
    chip,
    busy: options.busy || chip.label === "Installing",
    detail: { kind: "pack-dialog", pack },
    searchText: searchText([
      pack.name,
      pack.description,
      pack.role,
      pack.category,
      pack.id,
      `v${pack.version}`,
      "pack",
    ]),
  };
}

/**
 * Where a Pack manifest came from. The catalog already carries this fact
 * (`built_in` for the manifests OpenGeni ships, `manual` for one a workspace
 * admin registered), so it is read rather than guessed.
 */
export function packBundleProvenance(
  packId: string,
  items: readonly CapabilityCatalogItem[],
): BundleProvenance {
  const item = items.find((candidate) => candidate.id === `pack:${packId}`);
  return item?.source === "manual" ? "admin_registered" : "built_in";
}

/** The bundle-scoped search: name and description, case-insensitive. */
export function filterBundleRows(rows: readonly BundleRow[], query: string): BundleRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...rows];
  return rows.filter((row) => row.searchText.includes(normalized));
}

/**
 * One stable order for the whole list: Packs, then Plugins, then Skills (the
 * largest unit first), each alphabetical. A status change never reorders the
 * list under the reader's cursor.
 */
export function sortBundleRows(rows: readonly BundleRow[]): BundleRow[] {
  const rank: Record<BundleKind, number> = { pack: 0, plugin: 1, skill: 2 };
  return [...rows].sort(
    (left, right) =>
      rank[left.kind] - rank[right.kind] ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}
