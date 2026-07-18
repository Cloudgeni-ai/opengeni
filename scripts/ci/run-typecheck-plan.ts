#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import type { ImpactPlan } from "./impact";

const planIndex = process.argv.indexOf("--plan");
const planPath = planIndex >= 0 ? process.argv[planIndex + 1] : undefined;
if (!planPath) throw new Error("usage: run-typecheck-plan.ts --plan <json>");
const plan = JSON.parse(readFileSync(planPath, "utf8")) as ImpactPlan;
if (plan.schemaVersion !== 1 || !Array.isArray(plan.typecheckProjects)) {
  throw new Error("unsupported or malformed impact plan");
}
if (plan.typecheckProjects.length === 0) {
  process.stdout.write("[typecheck] no impacted projects\n");
  process.exit(0);
}
const args = plan.typecheckProjects.flatMap((project) => ["--project", project]);
const child = Bun.spawn(["bun", "scripts/typecheck.ts", ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
