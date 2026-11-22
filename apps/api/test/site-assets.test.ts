import { describe, expect, test } from "bun:test";
import { siteAssetObjectKey } from "@opengeni/contracts";
import { WorkspaceArtifactOperationError } from "@opengeni/db";
import {
  freezeSiteAssets,
  siteAssetFile,
  siteAssetResponse,
  storeSiteAssetBundle,
} from "../src/site-assets";

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  let puts = 0;
  const storage = {
    headObject: async (key: string) =>
      objects.has(key) ? { ContentLength: objects.get(key)!.byteLength } : null,
    putObject: async (input: { key: string; body: Uint8Array }) => {
      puts++;
      objects.set(input.key, input.body);
    },
    putObjectStreamIfAbsent: async (input: { key: string; chunks: AsyncIterable<Uint8Array> }) => {
      if (objects.has(input.key)) return false;
      const parts: Uint8Array[] = [];
      for await (const part of input.chunks) parts.push(part);
      objects.set(input.key, Buffer.concat(parts));
      return true;
    },
    getObjectBytes: async (key: string) =>
      objects.has(key)
        ? { bytes: objects.get(key)!, contentType: "application/octet-stream" }
        : null,
  };
  return { storage: storage as never, objects, puts: () => puts };
}

const bundle = (files: Array<{ path: string; text?: string; base64?: string }>) =>
  new TextEncoder().encode(
    JSON.stringify({
      files: files.map((file) => ({
        path: file.path,
        base64: file.base64 ?? Buffer.from(file.text ?? "").toString("base64"),
      })),
    }),
  );

describe("storeSiteAssetBundle", () => {
  test("stores each distinct file once, content-addressed, with a fresh token", async () => {
    const { storage, objects, puts } = memoryStorage();
    const manifest = await storeSiteAssetBundle(
      storage,
      "ws",
      bundle([
        { path: "b.js", text: "same" },
        { path: "a/c.css", text: "body{}" },
        { path: "copy.js", text: "same" },
      ]),
    );
    expect(manifest.files.map((file) => file.path)).toEqual(["a/c.css", "b.js", "copy.js"]);
    expect(manifest.token).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(puts()).toBe(2);
    const sha = manifest.files.find((file) => file.path === "b.js")!.sha256;
    expect(new TextDecoder().decode(objects.get(siteAssetObjectKey("ws", sha)))).toBe("same");
    // A second version reuses stored files and gets its own token.
    const again = await storeSiteAssetBundle(
      storage,
      "ws",
      bundle([{ path: "b.js", text: "same" }]),
    );
    expect(puts()).toBe(2);
    expect(again.token).not.toBe(manifest.token);
  });

  test("refuses HTML, bad paths, duplicates, bad base64 and malformed bundles", async () => {
    const { storage } = memoryStorage();
    const refused = async (bytes: Uint8Array, message: RegExp) => {
      const error = await storeSiteAssetBundle(storage, "ws", bytes).catch((caught) => caught);
      expect(error).toBeInstanceOf(WorkspaceArtifactOperationError);
      expect(String(error.message)).toMatch(message);
    };
    await refused(bundle([{ path: "about.html", text: "<p>" }]), /single-page/u);
    await refused(bundle([{ path: "../x.js", text: "x" }]), /isn't allowed/u);
    await refused(bundle([{ path: "run.sh", text: "x" }]), /isn't allowed/u);
    await refused(
      bundle([
        { path: "a.js", text: "1" },
        { path: "a.js", text: "2" },
      ]),
      /twice/u,
    );
    await refused(bundle([{ path: "a.js", base64: "not base64!" }]), /base64/u);
    await refused(new TextEncoder().encode("{}"), /JSON/u);
    await refused(new TextEncoder().encode("nope"), /JSON/u);
  });
});

describe("freezeSiteAssets", () => {
  test("freezes the first manifest and returns it on every later publish", async () => {
    const { storage, objects } = memoryStorage();
    const keys = { upload: "uploads/1/assets.json", frozen: "asset-manifests/1.json" };
    expect(await freezeSiteAssets(storage, "ws", keys)).toBeNull();
    objects.set(keys.upload, bundle([{ path: "a.js", text: "1" }]));
    const first = await freezeSiteAssets(storage, "ws", keys);
    // The mutable upload changing afterwards changes nothing.
    objects.set(keys.upload, bundle([{ path: "b.js", text: "2" }]));
    expect(await freezeSiteAssets(storage, "ws", keys)).toEqual(first);
  });
});

describe("serving", () => {
  test("needs the version's exact token and a listed path; answers 304 to its ETag", async () => {
    const { storage } = memoryStorage();
    const manifest = await storeSiteAssetBundle(
      storage,
      "ws",
      bundle([{ path: "assets/a.js", text: "export {}" }]),
    );
    expect(siteAssetFile(manifest, "x".repeat(22), "assets/a.js")).toBeNull();
    expect(siteAssetFile(manifest, manifest.token, "assets/b.js")).toBeNull();
    expect(siteAssetFile(null, manifest.token, "assets/a.js")).toBeNull();
    const file = siteAssetFile(manifest, manifest.token, "assets/a.js")!;
    const response = await siteAssetResponse(storage, "ws", file, {
      method: "GET",
      ifNoneMatch: null,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {}");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const cached = await siteAssetResponse(storage, "ws", file, {
      method: "GET",
      ifNoneMatch: `W/"${file.sha256}"`,
    });
    expect(cached.status).toBe(304);
  });

  test("answers HEAD with the file's headers and no body", async () => {
    const { storage } = memoryStorage();
    const manifest = await storeSiteAssetBundle(
      storage,
      "ws",
      bundle([{ path: "assets/a.css", text: "body{}" }]),
    );
    const file = siteAssetFile(manifest, manifest.token, "assets/a.css")!;
    const response = await siteAssetResponse(storage, "ws", file, {
      method: "HEAD",
      ifNoneMatch: null,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("");
  });
});
