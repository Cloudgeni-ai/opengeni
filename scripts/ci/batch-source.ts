#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keep the batch source contract identical to the native shadow lane. Output
// and service-dependent checks remain mandatory in the full main CI workflow.
// Base-comparison runs pass --continue so every step gets a verdict; --steps
// records per-step comparison evidence and never changes the exit status.
const args = process.argv.slice(2);
const continueOnFailure = args.includes("--continue");
const stepsIndex = args.indexOf("--steps");
const stepsPath = stepsIndex < 0 ? undefined : args[stepsIndex + 1];
const plan = args.find(
  (arg, index) => !arg.startsWith("--") && (stepsIndex < 0 || index !== stepsIndex + 1),
);
const temporary = process.env.RUNNER_TEMP;
const head = process.env.GITHUB_SHA;
if (!plan || !temporary || !head) throw new Error("Expected plan, RUNNER_TEMP and GITHUB_SHA");
type Step = "site-runtime" | "changeset" | "typecheck" | "guards";
const steps: { step: Step; exitCode: number | null }[] = (
  ["site-runtime", "changeset", "typecheck", "guards"] as const
).map((step) => ({ step, exitCode: null }));
let firstFailure = 0;
function record(step: Step, exitCode: number) {
  steps.find((item) => item.step === step)!.exitCode = exitCode;
  if (stepsPath) {
    try {
      writeFileSync(stepsPath, JSON.stringify({ schemaVersion: 1, steps }) + "\n");
    } catch (error) {
      console.error(
        "Source step evidence not recorded:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (exitCode !== 0) {
    if (firstFailure === 0) firstFailure = exitCode;
    if (!continueOnFailure) process.exit(exitCode);
  }
}
async function exec(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exit = await child.exited;
  return exit < 0 ? 127 : exit;
}
record("site-runtime", await exec(["bun", "scripts/generate-site-browser-runtime.ts", "--check"]));
async function changeset(): Promise<number> {
  // Match post-merge main release-plan validation, including Version batches.
  const updated = await exec(["git", "update-ref", "refs/heads/main", head!]);
  if (updated !== 0) return updated;
  const output = join(temporary!, "batch-changeset-status.json");
  const exit = await exec(["bunx", "changeset", "status", "--output", output]);
  if (exit !== 0) return exit;
  const status = JSON.parse(readFileSync(output, "utf8")) as {
    changesets: { releases: unknown[] }[];
    releases: unknown[];
  };
  if (
    status.changesets.some((change) => change.releases.length > 0) &&
    status.releases.length === 0
  ) {
    console.error("Pending changesets cannot produce a Version PR");
    return 1;
  }
  return 0;
}
record("changeset", await changeset());
record("typecheck", await exec(["bun", "scripts/ci/run-typecheck-plan.ts", "--plan", plan]));
record(
  "guards",
  await exec([
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
  ]),
);
if (firstFailure !== 0) process.exit(firstFailure);
