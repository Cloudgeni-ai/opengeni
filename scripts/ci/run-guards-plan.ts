#!/usr/bin/env bun
import { lstatSync, readFileSync } from "node:fs";

import type { ImpactPlan } from "./impact";

const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  lint: ["bun", "run", "lint"],
  format: ["bun", "run", "format:check"],
  "workspace-billing": ["bun", "scripts/check-workspace-billing-static.ts"],
  "docs-refs": ["bun", "scripts/check-docs-refs.ts"],
  "publish-closure": ["bun", "scripts/publish-closure-guard.ts"],
};

function exampleBuildCommands(projects: readonly string[]): string[][] {
  return projects.map((project) => {
    if (!/^examples\/[^/]+$/.test(project)) {
      throw new Error(`invalid example build project: ${project}`);
    }
    if (!lstatSync(project).isDirectory()) {
      throw new Error(`example build project is not a directory: ${project}`);
    }
    return ["bun", "run", "--cwd", project, "build"];
  });
}

async function runCommand(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}

async function main(): Promise<void> {
  const planIndex = process.argv.indexOf("--plan");
  const planPath = planIndex >= 0 ? process.argv[planIndex + 1] : undefined;
  const excluded = new Set<string>();
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--exclude" && process.argv[index + 1]) {
      excluded.add(process.argv[++index] as string);
    }
  }
  if (!planPath) {
    throw new Error("usage: run-guards-plan.ts --plan <json> [--exclude <guard>]...");
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as ImpactPlan;
  if (
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.guards) ||
    !Array.isArray(plan.exampleBuildProjects)
  ) {
    throw new Error("unsupported or malformed impact plan");
  }
  for (const guard of plan.guards) {
    if (excluded.has(guard)) {
      process.stdout.write(`[guard] ${guard} deferred to its output-producing job\n`);
      continue;
    }
    if (guard === "example-builds") {
      for (const command of exampleBuildCommands(plan.exampleBuildProjects)) {
        process.stdout.write(`[guard] example build: ${command[3]}\n`);
        await runCommand(command);
      }
      continue;
    }
    let command = COMMANDS[guard];
    if (!command) throw new Error(`unknown impact-plan guard: ${guard}`);
    if (
      guard === "publish-closure" &&
      plan.buildPackages.some((name) => name === "@opengeni/sdk" || name === "@opengeni/react")
    ) {
      command = [...command, "--require-client-dist"];
    }
    process.stdout.write(`[guard] ${guard}\n`);
    await runCommand(command);
  }
  process.stdout.write(`[guard] passed: ${plan.guards.join(", ") || "none"}\n`);
}

await main();
