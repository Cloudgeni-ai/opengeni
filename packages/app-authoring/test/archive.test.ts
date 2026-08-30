import { describe, expect, test } from "bun:test";

import {
  createAppBuildManifest,
  createOgAppSourceManifest,
  createPortableAppArchive,
  encodeOgAppSourceManifest,
  inspectPortableAppArchive,
  type PortableAppArchiveEntry,
} from "../src";

function entries(order: "forward" | "reverse" = "forward"): PortableAppArchiveEntry[] {
  const manifest = createOgAppSourceManifest({ name: "Status Console" });
  const values = [
    { path: "og-app.json", bytes: encodeOgAppSourceManifest(manifest) },
    { path: "index.html", bytes: new TextEncoder().encode("<h1>Status</h1>\n") },
    { path: "assets/app.js", bytes: new TextEncoder().encode("export const ready = true;\n") },
  ];
  return order === "forward" ? values : values.reverse();
}

describe("portable OpenGeni App archives", () => {
  test("are byte-for-byte deterministic regardless of input order", () => {
    expect(createPortableAppArchive(entries("forward"))).toEqual(
      createPortableAppArchive(entries("reverse")),
    );
  });

  test("round-trip only safe regular files and source metadata", () => {
    const inspected = inspectPortableAppArchive(createPortableAppArchive(entries()));
    expect(inspected.entries.map((entry) => entry.path)).toEqual([
      "assets/app.js",
      "index.html",
      "og-app.json",
    ]);
    expect(inspected.sourceManifest).toMatchObject({
      version: "opengeni.app-source.v1",
      slug: "status-console",
      entryPath: "index.html",
    });
  });

  test("rejects traversal and duplicate normalized paths", () => {
    expect(() =>
      createPortableAppArchive([...entries(), { path: "../secret", bytes: new Uint8Array() }]),
    ).toThrow("Unsafe app path");
    expect(() =>
      createPortableAppArchive([...entries(), { path: "index.html", bytes: new Uint8Array() }]),
    ).toThrow("Duplicate app archive path");
  });

  test("builds the immutable build file manifest", () => {
    const manifest = createAppBuildManifest(entries(), "index.html");
    expect(manifest.version).toBe("opengeni.app-build.v1");
    expect(manifest.entryPath).toBe("index.html");
    expect(manifest.files.find((file) => file.path === "index.html")).toMatchObject({
      contentType: "text/html; charset=utf-8",
      sizeBytes: 16,
      executable: false,
    });
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/u.test(file.contentSha256))).toBe(true);
  });
});
