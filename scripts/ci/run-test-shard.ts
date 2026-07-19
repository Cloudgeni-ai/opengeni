#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ImpactPlan } from "./impact";
import { describeTestConcurrencyBudget, testConcurrencyBudget } from "./resource-budget";
import {
  deterministicShards,
  discoverTestFiles,
  integrationShardWeights,
  type ShardWeightResolution,
} from "./workspace";

type FileExecution = {
  path: string;
  sha256: string;
  status: "pending" | "running" | "success" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  wallMilliseconds: number | null;
  exitCode: number | null;
};

type ShardFileProfile = {
  schemaVersion: 1;
  tier: string;
  shardIndex: number;
  shardCount: number;
  planning: {
    mode: ShardWeightResolution["mode"];
    reason: string;
    profileSha256: string | null;
  };
  files: FileExecution[];
};

function writeProfile(path: string, profile: ShardFileProfile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function explicitBunTestPath(path: string): string {
  // Bun's explicit-file filter requires a relative-path marker for custom
  // `.integration.ts` and `.e2e.ts` suffixes. A bare repository path is
  // interpreted as a test-name/file-pattern filter and exits 1 without running
  // the selected file. Impact plans contain repository-relative paths.
  return path.startsWith("./") ? path : `./${path}`;
}

function environment(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const name of Object.keys(env)) {
    if (name.startsWith("OPENGENI_")) delete env[name];
  }
  env.NODE_ENV = "test";
  env.OPENGENI_TEST_HERMETIC = "1";
  env.OPENGENI_TEST_REQUIRE_DOCKER = "1";
  // Real-service tiers must never silently skip their PostgreSQL/FORCE-RLS
  // assertions when a runner is missing its database boundary.
  env.OPENGENI_REQUIRE_REAL_DB = "1";
  return env;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string => {
    const index = args.indexOf(name);
    const result = index >= 0 ? args[index + 1] : undefined;
    if (!result) throw new Error(`missing ${name}`);
    return result;
  };
  const optionalValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const plan = JSON.parse(readFileSync(value("--plan"), "utf8")) as ImpactPlan;
  const tier = value("--tier");
  const index = Number(value("--shard"));
  const count = Number(value("--shards"));
  if (plan.schemaVersion !== 1 || !["integration", "e2e"].includes(tier)) {
    throw new Error("unsupported impact plan or test tier");
  }
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count) {
    throw new Error("invalid test shard");
  }
  const files = tier === "integration" ? plan.integrationTests : plan.e2eTests;
  const discovered = discoverTestFiles(process.cwd());
  const known = new Set(tier === "integration" ? discovered.integration : discovered.e2e);
  const unknown = files.filter((path) => !known.has(path));
  if (unknown.length > 0)
    throw new Error(`impact plan contains unknown ${tier} tests: ${unknown.join(", ")}`);
  if (new Set(files).size !== files.length)
    throw new Error(`impact plan contains duplicate ${tier} tests`);
  const planning: ShardWeightResolution =
    tier === "integration"
      ? integrationShardWeights(process.cwd())
      : {
          mode: "source-bytes",
          weights: null,
          reason: "E2E tier uses deterministic source-byte weights",
          profileSha256: null,
        };
  const selected =
    deterministicShards(process.cwd(), files, count, planning.weights ?? undefined)[index] ?? [];
  if (args.includes("--list-json")) {
    const ope26SessionPins = "test/e2e/session-pins.browser.e2e.ts";
    const workbench = "test/e2e/workbench.browser.e2e.ts";
    process.stdout.write(
      `${JSON.stringify({
        files: selected,
        needsBrowser: selected.some(
          (path) => path === "test/e2e/browser.e2e.ts" || path.endsWith(".browser.e2e.ts"),
        ),
        needsOpe26SessionPins: selected.includes(ope26SessionPins),
        needsWorkbench: selected.includes(workbench),
        planning: {
          mode: planning.mode,
          reason: planning.reason,
          profileSha256: planning.profileSha256,
        },
      })}\n`,
    );
    return;
  }
  const fileProfilePath = optionalValue("--file-profile");
  const fileProfile: ShardFileProfile = {
    schemaVersion: 1,
    tier,
    shardIndex: index,
    shardCount: count,
    planning: {
      mode: planning.mode,
      reason: planning.reason,
      profileSha256: planning.profileSha256,
    },
    files: selected.map((path) => ({
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      status: "pending",
      startedAt: null,
      completedAt: null,
      wallMilliseconds: null,
      exitCode: null,
    })),
  };
  if (fileProfilePath) writeProfile(fileProfilePath, fileProfile);
  const budget = testConcurrencyBudget();
  process.stdout.write(`[${tier}-shard] ${describeTestConcurrencyBudget(budget)}\n`);
  process.stdout.write(`[${tier}-shard] planning=${planning.mode}: ${planning.reason}\n`);
  for (const [fileIndex, path] of selected.entries()) {
    process.stdout.write(`[${tier}-shard] ${path}\n`);
    const execution = fileProfile.files[fileIndex];
    if (!execution) throw new Error(`missing file profile entry for ${path}`);
    execution.status = "running";
    execution.startedAt = new Date().toISOString();
    const started = performance.now();
    if (fileProfilePath) writeProfile(fileProfilePath, fileProfile);
    const timeout =
      tier === "e2e" || path.includes("selfhosted-auth-callout") ? "360000" : "180000";
    const child = Bun.spawn(
      [
        "bun",
        "test",
        "--no-orphans",
        `--timeout=${timeout}`,
        "--parallel=1",
        "--isolate",
        `--max-concurrency=${budget.concurrency}`,
        explicitBunTestPath(path),
      ],
      {
        cwd: process.cwd(),
        env: environment(),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const status = await child.exited;
    execution.completedAt = new Date().toISOString();
    execution.wallMilliseconds = Math.round((performance.now() - started) * 1000) / 1000;
    execution.exitCode = status;
    execution.status = status === 0 ? "success" : "failed";
    if (fileProfilePath) writeProfile(fileProfilePath, fileProfile);
    if (status !== 0) process.exit(status);
  }
  process.stdout.write(
    `[${tier}-shard] shard ${index + 1}/${count} passed (${selected.length} files)\n`,
  );
}

if (import.meta.main) await main();
