#!/usr/bin/env bun
/**
 * Publish the committed lockstep versions as `latest`. Unlike the full
 * release pipeline this only builds and publishes the npm packages; a version
 * that is already on npm is skipped, so a rerun finishes a partial publish.
 */
import { spawnSync } from "node:child_process";

import {
  publishableWorkspacePackages,
  topologicallySortedPackages,
} from "./publishable-workspaces";
import { sharedLockstepVersion } from "./release/lockstep-version";

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function published(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--silent"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

export function main(): void {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error("NODE_AUTH_TOKEN is required");
  const packages = topologicallySortedPackages(publishableWorkspacePackages());
  const version = sharedLockstepVersion(packages);
  process.stdout.write(`Publishing ${packages.length} packages at ${version} as latest\n`);
  run("bun", ["run", "build:packages"]);
  run("bun", ["scripts/publish-closure-guard.ts"]);
  run("bun", ["scripts/rewrite-workspace-deps.ts", "--strip-dev-dependencies"]);
  run("bun", ["scripts/rewrite-entry-points.ts"]);
  for (const pkg of packages) {
    if (published(pkg.name, pkg.version)) {
      process.stdout.write(`${pkg.name}@${pkg.version} already published; tagging latest\n`);
      run("npm", ["dist-tag", "add", `${pkg.name}@${pkg.version}`, "latest"]);
      continue;
    }
    run("npm", ["publish", "--tag", "latest", "--access", "public"], pkg.dir);
  }
}

if (import.meta.main) main();
