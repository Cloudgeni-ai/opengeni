#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import type { ImpactPlan } from "./impact";
import { describeTestConcurrencyBudget, testConcurrencyBudget } from "./resource-budget";
import { deterministicShards } from "./workspace";

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
  const selected = deterministicShards(process.cwd(), files, count)[index] ?? [];
  if (args.includes("--list-json")) {
    const ope26SessionPins = "test/e2e/session-pins.browser.e2e.ts";
    process.stdout.write(
      `${JSON.stringify({
        files: selected,
        needsBrowser: selected.some(
          (path) => path === "test/e2e/browser.e2e.ts" || path.endsWith(".browser.e2e.ts"),
        ),
        needsOpe26SessionPins: selected.includes(ope26SessionPins),
      })}\n`,
    );
    return;
  }
  const budget = testConcurrencyBudget();
  process.stdout.write(`[${tier}-shard] ${describeTestConcurrencyBudget(budget)}\n`);
  for (const path of selected) {
    process.stdout.write(`[${tier}-shard] ${path}\n`);
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
        path,
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
    if (status !== 0) process.exit(status);
  }
  process.stdout.write(
    `[${tier}-shard] shard ${index + 1}/${count} passed (${selected.length} files)\n`,
  );
}

await main();
