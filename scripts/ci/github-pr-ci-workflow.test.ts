import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as any;

test("PR-only capped selection precedes unit count; selected failures still fail aggregate", () => {
  const { jobs } = workflow("pr-ci");
  const plan = jobs.plan.steps.find((step: any) => step.id === "plan").run as string;
  expect(plan).toContain(
    'pr-fast-plan.ts --plan "$RUNNER_TEMP/pr-impact.json" --output "$RUNNER_TEMP/pr-plan.json"',
  );
  expect(plan.indexOf("pr-fast-plan.ts")).toBeLessThan(plan.indexOf("unit_count="));
  const units = jobs.fast.steps.find((step: any) => step.name === "Test every selected unit file");
  expect(units.if).toBe(
    "${{ needs.plan.outputs.docs_only != 'true' && needs.plan.outputs.unit_count != '0' }}",
  );
  expect(units["continue-on-error"]).toBeUndefined();
  expect(units.run).toContain("set -euo pipefail");
  expect(jobs.ready.steps[0].run).toContain('test "$FAST" = success');
  expect(JSON.stringify(workflow("batch-ci"))).not.toContain("pr-fast-plan.ts");
});

test("PR CI reserves a bounded PR lane without cancelling main or batch", () => {
  const pr = workflow("pr-ci");
  expect(pr.concurrency.queue).toBeUndefined();
  expect(pr.concurrency["cancel-in-progress"]).toBe(true);
  expect(pr.concurrency.group).toBe(
    "pr-ci-${{ github.event.pull_request.number || inputs.pr_number }}",
  );
  expect(pr.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
  expect(pr.on.pull_request.branches).toEqual(["main"]);
  expect(
    pr.jobs.plan.steps.some((s: any) => /github-pr-ci.ts (priority|admit-fast)/.test(s.run ?? "")),
  ).toBe(false);
  expect(
    workflow("batch-ci").jobs.plan.steps.some(
      (s: any) => s.run === "bun scripts/ci/github-pr-ci.ts priority batch",
    ),
  ).toBe(false);
  expect(workflow("batch-ci").concurrency["cancel-in-progress"]).toBe(false);
  expect(Object.keys(pr.jobs).sort()).toEqual(["fast", "plan", "ready"]);
  expect(pr.jobs.fast.needs).toBe("plan");
  expect(pr.jobs.fast["timeout-minutes"]).toBe(15);
  expect(pr.jobs.fast.strategy).toBeUndefined();
  expect(pr.jobs.plan.concurrency).toBeUndefined();
  expect(pr.jobs.fast.concurrency).toBeUndefined();
});

test("actual concurrency expression isolates PRs and matches dispatch", () => {
  const group = String(workflow("pr-ci").concurrency.group);
  const expression = group.slice(group.indexOf("${{") + 3, group.lastIndexOf("}}"));
  // Evaluate this authored expression's restricted function subset, not a
  // second implementation of the bucket algorithm. actionlint checks GHA syntax.
  const evaluate = new Function("github", "inputs", `return (${expression});`);
  const bucket = (number: number, dispatch: boolean) =>
    evaluate(
      { event: { pull_request: { number: dispatch ? undefined : number } } },
      { pr_number: dispatch ? String(number) : undefined },
    );
  const buckets = new Set<string>();
  for (let number = 1; number <= 1000; number++) {
    const actual = String(bucket(number, false));
    expect(actual).toBe(String(number));
    expect(String(bucket(number, true))).toBe(actual);
    buckets.add(actual);
  }
  expect(buckets.size).toBe(1000);
  expect(workflow("pr-ci").jobs.fast.strategy).toBeUndefined();
});

test("Queue ready entry and labeling do not wait for PR CI", () => {
  const queue = workflow("merge-queue");
  expect(queue.on.pull_request.types).toContain("labeled");
  const entry = Object.values(queue.jobs).find((j: any) =>
    String(j.name).includes("Queue ready"),
  ) as any;
  expect(entry).toBeDefined();
  expect(entry.needs).toBeUndefined();
  expect(entry.steps.map((s: any) => s.run ?? "").join("\n")).toContain("exact-head PR CI");
});

test("required aggregate covers docs and every selected job at exact head", () => {
  const { jobs } = workflow("pr-ci");
  expect(jobs.fast.steps.some((s: any) => s.run === "bun run lint")).toBe(true);
  expect(jobs.ready.name).toBe("PR CI");
  expect(jobs.ready.needs).toEqual(["plan", "fast"]);
  expect(jobs.ready.if).toBe("${{ always() }}");
  const aggregate = jobs.ready.steps[0].run;
  for (const required of ['test "$PLAN" = success', 'test "$FAST" = success'])
    expect(aggregate).toContain(required);
  expect(jobs.fast.if).toBeUndefined();
  const commands = jobs.fast.steps.map((s: any) => s.run ?? "").join("\n");
  expect(commands).toContain("run-typecheck-plan.ts");
  expect(commands).not.toContain("--exclude generated-fonts");
  expect(readFileSync("scripts/ci/impact.ts", "utf8")).toContain('"generated-fonts"');
  for (const name of ["fast"]) {
    expect(jobs[name]["runs-on"]).toBe("ubuntu-latest");
    const checkout = jobs[name].steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ needs.plan.outputs.head }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
  }
  const units = jobs.fast.steps.find((s: any) => s.name === "Test every selected unit file");
  expect(units.if).toBe(
    "${{ needs.plan.outputs.docs_only != 'true' && needs.plan.outputs.unit_count != '0' }}",
  );
  expect(units.env.OPENGENI_REQUIRE_REAL_DB).toBe("1");
  expect(units.run).toContain("batch-setup.ts postgres");
  expect(units.run).toContain("run-unit-shard.ts");
});

test("PR fast checks run Batch's cheap source contracts before they can cost a batch", () => {
  const { steps } = workflow("pr-ci").jobs.fast;
  const index = (text: string) => steps.findIndex((s: any) => (s.run ?? "").includes(text));
  const changesets = steps[index("scripts/ci/changeset-plan.ts")];
  expect(changesets.run).toContain("set -euo pipefail");
  expect(changesets.run).toContain("bun scripts/generate-site-browser-runtime.ts --check");
  expect(changesets.run).toContain(
    "bun scripts/workflow-execution-graph.ts --git-tree 'HEAD^{tree}'",
  );
  expect(changesets.if).toBeUndefined();
  expect(changesets["continue-on-error"]).toBeUndefined();
  // Cheapest checks first; every one runs before the selected unit files.
  expect(index("bun install --frozen-lockfile")).toBeLessThan(index("changeset-plan.ts"));
  expect(index("changeset-plan.ts")).toBeLessThan(index("bun run lint"));
  expect(index("run-guards-plan.ts")).toBeLessThan(index("run-unit-shard.ts"));
  // The same shared verdict is Batch's source contract, not a second copy.
  const batch = readFileSync("scripts/ci/batch-source.ts", "utf8");
  expect(batch).toContain('from "./changeset-plan"');
  expect(batch).toContain('"scripts/generate-site-browser-runtime.ts", "--check"');

  // Guards: exactly Batch's deferrals plus lint (its own step above), so every
  // guard that can fail Batch source contracts fails the PR first.
  const guards = steps[index("run-guards-plan.ts")];
  expect(guards.if).toBeUndefined();
  expect(guards.run).toContain('--plan "$RUNNER_TEMP/pr-plan/pr-plan.json"');
  expect(guards.run).toContain("--scope-scans-to-changes");
  expect(batch).not.toContain("--scope-scans-to-changes");
  const excluded = (text: string) =>
    [...text.matchAll(/--exclude"?,?\s*"?([a-z-]+)/g)].map((m) => m[1]);
  const batchExcluded = excluded(batch.slice(batch.indexOf("run-guards-plan.ts")));
  expect(batchExcluded.sort()).toEqual(["example-builds", "publish-closure", "sdk-compat"]);
  expect(excluded(guards.run).sort()).toEqual([...batchExcluded, "lint"].sort());
});

test("PR fast checks build Batch's production web bundle whenever the plan selects it", () => {
  const { jobs } = workflow("pr-ci");
  const plan = jobs.plan.steps.find((step: any) => step.id === "plan").run as string;
  expect(plan.indexOf("pr-fast-plan.ts")).toBeLessThan(plan.indexOf("web_bundle="));
  expect(plan).toContain(`jq '.prWebBundle == true' "$RUNNER_TEMP/pr-plan.json"`);
  expect(jobs.plan.outputs.web_bundle).toBe("${{ steps.plan.outputs.web_bundle }}");
  const steps = jobs.fast.steps as any[];
  const pr = steps.find((step) => step.name === "Production web bundle");
  expect(pr.if).toBe("${{ needs.plan.outputs.web_bundle == 'true' }}");
  expect(pr["continue-on-error"]).toBeUndefined();
  expect(steps.indexOf(pr)).toBeLessThan(
    steps.findIndex((step) => step.name === "Test every selected unit file"),
  );
  const batch = Object.values(workflow("batch-ci").jobs as Record<string, any>)
    .flatMap((job) => job.steps ?? [])
    .find((step: any) => step.name === "Production web bundle");
  // Same command and environment as Batch, minus its receipt wrapper.
  expect(batch.env).toEqual(pr.env);
  expect(batch.run.endsWith(` -- ${pr.run}`)).toBe(true);
});

test("write-capable supersession handler executes trusted base only on a new PR push", () => {
  const handler = workflow("pr-ci-superseded");
  expect(handler.on.pull_request_target.types).toEqual(["synchronize"]);
  const job = Object.values(handler.jobs)[0] as any;
  const checkout = job.steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
  expect(checkout.with.ref).toBe("${{ github.event.pull_request.base.sha }}");
  expect(job.steps.some((s: any) => s.run === "bun scripts/ci/github-pr-ci.ts superseded")).toBe(
    true,
  );
});

test("Version release explicitly queues hosted exact-head CI after trusted validation dispatch", () => {
  const release = workflow("release");
  const steps = Object.values(release.jobs).flatMap((j: any) => j.steps ?? []) as any[];
  const dispatch = steps.findIndex((s) => s.id === "version_ci");
  const queue = steps.findIndex((s) => s.run === "bun scripts/ci/github-pr-ci.ts queue-version");
  expect(dispatch).toBeGreaterThanOrEqual(0);
  expect(queue).toBeGreaterThan(dispatch);
  expect(steps[queue].env.VERSION_HEAD_SHA).toContain(
    "steps.version_ci.outputs.automation_head_sha",
  );
  expect(workflow("ci")["run-name"]).toContain("Version PR {0} head {1}");
});
