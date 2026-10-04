#!/usr/bin/env bun
/**
 * Operator script, run ONCE after the 1.0.0 lockstep release is published.
 *
 * For every published @opengeni package it:
 *   1. checks that 1.0.0 is on npm and that `latest` points at the lockstep
 *      version committed in this checkout (repairs it with `npm dist-tag add`);
 *   2. deprecates every version published BEFORE 1.0.0 (the whole retired
 *      per-package line, including its 1.x-7.x stables and canaries). 1.0.0
 *      and every later lockstep version are never touched.
 *
 * Dry run by default; pass --execute to change the registry. Needs an npm login
 * (or NODE_AUTH_TOKEN) with publish rights on the @opengeni scope.
 *
 *   bun scripts/release/deprecate-pre-1.0.ts            # print the plan
 *   bun scripts/release/deprecate-pre-1.0.ts --execute  # apply it
 */
import { spawnSync } from "node:child_process";
import { publishableWorkspacePackages } from "../publishable-workspaces";
import { LOCKSTEP_RESET_VERSION, sharedLockstepVersion } from "./lockstep-version";

export const DEPRECATION_MESSAGE = "Pre-1.0 line retired; use @opengeni/*@^1.0.0";
const VERSIONS_PER_COMMAND = 100;

type Packument = {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { deprecated?: string }>;
  time?: Record<string, string>;
};

/** Versions published before the lockstep reset that are not yet deprecated with our message. */
export function retiredVersions(packument: Packument): string[] {
  const resetAt = packument.time?.[LOCKSTEP_RESET_VERSION];
  if (!resetAt) throw new Error(`${LOCKSTEP_RESET_VERSION} is not published`);
  const cutoff = Date.parse(resetAt);
  return Object.entries(packument.versions ?? {})
    .filter(([version, manifest]) => {
      const publishedAt = packument.time?.[version];
      if (!publishedAt) throw new Error(`registry time is missing for ${version}`);
      return Date.parse(publishedAt) < cutoff && manifest.deprecated !== DEPRECATION_MESSAGE;
    })
    .map(([version]) => version)
    .sort(Bun.semver.order);
}

/** Exact-version ranges, chunked so each `npm deprecate` stays a modest request. */
export function deprecationRanges(versions: readonly string[]): string[] {
  const ranges: string[] = [];
  for (let index = 0; index < versions.length; index += VERSIONS_PER_COMMAND) {
    ranges.push(versions.slice(index, index + VERSIONS_PER_COMMAND).join(" || "));
  }
  return ranges;
}

async function fetchPackument(name: string): Promise<Packument> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${name}: registry returned HTTP ${response.status}`);
  return (await response.json()) as Packument;
}

function npm(args: string[], execute: boolean): void {
  const printable = ["bun", "x", "npm", ...args]
    .map((arg) => (/^[\w@./:=-]+$/.test(arg) ? arg : JSON.stringify(arg)))
    .join(" ");
  process.stdout.write(`${execute ? "+" : "(dry run)"} ${printable}\n`);
  if (!execute) return;
  const result = spawnSync("bun", ["x", "npm", ...args], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed for ${args[1]}`);
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const packages = publishableWorkspacePackages();
  const lockstep = sharedLockstepVersion(packages);
  if (Bun.semver.order(lockstep, LOCKSTEP_RESET_VERSION) < 0) {
    throw new Error(`checkout lockstep version ${lockstep} predates ${LOCKSTEP_RESET_VERSION}`);
  }
  for (const pkg of packages) {
    const remote = await fetchPackument(pkg.name);
    if (!remote.versions?.[lockstep]) {
      throw new Error(`${pkg.name}@${lockstep} is not published yet; publish before retiring`);
    }
    if (remote["dist-tags"]?.latest !== lockstep) {
      npm(["dist-tag", "add", `${pkg.name}@${lockstep}`, "latest"], execute);
    }
    const versions = retiredVersions(remote);
    for (const range of deprecationRanges(versions)) {
      npm(["deprecate", `${pkg.name}@${range}`, DEPRECATION_MESSAGE], execute);
    }
    process.stdout.write(`${pkg.name}: ${versions.length} retired versions to deprecate\n`);
  }
  if (!execute) process.stdout.write("Dry run only. Re-run with --execute to apply.\n");
}

if (import.meta.main) await main();
