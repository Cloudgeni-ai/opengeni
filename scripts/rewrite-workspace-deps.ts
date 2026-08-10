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
 * the depended workspace package's CURRENT version. The release path also
 * passes `--strip-dev-dependencies` so published package.json files do not
 * advertise dev-only private/workspace dependencies.
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
 * twice is a no-op. This script intentionally has no `--restore`: the concrete
 * range does not retain enough information to recover the exact original
 * workspace protocol, and guessing would corrupt intentional concrete peers.
 *
 * CI SAFETY: run this only in the ephemeral release checkout. Local validation
 * uses the exported pure transformer and packed-consumer tests, never mutation
 * plus a lossy reverse transform.
 *
 * Usage:
 *   bun scripts/rewrite-workspace-deps.ts            # rewrite -> concrete
 *   bun scripts/rewrite-workspace-deps.ts --strip-dev-dependencies
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLISHED_DEP_FIELDS,
  publishableWorkspacePackages,
  repoRoot,
  workspaceVersionMap,
  type PackageJson,
} from "./publishable-workspaces";

/**
 * Translate a single `workspace:` spec to a concrete range using pnpm/bun rules.
 * Returns the original string unchanged if it is not a workspace spec.
 */
export function resolveWorkspaceSpec(
  depName: string,
  spec: string,
  versionByPackage: Map<string, string>,
): string {
  if (!spec.startsWith("workspace:")) {
    return spec;
  }
  const rest = spec.slice("workspace:".length);
  const version = versionByPackage.get(depName);
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

export type WorkspaceDependencyRewrite = Readonly<{
  field: (typeof PUBLISHED_DEP_FIELDS)[number];
  dependency: string;
  before: string;
  after: string;
}>;

export function rewriteWorkspaceDependenciesToConcrete(
  pkg: PackageJson,
  versions: Map<string, string>,
): WorkspaceDependencyRewrite[] {
  const rewrites: WorkspaceDependencyRewrite[] = [];
  for (const field of PUBLISHED_DEP_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [depName, spec] of Object.entries(deps)) {
      const next = resolveWorkspaceSpec(depName, spec, versions);
      if (next !== spec) {
        deps[depName] = next;
        rewrites.push({ field, dependency: depName, before: spec, after: next });
      }
    }
  }
  return rewrites;
}

if (import.meta.main) {
  if (process.argv.includes("--restore")) {
    throw new Error(
      "--restore was removed because concrete ranges cannot faithfully recover their original workspace specs; validate in a disposable checkout instead.",
    );
  }
  const stripDevDependencies = process.argv.includes("--strip-dev-dependencies");
  const versions = workspaceVersionMap();
  let changed = 0;

  for (const { dir: pkgDir } of publishableWorkspacePackages()) {
    const pkgPath = join(repoRoot, pkgDir, "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as PackageJson;
    const rewrites = rewriteWorkspaceDependenciesToConcrete(pkg, versions);
    let pkgChanged = rewrites.length > 0;
    changed += rewrites.length;
    for (const rewrite of rewrites) {
      process.stdout.write(
        `  ${pkg.name ?? pkgDir}: ${rewrite.field}.${rewrite.dependency} ${rewrite.before} -> ${rewrite.after}\n`,
      );
    }

    if (stripDevDependencies && pkg.devDependencies) {
      delete pkg.devDependencies;
      pkgChanged = true;
      changed += 1;
      process.stdout.write(
        `  ${pkg.name ?? pkgDir}: removed devDependencies from publish manifest\n`,
      );
    }

    if (pkgChanged) {
      const trailing = raw.endsWith("\n") ? "\n" : "";
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}${trailing}`);
    }
  }

  if (changed === 0) {
    process.stdout.write(
      "rewrite-workspace-deps: no workspace: specs found in publishable packages (already concrete).\n",
    );
  } else {
    process.stdout.write(
      `rewrite-workspace-deps: applied ${changed} publish manifest rewrite(s).\n`,
    );
  }
}
