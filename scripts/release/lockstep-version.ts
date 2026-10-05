#!/usr/bin/env bun
/**
 * Lockstep version guard for the published @opengeni/* packages.
 *
 * Every published package shares ONE version (one Changesets `fixed` group).
 * The shared line restarted at 1.0.0, but the pre-reset line had already
 * published a few stable 1.x versions for some packages. npm never allows a
 * version to be published twice, so the whole lockstep group must skip any
 * version that one member already burned.
 *
 * `changeset version` computes the next version; this guard then moves the
 * whole group to the first version at or above it that no package has taken
 * (keeping the same major/minor and advancing the patch). It also rewrites the
 * CHANGELOG heading Changesets just wrote. The retired set is static because
 * the registry history is closed: every later release is computed above the
 * current lockstep version, so only these pre-reset versions can collide. The
 * guard is therefore deterministic and offline, which keeps the Version PR
 * tree reproducible in CI.
 *
 * Usage (part of `bun run changeset:version`):
 *   bun scripts/release/lockstep-version.ts           # apply
 *   bun scripts/release/lockstep-version.ts --check   # fail on drift/collision
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { publishableWorkspacePackages, repoRoot } from "../publishable-workspaces";

/** First version of the shared lockstep line. */
export const LOCKSTEP_RESET_VERSION = "1.0.0";

/**
 * Stable versions >= 1.0.0 published by the retired per-package line. Pre-reset
 * prereleases (`1.0.0-canary.0`, ...) are not listed: stable releases never
 * collide with them and canary sequences start far above them.
 */
export const RETIRED_PRE_RESET_VERSIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "@opengeni/config": ["1.0.4", "1.1.1", "1.2.2"],
    "@opengeni/contracts": ["1.0.1"],
    "@opengeni/core": ["1.0.1"],
    "@opengeni/db": ["1.0.1"],
    "@opengeni/react": ["1.0.1"],
    "@opengeni/runtime": ["1.0.1", "1.4.2"],
    "@opengeni/sdk": ["1.0.1"],
    "@opengeni/worker-bundle": ["1.0.1"],
  });

const stableVersion = /^(\d+)\.(\d+)\.(\d+)$/;

export function retiredVersionSet(
  names: Iterable<string>,
  retired: Readonly<Record<string, readonly string[]>> = RETIRED_PRE_RESET_VERSIONS,
): Set<string> {
  const taken = new Set<string>();
  for (const name of names) for (const version of retired[name] ?? []) taken.add(version);
  return taken;
}

function bumpPatch(version: string): string {
  const match = stableVersion.exec(version);
  if (!match) throw new Error(`lockstep version must be exact stable semver: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** First version >= `version` (same major.minor, advancing patch) not in `taken`. */
export function nextFreeLockstepVersion(version: string, taken: ReadonlySet<string>): string {
  if (!stableVersion.test(version)) {
    throw new Error(`lockstep version must be exact stable semver: ${version}`);
  }
  let candidate = version;
  while (taken.has(candidate)) candidate = bumpPatch(candidate);
  return candidate;
}

/** Base for `<base>-canary.N`: the next free patch after the committed version. */
export function lockstepCanaryBase(version: string, taken: ReadonlySet<string>): string {
  return nextFreeLockstepVersion(bumpPatch(version.replace(/-canary\.\d+$/, "")), taken);
}

export function sharedLockstepVersion(
  packages: readonly { name: string; version: string }[],
): string {
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (packages.length === 0 || versions.size !== 1) {
    throw new Error(
      `published @opengeni packages must share one lockstep version; found ${packages
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}. Keep every published package in the single Changesets fixed group.`,
    );
  }
  return [...versions][0]!;
}

/** Rewrite the top-level `version` field in place, preserving formatting. */
export function setManifestVersion(raw: string, from: string, to: string): string {
  const field = `\n  "version": ${JSON.stringify(from)}`;
  const index = raw.indexOf(field);
  const next = raw[index + field.length];
  if (index < 0 || (next !== "," && next !== "\n")) {
    throw new Error(`manifest does not declare version ${from}`);
  }
  return `${raw.slice(0, index)}\n  "version": ${JSON.stringify(to)}${raw.slice(index + field.length)}`;
}

/** Replace only the first `## <from>` heading Changesets wrote for this release. */
export function retitleChangelog(text: string, from: string, to: string): string {
  const heading = `\n## ${from}\n`;
  const index = text.indexOf(heading);
  if (index < 0) return text;
  return `${text.slice(0, index)}\n## ${to}\n${text.slice(index + heading.length)}`;
}

function main(): void {
  const check = process.argv.includes("--check");
  const packages = publishableWorkspacePackages();
  const current = sharedLockstepVersion(packages);
  const next = nextFreeLockstepVersion(current, retiredVersionSet(packages.map((pkg) => pkg.name)));
  if (next === current) {
    process.stdout.write(`lockstep-version: ${packages.length} packages at ${current}\n`);
    return;
  }
  if (check) {
    throw new Error(
      `lockstep version ${current} was already published by a retired pre-reset release; run \`bun scripts/release/lockstep-version.ts\` (it moves the group to ${next})`,
    );
  }
  for (const pkg of packages) {
    writeFileSync(
      pkg.packagePath,
      setManifestVersion(readFileSync(pkg.packagePath, "utf8"), current, next),
    );
    const changelog = join(repoRoot, pkg.dir, "CHANGELOG.md");
    if (existsSync(changelog)) {
      writeFileSync(changelog, retitleChangelog(readFileSync(changelog, "utf8"), current, next));
    }
  }
  process.stdout.write(
    `lockstep-version: ${current} is a retired pre-reset version; moved ${packages.length} packages to ${next}\n`,
  );
}

if (import.meta.main) main();
