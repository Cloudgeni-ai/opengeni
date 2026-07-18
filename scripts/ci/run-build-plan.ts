#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import type { ImpactPlan } from "./impact";

const planIndex = process.argv.indexOf("--plan");
const planPath = planIndex >= 0 ? process.argv[planIndex + 1] : undefined;
if (!planPath) throw new Error("usage: run-build-plan.ts --plan <json>");
const plan = JSON.parse(readFileSync(planPath, "utf8")) as ImpactPlan;
if (plan.schemaVersion !== 1 || !Array.isArray(plan.buildPackages)) {
  throw new Error("unsupported or malformed impact plan");
}
if (plan.buildPackages.length === 0) {
  process.stdout.write("[build:packages] no impacted publishable packages\n");
  process.exit(0);
}
const args = plan.buildPackages.flatMap((name) => ["--package", name]);
const child = Bun.spawn(["bun", "scripts/build-publishable-packages.ts", ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
