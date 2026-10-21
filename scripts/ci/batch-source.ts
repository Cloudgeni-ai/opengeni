#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Keep the batch source contract identical to the native shadow lane. Output
// and service-dependent checks remain mandatory in the full main CI workflow.
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
// Match post-merge main release-plan validation, including Version batches.
await run(["git", "update-ref", "refs/heads/main", head]);
const output = join(temporary, "batch-changeset-status.json");
await run(["bunx", "changeset", "status", "--output", output]);
const status = JSON.parse(readFileSync(output, "utf8")) as {
  changesets: { releases: unknown[] }[];
  releases: unknown[];
};
if (
  status.changesets.some((change) => change.releases.length > 0) &&
  status.releases.length === 0
) {
  console.error("Pending changesets cannot produce a Version PR");
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
