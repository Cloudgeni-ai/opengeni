import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareDebianVersions,
  currentPins,
  parsePackages,
  rewritePins,
} from "./browser-engine-pins";

const root = resolve(import.meta.dir, "..");
const paths = [
  "docker/desktop.Dockerfile",
  "docker/sandbox.Dockerfile",
  "scripts/browserd-image-build-contract.test.ts",
];

async function repositoryFiles(): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(resolve(root, path), "utf8")] as const),
    ),
  );
}

describe("browser engine pins", () => {
  test("Debian versions order like dpkg", () => {
    expect(compareDebianVersions("155.0.8059.84-1", "151.0.7922.108-1")).toBeGreaterThan(0);
    expect(compareDebianVersions("155.0.8059.9-1", "155.0.8059.84-1")).toBeLessThan(0);
    expect(compareDebianVersions("155.0.8059.79-1~deb13u1", "155.0.8059.79-1")).toBeLessThan(0);
    expect(
      compareDebianVersions("155.0.8059.79-1~deb13u2", "155.0.8059.79-1~deb13u1"),
    ).toBeGreaterThan(0);
    expect(compareDebianVersions("1:1.0-1", "2.0-1")).toBeGreaterThan(0);
    expect(compareDebianVersions("1.0-1", "1.0-1")).toBe(0);
  });

  test("parses Packages stanzas", () => {
    const stanzas = parsePackages(
      "Package: google-chrome-stable\nVersion: 155.0.8059.84-1\nSHA256: aa\n\nPackage: other\nVersion: 1\n",
    );
    expect(stanzas).toEqual([
      { Package: "google-chrome-stable", Version: "155.0.8059.84-1", SHA256: "aa" },
      { Package: "other", Version: "1" },
    ]);
  });

  test("reads one consistent pin set from the images and rewrites every copy", async () => {
    const files = await repositoryFiles();
    const current = currentPins(files);
    const next = {
      chrome: { version: "999.0.0.1-1", sha256: "f".repeat(64) },
      chromium: { version: "999.0.0.1-1~deb13u1", snapshot: "20991231T000000Z" },
    };
    const rewritten = rewritePins(files, next);
    expect(currentPins(rewritten)).toEqual(next);
    for (const path of paths) {
      expect(rewritten[path]).not.toContain(current.chrome.sha256);
      expect(rewritten[path]).not.toContain(`google-chrome-stable_${current.chrome.version}_`);
      expect(rewritten[path]).not.toContain(`CHROMIUM_VERSION=${current.chromium.version}`);
      expect(rewritten[path]).not.toContain(`SNAPSHOT=${current.chromium.snapshot}`);
    }
    // The image contract test keeps asserting exactly the rewritten pins.
    expect(rewritten["scripts/browserd-image-build-contract.test.ts"]).toContain(
      `google-chrome-stable_999.0.0.1-1_amd64.deb`,
    );
  });
});
