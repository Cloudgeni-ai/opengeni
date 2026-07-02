#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  publishableWorkspacePackages,
  repoRoot,
  topologicallySortedPackages,
} from "./publishable-workspaces";

const packages = topologicallySortedPackages(publishableWorkspacePackages());

for (const pkg of packages) {
  if (!pkg.packageJson.scripts?.build) {
    throw new Error(`${pkg.name} is publishable but has no build script.`);
  }
}

for (const pkg of packages) {
  process.stdout.write(`[build:packages] ${pkg.name} (${pkg.dir})\n`);
  const result = spawnSync("bun", ["run", "build"], {
    cwd: join(repoRoot, pkg.dir),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
