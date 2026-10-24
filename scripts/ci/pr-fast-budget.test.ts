import { expect, test } from "bun:test";
import {
  classifyPrWorkflow,
  fastBudget,
  FAST_ADMISSION,
  type FastObservation,
} from "./pr-fast-budget";
import { readFileSync } from "node:fs";
import { runPrCiCommand } from "./github-pr-ci";
const modern = (
  id: number,
  status = "completed",
  conclusion: string | null = "success",
): FastObservation => ({
  id,
  kind: "modern-pr",
  jobs: [{ name: FAST_ADMISSION, status, conclusion }],
});
test("four permits include the plan-to-check propagation gap", () => {
  expect(fastBudget([modern(1), modern(2), modern(3)], 99).allowed).toBe(true);
  expect(fastBudget([modern(1), modern(2), modern(3), modern(4)], 99).allowed).toBe(false);
  expect(
    fastBudget([modern(1, "in_progress", null), modern(2), modern(3), modern(4)], 99).allowed,
  ).toBe(false);
});
test("queued admission does not reserve checks but missing or unknown identity holds", () => {
  expect(fastBudget([modern(1, "queued", null)], 99).allowed).toBe(true);
  expect(fastBudget([{ id: 1, kind: "modern-pr", jobs: [] }], 99).allowed).toBe(true);
  expect(
    fastBudget(
      [
        {
          id: 1,
          kind: "modern-pr",
          jobs: [{ name: "unexpected", status: "queued", conclusion: null }],
        },
      ],
      99,
    ).allowed,
  ).toBe(false);
  expect(fastBudget([modern(1, "future-provider-status")], 99).allowed).toBe(false);
});
test("legacy global queue is one bounded fanout, never zero demand", () => {
  const legacy: FastObservation[] = Array.from({ length: 65 }, (_, i) => ({
    id: i + 1,
    kind: "legacy-pr",
    legacyGroup: "pr-ci-fanout",
    jobs: [],
  }));
  expect(fastBudget(legacy, 99)).toEqual({
    allowed: true,
    reason: "Reserved 60/60 jobs; 0 fast permits; 1 legacy groups",
  });
  expect(fastBudget([...legacy, modern(70)], 99).allowed).toBe(false);
  expect(fastBudget([{ id: 1, kind: "legacy-pr", jobs: [] }], 99).allowed).toBe(false);
});
test("main and Batch reserves plus unknown pre-fanout demand are not waived", () => {
  expect(fastBudget([{ id: 1, kind: "main", jobs: [] }], 99).allowed).toBe(false);
  expect(fastBudget([{ id: 1, kind: "other", jobs: [] }], 99).allowed).toBe(false);
  const jobs = Array.from({ length: 20 }, () => ({
    name: "job",
    status: "in_progress",
    conclusion: null,
  }));
  expect(fastBudget([{ id: 1, kind: "batch", jobs }], 99).allowed).toBe(true);
  expect(fastBudget([{ id: 1, kind: "batch", jobs }, modern(2), modern(3)], 99).allowed).toBe(
    false,
  );
});
test("actual new workflow has separately serialized admission and one fast runner", () => {
  const workflow = Bun.YAML.parse(readFileSync(".github/workflows/pr-ci.yml", "utf8")) as any;
  expect(classifyPrWorkflow(workflow)).toBe("modern-pr");
  workflow.jobs.fast.strategy = { matrix: { index: [0, 1] } };
  expect(classifyPrWorkflow(workflow)).toBeNull();
});
test("wire admission waits for a permit, uses exact workflow source and never mutates", async () => {
  let now = 0,
    released = false;
  const requests: string[] = [];
  const source = readFileSync(".github/workflows/pr-ci.yml", "utf8");
  const transport = (async (input: any, init: any) => {
    expect(init.method).toBe("GET");
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    let body: any;
    if (url.pathname.endsWith("/actions/runs")) {
      const rows =
        url.searchParams.get("status") === "in_progress"
          ? [1, 2, 3, 4]
              .filter((id) => !released || id !== 1)
              .map((id) => ({
                id,
                path: ".github/workflows/pr-ci.yml",
                head_sha: "a".repeat(40),
                status: "in_progress",
                run_attempt: 1,
              }))
          : [];
      body = { workflow_runs: rows, total_count: rows.length };
    } else if (url.pathname.includes("/contents/"))
      body = {
        encoding: "base64",
        size: source.length,
        content: Buffer.from(source).toString("base64"),
      };
    else if (url.pathname.endsWith("/jobs"))
      body = {
        jobs: [{ name: FAST_ADMISSION, status: "completed", conclusion: "success" }],
        total_count: 1,
      };
    else throw Error("Unexpected request");
    return Response.json(body);
  }) as typeof fetch;
  await runPrCiCommand(
    "admit-fast",
    { GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "fixture", GITHUB_RUN_ID: "99" },
    transport,
    undefined,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        released = true;
      },
    },
  );
  expect(now).toBeGreaterThan(0);
  expect(requests.filter((path) => path.includes("/contents/")).length).toBe(1);
  expect(requests.some((path) => path.includes(`ref=${"a".repeat(40)}`))).toBe(true);
});
test("incomplete inventory cannot turn into a timeout capacity waiver", async () => {
  let now = 0;
  const transport = (async () =>
    Response.json({ workflow_runs: [], total_count: 1 })) as unknown as typeof fetch;
  await expect(
    runPrCiCommand(
      "admit-fast",
      { GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "fixture", GITHUB_RUN_ID: "99" },
      transport,
      undefined,
      {
        now: () => now,
        sleep: async () => {
          now += 6 * 60 * 60 * 1000;
        },
      },
    ),
  ).rejects.toThrow("budget did not clear");
});
test("workflow-source404 retires only a freshly proven terminal run", async () => {
  for (const terminal of [false, true]) {
    let now = 0;
    const transport = (async (input: any) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/contents/"))
        return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.pathname.endsWith("/actions/runs/1"))
        return Response.json({ id: 1, status: terminal ? "completed" : "in_progress" });
      const rows =
        url.searchParams.get("status") === "in_progress"
          ? [
              {
                id: 1,
                path: ".github/workflows/pr-ci.yml",
                head_sha: "a".repeat(40),
                status: "in_progress",
                run_attempt: 1,
              },
            ]
          : [];
      return Response.json({ workflow_runs: rows, total_count: rows.length });
    }) as typeof fetch;
    const operation = runPrCiCommand(
      "admit-fast",
      { GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "fixture", GITHUB_RUN_ID: "99" },
      transport,
      undefined,
      {
        now: () => now,
        sleep: async () => {
          now += 6 * 60 * 60 * 1000;
        },
      },
    );
    if (terminal) await operation;
    else await expect(operation).rejects.toThrow("budget did not clear");
  }
});
