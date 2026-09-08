#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  publishableWorkspacePackages,
  repoRoot,
  topologicallySortedPackages,
  type WorkspacePackage,
} from "./publishable-workspaces";

export function nextCanaryVersion(baseVersion: string, lastCanary: string | null): string {
  const base = baseVersion.replace(/-canary\.\d+$/, "");
  const prefix = `${base}-canary.`;
  if (lastCanary && lastCanary.startsWith(prefix)) {
    const n = Number(lastCanary.slice(prefix.length));
    if (Number.isInteger(n) && n >= 0) return `${prefix}${n + 1}`;
  }
  return `${prefix}0`;
}

export function planCanaryVersions(
  packages: readonly { name: string; version: string }[],
  tags: ReadonlyMap<string, string | null>,
  fixedGroups: readonly (readonly string[])[],
): Map<string, string> {
  const versions = new Map(
    packages.map((pkg) => [pkg.name, nextCanaryVersion(pkg.version, tags.get(pkg.name) ?? null)]),
  );
  for (const group of fixedGroups) {
    if (group.length === 0) continue;
    const planned = group.map((name) => {
      const version = versions.get(name);
      if (!version) throw new Error(`Fixed canary package is not publishable: ${name}`);
      return version;
    });
    const base = planned[0]!.replace(/-canary\.\d+$/, "");
    if (planned.some((version) => !version.startsWith(`${base}-canary.`))) {
      throw new Error(
        `Fixed canary packages must share a committed base version: ${group.join(", ")}`,
      );
    }
    const next = Math.max(
      ...planned.map((version) => Number(version.slice(`${base}-canary.`.length))),
    );
    for (const name of group) versions.set(name, `${base}-canary.${next}`);
  }
  return versions;
}

function npmCanaryTag(name: string): string | null {
  const result = spawnSync("npm", ["view", name, "dist-tags.canary", "--silent"], {
    encoding: "utf8",
  });
  const text = (result.stdout ?? "").trim();
  if (result.status !== 0 || text.length === 0 || text === "undefined") return null;
  return text;
}

function writeVersion(pkg: WorkspacePackage, version: string): void {
  const json = JSON.parse(readFileSync(pkg.packagePath, "utf8")) as Record<string, unknown>;
  json.version = version;
  writeFileSync(pkg.packagePath, `${JSON.stringify(json, null, 2)}\n`);
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

export function main(): void {
  if (!process.env.NODE_AUTH_TOKEN) {
    throw new Error("NODE_AUTH_TOKEN is required to publish canary packages");
  }
  const packages = topologicallySortedPackages(publishableWorkspacePackages());
  const config = JSON.parse(readFileSync(join(repoRoot, ".changeset/config.json"), "utf8")) as {
    fixed?: string[][];
  };
  const versions = planCanaryVersions(
    packages,
    new Map(packages.map((pkg) => [pkg.name, npmCanaryTag(pkg.name)])),
    config.fixed ?? [],
  );
  for (const pkg of packages) {
    const next = versions.get(pkg.name)!;
    writeVersion(pkg, next);
    process.stdout.write(`${pkg.name}@${next}\n`);
  }
  run("bun", ["run", "build:packages"]);
  run("bun", ["scripts/publish-closure-guard.ts"]);
  run("bun", ["scripts/rewrite-workspace-deps.ts", "--strip-dev-dependencies"]);
  run("bun", ["scripts/rewrite-entry-points.ts"]);
  for (const pkg of packages) {
    run("npm", ["publish", "--tag", "canary", "--access", "public"], pkg.dir);
  }
  mkdirSync(".release", { recursive: true });
  writeFileSync(
    ".release/site-package-versions.json",
    JSON.stringify(
      Object.fromEntries(
        packages
          .filter((pkg) =>
            ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"].includes(
              pkg.name,
            ),
          )
          .map((pkg) => [pkg.name, JSON.parse(readFileSync(pkg.packagePath, "utf8")).version]),
      ),
      null,
      2,
    ),
  );
}

if (import.meta.main) main();
