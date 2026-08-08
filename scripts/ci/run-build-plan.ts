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
// Current main's canonical package builder already owns a crash-safe,
// content-addressed cache. Run that exact builder when any publishable output is
// selected rather than introducing a second cache or a release-incompatible
// partial-build protocol.
const child = Bun.spawn(["bun", "scripts/build-publishable-packages.ts"], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
