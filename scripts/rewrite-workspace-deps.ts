#!/usr/bin/env bun
/**
 * Rewrite `workspace:` protocol specifiers in the PUBLISHABLE packages to
 * concrete semver ranges right before `changeset publish`.
 *
 * WHY THIS EXISTS
 * ---------------
 * In a bun-managed workspace there is no npm package-lock, so `changeset
 * publish` falls back to the plain `npm publish` tool. Unlike `bun publish` or
 * `pnpm publish`, that path does NOT strip the `workspace:` protocol: it copies
 * the dependency spec verbatim into the published tarball's package.json. The
 * result is e.g. `@opengeni/react` shipping `"@opengeni/sdk": "workspace:*"`,
 * which npm clients cannot resolve → the package is uninstallable.
 *
 * We keep using npm (not bun) for publish because bun cannot emit npm
 * provenance. So we have to do the rewrite ourselves: replace each
 * `workspace:*` / `workspace:^x` / `workspace:~x` / `workspace:1.2.3` in the
 * publishable packages' published dependency maps (dependencies,
 * peerDependencies, optionalDependencies) with a concrete range resolved from
 * the depended workspace package's CURRENT version.
 *
 * Translation rules (matching pnpm/bun behavior):
 *   workspace:*        -> ^<version>   (caret, the common case)
 *   workspace:^        -> ^<version>
 *   workspace:~        -> ~<version>
 *   workspace:^1.2.3   -> ^1.2.3       (explicit range kept as-is, prefix stripped)
 *   workspace:~1.2.3   -> ~1.2.3
 *   workspace:1.2.3    -> 1.2.3        (exact pin)
 *
 * The depended version is read from the live workspace package.json, so this
 * MUST run AFTER `changeset version` has bumped versions (in CI) for the ranges
 * to point at the about-to-be-published versions.
 *
 * IDEMPOTENT: a spec with no `workspace:` prefix is left untouched, so running
 * twice is a no-op.
 *
 * CI SAFETY: in CI this runs in the ephemeral checkout right before publish, so
 * the rewritten package.json files are never committed. For local proving, pass
 * `--restore` to put the `workspace:*` form back (it reverts every @opengeni/*
 * published dep in the publishable packages to `workspace:*`).
 *
 * Usage:
 *   bun scripts/rewrite-workspace-deps.ts            # rewrite -> concrete
 *   bun scripts/rewrite-workspace-deps.ts --restore  # concrete -> workspace:*
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLISHED_DEP_FIELDS,
  publishableWorkspacePackages,
  repoRoot,
  workspacePackageByName,
  workspaceVersionMap,
  type PackageJson,
} from "./publishable-workspaces";

const restore = process.argv.includes("--restore");
const versions = workspaceVersionMap();
const workspaceNames = workspacePackageByName();

/**
 * Translate a single `workspace:` spec to a concrete range using pnpm/bun rules.
 * Returns the original string unchanged if it is not a workspace spec.
 */
function resolveWorkspaceSpec(depName: string, spec: string, versions: Map<string, string>): string {
  if (!spec.startsWith("workspace:")) {
    return spec;
  }
  const rest = spec.slice("workspace:".length);
  const version = versions.get(depName);
  if (!version) {
    throw new Error(
      `Cannot rewrite "${depName}": "${spec}" — no workspace package named "${depName}" with a version was found.`,
    );
  }
  if (rest === "*" || rest === "^") {
    return `^${version}`;
  }
  if (rest === "~") {
    return `~${version}`;
  }
  // workspace:^1.2.3 / workspace:~1.2.3 / workspace:1.2.3 — the range after the
  // protocol is already an explicit semver range; keep it verbatim.
  return rest;
}

let changed = 0;

for (const { dir: pkgDir } of publishableWorkspacePackages()) {
  const pkgPath = join(repoRoot, pkgDir, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as PackageJson;
  let pkgChanged = false;

  for (const field of PUBLISHED_DEP_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) {
      continue;
    }
    for (const [depName, spec] of Object.entries(deps)) {
      if (restore) {
        // Put the workspace protocol back on @opengeni/* deps (local proving).
        if (workspaceNames.has(depName) && depName.startsWith("@opengeni/") && !spec.startsWith("workspace:")) {
          deps[depName] = "workspace:*";
          pkgChanged = true;
          changed += 1;
        }
        continue;
      }
      const next = resolveWorkspaceSpec(depName, spec, versions);
      if (next !== spec) {
        deps[depName] = next;
        pkgChanged = true;
        changed += 1;
        process.stdout.write(`  ${pkg.name ?? pkgDir}: ${field}.${depName} ${spec} -> ${next}\n`);
      }
    }
  }

  if (pkgChanged) {
    // Preserve trailing newline if the file had one.
    const trailing = raw.endsWith("\n") ? "\n" : "";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}${trailing}`);
  }
}

if (restore) {
  process.stdout.write(`rewrite-workspace-deps: restored ${changed} @opengeni/* dep(s) to workspace:*.\n`);
} else if (changed === 0) {
  process.stdout.write("rewrite-workspace-deps: no workspace: specs found in publishable packages (already concrete).\n");
} else {
  process.stdout.write(`rewrite-workspace-deps: rewrote ${changed} workspace: spec(s) to concrete ranges.\n`);
}
