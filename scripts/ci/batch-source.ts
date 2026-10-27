#!/usr/bin/env bun
import { join } from "node:path";

import { checkChangesetPlan, reportChangesetPlanError } from "./changeset-plan";

// Keep the batch source contract identical to the native shadow lane. Output
// and service-dependent checks remain mandatory in the full main CI workflow.
// PR CI runs the same changeset plan and the cheap guards first (pr-ci.yml).
const plan = process.argv[2];
const temporary = process.env.RUNNER_TEMP;
const head = process.env.GITHUB_SHA;
if (!plan || !temporary || !head) throw new Error("Expected plan, RUNNER_TEMP and GITHUB_SHA");
async function run(command: string[]) {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exit = await child.exited;
  if (exit !== 0) process.exit(exit < 0 ? 127 : exit);
}
await run(["bun", "scripts/generate-site-browser-runtime.ts", "--check"]);
// Match post-merge main release-plan validation, including Version batches:
// every pending changeset on the combined tree, not only one PR's additions.
const changesets = await checkChangesetPlan({
  output: join(temporary, "batch-changeset-status.json"),
});
if (changesets) {
  reportChangesetPlanError(changesets);
  process.exit(1);
}
await run(["bun", "scripts/ci/run-typecheck-plan.ts", "--plan", plan]);
await run([
  "bun",
  "scripts/ci/run-guards-plan.ts",
  "--plan",
  plan,
  "--exclude",
  "publish-closure",
  "--exclude",
  "sdk-compat",
  "--exclude",
  "example-builds",
]);
