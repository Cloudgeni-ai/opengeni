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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The packages that actually get published to npm. Their entry points must point
// at dist in the published tarball, but at src in the committed (internal) tree.
const PUBLISHABLE_PACKAGE_DIRS = ["packages/contracts", "packages/sdk", "packages/react"] as const;

const SRC_MAIN = "./src/index.ts";
const DIST_MAIN = "./dist/index.js";
const DIST_TYPES = "./dist/index.d.ts";

type ExportsEntry = { types?: string; import?: string; default?: string } | string;
type PackageJson = Record<string, unknown> & {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, ExportsEntry>;
};

const restore = process.argv.includes("--restore");

/** Entry points in the dist form (published tarball). */
function toDist(pkg: PackageJson): boolean {
  let changed = false;
  if (pkg.main !== DIST_MAIN) {
    pkg.main = DIST_MAIN;
    changed = true;
  }
  if (pkg.module !== DIST_MAIN) {
    pkg.module = DIST_MAIN;
    changed = true;
  }
  if (pkg.types !== DIST_TYPES) {
    pkg.types = DIST_TYPES;
    changed = true;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    const dot = pkg.exports["."];
    const next = { types: DIST_TYPES, import: DIST_MAIN };
    if (JSON.stringify(dot) !== JSON.stringify(next)) {
      pkg.exports["."] = next;
      changed = true;
    }
  }
  return changed;
}

/** Entry points in the src form (internal workspace resolution; committed tree). */
function toSrc(pkg: PackageJson): boolean {
  let changed = false;
  if (pkg.main !== SRC_MAIN) {
    pkg.main = SRC_MAIN;
    changed = true;
  }
  if (pkg.module !== SRC_MAIN) {
    pkg.module = SRC_MAIN;
    changed = true;
  }
  if (pkg.types !== SRC_MAIN) {
    pkg.types = SRC_MAIN;
    changed = true;
  }
  if (pkg.exports && typeof pkg.exports === "object") {
    const dot = pkg.exports["."];
    const next = { types: SRC_MAIN, default: SRC_MAIN };
    if (JSON.stringify(dot) !== JSON.stringify(next)) {
      pkg.exports["."] = next;
      changed = true;
    }
  }
  return changed;
}

let changed = 0;

for (const pkgDir of PUBLISHABLE_PACKAGE_DIRS) {
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
  process.stdout.write(`rewrite-entry-points: restored ${changed} package(s) to src entry points.\n`);
} else if (changed === 0) {
  process.stdout.write("rewrite-entry-points: no packages to rewrite (already dist entry points).\n");
} else {
  process.stdout.write(`rewrite-entry-points: rewrote ${changed} package(s) to dist entry points.\n`);
}
