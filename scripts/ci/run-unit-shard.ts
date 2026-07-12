#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import type { ImpactPlan } from "./impact";
import { describeTestConcurrencyBudget, testConcurrencyBudget } from "./resource-budget";
import {
  deterministicFileBatches,
  deterministicShards,
  fileUsesProcessGlobalTestState,
} from "./workspace";

function sanitizedTestEnvironment(): Record<string, string> {
  const environment = { ...process.env } as Record<string, string>;
  for (const name of Object.keys(environment)) {
    if (name.startsWith("OPENGENI_")) delete environment[name];
  }
  environment.NODE_ENV = "test";
  environment.OPENGENI_TEST_HERMETIC = "1";
  return environment;
}

async function run(files: string[], isolated: boolean): Promise<number> {
  if (files.length === 0) return 0;
  const budget = testConcurrencyBudget();
  // One file worker per runner prevents Bun's CPU-count default from launching
  // the whole repository at once. A fresh global per file contains mock.module,
  // Happy DOM, fake timers, and process-global teardown. Tests within one file
  // remain bounded as well; individual tests are still serial unless authored
  // with test.concurrent.
  const args = [
    "bun",
    "test",
    "--no-orphans",
    "--timeout=30000",
    "--parallel=1",
    "--isolate",
    `--max-concurrency=${budget.concurrency}`,
    ...files,
  ];
  process.stdout.write(
    `[unit-shard] ${isolated ? "isolated" : "batch"}: ${describeTestConcurrencyBudget(budget)} files=${files.join(", ")}\n`,
  );
  const child = Bun.spawn(args, {
    cwd: process.cwd(),
    env: sanitizedTestEnvironment(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const planIndex = args.indexOf("--plan");
  const shardIndex = args.indexOf("--shard");
  const countIndex = args.indexOf("--shards");
  if (planIndex < 0 || shardIndex < 0 || countIndex < 0) {
    throw new Error("usage: run-unit-shard.ts --plan <json> --shard <index> --shards <count>");
  }
  const planPath = args[planIndex + 1];
  const index = Number(args[shardIndex + 1]);
  const count = Number(args[countIndex + 1]);
  if (
    !planPath ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index < 0 ||
    index >= count
  ) {
    throw new Error("invalid unit shard arguments");
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as ImpactPlan;
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.unitTests)) {
    throw new Error("unsupported or malformed impact plan");
  }
  const selected = deterministicShards(process.cwd(), plan.unitTests, count)[index] ?? [];
  const batch = selected.filter((path) => !fileUsesProcessGlobalTestState(process.cwd(), path));
  const isolated = selected.filter((path) => fileUsesProcessGlobalTestState(process.cwd(), path));
  const configuredBatchSize = Number(process.env.OPENGENI_TEST_FILES_PER_PROCESS ?? "16");
  for (const files of deterministicFileBatches(batch, configuredBatchSize)) {
    const batchStatus = await run(files, false);
    if (batchStatus !== 0) process.exit(batchStatus);
  }
  for (const path of isolated) {
    const status = await run([path], true);
    if (status !== 0) process.exit(status);
  }
  process.stdout.write(
    `[unit-shard] shard ${index + 1}/${count} passed (${selected.length} files)\n`,
  );
}

await main();
