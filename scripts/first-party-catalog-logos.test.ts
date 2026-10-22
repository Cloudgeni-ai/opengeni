import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { FIRST_PARTY_CAPABILITY_LOGOS } from "../packages/react/src/app/components/capabilities/capability-logo-source";
import { svgActiveContentReason } from "./catalog-vendored-logos";

const manifestUrl = new URL("../apps/web/public/capability-logos/manifest.json", import.meta.url);

type FirstPartyLogoManifest = {
  version: number;
  entries: Array<{
    capabilityId: string;
    file: string;
    sourceUrl: string;
    sourceLicense: string;
    modifications: string;
  }>;
};

describe("first-party catalog logo assets", () => {
  test("have complete provenance and pass the catalog SVG active-content guard", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as FirstPartyLogoManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.entries.map((entry) => entry.capabilityId).sort()).toEqual([
      "api:fiken",
      "api:github-app",
      "api:reddit",
      "api:x",
    ]);

    for (const entry of manifest.entries) {
      // The shared session UI inlines each logo, so embeds need no web assets.
      const svg = await readFile(
        new URL(`../apps/web/public/capability-logos/${entry.file}`, import.meta.url),
        "utf8",
      );
      expect(FIRST_PARTY_CAPABILITY_LOGOS[entry.capabilityId]).toBe(
        `data:image/svg+xml,${encodeURIComponent(svg)}`,
      );
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
      expect(entry.sourceLicense.trim().length).toBeGreaterThan(0);
      expect(entry.modifications.trim().length).toBeGreaterThan(0);
      const bytes = new Uint8Array(
        await readFile(
          new URL(`../apps/web/public/capability-logos/${entry.file}`, import.meta.url),
        ),
      );
      expect(svgActiveContentReason("image/svg+xml", bytes), entry.capabilityId).toBeNull();
    }
  });
});
