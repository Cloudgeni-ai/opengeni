import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as any;
const queue = workflow("merge-queue");
const ci = workflow("ci");

type JobResult = "success" | "failure" | "cancelled" | "skipped";
type RunScenario = {
  event: string;
  ref: string;
  workflowCancelled: boolean;
  mode: string;
  results: Record<string, JobResult>;
};

/** Transitive `needs` ancestry of one job in the parsed workflow. */
function ancestry(jobs: Record<string, any>, job: string): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string) => {
    const needs = jobs[name]?.needs ?? [];
    for (const need of Array.isArray(needs) ? needs : [needs]) {
      if (!jobs[need]) throw new Error(`${name} needs unknown job ${need}`);
      if (!seen.has(need)) {
        seen.add(need);
        visit(need);
      }
    }
  };
  visit(job);
  return seen;
}

/** Top-level `&&` atoms of a job condition; anything outside the modelled grammar throws. */
function conditionAtoms(condition: string): string[] {
  const body = /^\$\{\{ (.+) \}\}$/su.exec(condition)?.[1];
  if (!body) throw new Error(`Condition is not one expression: ${condition}`);
  const unmodelled = body.replace(/!?\b(?:success|always|cancelled|failure)\(\)/gu, "");
  if (/\|\||[()]/u.test(unmodelled)) throw new Error(`Unmodelled condition grammar: ${condition}`);
  return body.split("&&").map((atom) => atom.trim());
}

/**
 * Models GitHub's documented job-condition semantics for the atoms used here:
 * without an explicit status function GitHub prepends success(), and success()
 * requires every transitive ancestor to have succeeded, so a skipped ancestor
 * skips the job. Unknown atoms or contexts fail the test instead of passing.
 */
function jobRuns(jobs: Record<string, any>, job: string, condition: string, run: RunScenario) {
  const atoms = conditionAtoms(condition);
  const statusAtoms = atoms.filter((atom) =>
    /^!?(?:success|always|cancelled|failure)\(\)$/u.test(atom),
  );
  const effective = statusAtoms.length ? atoms : ["success()", ...atoms];
  const value = (path: string) => {
    if (path === "github.event_name") return run.event;
    if (path === "github.ref") return run.ref;
    if (path === "needs.plan.outputs.mode") return run.mode;
    const result = /^needs\.([\w-]+)\.result$/u.exec(path)?.[1];
    if (
      result &&
      (Array.isArray(jobs[job].needs) ? jobs[job].needs : [jobs[job].needs]).includes(result)
    )
      return run.results[result];
    throw new Error(`Unmodelled context ${path}`);
  };
  return effective.every((atom) => {
    if (atom === "!cancelled()") return !run.workflowCancelled;
    if (atom === "always()") return true;
    if (atom === "success()")
      return (
        !run.workflowCancelled &&
        [...ancestry(jobs, job)].every((name) => run.results[name] === "success")
      );
    const comparison = /^([\w.-]+) == '([^']*)'$/u.exec(atom);
    if (!comparison) throw new Error(`Unmodelled condition atom ${atom}`);
    return value(comparison[1]!) === comparison[2];
  });
}

test("queue checks cover PR entry and the exact combined merge group", () => {
  expect(queue.on.pull_request.branches).toEqual(["main"]);
  expect(queue.on.merge_group.types).toEqual(["checks_requested"]);
  expect(queue.permissions).toEqual({ contents: "read" });
  expect(queue.concurrency.group).toContain("github.ref");
  const plan = queue.jobs.plan.steps.find((step: any) => step.id === "plan");
  expect(plan.env.BASE_SHA).toContain("github.event.merge_group.base_sha");
  expect(plan.run).toContain('--head "$GITHUB_SHA"');
  expect(queue.jobs.units.strategy.matrix.include).toBe(
    "${{ fromJSON(needs.plan.outputs.unit_matrix) }}",
  );
  expect(plan.run).toContain(". / 240");
  expect(plan.run).toContain(". > 16 then 16");
  expect(
    queue.jobs.units.steps.find((step: any) => step.env?.OPENGENI_REQUIRE_REAL_DB).run,
  ).toContain("--shards ${{ matrix.total }}");
  expect(
    queue.jobs.units.steps.find((step: any) => step.env?.OPENGENI_REQUIRE_REAL_DB).env
      .OPENGENI_REQUIRE_REAL_DB,
  ).toBe("1");
  expect(queue.jobs.ready.name).toBe(
    "${{ github.event_name == 'merge_group' && 'Queue ready' || 'Queue shadow result' }}",
  );
  expect(queue.jobs.ready.if).toContain("always()");
  expect(queue.jobs.ready.if).toContain("github.event_name != 'pull_request'");
  expect(queue.jobs.ready.needs).toEqual(["plan", "contracts", "units"]);
  const gate = queue.jobs.ready.steps[0].run;
  expect(gate).toContain('test "$PLAN" = success');
  expect(gate).toContain('test "$CONTRACTS" = success');
  expect(gate).toContain('else test "$UNITS" = success');
});

test("cheap PR entry never masquerades as combined-tree CI or duplicates the heavy suite", () => {
  expect(queue.jobs.entry.if).toBe(
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.ref != 'changeset-release/main' }}",
  );
  expect(queue.jobs.entry.name).toContain(
    "github.event.pull_request.head.ref != 'changeset-release/main'",
  );
  expect(queue.jobs.entry.name).toContain("'PR entry (not applicable)'");
  expect(queue.jobs.entry.steps[0].run).toContain("not test or review evidence");
  expect(queue.jobs.plan.if).toContain("github.event_name != 'pull_request'");
  expect(queue.jobs.plan.if).toContain("queue-shadow");
  expect(queue.jobs.plan.steps.some((step: any) => step.run?.includes("bun install"))).toBe(false);
});

test("ordinary PR events cannot starve reconciliation or publish public alerts", () => {
  const health = workflow("queue-health");
  expect(health.on.workflow_run.workflows).toContain("Batch CI");
  expect(health.jobs.report.if).toContain(
    "github.event.workflow_run.path == '.github/workflows/batch-ci.yml'",
  );
  expect(health.concurrency).toBeUndefined();
  expect(health.jobs.report.if).toContain("github.event.workflow_run.event == 'merge_group'");
  expect(health.jobs.report.if).toContain(
    "github.event.workflow_run.path == '.github/workflows/ci.yml'",
  );
  expect(health.jobs.report.concurrency.group).toContain("'event' || 'reconcile'");
  const run = health.jobs.report.steps.find((step: any) => step.env?.QUEUE_HEALTH_ALERTS);
  expect(run.env.QUEUE_HEALTH_ALERTS).toContain("vars.QUEUE_HEALTH_ALERTS == 'true'");
  expect(run.env.QUEUE_HEALTH_ALERTS).toContain("github.event_name != 'workflow_run'");
});

test("main full CI cannot be cancelled by a new push and publishes only full exact-SHA success", () => {
  expect(ci.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request' }}",
  );
  expect(ci.concurrency.group).toContain("ci-main-push");
  expect(ci.concurrency.group).toContain("github.event_name == 'push' && github.ref");
  expect(ci.concurrency.group).toContain("changeset-release/main");
  expect(ci.concurrency.group).not.toContain("queue-");
  const plan = ci.jobs.plan.steps.find((step: any) => step.id === "plan").run;
  expect(plan).toContain(
    '{ [ "$EVENT_NAME" = "push" ] && [ "$GITHUB_REF" = "refs/heads/main" ]; }',
  );
  expect(ci.jobs["full-green"].needs).toEqual([
    "plan",
    "test",
    "deployment",
    "images",
    "merge-content",
  ]);
  expect(ci.jobs["full-green"].permissions).toEqual({ contents: "read", statuses: "write" });
  expect(workflow("merge-content").concurrency).toBeUndefined();
  expect(ci.jobs["merge-content"].steps.at(-1).run).toContain("--since-full-green");
  expect(ci.jobs["full-green"].steps[0].run).toContain("/attempts/$GITHUB_RUN_ATTEMPT");
});

test("full-green publishes only for a non-cancelled full main push whose direct needs all succeeded", () => {
  const job = ci.jobs["full-green"];
  const needs: string[] = job.needs;
  const atoms = conditionAtoms(job.if);
  expect(atoms).toContain("!cancelled()");
  expect(atoms).not.toContain("success()");
  expect(atoms).not.toContain("always()");
  for (const need of needs) expect(atoms).toContain(`needs.${need}.result == 'success'`);
  for (const predicate of [
    "github.event_name == 'push'",
    "github.ref == 'refs/heads/main'",
    "needs.plan.outputs.mode == 'full'",
  ])
    expect(atoms).toContain(predicate);

  // A full main push: every ancestor succeeds except the dispatch-only
  // Version admission job, which is always skipped on push.
  const ancestors = ancestry(ci.jobs, "full-green");
  expect(ancestors.has("automation-admission")).toBe(true);
  expect(ci.jobs["automation-admission"].if).toBe(
    "${{ github.event_name == 'workflow_dispatch' }}",
  );
  const results = Object.fromEntries([...ancestors].map((name) => [name, "success"])) as Record<
    string,
    JobResult
  >;
  results["automation-admission"] = "skipped";
  const green: RunScenario = {
    event: "push",
    ref: "refs/heads/main",
    workflowCancelled: false,
    mode: "full",
    results,
  };
  const runs = (patch: Partial<RunScenario>) =>
    jobRuns(ci.jobs, "full-green", job.if, { ...green, ...patch });

  expect(runs({})).toBe(true);
  // The former gate never published from a push because of that skipped ancestor.
  const former =
    "${{ success() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.plan.outputs.mode == 'full' }}";
  expect(jobRuns(ci.jobs, "full-green", former, green)).toBe(false);
  expect(
    jobRuns(ci.jobs, "full-green", former, {
      ...green,
      results: { ...results, "automation-admission": "success" },
    }),
  ).toBe(true);

  for (const need of needs)
    for (const result of ["failure", "cancelled", "skipped"] as const)
      expect([need, result, runs({ results: { ...results, [need]: result } })]).toEqual([
        need,
        result,
        false,
      ]);
  expect(runs({ workflowCancelled: true })).toBe(false);
  for (const event of ["pull_request", "workflow_dispatch", "schedule", "merge_group"])
    expect([event, runs({ event })]).toEqual([event, false]);
  for (const ref of [
    "refs/heads/production",
    "refs/heads/changeset-release/main",
    "refs/heads/queue/x",
  ])
    expect([ref, runs({ ref })]).toEqual([ref, false]);
  for (const mode of ["impact", "docs", ""]) expect([mode, runs({ mode })]).toEqual([mode, false]);
});

test("queue source retains committed runtime and outstanding release-plan contracts", () => {
  const commands = queue.jobs.contracts.steps.map((step: any) => step.run ?? "").join("\n");
  expect(commands).toContain("generate-site-browser-runtime.ts --check");
  expect(commands).toContain("bunx changeset status");
  expect(commands).toContain('git update-ref refs/heads/main "$GITHUB_SHA"');
});

test("bot-created PRs get queue entry evidence only after authenticated full CI", () => {
  const report = ci.jobs["automation-report"];
  const step = report.steps.find(
    (candidate: any) => candidate.name === "Report queue entry check for the admitted Version PR",
  );
  expect(step.if).toContain("success() && needs.automation-admission.result == 'success'");
  for (const job of ["test", "deployment", "images"])
    expect(step.env.CONCLUSION).toContain(`needs.${job}.result == 'success'`);
  expect(step.env.HEAD_SHA).toBe("${{ inputs.automation_head_sha }}");
  expect(step.run).toContain("-f name='Queue ready'");
});

test("prepared ruleset is inert, main-only, uses MERGE and requires every successful queue entry", () => {
  const ruleset = JSON.parse(readFileSync(".github/main-merge-queue.ruleset.json", "utf8"));
  expect(ruleset.enforcement).toBe("disabled");
  expect(ruleset.conditions.ref_name.include).toEqual(["refs/heads/main"]);
  expect(ruleset.bypass_actors).toEqual([]);
  expect(ruleset.rules[0].parameters).toEqual({
    check_response_timeout_minutes: 45,
    grouping_strategy: "ALLGREEN",
    max_entries_to_build: 8,
    max_entries_to_merge: 1,
    merge_method: "MERGE",
    min_entries_to_merge: 1,
    min_entries_to_merge_wait_minutes: 5,
  });
  expect(ruleset.rules[1].parameters.required_status_checks).toEqual([
    { context: "Queue ready", integration_id: 15368 },
  ]);
});

test("Mergify option is a non-discovered draft with true batches and isolated Version handling", () => {
  const draft = Bun.YAML.parse(readFileSync("docs/queue-options/.mergify.yml", "utf8")) as any;
  expect(draft.merge_queue.max_parallel_checks).toBe(2);
  expect(draft.defaults.queue_rule.merge_method).toBe("merge");
  expect(draft.defaults.queue_rule.max_checks_retries).toBe(1);
  expect(draft.defaults.queue_rule.batch_max_failure_resolution_attempts).toBeNull();
  expect(draft.defaults.queue_rule.merge_conditions).toEqual(["check-success=Queue batch ready"]);
  expect(draft.queue_rules[0].batch_size).toBe(1);
  expect(draft.queue_rules[1].batch_size).toEqual({ min: 1, max: 16 });
  expect(draft.pull_request_rules).toBeUndefined();
});
