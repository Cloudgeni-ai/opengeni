import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packagedManifest, storeManifest } from "../scripts/manifest";

const root = resolve(import.meta.dir, "..");
const readJson = async (file: string) =>
  JSON.parse(await readFile(resolve(root, file), "utf8")) as Record<string, unknown>;

describe("packaged manifest", () => {
  test("takes its version from package.json, the single version owner", async () => {
    const source = await readJson("manifest.json");
    const { version } = await readJson("package.json");
    expect(source.version).toBeUndefined();
    const manifest = packagedManifest(source, version);
    expect(manifest.version).toBe(version);
    expect(Object.keys(manifest).slice(0, 5)).toEqual([
      "manifest_version",
      "name",
      "short_name",
      "description",
      "version",
    ]);
  });

  test("refuses a second version source or a version Chrome cannot load", () => {
    expect(() => packagedManifest({ version: "0.1.0" }, "0.1.1")).toThrow(/package.json owns/);
    expect(() => packagedManifest({}, "0.1.3-canary.0")).toThrow(/Chrome extension version/);
    expect(() => packagedManifest({}, undefined)).toThrow(/Chrome extension version/);
  });

  test("strips the development key only from the store manifest", async () => {
    const manifest = packagedManifest(await readJson("manifest.json"), "0.1.3");
    expect(typeof manifest.key).toBe("string");
    const store = storeManifest(manifest);
    expect(store.key).toBeUndefined();
    expect(store.version).toBe("0.1.3");
  });
});
