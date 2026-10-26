import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";

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
      "api:excel-addin",
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

describe("built-in integration marks", () => {
  const directory = new URL("../apps/web/src/assets/integration-logos/", import.meta.url);

  test("cover every bundled file with provenance and pass the SVG active-content guard", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")) as {
      version: number;
      entries: Array<{
        integration: string;
        file: string;
        sourceUrl: string;
        sourceLicense: string;
        modifications: string;
      }>;
    };
    expect(manifest.version).toBe(1);
    const files = (await readdir(directory)).filter(
      (name) => name !== "manifest.json" && name !== "README.md",
    );
    expect(manifest.entries.map((entry) => entry.file).sort()).toEqual(files.sort());
    for (const entry of manifest.entries) {
      expect(entry.sourceUrl).toMatch(/^https:\/\//);
      expect(entry.sourceLicense.trim().length).toBeGreaterThan(0);
      expect(entry.modifications.trim().length).toBeGreaterThan(0);
      if (!entry.file.endsWith(".svg")) continue;
      const bytes = new Uint8Array(await readFile(new URL(entry.file, directory)));
      expect(svgActiveContentReason("image/svg+xml", bytes), entry.file).toBeNull();
    }
  });

  test("the console and shared UI never hotlink a remote logo image", async () => {
    const remoteImage =
      /["'`]https?:\/\/[^"'`\s]+\.(?:png|svg|ico|jpe?g|webp|gif)(?:\?[^"'`\s]*)?["'`]/i;
    const offenders: string[] = [];
    for (const root of ["../apps/web/src/", "../packages/react/src/"]) {
      const base = new URL(root, import.meta.url);
      for (const path of await readdir(base, { recursive: true })) {
        if (!/\.tsx?$/.test(path) || /\.test\.tsx?$|\.gen\.ts$|(^|\/)dev\//.test(path)) continue;
        const text = await readFile(new URL(path, base), "utf8");
        if (remoteImage.test(text)) offenders.push(`${root}${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
