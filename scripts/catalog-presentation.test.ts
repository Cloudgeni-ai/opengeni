import { describe, expect, test } from "bun:test";

import {
  CapabilityCatalogItem as CapabilityCatalogItemSchema,
  type CapabilityCatalogItem,
} from "@opengeni/contracts";
import {
  capabilityCuration,
  filterCapabilityCatalogItems,
  opaqueCatalogName,
  sortConnectorsForPresentation,
} from "../apps/web/src/lib/capabilities";
import { FIRST_PARTY_CAPABILITY_LOGOS } from "../apps/web/src/components/capabilities/capability-logo-source";
import { VENDORED_LOGO_MANIFEST } from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;
const FIRST_PARTY_LOGO_IDS = new Set(Object.keys(FIRST_PARTY_CAPABILITY_LOGOS));

type PresentationItem = CapabilityCatalogItem;

describe("default catalog presentation", () => {
  test("keeps the complete catalog while making the first Browse rows logo-rich", async () => {
    const rows = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath)).rows;
    const vendored = new Set(VENDORED_LOGO_MANIFEST.entries.map((entry) => entry.capabilityId));
    const registry: PresentationItem[] = rows.map((row) => {
      const id = catalogCapabilityId(row.domain, row.mcpUrl);
      return CapabilityCatalogItemSchema.parse({
        id,
        kind: "mcp",
        source: "registry",
        surfaceType: null,
        name: row.name,
        category: row.category ?? "integrations",
        logoAssetPath: vendored.has(id) ? "catalog-assets/vendored" : null,
        metadata:
          row.curated || row.featured || row.official
            ? {
                curation: {
                  ...(row.curated ? { curated: true } : {}),
                  ...(row.featured ? { featured: true } : {}),
                  ...(row.official ? { official: true } : {}),
                },
              }
            : {},
      });
    });
    const firstParty: PresentationItem[] = [
      CapabilityCatalogItemSchema.parse({
        id: "api:fiken",
        kind: "api",
        source: "built_in",
        surfaceType: "first_party_fiken",
        name: "Fiken",
        category: "finance",
        logoAssetPath: null,
        metadata: {},
      }),
      CapabilityCatalogItemSchema.parse({
        id: "api:reddit",
        kind: "api",
        source: "built_in",
        surfaceType: "provider_integration",
        name: "Reddit",
        category: "social-media",
        logoAssetPath: null,
        metadata: {},
      }),
      CapabilityCatalogItemSchema.parse({
        id: "api:x",
        kind: "api",
        source: "built_in",
        surfaceType: "provider_integration",
        name: "X",
        category: "social-media",
        logoAssetPath: null,
        metadata: {},
      }),
    ];
    const serverOrder = [...firstParty, ...registry].sort((left, right) =>
      `${left.kind}:${left.category}:${left.name}`.localeCompare(
        `${right.kind}:${right.category}:${right.name}`,
      ),
    );
    const browse = serverOrder.filter((item) => !capabilityCuration(item).featured);
    const sorted = sortConnectorsForPresentation(browse);
    const before = browse.slice(0, 48);
    const after = sorted.slice(0, 48);

    expect(sorted).toHaveLength(browse.length);
    expect(new Set(sorted.map((item) => item.id))).toEqual(new Set(browse.map((item) => item.id)));

    const isFirstParty = (item: PresentationItem): boolean =>
      (item.kind === "mcp" || item.kind === "api") &&
      (item.source === "built_in" || item.surfaceType?.startsWith("first_party_") === true);
    const tier = (item: PresentationItem): number => {
      if (isFirstParty(item)) return 0;
      if (capabilityCuration(item).curated) return 1;
      if (item.logoAssetPath) return 2;
      return opaqueCatalogName(item.name) ? 4 : 3;
    };
    const tiers = sorted.map(tier);
    expect(tiers).toEqual([...tiers].sort((left, right) => left - right));
    const firstPartyCount = sorted.filter(isFirstParty).length;
    expect(sorted.slice(0, firstPartyCount).every(isFirstParty)).toBe(true);

    const quality = (items: readonly PresentationItem[], includeFirstPartyMarks: boolean) => ({
      logoBacked: items.filter(
        (item) =>
          item.logoAssetPath || (includeFirstPartyMarks && FIRST_PARTY_LOGO_IDS.has(item.id)),
      ).length,
      curated: items.filter((item) => capabilityCuration(item).curated).length,
      opaque: items.filter((item) => opaqueCatalogName(item.name)).length,
    });
    // The baseline models the prior UI: first-party rows had no bundled mark.
    const beforeQuality = quality(before, false);
    const afterQuality = quality(after, true);
    expect(afterQuality.logoBacked).toBeGreaterThanOrEqual(18);
    expect(afterQuality.logoBacked).toBeGreaterThanOrEqual(beforeQuality.logoBacked);
    expect(afterQuality.curated).toBeGreaterThanOrEqual(16);
    expect(afterQuality.curated).toBeGreaterThanOrEqual(beforeQuality.curated);
    expect(afterQuality.opaque).toBeLessThanOrEqual(5);
    expect(afterQuality.opaque).toBeLessThanOrEqual(beforeQuality.opaque);
    expect(quality(sorted.slice(0, 20), true).logoBacked).toBeGreaterThanOrEqual(17);

    const longTailTarget = browse.find((item, index) => index >= 48 && item.name.length >= 4);
    expect(longTailTarget).toBeDefined();
    const searchResults = sortConnectorsForPresentation(
      filterCapabilityCatalogItems(browse, "all", longTailTarget!.name),
    );
    expect(searchResults.some((item) => item.id === longTailTarget!.id)).toBe(true);
  });
});
