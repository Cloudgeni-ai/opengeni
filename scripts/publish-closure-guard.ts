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
 *       the SDK remains zero-runtime-dep, and React only depends on SDK among
 *       @opengeni/* packages.
 *   (d) the BUILT sdk/react dist bundles reference any server/embed package.
 *
 * Wired into the release gate and safe to run locally without publishing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  };
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

// (a) SDK must be zero-dependency and carry no @opengeni runtime dep.
const sdkPkg = readPkg("packages/sdk");
const sdkRuntimeDeps = Object.keys(sdkPkg.dependencies ?? {});
if (sdkRuntimeDeps.length > 0) {
  failures.push(
    `@opengeni/sdk must have an EMPTY runtime \`dependencies\`, found: ${sdkRuntimeDeps.join(", ")}. ` +
      `The SDK hand-mirrors contract wire types to stay zero-dependency.`,
  );
}
const sdkOpengeniDeps = opengeniRuntimeDeps(sdkPkg);
if (sdkOpengeniDeps.length > 0) {
  failures.push(
    `@opengeni/sdk has forbidden @opengeni/* runtime dependency: ${sdkOpengeniDeps.join(", ")}.`,
  );
}

// (b) React's only @opengeni runtime dependency may be @opengeni/sdk.
const reactPkg = readPkg("packages/react");
const reactOpengeniDeps = opengeniRuntimeDeps(reactPkg);
const reactForbidden = reactOpengeniDeps.filter((name) => name !== "@opengeni/sdk");
if (reactForbidden.length > 0) {
  failures.push(
    `@opengeni/react may only depend on @opengeni/sdk among @opengeni/* packages, found: ${reactForbidden.join(", ")}.`,
  );
}
if (!reactOpengeniDeps.includes("@opengeni/sdk")) {
  failures.push(`@opengeni/react must keep @opengeni/sdk as a runtime dependency.`);
}

// CSS subpath imports must resolve in strict external TypeScript consumers as
// well as bundlers. A bare string export ships runtime CSS but leaves tsgo/tsc
// unable to type a side-effect import unless every consumer adds its own
// wildcard declaration.
const reactExports = (reactPkg as PackageJson & { exports?: Record<string, unknown> }).exports;
for (const subpath of ["./styles.css", "./tokens.css"]) {
  const entry = reactExports?.[subpath];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    failures.push(`@opengeni/react ${subpath} must provide typed conditional exports.`);
    continue;
  }
  const conditions = entry as { types?: unknown; default?: unknown };
  for (const condition of ["types", "default"] as const) {
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

for (const { dir: pkgDir } of publishable) {
  ensureBuilt(pkgDir);
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
  `Publish closure guard passed: ${publishable.length} package(s) in the npm closure, client bundle is clean.\n`,
);
