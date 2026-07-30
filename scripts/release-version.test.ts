import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readReleaseVersion } from "./release-version";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function chart(source: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "opengeni-release-version-"));
  roots.push(root);
  const path = resolve(root, "Chart.yaml");
  await writeFile(path, source);
  return path;
}

describe("source-controlled product release version", () => {
  test("reads one exact chart/app version", async () => {
    await expect(
      readReleaseVersion(
        await chart("apiVersion: v2\nname: opengeni\nversion: 0.22.0\nappVersion: 0.22.0\n"),
      ),
    ).resolves.toBe("0.22.0");
  });

  test("rejects package-style, mutable, or divergent product identity", async () => {
    await expect(
      readReleaseVersion(
        await chart("apiVersion: v2\nname: opengeni\nversion: latest\nappVersion: latest\n"),
      ),
    ).rejects.toThrow("exact semver");
    await expect(
      readReleaseVersion(
        await chart("apiVersion: v2\nname: opengeni\nversion: 0.22.0\nappVersion: 0.21.0\n"),
      ),
    ).rejects.toThrow("must equal");
    await expect(
      readReleaseVersion(
        await chart("apiVersion: v2\nname: another-chart\nversion: 0.22.0\nappVersion: 0.22.0\n"),
      ),
    ).rejects.toThrow("named opengeni");
  });
});
