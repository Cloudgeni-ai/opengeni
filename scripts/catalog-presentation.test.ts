import { describe, expect, test } from "bun:test";

import {
  CapabilityCatalogItem as CapabilityCatalogItemSchema,
  type CapabilityCatalogItem,
} from "@opengeni/contracts";
import { capabilityCuration, filterCapabilityCatalogItems } from "../apps/web/src/lib/capabilities";
import {
  opaqueCatalogName,
  sortConnectorsForPresentation,
} from "../apps/web/src/components/capabilities/catalog-presentation";
import { capabilityLogoSource } from "../apps/web/src/components/capabilities/capability-logo-source";
import {
  catalogServiceIdentity,
  mergeConnectionServices,
  partitionConnectionServices,
} from "../apps/web/src/components/capabilities/connection-services";
import { sortFeaturedFirst } from "../apps/web/src/lib/capabilities";
import { VENDORED_LOGO_MANIFEST } from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
  .pathname;

type PresentationItem = CapabilityCatalogItem;

describe("default catalog presentation", () => {
  test("partitions grouped services without duplicate featured rows or losing options", () => {
    const item = (id: string, providerDomain: string, curated = false) =>
      CapabilityCatalogItemSchema.parse({
        id,
        name: id,
        kind: "mcp",
        source: "registry",
        providerDomain,
        metadata: { curation: { curated } },
      });
    const connectors = [
      item("slack-tools", "slack.com", true),
      item("long-tail", "example.org"),
      item("front-tools", "front.com"),
    ];
    const service = (id: string, optionId = id) => ({
      id,
      name: id,
      options: [
        {
          id: optionId,
          name: optionId,
          status: "Not connected",
          connected: false,
          onOpen: () => {},
        },
      ],
    });
    const services = mergeConnectionServices([
      service("slack", "slack-chat"),
      ...connectors.map((entry) =>
        service(catalogServiceIdentity(entry.id, entry.name, entry.providerDomain).id, entry.id),
      ),
    ]);
    const partition = partitionConnectionServices(
      services,
      true,
      [connectors[0]!],
      ["slack"],
      connectors,
    );
    expect(partition.featuredServices.map((entry) => entry.id)).toEqual(["slack", "front-tools"]);
    expect(partition.featuredServices[0]!.options.map((option) => option.id)).toEqual([
      "slack-chat",
      "slack-tools",
    ]);
    expect(partition.remainingServices.map((entry) => entry.id)).toEqual(["long-tail"]);
  });

  test("keeps the complete connector sort input while prioritizing recognizable entries", async () => {
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
        providerDomain: row.domain,
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
    // The unified catalog sorts all connectors before merging provider services
    // and partitioning Featured/Browse. These assertions cover that sort input,
    // not the separately filtered Browse section.
    const browse = serverOrder;
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
      if (capabilityCuration(item).featured) return 1;
      if (capabilityCuration(item).curated) return 2;
      if (item.logoAssetPath) return 3;
      return opaqueCatalogName(item.name) ? 5 : 4;
    };
    const tiers = sorted.map(tier);
    expect(tiers).toEqual([...tiers].sort((left, right) => left - right));
    const firstPartyCount = sorted.filter(isFirstParty).length;
    expect(sorted.slice(0, firstPartyCount).every(isFirstParty)).toBe(true);

    const quality = (items: readonly PresentationItem[], includeFirstPartyMarks: boolean) => ({
      logoBacked: items.filter(
        (item) =>
          item.logoAssetPath ||
          (includeFirstPartyMarks && capabilityLogoSource(item, (path) => path)),
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

    // Assess service rows actually presented: all Featured, then the first
    // 48 Browse services. Merged options count as one row and retain its logo.
    const services = mergeConnectionServices(
      sorted.map((item) => ({
        ...catalogServiceIdentity(item.id, item.name, item.providerDomain),
        logo: capabilityLogoSource(item, (path) => path),
        options: [
          {
            id: item.id,
            name: "Agent tools",
            status: "Not connected",
            connected: false,
            onOpen: () => {},
          },
        ],
      })),
    );
    const featured = sortFeaturedFirst(serverOrder).filter(
      (item) => capabilityCuration(item).featured,
    );
    const partition = partitionConnectionServices(services, true, featured, [], serverOrder);
    const allPresented = [...partition.featuredServices, ...partition.remainingServices];
    expect(allPresented).toHaveLength(services.length);
    expect(new Set(allPresented.map((service) => service.id)).size).toBe(services.length);
    expect(
      new Set(allPresented.flatMap((service) => service.options.map((option) => option.id))),
    ).toEqual(new Set(sorted.map((item) => item.id)));
    expect(partition.remainingServices).toEqual(
      services.filter((service) => !partition.featuredServices.includes(service)),
    );
    expect(partitionConnectionServices(services, false, featured, [], serverOrder)).toEqual({
      featuredServices: [],
      remainingServices: services,
    });
    const visible = [...partition.featuredServices, ...partition.remainingServices.slice(0, 48)];
    const byId = new Map(sorted.map((item) => [item.id, item]));
    expect(visible.filter((service) => Boolean(service.logo)).length).toBeGreaterThanOrEqual(18);
    expect(
      visible.filter((service) =>
        service.options.some((option) => capabilityCuration(byId.get(option.id)!).curated),
      ).length,
    ).toBeGreaterThanOrEqual(16);
    expect(visible.filter((service) => opaqueCatalogName(service.name)).length).toBeLessThanOrEqual(
      5,
    );
    expect(
      visible.slice(0, 20).filter((service) => Boolean(service.logo)).length,
    ).toBeGreaterThanOrEqual(17);
    for (const bucket of new Set(tiers)) {
      expect(sorted.filter((item) => tier(item) === bucket)).toEqual(
        serverOrder.filter((item) => tier(item) === bucket),
      );
    }

    const longTailTarget = browse.find((item, index) => index >= 48 && item.name.length >= 4);
    expect(longTailTarget).toBeDefined();
    const searchResults = sortConnectorsForPresentation(
      filterCapabilityCatalogItems(browse, "all", longTailTarget!.name),
    );
    expect(searchResults.some((item) => item.id === longTailTarget!.id)).toBe(true);
  });
});
