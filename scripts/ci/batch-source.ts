#!/usr/bin/env bun
import { join } from "node:path";
import { diagnoseStep, writeDiagnostic } from "./batch-diagnostic";

import { checkChangesetPlan, reportChangesetPlanError } from "./changeset-plan";

// Keep the batch source contract identical to the native shadow lane. Output
// and service-dependent checks remain mandatory in the full main CI workflow.
// PR CI runs the same changeset plan and the cheap guards first (pr-ci.yml).
const plan = process.argv[2];
const temporary = process.env.RUNNER_TEMP;
const head = process.env.GITHUB_SHA;
if (!plan || !temporary || !head) throw new Error("Expected plan, RUNNER_TEMP and GITHUB_SHA");
const TAIL_BYTES = 256 * 1024;
// Stream output unchanged and keep a bounded tail; a failed check records the
// files its output names so the batcher can attribute deterministic failures.
async function run(check: string | null, command: string[]) {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-TAIL_BYTES);
    }
  };
  await Promise.all([pump(child.stdout, process.stdout), pump(child.stderr, process.stderr)]);
  const exit = await child.exited;
  if (exit === 0) return;
  if (check && exit > 0 && exit < 128) writeDiagnostic(diagnoseStep(check, tail, process.cwd()));
  process.exit(exit < 0 ? 127 : exit);
}
await run("site-runtime", ["bun", "scripts/generate-site-browser-runtime.ts", "--check"]);
// Match post-merge main release-plan validation, including Version batches:
// every pending changeset on the combined tree, not only one PR's additions.
const changesets = await checkChangesetPlan({
  output: join(temporary, "batch-changeset-status.json"),
});
if (changesets) {
  reportChangesetPlanError(changesets);
  // The planner error names the changeset ("Found changeset X"), mapped to its file.
  writeDiagnostic(diagnoseStep("changesets", changesets, process.cwd()));
  process.exit(1);
}
await run("typecheck", ["bun", "scripts/ci/run-typecheck-plan.ts", "--plan", plan]);
await run("guards", [
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
