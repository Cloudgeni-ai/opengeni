import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import contractsConfig from "../packages/contracts/tsup.config";
import sdkConfig from "../packages/sdk/tsup.config";
import {
  publishableWorkspacePackages,
  topologicallySortedPackages,
  workspaceVersionMap,
  type PackageJson,
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
    expect(manifest.dependencies?.["@opengeni/connect"]).toBe(connect!.version);
  }
});

test("new public subpaths retain source entries and rewrite to JS/declarations and typed CSS", () => {
  const root = join(import.meta.dir, "..");
  for (const [directory, subpaths] of [
    ["packages/connect", ["."]],
    [
      "packages/contracts",
      [
        "./browser-storage",
        "./allowance-refusal",
        "./learning-refusal",
        "./usage-allowances",
        "./session-usage-limits",
        "./session-usage-limit-refusal",
        "./secret-use-approval-question",
        "./vault-provider-wire",
        "./values",
      ],
    ],
    [
      "packages/sdk",
      [
        "./site",
        "./browser",
        "./allowance-refusal",
        "./learning-refusal",
        "./session-usage-limits",
        "./secret-use-approval",
        "./workspace-integrations",
        "./external-vault-receiver",
        "./session-proxy",
        "./tool-auth",
      ],
    ],
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

test("every public contracts and SDK source subpath has a matching runtime build entry", async () => {
  for (const [name, buildConfig] of [
    ["contracts", contractsConfig],
    ["sdk", sdkConfig],
  ] as const) {
    const directory = join(import.meta.dir, "../packages", name);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const resolved = typeof buildConfig === "function" ? await buildConfig({}) : buildConfig;
    const configs = Array.isArray(resolved) ? resolved : [resolved];
    const entries = new Set(
      configs.flatMap((config) =>
        Array.isArray(config.entry) ? config.entry : Object.values(config.entry ?? {}),
      ),
    );
    const published = structuredClone(manifest);
    rewriteEntryPointsToDist(published);
    for (const [subpath, value] of Object.entries(manifest.exports)) {
      const source = value as { import?: string; default?: string };
      const runtime = source.import ?? source.default;
      if (!runtime?.startsWith("./src/") || !runtime.endsWith(".ts")) continue;
      const label = `@opengeni/${name} ${subpath}`;
      expect(entries.has(runtime.slice(2)), `${label} runtime build entry`).toBe(true);
      if (process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES === "1") {
        const emitted = published.exports[subpath];
        expect(existsSync(join(directory, emitted.types)), `${label} declarations`).toBe(true);
        expect(
          existsSync(join(directory, emitted.import ?? emitted.default)),
          `${label} runtime`,
        ).toBe(true);
      }
    }
  }
});

type PublishedEntry = { field: string; condition: string; target: string };

function missingPublishedTargets(
  directory: string,
  sourceTarget: string,
  target: string,
): string[] {
  if (!target.includes("*")) return existsSync(join(directory, target)) ? [] : [target];
  // Expand the source, not dist: scanning emitted files alone cannot detect
  // a missing sibling output. Match the closure guard's source/fixture scope.
  const [prefix, suffix = ""] = sourceTarget.split("*");
  if (!sourceTarget.includes("*") || sourceTarget.split("*").length !== 2)
    return [`${target}: expected one source wildcard`];
  const root = join(directory, dirname(`${prefix}x`));
  const outputs: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      const source = `./${relative(directory, child).split("\\").join("/")}`;
      if (!source.startsWith(prefix!) || !source.endsWith(suffix)) continue;
      const match = source.slice(prefix!.length, source.length - suffix.length);
      if (
        sourceTarget.startsWith("./src/") &&
        /\.(test|browser|dom-fixture)$|\.test\./u.test(match)
      )
        continue;
      outputs.push(target.replaceAll("*", match));
    }
  };
  if (existsSync(root)) visit(root);
  if (outputs.length === 0) return [`${sourceTarget}: matches no source files`];
  return outputs.filter((output) => !existsSync(join(directory, output))).sort();
}

test("wildcard published targets require every source module's runtime and declaration", () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeni-export-targets-"));
  try {
    for (const path of ["src/ui", "dist/ui"]) mkdirSync(join(directory, path), { recursive: true });
    for (const name of ["button", "badge"])
      for (const path of [`src/ui/${name}.tsx`, `dist/ui/${name}.js`, `dist/ui/${name}.d.ts`])
        writeFileSync(join(directory, path), "export {};\n");
    const check = (kind: "runtime" | "types") =>
      missingPublishedTargets(
        directory,
        "./src/ui/*.tsx",
        kind === "types" ? "./dist/ui/*.d.ts" : "./dist/ui/*.js",
      );
    const manifest = {
      exports: { "./ui/*": { types: "./src/ui/*.tsx", default: "./src/ui/*.tsx" } },
    };
    const contract = () => publishedPackageProblems(directory, "fixture", manifest, true);
    expect(contract()).toEqual([]);
    expect(check("runtime")).toEqual([]);
    expect(check("types")).toEqual([]);
    unlinkSync(join(directory, "dist/ui/badge.js"));
    expect(check("runtime")).toEqual(["./dist/ui/badge.js"]);
    expect(contract()).toEqual([
      'fixture exports["./ui/*"] (import) -> ./dist/ui/*.js: missing after the package build: ./dist/ui/badge.js',
    ]);
    expect(check("types")).toEqual([]);
    unlinkSync(join(directory, "dist/ui/badge.d.ts"));
    expect(check("types")).toEqual(["./dist/ui/badge.d.ts"]);
    expect(contract()).toHaveLength(2);
    expect(missingPublishedTargets(directory, "./src/missing/*.tsx", "./dist/ui/*.js")).toEqual([
      "./src/missing/*.tsx: matches no source files",
    ]);
    expect(
      missingPublishedTargets(directory, "./src/ui/button.tsx", "./dist/ui/button.js"),
    ).toEqual([]);
    expect(missingPublishedTargets(directory, "./src/ui/badge.tsx", "./dist/ui/badge.js")).toEqual([
      "./dist/ui/badge.js",
    ]);
    expect(missingPublishedTargets(directory, "./src/ui/*.tsx", "./dist/wrong/*.js")).toEqual([
      "./dist/wrong/badge.js",
      "./dist/wrong/button.js",
    ]);
    unlinkSync(join(directory, "dist/ui/button.js"));
    expect(check("runtime")).toEqual(["./dist/ui/badge.js", "./dist/ui/button.js"]);
    mkdirSync(join(directory, "src/ui/nested"));
    writeFileSync(join(directory, "src/ui/nested/toggle.tsx"), "export {};\n");
    expect(check("runtime")).toContain("./dist/ui/nested/toggle.js");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

function publishedPackageProblems(
  directory: string,
  name: string,
  manifest: PackageJson,
  verifyBuilt: boolean,
): string[] {
  // A dist target must be something the build emits. A source extension in
  // dist (for example `./dist/accounts.tsx`) is a subpath consumers can never
  // import, which is how `@opengeni/react/accounts` shipped broken.
  const emitted = /\.(?:js|cjs|mjs|json)$/u;
  const problems: string[] = [];
  const published = structuredClone(manifest);
  rewriteEntryPointsToDist(published);
  const sourceEntries = publishedEntries(manifest);
  for (const { field, condition, target } of publishedEntries(published)) {
    const label = `${name} ${field} (${condition}) -> ${target}`;
    // Rewriting a default source export may rename its condition to import.
    const source =
      sourceEntries.find((entry) => entry.field === field && entry.condition === condition) ??
      sourceEntries.find(
        (entry) => entry.field === field && condition === "import" && entry.condition === "default",
      );
    const missing = () => missingPublishedTargets(directory, source?.target ?? target, target);
    if (target.startsWith("./dist/")) {
      const declaration = target.endsWith(".d.ts");
      if (condition === "types" ? !declaration : declaration || !emitted.test(target))
        problems.push(
          `${label}: not an emitted ${condition === "types" ? "declaration" : "runtime"} file`,
        );
      // Unit shards have no dist; the package job repeats this after the
      // canonical build and then also requires every emitted file to exist.
      if (verifyBuilt)
        for (const output of missing())
          problems.push(`${label}: missing after the package build: ${output}`);
    } else {
      for (const output of missing())
        problems.push(`${label}: shipped file does not exist: ${output}`);
    }
  }
  return problems;
}

test("every published package entry resolves to an emitted file or a shipped asset", () => {
  const root = join(import.meta.dir, "..");
  const problems = publishableWorkspacePackages().flatMap((pkg) =>
    publishedPackageProblems(
      join(root, pkg.dir),
      pkg.name,
      pkg.packageJson,
      process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES === "1",
    ),
  );
  expect(problems).toEqual([]);
});
