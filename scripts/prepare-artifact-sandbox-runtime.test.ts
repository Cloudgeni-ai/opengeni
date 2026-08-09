import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  packedArtifactToolAliases,
  rendererDependenciesForTarget,
} from "./prepare-artifact-sandbox-runtime";

describe("portable sandbox artifact runtime", () => {
  test("selects only exact target-native renderer packages", () => {
    expect(rendererDependenciesForTarget("linux-x64-gnu")).toEqual({
      resvg: "@resvg/resvg-js-linux-x64-gnu",
      sharp: "@img/sharp-linux-x64",
      sharpLibvips: "@img/sharp-libvips-linux-x64",
    });
    expect(rendererDependenciesForTarget("linux-arm64-gnu")).toEqual({
      resvg: "@resvg/resvg-js-linux-arm64-gnu",
      sharp: "@img/sharp-linux-arm64",
      sharpLibvips: "@img/sharp-libvips-linux-arm64",
    });
    expect(rendererDependenciesForTarget("darwin-x64")).toEqual({
      resvg: "@resvg/resvg-js-darwin-x64",
      sharp: "@img/sharp-darwin-x64",
      sharpLibvips: "@img/sharp-libvips-darwin-x64",
    });
    expect(rendererDependenciesForTarget("darwin-arm64")).toEqual({
      resvg: "@resvg/resvg-js-darwin-arm64",
      sharp: "@img/sharp-darwin-arm64",
      sharpLibvips: "@img/sharp-libvips-darwin-arm64",
    });
  });

  test("rejects runtime targets without a proven portable renderer closure", () => {
    expect(() => rendererDependenciesForTarget("linux-x64-musl")).toThrow(
      "Portable sandbox renderer dependencies are unavailable",
    );
    expect(() => rendererDependenciesForTarget("win32-x64-msvc")).toThrow(
      "Portable sandbox renderer dependencies are unavailable",
    );
  });

  test("maps every packed self-export into one exact dist module graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-tool-aliases-"));
    try {
      await mkdir(join(root, "dist"));
      await Promise.all([
        writeFile(join(root, "dist", "index.js"), "export const root = true;"),
        writeFile(join(root, "dist", "document-render.js"), "export const render = true;"),
      ]);
      const canonicalRoot = await realpath(root);
      const aliases = await packedArtifactToolAliases(canonicalRoot, "@opengeni/artifact-tool", {
        ".": { types: "./src/index.ts", default: "./src/index.ts" },
        "./document/render": {
          types: "./src/document-render.ts",
          default: "./src/document-render.ts",
        },
      });
      expect([...aliases.keys()]).toEqual([
        "@opengeni/artifact-tool",
        "@opengeni/artifact-tool/document/render",
      ]);
      expect(aliases.get("@opengeni/artifact-tool/document/render")).toBe(
        join(canonicalRoot, "dist", "document-render.js"),
      );
      await expect(
        packedArtifactToolAliases(canonicalRoot, "@opengeni/artifact-tool", {
          ".": { default: "./src/index.ts" },
        }),
      ).rejects.toThrow("export conditions are unsupported");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
