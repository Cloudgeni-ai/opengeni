import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishableWorkspacePackages,
  topologicallySortedPackages,
  workspaceVersionMap,
} from "./publishable-workspaces";
import { rewriteEntryPointsToDist, srcToDist } from "./rewrite-entry-points";
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

test("new public subpaths retain source entries and rewrite to JS/declarations and typed CSS", () => {
  const root = join(import.meta.dir, "..");
  for (const [directory, subpaths] of [
    ["packages/connect", ["."]],
    ["packages/sdk", ["./site", "./browser"]],
    ["packages/react", ["./connect", "./sites", "./connect.css"]],
  ] as const) {
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    const sourceEntries = structuredClone(manifest.exports);
    rewriteEntryPointsToDist(manifest);
    for (const subpath of subpaths) {
      const entry = manifest.exports[subpath];
      expect(entry).toBeDefined();
      expect(typeof entry.types).toBe("string");
      const source = sourceEntries[subpath];
      expect(existsSync(join(root, directory, source.types))).toBe(true);
      expect(existsSync(join(root, directory, source.import ?? source.default))).toBe(true);
      expect(entry.types).toBe(srcToDist(source.types, "types"));
      expect(entry.import ?? entry.default).toBe(
        srcToDist(source.import ?? source.default, "runtime"),
      );
      // Unit shards intentionally have no dist. The package job repeats this
      // same contract after the canonical build with emitted-file checks on.
      if (process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES === "1") {
        expect(
          existsSync(join(root, directory, entry.types)),
          `${directory}/${subpath} declarations`,
        ).toBe(true);
        expect(
          existsSync(join(root, directory, entry.import ?? entry.default)),
          `${directory}/${subpath} runtime`,
        ).toBe(true);
      }
    }
  }
});

type PublishedEntry = { field: string; condition: string; target: string };

function publishedEntries(manifest: Record<string, unknown>): PublishedEntry[] {
  const entries: PublishedEntry[] = [];
  const visit = (field: string, condition: string, value: unknown): void => {
    if (typeof value === "string") entries.push({ field, condition, target: value });
    else if (value && typeof value === "object")
      for (const [key, nested] of Object.entries(value)) visit(field, key, nested);
  };
  for (const field of ["main", "module", "types"] as const)
    visit(field, field === "types" ? "types" : "default", manifest[field]);
  const exports = manifest.exports;
  if (typeof exports === "string") visit("exports", "default", exports);
  else if (exports && typeof exports === "object")
    for (const [subpath, value] of Object.entries(exports))
      visit(`exports["${subpath}"]`, "default", value);
  const bin = manifest.bin;
  if (typeof bin === "string") visit("bin", "default", bin);
  else if (bin && typeof bin === "object")
    for (const [name, value] of Object.entries(bin)) visit(`bin["${name}"]`, "default", value);
  return entries;
}

test("every published package entry resolves to an emitted file or a shipped asset", () => {
  // A dist target must be something the build emits. A source extension in
  // dist (for example `./dist/accounts.tsx`) is a subpath consumers can never
  // import, which is how `@opengeni/react/accounts` shipped broken.
  const emitted = /\.(?:js|cjs|mjs|json)$/u;
  const root = join(import.meta.dir, "..");
  const problems: string[] = [];
  for (const pkg of publishableWorkspacePackages()) {
    const published = structuredClone(pkg.packageJson);
    rewriteEntryPointsToDist(published);
    for (const { field, condition, target } of publishedEntries(published)) {
      const label = `${pkg.name} ${field} (${condition}) -> ${target}`;
      if (target.startsWith("./dist/")) {
        const declaration = target.endsWith(".d.ts");
        if (condition === "types" ? !declaration : declaration || !emitted.test(target))
          problems.push(
            `${label}: not an emitted ${condition === "types" ? "declaration" : "runtime"} file`,
          );
        // Unit shards have no dist; the package job repeats this after the
        // canonical build and then also requires every emitted file to exist.
        if (
          process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES === "1" &&
          !existsSync(join(root, pkg.dir, target))
        )
          problems.push(`${label}: missing after the package build`);
      } else if (!existsSync(join(root, pkg.dir, target))) {
        problems.push(`${label}: shipped file does not exist`);
      }
    }
  }
  expect(problems).toEqual([]);
});
