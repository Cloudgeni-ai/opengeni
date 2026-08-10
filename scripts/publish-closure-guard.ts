#!/usr/bin/env bun
/**
 * Publish closure guard.
 *
 * Stage C publishes the full @opengeni/* runtime closure needed by the client,
 * API router, core, and worker bundle. This guard fails loudly if:
 *
 *   (a) a publishable package's published dependency maps point at an ignored or
 *       private workspace package.
 *   (b) a publishable package is missing npm-public package metadata or a build.
 *   (c) @opengeni/sdk / @opengeni/react stop honoring the client-clean closure:
 *       the SDK depends only on the canonical contracts package, React depends
 *       only on SDK, and its browser-safe artifact engine is an optional peer
 *       for the isolated artifact subpaths.
 *   (d) the BUILT sdk/react dist bundles reference any server/embed package.
 *   (e) the BUILT runtime leaves OpenAI Agents or Zod externally resolved,
 *       allowing an embedding host to change their runtime schema identity.
 *   (f) the runtime's third-party notices omit a package present in its built
 *       executable source maps.
 *   (g) a package's built runtime, shipped source, or emitted declarations
 *       reference an @opengeni/* package that its published manifest does not
 *       declare.
 *
 * Wired into the release gate and safe to run locally without publishing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Script } from "node:vm";
import { gzipSync } from "node:zlib";
import { artifactKernelWasmPackageSizeBudgets } from "./build-artifact-kernel-wasm-packages";
import {
  declarationModuleSpecifiers,
  runtimeModuleSpecifiers,
  type RuntimeLoader,
} from "./publish-closure-imports";
import {
  PUBLISHED_DEP_FIELDS,
  changesetIgnoreSet,
  publishableWorkspacePackages,
  repoRoot,
  topologicallySortedPackages,
  workspaceDependencyNames,
  workspacePackageByName,
  type PackageJson,
  type WorkspacePackage,
} from "./publishable-workspaces";

const SERVER_EMBED_PACKAGES = [
  "agent-proto",
  "api-router",
  "codex",
  "config",
  "core",
  "db",
  "documents",
  "events",
  "github",
  "network",
  "observability",
  "runtime",
  "storage",
  "worker-bundle",
  "deployment",
  "testing",
] as const;

const failures: string[] = [];
const publishable = topologicallySortedPackages(publishableWorkspacePackages());
const publishableNames = new Set(publishable.map((pkg) => pkg.name));
const ignored = changesetIgnoreSet();
const workspaceNames = workspacePackageByName();
const PREPUBLISH_GUARD_SCRIPT = "bash ../../scripts/prepublish-guard";

function readPkg(pkgDir: string): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, pkgDir, "package.json"), "utf8")) as PackageJson;
}

function opengeniRuntimeDeps(pkg: PackageJson): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@opengeni/"));
}

function assertPublishableMetadata(pkg: WorkspacePackage): void {
  const json = pkg.packageJson as PackageJson & {
    main?: string;
    module?: string;
    types?: string;
    exports?: unknown;
    files?: unknown;
    publishConfig?: { access?: string; provenance?: boolean };
    opengeniArtifactKernelAsset?: {
      schemaVersion?: unknown;
      target?: unknown;
      modality?: unknown;
    };
  };
  const kernelAsset = json.opengeniArtifactKernelAsset;
  if (json.publishConfig?.access !== "public") {
    failures.push(`${pkg.name} is publishable but missing publishConfig.access="public".`);
  }
  if (json.publishConfig?.provenance !== true) {
    failures.push(`${pkg.name} is publishable but missing publishConfig.provenance=true.`);
  }
  if (json.license !== "Apache-2.0") {
    failures.push(`${pkg.name} is publishable but missing license="Apache-2.0".`);
  }
  if (!existsSync(join(repoRoot, pkg.dir, "LICENSE"))) {
    failures.push(`${pkg.name} is publishable but missing a package-local LICENSE file.`);
  }
  if (kernelAsset) {
    assertArtifactKernelAssetPackage(pkg, json, kernelAsset);
  } else {
    if (!Array.isArray(json.files) || !json.files.includes("dist") || !json.files.includes("src")) {
      failures.push(`${pkg.name} is publishable but its files list must include "dist" and "src".`);
    }
    if (
      json.main !== "./src/index.ts" ||
      json.module !== "./src/index.ts" ||
      json.types !== "./src/index.ts"
    ) {
      failures.push(
        `${pkg.name} committed entry points must stay on ./src/index.ts for workspace source resolution.`,
      );
    }
  }
  if (!json.exports || typeof json.exports !== "object") {
    failures.push(`${pkg.name} is publishable but has no exports map.`);
  }
  if (!json.scripts?.build) {
    failures.push(`${pkg.name} is publishable but has no build script.`);
  }
  if (json.scripts?.prepublishOnly !== PREPUBLISH_GUARD_SCRIPT) {
    failures.push(
      `${pkg.name} is publishable but missing prepublishOnly="${PREPUBLISH_GUARD_SCRIPT}".`,
    );
  }
}

function assertArtifactKernelAssetPackage(
  pkg: WorkspacePackage,
  json: PackageJson & {
    main?: string;
    module?: string;
    types?: string;
    files?: unknown;
  },
  marker: { schemaVersion?: unknown; target?: unknown; modality?: unknown },
): void {
  const modalities = ["spreadsheet", "document", "presentation"] as const;
  if (
    marker.schemaVersion !== 1 ||
    marker.target !== "wasm-web" ||
    !modalities.includes(marker.modality as (typeof modalities)[number])
  ) {
    failures.push(`${pkg.name} has an invalid artifact-kernel asset marker.`);
    return;
  }
  const modality = marker.modality as (typeof modalities)[number];
  const expectedName = `@opengeni/artifact-kernel-wasm-${modality}`;
  if (pkg.name !== expectedName) {
    failures.push(`${pkg.name} artifact-kernel modality requires package name ${expectedName}.`);
  }
  if (JSON.stringify(json.files) !== JSON.stringify(["dist"])) {
    failures.push(`${pkg.name} must publish only its verified dist directory.`);
  }
  if (
    json.main !== "./dist/index.js" ||
    json.module !== "./dist/index.js" ||
    json.types !== "./dist/index.d.ts"
  ) {
    failures.push(`${pkg.name} must resolve exclusively through its verified dist entrypoint.`);
  }
  const exports = json.exports as Record<string, unknown> | undefined;
  if (
    JSON.stringify(exports?.["."]) !==
      JSON.stringify({
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      }) ||
    exports?.["./runtime-manifest"] !== "./dist/artifact-kernel-runtime.json"
  ) {
    failures.push(`${pkg.name} must export only its typed entrypoint and runtime manifest.`);
  }
  const expectedBuild = `bun ../../scripts/build-artifact-kernel-wasm-packages.ts --modality ${modality} --asset-root ./dist`;
  if (json.scripts?.build !== expectedBuild) {
    failures.push(`${pkg.name} must rebuild and verify its exact committed runtime assets.`);
  }
  const dist = join(repoRoot, pkg.dir, "dist");
  const expectedStem = `artifact_kernel_${modality}`;
  const required = [
    "artifact-kernel-runtime.json",
    `${expectedStem}.d.ts`,
    `${expectedStem}.js`,
    `${expectedStem}_bg.wasm`,
    `${expectedStem}_bg.wasm.d.ts`,
    "index.d.ts",
    "index.js",
  ].sort();
  if (!existsSync(dist)) {
    failures.push(`${pkg.name} is missing its verified dist directory.`);
    return;
  }
  const actual = readdirSync(dist).sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    failures.push(`${pkg.name} dist must contain only its exact modality runtime files.`);
    return;
  }
  try {
    const manifest = JSON.parse(
      readFileSync(join(dist, "artifact-kernel-runtime.json"), "utf8"),
    ) as {
      schemaVersion?: unknown;
      runtimeIdentity?: Record<string, unknown>;
      files?: Array<{ path?: unknown; bytes?: unknown; sha256?: unknown; gzipBytes?: unknown }>;
      sizeBudget?: { wasmBytes?: unknown; wasmGzipBytes?: unknown; glueBytes?: unknown };
    };
    const identity = manifest.runtimeIdentity;
    const artifactToolVersion = workspaceNames.get("@opengeni/artifact-tool")?.version;
    if (
      manifest.schemaVersion !== 1 ||
      identity?.schemaVersion !== 1 ||
      identity?.target !== "wasm-web" ||
      identity.modality !== modality ||
      identity.packageName !== pkg.name ||
      identity.packageVersion !== pkg.version ||
      identity.artifactToolVersion !== artifactToolVersion ||
      typeof identity.buildIdentity !== "string" ||
      identity.buildIdentity.length === 0 ||
      identity.kernelVersion !== identity.buildIdentity ||
      ![
        identity.abiVersion,
        identity.protocolVersion,
        identity.modelSchemaVersion,
        identity.commandVersion,
      ].every((value) => Number.isSafeInteger(value) && (value as number) > 0) ||
      !Array.isArray(manifest.files)
    ) {
      failures.push(`${pkg.name} runtime manifest has an invalid typed identity.`);
      return;
    }
    const expectedPayloadFiles = required.filter((path) => path !== "artifact-kernel-runtime.json");
    const descriptors = manifest.files;
    if (
      descriptors.length !== expectedPayloadFiles.length ||
      JSON.stringify(descriptors.map(({ path }) => path).sort()) !==
        JSON.stringify(expectedPayloadFiles)
    ) {
      failures.push(`${pkg.name} runtime manifest does not cover its exact payload files.`);
      return;
    }
    for (const descriptor of descriptors) {
      if (typeof descriptor.path !== "string") continue;
      const bytes = readFileSync(join(dist, descriptor.path));
      const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (descriptor.bytes !== bytes.byteLength || descriptor.sha256 !== sha256) {
        failures.push(`${pkg.name} runtime manifest digest differs for ${descriptor.path}.`);
      }
      if (
        descriptor.gzipBytes !== undefined &&
        descriptor.gzipBytes !== gzipSync(bytes, { level: 9, mtime: 0 }).byteLength
      ) {
        failures.push(`${pkg.name} runtime manifest gzip size differs for ${descriptor.path}.`);
      }
    }
    const wasm = descriptors.find(({ path }) => path === `${expectedStem}_bg.wasm`);
    const glue = descriptors.find(({ path }) => path === `${expectedStem}.js`);
    const budget = manifest.sizeBudget;
    const expectedBudget = artifactKernelWasmPackageSizeBudgets[modality];
    if (
      !budget ||
      JSON.stringify(budget) !== JSON.stringify(expectedBudget) ||
      !wasm ||
      !Number.isSafeInteger(wasm.bytes) ||
      !Number.isSafeInteger(wasm.gzipBytes) ||
      !glue ||
      !Number.isSafeInteger(glue.bytes) ||
      (wasm?.bytes as number) > (budget.wasmBytes as number) ||
      (wasm?.gzipBytes as number) > (budget.wasmGzipBytes as number) ||
      (glue?.bytes as number) > (budget.glueBytes as number)
    ) {
      failures.push(`${pkg.name} runtime payload exceeds or lacks its truthful size budget.`);
    }
  } catch {
    failures.push(`${pkg.name} runtime manifest is not valid JSON.`);
  }
}

for (const pkg of publishable) {
  assertPublishableMetadata(pkg);
  for (const depName of workspaceDependencyNames(pkg, PUBLISHED_DEP_FIELDS)) {
    if (!publishableNames.has(depName)) {
      const ignoredText = ignored.has(depName) ? "ignored" : "private";
      failures.push(
        `${pkg.name} depends on ${ignoredText} workspace package ${depName} in a published dependency map.`,
      );
    }
  }
}

for (const ignoredName of ignored) {
  const pkg = workspaceNames.get(ignoredName);
  if (!pkg || pkg.name === "opengeni-web") {
    continue;
  }
  for (const consumer of publishable) {
    if (workspaceDependencyNames(consumer, PUBLISHED_DEP_FIELDS).includes(ignoredName)) {
      failures.push(`${ignoredName} is ignored but is a published dependency of ${consumer.name}.`);
    }
  }
}

// (a) SDK may depend only on the canonical contracts package used by its opt-in
// editable-artifact entries. Its ordinary entries remain isolated below.
const sdkPkg = readPkg("packages/sdk");
const sdkRuntimeDeps = Object.keys(sdkPkg.dependencies ?? {});
const allowedSdkRuntimeDeps = new Set(["@opengeni/contracts"]);
const sdkForbiddenRuntimeDeps = sdkRuntimeDeps.filter((name) => !allowedSdkRuntimeDeps.has(name));
if (sdkForbiddenRuntimeDeps.length > 0) {
  failures.push(
    `@opengeni/sdk may only depend on @opengeni/contracts at runtime, found: ${sdkForbiddenRuntimeDeps.join(", ")}.`,
  );
}
const sdkOpengeniDeps = opengeniRuntimeDeps(sdkPkg);
if (
  sdkOpengeniDeps.length !== 1 ||
  sdkOpengeniDeps[0] !== "@opengeni/contracts" ||
  sdkPkg.dependencies?.["@opengeni/contracts"] !== "workspace:*"
) {
  failures.push(
    `@opengeni/sdk must declare exactly @opengeni/contracts="workspace:*" as its @opengeni runtime dependency.`,
  );
}

// (b) React's only @opengeni runtime dependency is the client SDK. The artifact
// engine stays an optional peer so ordinary React/session consumers do not
// install its format codecs or native rasterizer.
const reactPkg = readPkg("packages/react");
const reactOpengeniDeps = opengeniRuntimeDeps(reactPkg);
const allowedReactOpengeniDeps = new Set(["@opengeni/sdk"]);
const reactForbidden = reactOpengeniDeps.filter((name) => !allowedReactOpengeniDeps.has(name));
if (reactForbidden.length > 0) {
  failures.push(
    `@opengeni/react may only depend on @opengeni/sdk among @opengeni/* packages, found: ${reactForbidden.join(", ")}.`,
  );
}
if (!reactOpengeniDeps.includes("@opengeni/sdk")) {
  failures.push(`@opengeni/react must keep @opengeni/sdk as a runtime dependency.`);
}
const reactPeerDependencies = reactPkg.peerDependencies ?? {};
if (reactPeerDependencies["@opengeni/artifact-tool"] !== ">=0.0.0 <0.2.0") {
  failures.push(
    `@opengeni/react must expose the initial @opengeni/artifact-tool 0.1 line as a compatible peer.`,
  );
}
const reactPeerMetadata = (
  reactPkg as PackageJson & { peerDependenciesMeta?: Record<string, { optional?: boolean }> }
).peerDependenciesMeta;
if (reactPeerMetadata?.["@opengeni/artifact-tool"]?.optional !== true) {
  failures.push(`@opengeni/react must keep @opengeni/artifact-tool an optional peer.`);
}

// CSS subpath imports must resolve in strict external TypeScript consumers as
// well as bundlers. A bare string export ships runtime CSS but leaves tsc
// unable to type a side-effect import unless every consumer adds its own
// wildcard declaration.
const reactExports = (reactPkg as PackageJson & { exports?: Record<string, unknown> }).exports;
for (const subpath of ["./styles.css", "./compiled.css", "./responsive.css", "./tokens.css"]) {
  const entry = reactExports?.[subpath];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    failures.push(`@opengeni/react ${subpath} must provide typed conditional exports.`);
    continue;
  }
  const conditions = entry as { types?: unknown; style?: unknown; default?: unknown };
  for (const condition of ["types", "style", "default"] as const) {
    const target = conditions[condition];
    if (typeof target !== "string" || !target.startsWith("./")) {
      failures.push(`@opengeni/react ${subpath} is missing a local ${condition} export target.`);
      continue;
    }
    if (!existsSync(join(repoRoot, "packages/react", target))) {
      failures.push(`@opengeni/react ${subpath} ${condition} target does not exist: ${target}.`);
    }
  }
}

// (d) Built dist bundles must not reference any server/embed package.
//
// The sdk/react tsup configs externalize all @opengeni/* (see their
// tsup.config.ts), so a leaked `import "@opengeni/<server>"` survives in dist as
// a literal specifier rather than being inlined — which is exactly what this
// grep relies on. The trailing `(?:/|["'\`]|$)` ensures we match the full
// package boundary (e.g. `@opengeni/db` but not a hypothetical
// `@opengeni/dbutils`); the capture group reports just the clean package name.
const serverInternalPattern = new RegExp(
  `@opengeni/(${SERVER_EMBED_PACKAGES.join("|")})(?:/|["'\`]|$)`,
);

function ensureBuilt(pkgDir: string): void {
  const distEntry = join(repoRoot, pkgDir, "dist", "index.js");
  if (existsSync(distEntry)) {
    return;
  }
  process.stdout.write(`[closure-guard] building ${pkgDir} (dist missing)...\n`);
  const result = spawnSync("bun", ["run", "build"], {
    cwd: join(repoRoot, pkgDir),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failures.push(`Failed to build ${pkgDir} for closure-guard inspection.`);
  }
}

function compiledTarget(sourceTarget: string, kind: "runtime" | "types"): string | null {
  if (!sourceTarget.startsWith("./src/") || !/\.tsx?$/.test(sourceTarget)) {
    return null;
  }
  const stem = sourceTarget.slice("./src/".length).replace(/\.tsx?$/, "");
  return `./dist/${stem}${kind === "types" ? ".d.ts" : ".js"}`;
}

function assertBuiltExportTargets(pkg: WorkspacePackage): void {
  const exports = (pkg.packageJson as PackageJson & { exports?: Record<string, unknown> }).exports;
  if (!exports || typeof exports !== "object") return;

  for (const [subpath, entry] of Object.entries(exports)) {
    const targets: Array<{ kind: "runtime" | "types"; source: string }> = [];
    if (typeof entry === "string") {
      targets.push({ kind: "runtime", source: entry });
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const conditions = entry as { types?: unknown; import?: unknown; default?: unknown };
      if (typeof conditions.types === "string") {
        targets.push({ kind: "types", source: conditions.types });
      }
      const runtime = conditions.import ?? conditions.default;
      if (typeof runtime === "string") {
        targets.push({ kind: "runtime", source: runtime });
      }
    }

    for (const target of targets) {
      const compiled = compiledTarget(target.source, target.kind);
      if (!compiled) continue;
      if (!existsSync(join(repoRoot, pkg.dir, compiled))) {
        failures.push(
          `${pkg.name} export ${subpath} compiles from ${target.source} but is missing ${compiled}.`,
        );
      }
    }
  }
}

for (const pkg of publishable) {
  const pkgDir = pkg.dir;
  ensureBuilt(pkgDir);
  assertBuiltExportTargets(pkg);
}

const workerWorkflowBundlePath = join(repoRoot, "apps/worker/dist/workflow-bundle.js");
if (!existsSync(workerWorkflowBundlePath)) {
  failures.push(
    "@opengeni/worker-bundle is missing dist/workflow-bundle.js; installed hosts cannot load workflows",
  );
} else {
  const code = readFileSync(workerWorkflowBundlePath, "utf8");
  if (Buffer.byteLength(code, "utf8") < 100_000) {
    failures.push("@opengeni/worker-bundle workflow artifact is unexpectedly small");
  } else {
    try {
      new Script(code, { filename: workerWorkflowBundlePath }).createCachedData();
    } catch (error) {
      failures.push(
        `@opengeni/worker-bundle workflow artifact is not valid JavaScript: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function builtContractFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...builtContractFiles(path));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function builtSourceMapFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...builtSourceMapFiles(filePath));
    else if (entry.name.endsWith(".js.map")) files.push(filePath);
  }
  return files;
}

function shippedSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...shippedSourceFiles(path));
    else if (/\.(?:js|jsx|ts|tsx)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

// Workspace hoisting can make an undeclared direct dependency appear healthy
// in this monorepo while the published tarball fails under strict/isolated
// resolution. Inspect the built runtime and declaration graphs plus the shipped
// source graph (the worker gives Temporal its workflow source), and require
// every external @opengeni/* specifier to be present in a published dependency
// map. Runtime discovery includes ESM, dynamic import, and CommonJS require;
// declaration discovery includes type-only imports/exports and reference types.
for (const pkg of publishable) {
  const distDir = join(repoRoot, pkg.dir, "dist");
  const sourceDir = join(repoRoot, pkg.dir, "src");
  const declaredRuntimePackages = new Set(workspaceDependencyNames(pkg, PUBLISHED_DEP_FIELDS));
  const importSurfaces = [
    ...(existsSync(distDir) ? builtContractFiles(distDir) : []),
    ...(existsSync(sourceDir) ? shippedSourceFiles(sourceDir) : []),
  ];
  for (const path of importSurfaces) {
    const text = readFileSync(path, "utf8");
    const moduleSpecifiers = path.endsWith(".d.ts")
      ? declarationModuleSpecifiers(text, path)
      : await runtimeModuleSpecifiers(
          text,
          (path.endsWith(".tsx")
            ? "tsx"
            : path.endsWith(".ts")
              ? "ts"
              : path.endsWith(".jsx")
                ? "jsx"
                : "js") satisfies RuntimeLoader,
        );
    for (const imported of moduleSpecifiers) {
      const match = imported.match(/^(@opengeni\/[^/]+)(?:\/|$)/u);
      const importedPackage = match?.[1];
      if (
        importedPackage &&
        importedPackage !== pkg.name &&
        !declaredRuntimePackages.has(importedPackage)
      ) {
        failures.push(
          `${path.slice(repoRoot.length + 1)} imports undeclared runtime workspace package ${importedPackage}. ` +
            `${pkg.name} must declare every externalized direct import in dependencies, peerDependencies, or optionalDependencies.`,
        );
      }
    }
  }
}

for (const pkgDir of ["packages/sdk", "packages/react"]) {
  const distDir = join(repoRoot, pkgDir, "dist");
  if (!existsSync(distDir)) continue;
  for (const path of builtContractFiles(distDir)) {
    const text = readFileSync(path, "utf8");
    const match = text.match(serverInternalPattern);
    if (match) {
      const leaked = match[1] ? `@opengeni/${match[1]}` : "<unknown>";
      failures.push(
        `${path.slice(repoRoot.length + 1)} references a server/embed package (${leaked}). ` +
          `A server import leaked into a published client bundle.`,
      );
    }
  }
}

const artifactNativeRuntimeSpecifiers = ["@resvg/resvg-js", "sharp"] as const;
const artifactBrowserCodecRuntimeSpecifiers = ["docx", "exceljs", "pptxgenjs"] as const;
const artifactOptionalRuntimeSpecifiers = [
  ...artifactNativeRuntimeSpecifiers,
  ...artifactBrowserCodecRuntimeSpecifiers,
] as const;
const reactDistDir = join(repoRoot, "packages/react/dist");

function matchesPackageSpecifier(imported: string, packageName: string): boolean {
  return imported === packageName || imported.startsWith(`${packageName}/`);
}

async function builtRuntimeClosure(entryPaths: readonly string[]): Promise<{
  externalImports: Map<string, string>;
  files: Set<string>;
}> {
  const externalImports = new Map<string, string>();
  const visited = new Set<string>();
  const queue = [...entryPaths];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (!existsSync(path)) {
      failures.push(`Built runtime closure entry is missing: ${path.slice(repoRoot.length + 1)}.`);
      continue;
    }
    const imports = await runtimeModuleSpecifiers(readFileSync(path, "utf8"), "js");
    for (const imported of imports) {
      if (imported.startsWith(".")) {
        queue.push(resolve(dirname(path), imported));
      } else {
        externalImports.set(imported, path);
      }
    }
  }
  return { externalImports, files: visited };
}

const contractsDistDir = join(repoRoot, "packages/contracts/dist");
if (existsSync(contractsDistDir)) {
  const { externalImports, files } = await builtRuntimeClosure([
    join(contractsDistDir, "editable-artifacts.js"),
    join(contractsDistDir, "editable-artifact-live.js"),
  ]);
  const contractRuntime = [...files].map((path) => readFileSync(path, "utf8")).join("\n");
  if (!contractRuntime.includes("OGATX001")) {
    failures.push("The built editable-artifact contract entry does not contain the OGATX codec.");
  }
  if (!contractRuntime.includes("OGALV001")) {
    failures.push(
      "The built editable-artifact live contract entry does not contain the OGALV codec.",
    );
  }
  for (const [imported, sourcePath] of externalImports) {
    if (imported.startsWith("@opengeni/")) {
      failures.push(
        `${sourcePath.slice(repoRoot.length + 1)} makes the canonical editable-artifact contract depend on ${imported}.`,
      );
    }
  }
}

const coreDistDir = join(repoRoot, "packages/core/dist");
if (existsSync(coreDistDir)) {
  for (const entry of ["editable-artifacts.js", "editable-artifact-live.js"]) {
    const { externalImports } = await builtRuntimeClosure([join(coreDistDir, entry)]);
    for (const [imported, sourcePath] of externalImports) {
      if (imported === "hono" || matchesPackageSpecifier(imported, "@opengeni/api-router")) {
        failures.push(
          `${sourcePath.slice(repoRoot.length + 1)} couples the transport-neutral core artifact entry to ${imported}.`,
        );
      }
    }
  }
}

if (existsSync(reactDistDir)) {
  // Even the explicit artifacts entry must reach codecs through artifact-tool,
  // never import its heavy/native dependencies directly.
  for (const path of builtContractFiles(reactDistDir).filter((candidate) =>
    candidate.endsWith(".js"),
  )) {
    const imports = await runtimeModuleSpecifiers(readFileSync(path, "utf8"), "js");
    for (const imported of imports) {
      if (
        artifactOptionalRuntimeSpecifiers.some((packageName) =>
          matchesPackageSpecifier(imported, packageName),
        )
      ) {
        failures.push(
          `${path.slice(repoRoot.length + 1)} directly imports artifact codec ${imported}. ` +
            "React must reach codecs only through the optional artifact-tool peer.",
        );
      }
    }
  }

  // The explicit artifacts entry may use the optional artifact-tool peer. All
  // ordinary React surfaces must remain usable without installing it.
  const nonArtifactEntries = [
    "index.js",
    "composer.js",
    "session.js",
    "session-ui.js",
    "machines.js",
    "model-policy.js",
    "realtime.js",
  ].map((entry) => join(reactDistDir, entry));
  const { externalImports: nonArtifactImports } = await builtRuntimeClosure(nonArtifactEntries);
  for (const [imported, sourcePath] of nonArtifactImports) {
    if (matchesPackageSpecifier(imported, "@opengeni/artifact-tool")) {
      failures.push(
        `${sourcePath.slice(repoRoot.length + 1)} makes optional artifact runtime ${imported} reachable from a non-artifact React entry.`,
      );
    }
  }

  // Each modality subpath is a deliberate payload boundary. Consumers that
  // render one editor must not inherit the other two editors through a shared
  // barrel or an over-broad generated chunk.
  const modalityEntries = [
    {
      name: "spreadsheet",
      entry: "artifacts-spreadsheet.js",
      ownMarker: "SpreadsheetArtifactSurface",
    },
    {
      name: "document",
      entry: "artifacts-document.js",
      ownMarker: "DocumentArtifactSurface",
    },
    {
      name: "presentation",
      entry: "artifacts-presentation.js",
      ownMarker: "PresentationArtifactSurface",
    },
  ] as const;
  for (const modality of modalityEntries) {
    const { externalImports, files } = await builtRuntimeClosure([
      join(reactDistDir, modality.entry),
    ]);
    const closure = [...files].map((path) => readFileSync(path, "utf8")).join("\n");
    if (!closure.includes(modality.ownMarker)) {
      failures.push(
        `React ${modality.name} artifact subpath does not reach its own editor runtime.`,
      );
    }
    for (const other of modalityEntries) {
      if (other.name !== modality.name && closure.includes(other.ownMarker)) {
        failures.push(
          `React ${modality.name} artifact subpath reaches the ${other.name} editor runtime.`,
        );
      }
    }
    for (const [imported, sourcePath] of externalImports) {
      if (
        matchesPackageSpecifier(imported, "@opengeni/artifact-tool") &&
        !matchesPackageSpecifier(imported, "@opengeni/artifact-tool/reference")
      ) {
        failures.push(
          `${sourcePath.slice(repoRoot.length + 1)} makes production/native artifact runtime ${imported} reachable from the browser ${modality.name} editor. ` +
            "Browser renderer models must use the explicit /reference surface; authoritative execution stays in the SDK Worker/WASM runtime.",
        );
      }
    }
  }
}

const sdkDistDir = join(repoRoot, "packages/sdk/dist");
if (existsSync(sdkDistDir)) {
  const builtSdkPkg = readPkg("packages/sdk") as PackageJson & { sideEffects?: unknown };
  const sdkSideEffects = Array.isArray(builtSdkPkg.sideEffects) ? builtSdkPkg.sideEffects : [];
  for (const workerEntry of [
    "./src/editable-artifacts-worker.ts",
    "./src/editable-artifacts/worker/browser-entry.ts",
    "./dist/editable-artifacts-worker.js",
  ]) {
    if (!sdkSideEffects.includes(workerEntry)) {
      failures.push(
        `@opengeni/sdk must mark ${workerEntry} side-effectful so bundlers retain Worker auto-install.`,
      );
    }
  }

  const nonArtifactSdkEntries = [
    "index.js",
    "core.js",
    "realtime.js",
    "codex-realtime-controller.js",
    "gateway-realtime-transport.js",
  ].map((entry) => join(sdkDistDir, entry));
  const { externalImports, files } = await builtRuntimeClosure(nonArtifactSdkEntries);
  for (const [imported, sourcePath] of externalImports) {
    if (matchesPackageSpecifier(imported, "@opengeni/contracts")) {
      failures.push(
        `${sourcePath.slice(repoRoot.length + 1)} makes the contracts runtime reachable from a non-artifact SDK entry.`,
      );
    }
  }
  const editableArtifactMarker =
    /\b(?:createEditableArtifactSyncController|EditableArtifactSyncPool|MemoryEditableArtifactStorage)\b/u;
  for (const path of files) {
    if (editableArtifactMarker.test(readFileSync(path, "utf8"))) {
      failures.push(
        `${path.slice(repoRoot.length + 1)} makes editable-artifact sync runtime reachable from a non-artifact SDK entry.`,
      );
    }
  }

  // The browser client may share the bounded wire codec with its Worker, but
  // it must not pull the WASM adapter or Worker execution runtime onto the main
  // thread. Hosts opt into that code through the dedicated Worker subpath.
  const workerRuntimeMarker = "artifact Worker is already initialized";
  const { files: editableClientFiles } = await builtRuntimeClosure([
    join(sdkDistDir, "editable-artifacts.js"),
  ]);
  for (const path of editableClientFiles) {
    if (readFileSync(path, "utf8").includes(workerRuntimeMarker)) {
      failures.push(
        `${path.slice(repoRoot.length + 1)} makes the editable-artifact Worker runtime reachable from the main-thread SDK client.`,
      );
    }
  }
}

function literalRuntimeImportPattern(specifiers: readonly string[]): RegExp {
  return new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?)["'\`](?:${specifiers
      .map((specifier) => specifier.replaceAll("/", "\\/"))
      .join("|")})(?:\\/[^"'\`]*)?["'\`]`,
    "u",
  );
}

// Browser-safe Office codecs may be literal imports inside their explicit lazy
// entries so Vite can code-split them. They must never leak into the synchronous
// authoring facade. Native rasterizers remain bundler-opaque everywhere.
const authoringCodecImportPattern = literalRuntimeImportPattern(artifactOptionalRuntimeSpecifiers);
const nativeRasterizerImportPattern = literalRuntimeImportPattern(artifactNativeRuntimeSpecifiers);
const artifactToolPkg = readPkg("packages/artifact-tool") as PackageJson & {
  files?: unknown;
  exports?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
};
const artifactToolFiles = Array.isArray(artifactToolPkg.files) ? artifactToolPkg.files : [];
if (!artifactToolFiles.includes("dist") || !artifactToolFiles.includes("src")) {
  failures.push("@opengeni/artifact-tool must publish its built dist and source declarations.");
}
if (
  artifactToolFiles.some(
    (entry) =>
      typeof entry === "string" &&
      (entry === "kernel" || entry.startsWith("kernel/") || /\.(?:node|wasm)$/u.test(entry)),
  )
) {
  failures.push(
    "@opengeni/artifact-tool must not publish an incomplete Rust native/WASM asset matrix.",
  );
}
const artifactToolExports = artifactToolPkg.exports ?? {};
const requiredArtifactToolExports = [
  ".",
  "./reference",
  "./native",
  "./runtime",
  "./runtime/locator",
  "./spreadsheet",
  "./spreadsheet/render",
  "./spreadsheet/xlsx",
  "./document",
  "./document/render",
  "./document/docx",
  "./presentation",
  "./presentation/render",
  "./presentation/pptx",
] as const;
for (const subpath of requiredArtifactToolExports) {
  if (!(subpath in artifactToolExports)) {
    failures.push(`@opengeni/artifact-tool is missing public export ${subpath}.`);
  }
}
if (Object.keys(artifactToolExports).some((subpath) => /(?:binding|kernel|wasm)/iu.test(subpath))) {
  failures.push(
    "@opengeni/artifact-tool must not expose target binding/kernel/WASM package internals.",
  );
}
if (Object.keys(artifactToolPkg.optionalDependencies ?? {}).length > 0) {
  failures.push(
    "@opengeni/artifact-tool must not advertise optional target packages before all eight verified targets ship atomically.",
  );
}
const artifactToolDistDir = join(repoRoot, "packages/artifact-tool/dist");
if (existsSync(artifactToolDistDir)) {
  const authoringEntries = [
    "index.js",
    "production-document.js",
    "production-presentation.js",
    "production-spreadsheet.js",
  ].map((entry) => join(artifactToolDistDir, entry));
  const { files: authoringFiles } = await builtRuntimeClosure(authoringEntries);
  for (const path of authoringFiles) {
    if (authoringCodecImportPattern.test(readFileSync(path, "utf8"))) {
      failures.push(
        `${path.slice(repoRoot.length + 1)} makes an Office codec or rasterizer reachable from the synchronous artifact authoring facade.`,
      );
    }
  }

  for (const path of builtContractFiles(artifactToolDistDir).filter((candidate) =>
    candidate.endsWith(".js"),
  )) {
    if (nativeRasterizerImportPattern.test(readFileSync(path, "utf8"))) {
      failures.push(
        `${path.slice(repoRoot.length + 1)} exposes a bundler-discoverable native rasterizer import. ` +
          "Native dependencies must stay behind runtime-variable imports in isolated render entries.",
      );
    }
  }
}

// OpenAI Agents requires Zod 4, while an embedding host may legitimately use a
// different Zod major. The runtime build must therefore contain that whole
// implementation boundary. Type declarations may continue to reference the
// public Agents types, so inspect executable JavaScript only.
const externalAgentsRuntimeImportPattern =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'`](?:@openai\/agents(?:[/-]|["'`])|zod(?:\/|["'`]))/;
const runtimeDistDir = join(repoRoot, "packages/runtime/dist");
const runtimeNoticesPath = join(repoRoot, "packages/runtime/THIRD_PARTY_NOTICES");
const runtimePkg = readPkg("packages/runtime") as PackageJson & { files?: unknown };
if (!existsSync(runtimeNoticesPath)) {
  failures.push("@opengeni/runtime bundles third-party code but is missing THIRD_PARTY_NOTICES.");
}
if (!Array.isArray(runtimePkg.files) || !runtimePkg.files.includes("THIRD_PARTY_NOTICES")) {
  failures.push("@opengeni/runtime must publish THIRD_PARTY_NOTICES with its bundled code.");
}
if (existsSync(runtimeDistDir)) {
  for (const builtPath of builtContractFiles(runtimeDistDir).filter((path) =>
    path.endsWith(".js"),
  )) {
    const text = readFileSync(builtPath, "utf8");
    if (externalAgentsRuntimeImportPattern.test(text)) {
      failures.push(
        `${builtPath.slice(repoRoot.length + 1)} externally imports OpenAI Agents or Zod. ` +
          "The runtime must bundle that schema-identity boundary for embedding hosts.",
      );
    }
  }
  if (existsSync(runtimeNoticesPath)) {
    const notices = readFileSync(runtimeNoticesPath, "utf8");
    const bundledPackages = new Map<string, string>();
    for (const sourceMapPath of builtSourceMapFiles(runtimeDistDir)) {
      const sourceMap = JSON.parse(readFileSync(sourceMapPath, "utf8")) as {
        sources?: unknown;
      };
      if (!Array.isArray(sourceMap.sources)) continue;
      for (const source of sourceMap.sources) {
        if (typeof source !== "string") continue;
        const match = source.match(
          /node_modules\/\.bun\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//,
        );
        if (!match) continue;
        const [, storeDirectory, sourcePackageName] = match;
        const manifestPath = join(
          repoRoot,
          "node_modules/.bun",
          storeDirectory!,
          "node_modules",
          sourcePackageName!,
          "package.json",
        );
        if (!existsSync(manifestPath)) {
          failures.push(`Bundled source package manifest is missing: ${manifestPath}`);
          continue;
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          bundledPackages.set(manifest.name, manifest.version);
        }
      }
    }
    for (const [name, version] of [...bundledPackages].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!notices.includes(`${name} ${version}`)) {
        failures.push(
          `@opengeni/runtime bundles ${name} ${version} but THIRD_PARTY_NOTICES omits it.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("\nPublish closure guard FAILED:\n");
  for (const failure of failures) {
    process.stderr.write(`  ✗ ${failure}\n`);
  }
  process.stderr.write(
    "\nThe publishable @opengeni/* closure must not depend on ignored packages, and the client bundle must stay server-free. " +
      "See scripts/publish-closure-guard.ts for the rules.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `Publish closure guard passed: ${publishable.length} package(s) in the npm closure, client bundle is clean, and runtime dependencies are isolated.\n`,
);
