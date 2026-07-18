import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { WorkspacePackage } from "../publishable-workspaces";
import {
  packageBuildFingerprint,
  packageSourceFingerprint,
  prunePackageBuildCache,
  restorePackageBuild,
  savePackageBuild,
} from "./content-cache";

function fixture(): { root: string; cacheRoot: string; pkg: WorkspacePackage } {
  const root = mkdtempSync(join(tmpdir(), "opengeni-build-cache-"));
  const dir = "packages/example";
  mkdirSync(join(root, dir, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "bun.lock"), "lock\n");
  writeFileSync(join(root, "tsconfig.base.json"), "{}\n");
  writeFileSync(join(root, ".bun-version"), "1.3.14\n");
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  writeFileSync(join(root, "scripts/build-publishable-packages.ts"), "// builder\n");
  writeFileSync(join(root, "scripts/publishable-workspaces.ts"), "// workspaces\n");
  writeFileSync(join(root, "scripts/ci/content-cache.ts"), "// cache\n");
  writeFileSync(join(root, "scripts/ci/workspace.ts"), "// graph v1\n");
  writeFileSync(
    join(root, dir, "package.json"),
    '{"name":"@opengeni/example","version":"1.0.0"}\n',
  );
  writeFileSync(join(root, dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, dir, "tsup.config.ts"), "export default {}\n");
  writeFileSync(join(root, dir, "src/index.ts"), "export const value = 1;\n");
  mkdirSync(join(root, dir, "assets"), { recursive: true });
  writeFileSync(join(root, dir, "assets/schema.json"), '{"version":1}\n');
  const pkg: WorkspacePackage = {
    dir,
    packagePath: join(root, dir, "package.json"),
    name: "@opengeni/example",
    version: "1.0.0",
    packageJson: { name: "@opengeni/example", version: "1.0.0" },
  };
  return { root, cacheRoot: join(root, ".cache"), pkg };
}

const toolchain = { bun: "test", platform: "test", arch: "test", nodeEnv: "test" };

describe("content-addressed package build cache", () => {
  test("source, root, dependency, and toolchain changes fence the fingerprint", () => {
    const { root, pkg } = fixture();
    const base = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    writeFileSync(join(root, pkg.dir, "src/index.ts"), "export const value = 2;\n");
    const source = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    expect(source).not.toBe(base);
    const dependency = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map([["@opengeni/dependency", "a".repeat(64)]]),
      toolchain,
    });
    expect(dependency).not.toBe(source);
    const changedTool = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain: { ...toolchain, bun: "other" },
    });
    expect(changedTool).not.toBe(source);
    writeFileSync(join(root, "scripts/ci/workspace.ts"), "// graph v2\n");
    const graph = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    expect(graph).not.toBe(source);
    writeFileSync(join(root, pkg.dir, "assets/schema.json"), '{"version":2}\n');
    const asset = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    expect(asset).not.toBe(graph);

    let configured = asset;
    for (const [path, contents] of [
      [".npmrc", "registry=https://registry.npmjs.org/\n"],
      ["bunfig.toml", 'preload = ["./build-preload.ts"]\n'],
      ["build-preload.ts", "export const preload = 1;\n"],
      ["patches/example.patch", "patch v1\n"],
    ] as const) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
      const next = packageBuildFingerprint({
        root,
        pkg,
        dependencyFingerprints: new Map(),
        toolchain,
      });
      expect(next).not.toBe(configured);
      configured = next;
    }
    writeFileSync(join(root, "build-preload.ts"), "export const preload = 2;\n");
    const changedPreload = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    expect(changedPreload).not.toBe(configured);

    mkdirSync(join(root, pkg.dir, "dist"), { recursive: true });
    writeFileSync(join(root, pkg.dir, "dist/ignored.js"), "old output\n");
    expect(
      packageBuildFingerprint({
        root,
        pkg,
        dependencyFingerprints: new Map(),
        toolchain,
      }),
    ).toBe(changedPreload);

    chmodSync(join(root, pkg.dir, "assets/schema.json"), 0o755);
    expect(
      packageBuildFingerprint({
        root,
        pkg,
        dependencyFingerprints: new Map(),
        toolchain,
      }),
    ).not.toBe(changedPreload);
  });

  test("an ignored/private workspace dependency fences publishable output", () => {
    const { root, pkg } = fixture();
    const dependency: WorkspacePackage = {
      dir: "packages/private-helper",
      packagePath: join(root, "packages/private-helper/package.json"),
      name: "@opengeni/private-helper",
      version: "1.0.0",
      packageJson: {
        name: "@opengeni/private-helper",
        version: "1.0.0",
        private: true,
      },
    };
    mkdirSync(join(root, dependency.dir, "src"), { recursive: true });
    writeFileSync(dependency.packagePath, JSON.stringify(dependency.packageJson));
    writeFileSync(join(root, dependency.dir, "src/index.ts"), "export const value = 1;\n");
    const beforeDependency = packageSourceFingerprint(root, dependency);
    const before = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map([[dependency.name, beforeDependency]]),
      toolchain,
    });
    writeFileSync(join(root, dependency.dir, "src/index.ts"), "export const value = 2;\n");
    const afterDependency = packageSourceFingerprint(root, dependency);
    const after = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map([[dependency.name, afterDependency]]),
      toolchain,
    });
    expect(afterDependency).not.toBe(beforeDependency);
    expect(after).not.toBe(before);
  });

  test("package-local Bun config references are repository-relative fingerprint inputs", () => {
    const { root, pkg } = fixture();
    const shared = join(root, "shared-preload.ts");
    writeFileSync(shared, "export const preload = 1;\n");
    writeFileSync(join(root, pkg.dir, "bunfig.toml"), 'preload = ["../../shared-preload.ts"]\n');
    const before = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    writeFileSync(shared, "export const preload = 2;\n");
    expect(
      packageBuildFingerprint({
        root,
        pkg,
        dependencyFingerprints: new Map(),
        toolchain,
      }),
    ).not.toBe(before);

    for (const preload of [shared, `file://${shared}`]) {
      writeFileSync(join(root, pkg.dir, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
      expect(() =>
        packageBuildFingerprint({
          root,
          pkg,
          dependencyFingerprints: new Map(),
          toolchain,
        }),
      ).toThrow("must be repository-relative");
    }
  });

  test("a Bun input reached through a symlinked parent is rejected before reading it", () => {
    if (process.platform === "win32") return;
    const { root, pkg } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "opengeni-build-cache-outside-"));
    writeFileSync(join(outside, "input.ts"), "export const external = true;\n");
    symlinkSync(outside, join(root, "linked"), "dir");
    writeFileSync(join(root, "bunfig.toml"), 'preload = ["./linked/input.ts"]\n');
    expect(() =>
      packageBuildFingerprint({
        root,
        pkg,
        dependencyFingerprints: new Map(),
        toolchain,
      }),
    ).toThrow("symlink components");
  });

  test("verified outputs restore exactly and tampering becomes a miss", () => {
    const { root, cacheRoot, pkg } = fixture();
    const fingerprint = packageBuildFingerprint({
      root,
      pkg,
      dependencyFingerprints: new Map(),
      toolchain,
    });
    mkdirSync(join(root, pkg.dir, "dist"), { recursive: true });
    writeFileSync(join(root, pkg.dir, "dist/index.js"), "export const built = 1;\n");
    savePackageBuild({ root, cacheRoot, pkg, fingerprint });
    rmSync(join(root, pkg.dir, "dist"), { recursive: true });
    expect(restorePackageBuild({ root, cacheRoot, pkg, fingerprint })).toEqual({ hit: true });
    expect(readFileSync(join(root, pkg.dir, "dist/index.js"), "utf8")).toContain("built = 1");

    const cacheFile = join(cacheRoot, "v1", "_opengeni_example", fingerprint, "dist/index.js");
    writeFileSync(cacheFile, "tampered\n");
    const restored = restorePackageBuild({ root, cacheRoot, pkg, fingerprint });
    expect(restored.hit).toBe(false);
    if (!restored.hit) expect(restored.reason).toContain("digest mismatch");
  });

  test("one input fingerprint cannot silently accept nondeterministic output bytes", () => {
    const { root, cacheRoot, pkg } = fixture();
    const fingerprint = "b".repeat(64);
    mkdirSync(join(root, pkg.dir, "dist"), { recursive: true });
    writeFileSync(join(root, pkg.dir, "dist/index.js"), "export const built = 1;\n");
    savePackageBuild({ root, cacheRoot, pkg, fingerprint });
    writeFileSync(join(root, pkg.dir, "dist/index.js"), "export const built = 2;\n");
    expect(() => savePackageBuild({ root, cacheRoot, pkg, fingerprint })).toThrow(
      "nondeterministic output",
    );
  });

  test("a symlink inside build output is rejected instead of omitted from the manifest", () => {
    if (process.platform === "win32") return;
    const { root, cacheRoot, pkg } = fixture();
    const fingerprint = "c".repeat(64);
    const dist = join(root, pkg.dir, "dist");
    const outside = join(root, "outside-output.js");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.js"), "export const built = true;\n");
    writeFileSync(outside, "must not enter cache\n");
    symlinkSync(outside, join(dist, "linked.js"));

    expect(() => savePackageBuild({ root, cacheRoot, pkg, fingerprint })).toThrow(
      "cache outputs may not be symlinks",
    );
    expect(existsSync(join(cacheRoot, "v1", "_opengeni_example", fingerprint))).toBe(false);
  });

  test("remote-cache snapshots retain only a bounded number of entries per package", () => {
    const { root, cacheRoot, pkg } = fixture();
    mkdirSync(join(root, pkg.dir, "dist"), { recursive: true });
    for (const [index, fingerprint] of ["1".repeat(64), "2".repeat(64), "3".repeat(64)].entries()) {
      writeFileSync(join(root, pkg.dir, "dist/index.js"), `export const built = ${index};\n`);
      savePackageBuild({ root, cacheRoot, pkg, fingerprint });
      const manifest = join(cacheRoot, "v1", "_opengeni_example", fingerprint, "manifest.json");
      const timestamp = new Date(1_000 + index * 1_000);
      utimesSync(manifest, timestamp, timestamp);
    }
    expect(prunePackageBuildCache({ cacheRoot, keepPerPackage: 2 })).toEqual({
      removedEntries: 1,
      keptEntries: 2,
    });
    expect(restorePackageBuild({ root, cacheRoot, pkg, fingerprint: "1".repeat(64) })).toEqual({
      hit: false,
      reason: "not-found",
    });
    expect(restorePackageBuild({ root, cacheRoot, pkg, fingerprint: "3".repeat(64) })).toEqual({
      hit: true,
    });
  });

  test("a symlinked content-address entry is rejected without reading outside the cache", () => {
    if (process.platform === "win32") return;
    const { root, cacheRoot, pkg } = fixture();
    const fingerprint = "a".repeat(64);
    const outside = join(root, "outside");
    mkdirSync(join(outside, "dist"), { recursive: true });
    writeFileSync(join(outside, "manifest.json"), "{}\n");
    const entry = join(cacheRoot, "v1", "_opengeni_example", fingerprint);
    mkdirSync(join(cacheRoot, "v1", "_opengeni_example"), { recursive: true });
    symlinkSync(outside, entry);
    const restored = restorePackageBuild({ root, cacheRoot, pkg, fingerprint });
    expect(restored.hit).toBe(false);
    if (!restored.hit) expect(restored.reason).toContain("symlink");
    expect(readFileSync(join(outside, "manifest.json"), "utf8")).toBe("{}\n");
  });
});
