#!/usr/bin/env bun
/**
 * Publish closure guard.
 *
 * The publishable client closure is exactly:
 *   @opengeni/contracts, @opengeni/sdk, @opengeni/react
 *
 * This guard fails loudly (non-zero exit) if that closure is contaminated:
 *
 *   (a) @opengeni/sdk gains ANY @opengeni/* runtime dependency, or a non-empty
 *       `dependencies` map (it must stay zero-dependency — it hand-mirrors the
 *       contracts wire types instead of importing them).
 *   (b) @opengeni/react's runtime `dependencies` reference any @opengeni/*
 *       package other than @opengeni/sdk.
 *   (c) the BUILT sdk/react dist bundles reference any server-internal package
 *       (config, db, runtime, storage, documents, events, github,
 *       observability, deployment, testing) — i.e. a server import leaked into
 *       a published client bundle.
 *
 * Wired into ci.yml and the release gate. If you are reading this because the
 * guard went red: do NOT relax it. Remove the server import or move the type to
 * @opengeni/contracts / hand-mirror it in the SDK.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SERVER_INTERNAL_PACKAGES = [
  "config",
  "db",
  "runtime",
  "storage",
  "documents",
  "events",
  "github",
  "observability",
  "deployment",
  "testing",
] as const;

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const failures: string[] = [];

function readPkg(pkgDir: string): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, pkgDir, "package.json"), "utf8")) as PackageJson;
}

function opengeniRuntimeDeps(pkg: PackageJson): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@opengeni/"));
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
  failures.push(`@opengeni/sdk has forbidden @opengeni/* runtime dependency: ${sdkOpengeniDeps.join(", ")}.`);
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

// (c) Built dist bundles must not reference any server-internal package.
//
// The sdk/react tsup configs externalize all @opengeni/* (see their
// tsup.config.ts), so a leaked `import "@opengeni/<server>"` survives in dist as
// a literal specifier rather than being inlined — which is exactly what this
// grep relies on. The trailing `(?:/|["'\`]|$)` ensures we match the full
// package boundary (e.g. `@opengeni/db` but not a hypothetical
// `@opengeni/dbutils`); the capture group reports just the clean package name.
const serverInternalPattern = new RegExp(
  `@opengeni/(${SERVER_INTERNAL_PACKAGES.join("|")})(?:/|["'\`]|$)`,
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

for (const pkgDir of ["packages/sdk", "packages/react"]) {
  ensureBuilt(pkgDir);
  for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    const path = join(repoRoot, pkgDir, file);
    if (!existsSync(path)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    const match = text.match(serverInternalPattern);
    if (match) {
      const leaked = match[1] ? `@opengeni/${match[1]}` : "<unknown>";
      failures.push(
        `${pkgDir}/${file} references a server-internal package (${leaked}). ` +
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
    "\nThe publishable client closure {@opengeni/contracts, @opengeni/sdk, @opengeni/react} must stay free of " +
      "server-internal packages. See scripts/publish-closure-guard.ts for the rules.\n",
  );
  process.exit(1);
}

process.stdout.write("Publish closure guard passed: client closure is clean.\n");
