#!/usr/bin/env bun
/**
 * Rewrite the entry-point fields (`main`/`module`/`types`/`exports`) of the
 * PUBLISHABLE packages from their src form to their dist form right before
 * `changeset publish`.
 *
 * WHY THIS EXISTS
 * ---------------
 * For INTERNAL consumption (apps/web, apps/api, apps/worker, sibling packages)
 * the publishable packages MUST point their entry points at `./src/index.ts`.
 * CI typechecks and builds the Docker images straight from source — BEFORE any
 * `dist` exists — so if package.json pointed `@opengeni/sdk` at `./dist/...`,
 * every internal workspace consumer would fail to resolve it (TS2307). Keeping
 * the committed entry points on `src` is the standard monorepo pattern: src for
 * internal resolution, dist only in the published tarball.
 *
 * But the PUBLISHED npm tarball must point at the compiled `./dist/...` outputs
 * — external consumers do not have our TypeScript sources on their resolver
 * path and must load the built JS + .d.ts. So we swap the entry points to the
 * dist form in the ephemeral CI checkout right before publish (after the tsup
 * build has produced dist/), exactly the way rewrite-workspace-deps.ts swaps the
 * `workspace:*` specs to concrete ranges. The edit is never committed.
 *
 * The src->dist mapping per package (mirrors what tsup emits):
 *   main    ./src/index.ts        -> ./dist/index.js
 *   module  ./src/index.ts        -> ./dist/index.js
 *   types   ./src/index.ts        -> ./dist/index.d.ts
 *   exports["."]                   -> { types: ./dist/index.d.ts, import: ./dist/index.js }
 *
 * Any OTHER exports subpaths (e.g. @opengeni/react's "./styles.css" and
 * "./tokens.css", which ship raw CSS straight from styles/) are left untouched.
 *
 * IDEMPOTENT: a package already on the dist form is left unchanged, so running
 * twice is a no-op.
 *
 * CI SAFETY: in CI this runs in the ephemeral checkout right before publish, so
 * the rewritten package.json files are never committed. For local proving, pass
 * `--restore` to put the `src` form back.
 *
 * Usage:
 *   bun scripts/rewrite-entry-points.ts            # src -> dist (pre-publish)
 *   bun scripts/rewrite-entry-points.ts --restore  # dist -> src (local proving)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishableWorkspacePackages, repoRoot, type PackageJson } from "./publishable-workspaces";

type ExportsEntry = { types?: string; import?: string; default?: string } | string;

const restore = process.argv.includes("--restore");

function srcToDist(value: string, kind: "runtime" | "types"): string {
  if (!value.startsWith("./src/")) {
    return value;
  }
  const withoutSourceRoot = value
    .slice("./src/".length)
    .replace(/\.ts$/, kind === "types" ? ".d.ts" : ".js");
  return `./dist/${withoutSourceRoot}`;
}

function distToSrc(value: string): string {
  if (!value.startsWith("./dist/")) {
    return value;
  }
  const withoutDistRoot = value
    .slice("./dist/".length)
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");
  return `./src/${withoutDistRoot}`;
}

function entryToDist(entry: ExportsEntry): ExportsEntry {
  if (typeof entry === "string") {
    return srcToDist(entry, "runtime");
  }
  const next: ExportsEntry = { ...entry };
  const runtimeSource = entry.import ?? entry.default;
  if (entry.types) {
    next.types = srcToDist(entry.types, "types");
  }
  if (runtimeSource) {
    next.import = srcToDist(runtimeSource, "runtime");
    delete next.default;
  }
  return next;
}

function entryToSrc(entry: ExportsEntry): ExportsEntry {
  if (typeof entry === "string") {
    return distToSrc(entry);
  }
  const next: ExportsEntry = { ...entry };
  const runtimeDist = entry.import ?? entry.default;
  if (entry.types) {
    next.types = distToSrc(entry.types);
  }
  if (runtimeDist) {
    next.default = distToSrc(runtimeDist);
    delete next.import;
  }
  return next;
}

/** Entry points in the dist form (published tarball). */
function toDist(pkg: PackageJson): boolean {
  let changed = false;
  if (typeof pkg.main === "string" && pkg.main !== srcToDist(pkg.main, "runtime")) {
    pkg.main = srcToDist(pkg.main, "runtime");
    changed = true;
  }
  if (typeof pkg.module === "string" && pkg.module !== srcToDist(pkg.module, "runtime")) {
    pkg.module = srcToDist(pkg.module, "runtime");
    changed = true;
  }
  if (typeof pkg.types === "string" && pkg.types !== srcToDist(pkg.types, "types")) {
    pkg.types = srcToDist(pkg.types, "types");
    changed = true;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    for (const [subpath, entry] of Object.entries(pkg.exports as Record<string, ExportsEntry>)) {
      const next = entryToDist(entry);
      if (JSON.stringify(entry) !== JSON.stringify(next)) {
        (pkg.exports as Record<string, ExportsEntry>)[subpath] = next;
        changed = true;
      }
    }
  }
  return changed;
}

/** Entry points in the src form (internal workspace resolution; committed tree). */
function toSrc(pkg: PackageJson): boolean {
  let changed = false;
  if (typeof pkg.main === "string" && pkg.main !== distToSrc(pkg.main)) {
    pkg.main = distToSrc(pkg.main);
    changed = true;
  }
  if (typeof pkg.module === "string" && pkg.module !== distToSrc(pkg.module)) {
    pkg.module = distToSrc(pkg.module);
    changed = true;
  }
  if (typeof pkg.types === "string" && pkg.types !== distToSrc(pkg.types)) {
    pkg.types = distToSrc(pkg.types);
    changed = true;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    for (const [subpath, entry] of Object.entries(pkg.exports as Record<string, ExportsEntry>)) {
      const next = entryToSrc(entry);
      if (JSON.stringify(entry) !== JSON.stringify(next)) {
        (pkg.exports as Record<string, ExportsEntry>)[subpath] = next;
        changed = true;
      }
    }
  }
  return changed;
}

let changed = 0;

for (const { dir: pkgDir } of publishableWorkspacePackages()) {
  const pkgPath = join(repoRoot, pkgDir, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as PackageJson;

  const pkgChanged = restore ? toSrc(pkg) : toDist(pkg);

  if (pkgChanged) {
    changed += 1;
    const trailing = raw.endsWith("\n") ? "\n" : "";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}${trailing}`);
    const form = restore ? "src" : "dist";
    process.stdout.write(`  ${pkg.name ?? pkgDir}: entry points -> ${form}\n`);
  }
}

if (restore) {
  process.stdout.write(
    `rewrite-entry-points: restored ${changed} package(s) to src entry points.\n`,
  );
} else if (changed === 0) {
  process.stdout.write(
    "rewrite-entry-points: no packages to rewrite (already dist entry points).\n",
  );
} else {
  process.stdout.write(
    `rewrite-entry-points: rewrote ${changed} package(s) to dist entry points.\n`,
  );
}
