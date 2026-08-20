import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  FIRST_PARTY_CAPABILITY_LOGOS,
  capabilityLogoSource,
} from "@/components/capabilities/capability-logo-source";

const manifestUrl = new URL("../../../public/capability-logos/manifest.json", import.meta.url);

describe("capability logo source", () => {
  test("covers every declared first-party mark with a committed passive SVG", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
      entries: Array<{ capabilityId: string; file: string; sourceUrl: string }>;
    };
    expect(manifest.entries.map((entry) => entry.capabilityId).sort()).toEqual(
      Object.keys(FIRST_PARTY_CAPABILITY_LOGOS).sort(),
    );
    for (const entry of manifest.entries) {
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
      const svg = await readFile(
        new URL(`../../../public/capability-logos/${entry.file}`, import.meta.url),
        "utf8",
      );
      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<script|<image|<foreignObject|\bon[a-z]+=/i);
    }
  });

  test("prefers a bundled first-party mark and otherwise uses the catalog asset resolver", () => {
    const resolve = (path: string | null) => (path ? `https://api.test/v1/${path}` : null);
    expect(capabilityLogoSource({ id: "api:x", logoAssetPath: null }, resolve)).toBe(
      "/capability-logos/x.svg",
    );
    expect(
      capabilityLogoSource(
        { id: "mcp:linear", logoAssetPath: "catalog-assets/linear.svg" },
        resolve,
      ),
    ).toBe("https://api.test/v1/catalog-assets/linear.svg");
    expect(capabilityLogoSource({ id: "mcp:plain", logoAssetPath: null }, resolve)).toBeNull();
  });
});
