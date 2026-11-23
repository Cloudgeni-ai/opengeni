import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  test("asks for no new required permission, so an update never turns the extension off", async () => {
    // Chrome turns an installed extension off when an update requires a
    // permission it warns about, until the person accepts it. Version 0.3.0
    // did that with `tabGroups`. A new permission must be optional.
    const { permissions, optional_permissions } = await readJson("manifest.json");
    expect(permissions).toEqual([
      "alarms",
      "debugger",
      "downloads",
      "nativeMessaging",
      "scripting",
      "storage",
      "tabs",
      "webNavigation",
    ]);
    // Grouping the tabs an agent controls is the person's choice.
    expect(optional_permissions).toEqual(["contentSettings", "tabGroups"]);
  });

  test("lets pages load only the agent's cursor, at a URL that changes", async () => {
    const source = await readJson("manifest.json");
    expect(source.web_accessible_resources).toEqual([
      { resources: ["icons/agent-cursor.png"], matches: ["<all_urls>"], use_dynamic_url: true },
    ]);
    // runtime.getURL returns the dynamic URL from Chrome 130.
    expect(source.minimum_chrome_version).toBe("130");
  });

  test("the build ships every resource a page may load, in the folder and the archive", async () => {
    const out = await mkdtemp(join(tmpdir(), "extension-build-"));
    try {
      const build = Bun.spawnSync(["bun", "scripts/build.ts", "--out", out], { cwd: root });
      expect(build.exitCode).toBe(0);
      const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as {
        web_accessible_resources: { resources: string[] }[];
      };
      const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
      expect(resources).toContain("icons/agent-cursor.png");
      const archive = new Bun.Archive(await readFile(join(out, "opengeni-browser-extension.tar")));
      const entries = [...(await archive.files()).keys()];
      for (const file of resources) {
        expect(await Bun.file(join(out, file)).exists()).toBe(true);
        expect(entries).toContain(`opengeni-browser-extension/${file}`);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
