#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import {
  publishableWorkspacePackages,
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
  for (const pkg of packages) {
    const next = nextCanaryVersion(pkg.version, npmCanaryTag(pkg.name));
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
}

if (import.meta.main) main();
