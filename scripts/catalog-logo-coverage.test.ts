import { describe, expect, test } from "bun:test";

import { builtInConnectorCatalogItems, codexAppsCatalogItem } from "@opengeni/core";
import type { CapabilityCatalogItem } from "@opengeni/contracts";
import { capabilityLogoSource } from "../packages/react/src/app/components/capabilities/capability-logo-source";
import { catalogIdentityEntriesByMcpUrl, curatedCatalogEntriesByMcpUrl } from "./catalog-curation";
import { VENDORED_LOGO_MANIFEST, vendoredLogosByCapabilityId } from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  catalogRowToDbInput,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  resolveCatalogRowLogo,
  type LogoStorage,
} from "./import-integrations-catalog";

/**
 * Every connector the catalog reviews must show its brand, never a letter.
 * The shared UI draws a monogram when a row resolves no logo, so a new
 * connector without a mark would otherwise regress silently.
 */

const storage: LogoStorage = { async putObject() {} };
const refuseFetch = async () => {
  throw new Error("coverage must not fetch: vendored logos are committed");
};
// The catalog-asset route serves any stored key; a stand-in URL is enough here.
const assetUrl = (path: string | null) => (path ? `https://api.test/v1/${path}` : null);

describe("catalog logo coverage", () => {
  test("every curated and identity connector resolves a logo, as imported", async () => {
    const snapshotPath = new URL("../data/catalog/integrations-snapshot.json", import.meta.url)
      .pathname;
    const normalized = normalizeCatalogSnapshot(await readSnapshotFile(snapshotPath));
    const reviewed = normalized.rows.filter(
      (row) =>
        curatedCatalogEntriesByMcpUrl.has(row.mcpUrl) ||
        catalogIdentityEntriesByMcpUrl.has(row.mcpUrl),
    );
    expect(reviewed.length).toBe(
      new Set([...curatedCatalogEntriesByMcpUrl.keys(), ...catalogIdentityEntriesByMcpUrl.keys()])
        .size,
    );
    const vendoredLogos = vendoredLogosByCapabilityId(VENDORED_LOGO_MANIFEST);
    const missing: string[] = [];
    for (const row of reviewed) {
      const logo = await resolveCatalogRowLogo(row, {
        storage,
        fetchImpl: refuseFetch,
        storeLogos: false,
        vendoredLogos,
      });
      const item = catalogRowToDbInput(row, {
        importBatchId: "00000000-0000-4000-8000-000000000001",
        logoAssetPath: logo.logoAssetPath,
        logoSource: logo.logoSource,
      });
      const src = capabilityLogoSource(
        { id: item.id, mcpUrl: item.mcpUrl, logoAssetPath: item.logoAssetPath, metadata: {} },
        assetUrl,
      );
      if (!src) missing.push(`${row.name} (${catalogCapabilityId(row.domain, row.mcpUrl)})`);
    }
    expect(missing).toEqual([]);
  });

  test("every built-in connector ships a bundled mark", () => {
    const builtIns: CapabilityCatalogItem[] = [
      ...builtInConnectorCatalogItems({
        settings: { webBaseUrl: "https://app.test" },
        socialConnections: [],
        workspaceConnections: [],
      }),
      codexAppsCatalogItem(true),
    ];
    expect(builtIns.length).toBeGreaterThan(0);
    const missing = builtIns
      .filter((item) => !capabilityLogoSource({ ...item, logoAssetPath: null }, () => null))
      .map((item) => `${item.name} (${item.id})`);
    expect(missing).toEqual([]);
  });
});
