import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishableWorkspacePackages,
  topologicallySortedPackages,
  workspaceVersionMap,
} from "./publishable-workspaces";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";

test("Docker dependency stages and Codemode runtimes retain the Connect SDK dependency", () => {
  const root = join(import.meta.dir, "..");
  for (const file of ["opengeni", "sandbox", "desktop"]) {
    const source = readFileSync(join(root, "docker", `${file}.Dockerfile`), "utf8");
    expect(source).toContain("COPY packages/connect/package.json packages/connect/package.json");
    if (file !== "opengeni")
      expect(source).toContain(
        'cp -a packages/connect/src "$runtime/node_modules/@opengeni/connect/src"',
      );
  }
});

test("Connect is published before its SDK and React consumers without a React/server dependency", () => {
  const packages = topologicallySortedPackages(publishableWorkspacePackages());
  const names = packages.map((pkg) => pkg.name);
  const connect = packages.find((pkg) => pkg.name === "@opengeni/connect");
  expect(connect).toBeDefined();
  expect(connect!.packageJson.dependencies ?? {}).toEqual({});
  expect(connect!.packageJson.peerDependencies ?? {}).toEqual({});
  expect(existsSync(join(import.meta.dir, "..", connect!.dir, "LICENSE"))).toBe(true);
  for (const name of ["@opengeni/sdk", "@opengeni/react"]) {
    expect(names.indexOf(name)).toBeGreaterThan(names.indexOf("@opengeni/connect"));
    const manifest = structuredClone(packages.find((pkg) => pkg.name === name)!.packageJson);
    rewriteWorkspaceDependenciesToConcrete(manifest, workspaceVersionMap());
    expect(manifest.dependencies?.["@opengeni/connect"]).toBe(`^${connect!.version}`);
  }
});

test("new public subpaths rewrite to actual built JS/declarations and typed CSS", () => {
  const root = join(import.meta.dir, "..");
  for (const [directory, subpaths] of [
    ["packages/connect", ["."]],
    ["packages/sdk", ["./site", "./browser"]],
    ["packages/react", ["./connect", "./sites", "./connect.css"]],
  ] as const) {
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    rewriteEntryPointsToDist(manifest);
    for (const subpath of subpaths) {
      const entry = manifest.exports[subpath];
      expect(entry).toBeDefined();
      expect(typeof entry.types).toBe("string");
      expect(existsSync(join(root, directory, entry.types))).toBe(true);
      expect(existsSync(join(root, directory, entry.import ?? entry.default))).toBe(true);
    }
  }
});
