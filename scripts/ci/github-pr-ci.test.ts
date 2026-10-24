import { test, expect } from "bun:test";
import {
  docsOnly,
  mainReleaseApprovalOnly,
  priorityHold,
  supersededPrRuns,
  supersededVersionValidationRuns,
} from "./github-pr-ci";
const run = (id: number, path: string, event = "push", head_branch = "main") => ({
  id,
  path,
  event,
  head_branch,
  head_sha: "a".repeat(40),
  status: "in_progress",
  run_attempt: 1,
  pull_requests: [{ number: 42 }],
});
test("executable admin and non-document files under docs never skip source checks", () => {
  for (const path of [
    "docs/merge-batcher-admin/off.ts",
    "docs/merge-batcher-admin/README.md",
    "docs/a.sh",
    "docs/config.json",
  ])
    expect(docsOnly([path])).toBe(false);
  expect(docsOnly(["docs/guide.md", "README.md"])).toBe(true);
});
test("cancellation selects only older heads of the exact PR CI workflow", () => {
  const runs = [
    run(1, ".github/workflows/pr-ci.yml", "pull_request", "feature"),
    run(2, ".github/workflows/ci.yml"),
    run(3, ".github/workflows/batch-ci.yml", "push", "queue/live/x"),
    {
      ...run(4, ".github/workflows/pr-ci.yml", "pull_request", "feature"),
      pull_requests: [{ number: 43 }],
    },
    {
      ...run(5, ".github/workflows/pr-ci.yml", "pull_request", "feature"),
      head_sha: "b".repeat(40),
    },
  ];
  expect(supersededPrRuns(runs, 42, "b".repeat(40), "feature")).toEqual([1]);
});
test("Version dispatch supersession cannot select main or batch runs", () => {
  expect(
    supersededPrRuns(
      [
        run(1, ".github/workflows/pr-ci.yml", "workflow_dispatch", "changeset-release/main"),
        run(2, ".github/workflows/ci.yml", "workflow_dispatch", "main"),
        run(3, ".github/workflows/pr-ci.yml", "workflow_dispatch", "other"),
      ],
      42,
      "b".repeat(40),
      "changeset-release/main",
    ),
  ).toEqual([1]);
});
test("main outranks batch and PR; batch outranks PR but not another batch", () => {
  const main = { run: run(1, ".github/workflows/ci.yml"), jobs: [] };
  const batch = {
    run: run(2, ".github/workflows/batch-ci.yml", "push", "queue/live/x"),
    jobs: [{ name: "unit", status: "queued", conclusion: null }],
  };
  expect(priorityHold("batch", [main], 3)).toContain("main");
  expect(priorityHold("pr", [main], 3)).toContain("main");
  expect(priorityHold("pr", [batch], 3)).toContain("batch");
  expect(priorityHold("batch", [batch], 3)).toBeNull();
});
test("pre-fanout and unknown job states hold; proven approval waits do not", () => {
  const r = run(1, ".github/workflows/ci.yml");
  for (const status of ["queued", "in_progress", "pending", "requested", "mystery"])
    expect(
      priorityHold("pr", [{ run: r, jobs: [{ name: "job", status, conclusion: null }] }], 2),
    ).not.toBeNull();
  expect(
    priorityHold(
      "pr",
      [
        {
          run: r,
          jobs: [
            { name: "test", status: "completed", conclusion: "success" },
            { name: "deploy", status: "waiting", conclusion: null },
          ],
        },
      ],
      2,
    ),
  ).toBeNull();
  expect(priorityHold("pr", [{ run: r, jobs: [] }], 1)).toBeNull();
});
test("main public-release approval tail with pending descendants is zero demand", () => {
  const main = { ...run(1, ".github/workflows/ci.yml"), status: "waiting" };
  const tail = [
    { id: 10, name: "test", status: "completed", conclusion: "success" },
    { id: 11, name: "Build API workload image", status: "waiting", conclusion: null },
    { id: 12, name: "Deploy staging", status: "pending", conclusion: null },
  ];
  const job = (patch: Record<string, unknown>, index = 1) =>
    tail.map((j, i) => (i === index ? { ...j, ...patch } : j));
  expect(mainReleaseApprovalOnly(main, tail)).toBe(true);
  for (const lane of ["pr", "batch"] as const)
    expect(priorityHold(lane, [{ run: main, jobs: tail }], 99)).toBeNull();
  for (const jobs of [
    [],
    job({ name: "Deploy production" }),
    job({ status: "queued" }, 2),
    job({ status: "in_progress" }, 0),
    job({ status: "requested" }, 2),
    job({ status: "mystery" }, 2),
    job({ id: 10 }, 2),
    job({ id: 0 }, 2),
    job({ id: undefined }, 0),
    [...tail, { id: 13, name: "Build API workload image", status: "waiting", conclusion: null }],
  ]) {
    expect(mainReleaseApprovalOnly(main, jobs)).toBe(false);
    expect(priorityHold("pr", [{ run: main, jobs }], 99)).toContain("main run 1");
  }
  // Run status must itself be waiting; listed demand is never re-read as idle.
  expect(mainReleaseApprovalOnly({ ...main, status: "in_progress" }, tail)).toBe(false);
  // The release-tail proof applies only to main push CI: Batch handling is unchanged.
  const batch = {
    ...run(2, ".github/workflows/batch-ci.yml", "push", "queue/live/x"),
    status: "waiting",
  };
  expect(priorityHold("pr", [{ run: batch, jobs: tail }], 99)).toContain("batch run 2");
  expect(
    priorityHold("pr", [{ run: batch, jobs: tail.filter((j) => j.status !== "pending") }], 99),
  ).toBeNull();
});
test("docs-only filters never hide code/workflow/renamed source", () => {
  expect(docsOnly(["README.md", "docs/guide.md"])).toBe(true);
  for (const paths of [
    [],
    ["docs/x.md", "src/x.ts"],
    [".github/workflows/pr-ci.yml"],
    ["packages/x/README.md"],
    ["docs/x.md", "old.ts"],
  ])
    expect(docsOnly(paths)).toBe(false);
});
test("legacy full Version validation cancellation is exact-title bound, never main push", () => {
  const old = {
    ...run(10, ".github/workflows/ci.yml", "workflow_dispatch", "main"),
    display_title: `Version PR 42 head ${"a".repeat(40)}`,
  };
  expect(
    supersededVersionValidationRuns(
      [
        old,
        { ...old, id: 11, event: "push" },
        { ...old, id: 12, display_title: `Version PR 43 head ${"a".repeat(40)}` },
        { ...old, id: 13, display_title: `Version PR 42 head ${"b".repeat(40)}` },
        { ...old, id: 14, path: ".github/workflows/batch-ci.yml" },
      ],
      42,
      "b".repeat(40),
    ),
  ).toEqual([10]);
});
