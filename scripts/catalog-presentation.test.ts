import { describe, expect, test } from "bun:test";

import type { CapabilityCatalogItem } from "@opengeni/contracts";
import {
  capabilityCuration,
  opaqueCatalogName,
  sortConnectorsForPresentation,
} from "../apps/web/src/lib/capabilities";
import { VENDORED_LOGO_MANIFEST } from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;
const FIRST_PARTY_IDS = new Set(["api:fiken", "api:reddit", "api:x"]);

type PresentationItem = Pick<
  CapabilityCatalogItem,
  "id" | "kind" | "source" | "surfaceType" | "metadata" | "logoAssetPath" | "name"
> & { category: string };

describe("default catalog presentation", () => {
  test("keeps the complete catalog while making the first Browse rows logo-rich", async () => {
    const rows = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath)).rows;
    const vendored = new Set(VENDORED_LOGO_MANIFEST.entries.map((entry) => entry.capabilityId));
    const registry: PresentationItem[] = rows.map((row) => {
      const id = catalogCapabilityId(row.domain, row.mcpUrl);
      return {
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
      };
    });
    const firstParty: PresentationItem[] = [
      {
        id: "api:fiken",
        kind: "api",
        source: "built_in",
        surfaceType: "first_party_fiken",
        name: "Fiken",
        category: "finance",
        logoAssetPath: null,
        metadata: {},
      },
      {
        id: "api:reddit",
        kind: "api",
        source: "built_in",
        surfaceType: "provider_integration",
        name: "Reddit",
        category: "social-media",
        logoAssetPath: null,
        metadata: {},
      },
      {
        id: "api:x",
        kind: "api",
        source: "built_in",
        surfaceType: "provider_integration",
        name: "X",
        category: "social-media",
        logoAssetPath: null,
        metadata: {},
      },
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
    expect({
      logoBacked: before.filter((item) => item.logoAssetPath).length,
      curated: before.filter((item) => capabilityCuration(item).curated).length,
      opaque: before.filter((item) => opaqueCatalogName(item.name)).length,
    }).toEqual({ logoBacked: 8, curated: 9, opaque: 12 });
    expect({
      logoBacked: after.filter((item) => item.logoAssetPath || FIRST_PARTY_IDS.has(item.id)).length,
      curated: after.filter((item) => capabilityCuration(item).curated).length,
      opaque: after.filter((item) => opaqueCatalogName(item.name)).length,
    }).toEqual({ logoBacked: 19, curated: 17, opaque: 4 });
    const firstTwenty = sorted.slice(0, 20);
    expect(firstTwenty.map((item) => item.name)).toEqual([
      "Fiken",
      "Reddit",
      "X",
      "Amplitude",
      "Zapier",
      "Front",
      "Intercom",
      "Mobbin",
      "PagerDuty",
      "Box",
      "Dropbox",
      "PayPal",
      "Ahrefs",
      "Semrush",
      "Otter.ai",
      "ClickUp",
      "monday.com",
      "Apollo.io",
      "Calendly",
      "Webflow",
    ]);
    expect(
      firstTwenty.filter((item) => item.logoAssetPath || FIRST_PARTY_IDS.has(item.id)),
    ).toHaveLength(19);
  });
});
