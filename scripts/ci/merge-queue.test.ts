import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as any;
const queue = workflow("merge-queue");
const ci = workflow("ci");

test("queue checks cover PR entry and the exact combined merge group", () => {
  expect(queue.on.pull_request.branches).toEqual(["main"]);
  expect(queue.on.merge_group.types).toEqual(["checks_requested"]);
  expect(queue.permissions).toEqual({ contents: "read" });
  expect(queue.concurrency.group).toContain("github.ref");
  const plan = queue.jobs.plan.steps.find((step: any) => step.id === "plan");
  expect(plan.env.BASE_SHA).toContain("github.event.merge_group.base_sha");
  expect(plan.run).toContain('--head "$GITHUB_SHA"');
  expect(queue.jobs.units.strategy.matrix.shard).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(
    queue.jobs.units.steps.find((step: any) => step.env?.OPENGENI_REQUIRE_REAL_DB).env
      .OPENGENI_REQUIRE_REAL_DB,
  ).toBe("1");
  expect(queue.jobs.ready.name).toBe("Queue ready");
  expect(queue.jobs.ready.if).toBe("${{ always() }}");
  expect(queue.jobs.ready.needs).toEqual(["plan", "contracts", "units"]);
  const gate = queue.jobs.ready.steps[0].run;
  expect(gate).toContain('test "$PLAN" = success');
  expect(gate).toContain('test "$CONTRACTS" = success');
  expect(gate).toContain('else test "$UNITS" = success');
});

test("main full CI cannot be cancelled by a new push and publishes only full exact-SHA success", () => {
  expect(ci.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request' }}",
  );
  expect(ci.concurrency.group).toContain("ci-main-push");
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
  expect(ci.jobs["full-green"].if).toContain("success()");
  expect(ci.jobs["full-green"].if).toContain("needs.plan.outputs.mode == 'full'");
  expect(ci.jobs["full-green"].if).toContain("github.ref == 'refs/heads/main'");
  expect(ci.jobs["full-green"].permissions).toEqual({ contents: "read", statuses: "write" });
  expect(workflow("merge-content").concurrency).toBeUndefined();
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
    max_entries_to_merge: 8,
    merge_method: "MERGE",
    min_entries_to_merge: 1,
    min_entries_to_merge_wait_minutes: 5,
  });
  expect(ruleset.rules[1].parameters.required_status_checks).toEqual([
    { context: "Queue ready", integration_id: 15368 },
  ]);
});
