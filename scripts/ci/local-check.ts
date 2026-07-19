#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createImpactPlan, gitChangedFiles, parseGitNameStatus } from "./impact";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function worktreeChangedFiles(): string[] {
  const changed = new Set(
    parseGitNameStatus(
      execFileSync(
        "git",
        ["diff", "HEAD", "--name-status", "-z", "--find-renames", "--find-copies"],
        { encoding: "utf8" },
      ),
    ),
  );
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const path of untracked) changed.add(path);
  return [...changed].sort();
}

async function run(
  command: string[],
  phase: string,
  profileDirectory: string,
  timeoutSeconds = 900,
): Promise<void> {
  process.stdout.write(`[check:fast] ${command.join(" ")}\n`);
  const child = Bun.spawn(
    [
      "bun",
      "scripts/ci/profile-command.ts",
      "--name",
      `local-${phase}`,
      "--output",
      join(profileDirectory, `${phase}.json`),
      "--timeout-seconds",
      String(timeoutSeconds),
      "--",
      ...command,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let base = "origin/main";
  let forceFull = false;
  let includeServices = false;
  let filesPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base" && args[index + 1]) base = args[++index] as string;
    else if (arg === "--files" && args[index + 1]) filesPath = args[++index] as string;
    else if (arg === "--full") forceFull = true;
    else if (arg === "--services") includeServices = true;
    else {
      throw new Error(
        "usage: bun run check:fast -- [--base <ref>] [--files <newline-file>] [--full] [--services]",
      );
    }
  }

  const head = git(["rev-parse", "HEAD"]);
  let changed: string[] = [];
  if (filesPath) changed = readFileSync(filesPath, "utf8").split("\n").filter(Boolean);
  else if (!forceFull) {
    // Include committed branch changes and current staged/unstaged/untracked work.
    // A rename contributes both old and new boundaries through gitChangedFiles.
    changed = [...new Set([...gitChangedFiles(base, head), ...worktreeChangedFiles()])].sort();
  }
  const plan = createImpactPlan(changed, {
    forceFull,
    base: forceFull ? null : base,
    head,
  });
  const cacheDirectory = join(process.cwd(), ".cache/opengeni");
  mkdirSync(cacheDirectory, { recursive: true });
  const profileDirectory = join(cacheDirectory, "local-profiles");
  rmSync(profileDirectory, { recursive: true, force: true });
  mkdirSync(profileDirectory, { recursive: true });
  const planPath = join(cacheDirectory, "local-impact-plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(
    `[check:fast] mode=${plan.mode} changed=${plan.changedFiles.length} packages=${plan.affectedPackages.join(",") || "none"}\n`,
  );
  for (const reason of plan.reasons) {
    process.stdout.write(`[check:fast] why ${reason.path}: ${reason.reason}\n`);
  }

  await run(
    ["bun", "scripts/ci/run-typecheck-plan.ts", "--plan", planPath],
    "typecheck",
    profileDirectory,
  );
  if (plan.unitTests.length > 0) {
    await run(
      ["bun", "scripts/ci/run-unit-shard.ts", "--plan", planPath, "--shard", "0", "--shards", "1"],
      "unit",
      profileDirectory,
    );
  }
  process.env.OPENGENI_BUILD_CACHE_REPORT = join(profileDirectory, "package-cache.json");
  try {
    await run(
      ["bun", "scripts/ci/run-build-plan.ts", "--plan", planPath],
      "packages",
      profileDirectory,
    );
  } finally {
    delete process.env.OPENGENI_BUILD_CACHE_REPORT;
  }
  if (plan.affectedPackages.includes("@opengeni/react")) {
    await run(
      ["bun", "run", "--cwd", "packages/react", "demo:build"],
      "react-demo",
      profileDirectory,
    );
  }
  if (plan.affectedPackages.includes("opengeni-web")) {
    await run(["bun", "run", "--cwd", "apps/web", "build"], "web", profileDirectory);
  }
  await run(
    ["bun", "scripts/ci/run-guards-plan.ts", "--plan", planPath],
    "guards",
    profileDirectory,
  );

  if (includeServices) {
    for (const tier of ["integration", "e2e"] as const) {
      const selected = tier === "integration" ? plan.integrationTests : plan.e2eTests;
      if (selected.length === 0) continue;
      await run(
        [
          "bun",
          "scripts/ci/run-test-shard.ts",
          "--plan",
          planPath,
          "--tier",
          tier,
          "--shard",
          "0",
          "--shards",
          "1",
        ],
        tier,
        profileDirectory,
        tier === "e2e" ? 3600 : 1800,
      );
    }
  } else if (plan.integrationTests.length > 0 || plan.e2eTests.length > 0) {
    process.stdout.write(
      `[check:fast] deferred required PR service gates: integration=${plan.integrationTests.length} e2e=${plan.e2eTests.length}; pass --services to run them locally\n`,
    );
  }
  process.stdout.write(
    `[check:fast] passed; exact plan: ${planPath}; phase profiles: ${profileDirectory}\n`,
  );
}

await main();
