import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = (name: string) =>
  Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as any;

test("PR CI reserves a bounded PR lane without cancelling main or batch", () => {
  const pr = workflow("pr-ci");
  expect(pr.concurrency).toEqual({
    group: "pr-ci-fanout",
    queue: "max",
    "cancel-in-progress": false,
  });
  expect(pr.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
  expect(pr.on.pull_request.branches).toEqual(["main"]);
  expect(
    pr.jobs.plan.steps.some((s: any) => s.run === "bun scripts/ci/github-pr-ci.ts priority pr"),
  ).toBe(true);
  expect(
    workflow("batch-ci").jobs.plan.steps.some(
      (s: any) => s.run === "bun scripts/ci/github-pr-ci.ts priority batch",
    ),
  ).toBe(true);
  expect(workflow("batch-ci").concurrency["cancel-in-progress"]).toBe(false);
  // plan completes before contracts + the two unit shards; ready joins them.
  expect(Object.keys(pr.jobs).sort()).toEqual(["contracts", "plan", "ready", "units"]);
  expect(pr.jobs.contracts.needs).toBe("plan");
  expect(pr.jobs.units.needs).toBe("plan");
  expect(pr.jobs.units.strategy.matrix.include).toBe(
    "${{ fromJSON(needs.plan.outputs.unit_matrix) }}",
  );
  expect(pr.jobs.plan.steps.find((s: any) => s.id === "plan").run).toContain(
    'unit_matrix=[{"index":0,"total":2},{"index":1,"total":2}]',
  );
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
  expect(jobs.contracts.steps.some((s: any) => s.run === "bun run lint")).toBe(true);
  expect(jobs.ready.name).toBe("PR CI");
  expect(jobs.ready.needs).toEqual(["plan", "contracts", "units"]);
  expect(jobs.ready.if).toBe("${{ always() }}");
  const aggregate = jobs.ready.steps[0].run;
  for (const required of [
    'test "$PLAN" = success',
    'test "$CONTRACTS" = success',
    'test "$UNITS" = success',
    'test "$UNITS" = skipped',
  ])
    expect(aggregate).toContain(required);
  expect(jobs.contracts.if).toBeUndefined();
  const commands = jobs.contracts.steps.map((s: any) => s.run ?? "").join("\n");
  expect(commands).toContain("run-typecheck-plan.ts");
  expect(commands).toContain("run-guards-plan.ts");
  expect(commands).not.toContain("--exclude generated-fonts");
  expect(commands).not.toContain("--exclude lint");
  expect(readFileSync("scripts/ci/impact.ts", "utf8")).toContain('"generated-fonts"');
  for (const name of ["contracts", "units"]) {
    expect(jobs[name]["runs-on"]).toBe("ubuntu-latest");
    const checkout = jobs[name].steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ needs.plan.outputs.head }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
  }
  const units = jobs.units.steps.find((s: any) => s.name === "Test every selected unit file");
  expect(units.env.OPENGENI_REQUIRE_REAL_DB).toBe("1");
  expect(units.run).toContain("batch-setup.ts postgres");
  expect(units.run).toContain("run-unit-shard.ts");
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
