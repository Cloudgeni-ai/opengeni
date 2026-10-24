import { expect, test } from "bun:test";
import { scanRunnerDemand } from "./model";

const pr = (id: number) => ({
  id,
  status: "pending",
  event: "pull_request",
  path: ".github/workflows/pr-ci.yml",
});
function scan(runs: Record<string, unknown>[], excludePrCiDemand = true) {
  const jobs: string[] = [];
  return {
    jobs,
    result: scanRunnerDemand({
      baseBranch: "main",
      batchWorkflow: ".github/workflows/batch-ci.yml",
      excludePrCiDemand,
      get: async (path) => {
        if (path.includes("/jobs?")) {
          jobs.push(path);
          return { total_count: 1, jobs: [{ status: "queued" }] };
        }
        const status = new URLSearchParams(path.split("?")[1]).get("status");
        const listed = runs.filter((run) => run.status === status);
        return { total_count: listed.length, workflow_runs: listed };
      },
    }),
  };
}

test("recognized PR backlog does not consume Batch capacity or scan slots", async () => {
  const probe = scan(Array.from({ length: 65 }, (_, i) => pr(i + 1)));
  expect(await probe.result).toMatchObject({ ok: true, otherDemand: 0, scannedRuns: 0 });
  expect(probe.jobs).toEqual([]);
  expect(
    await scan(
      Array.from({ length: 65 }, (_, i) => pr(i + 1)),
      false,
    ).result,
  ).toMatchObject({ ok: false, hold: "scan-bound" });
});

test("an active Batch still holds even among excluded PR runs", async () => {
  expect(
    await scan([pr(1), { ...pr(2), path: ".github/workflows/batch-ci.yml", event: "push" }]).result,
  ).toMatchObject({ ok: false, hold: "batch-slot" });
});

test("unknown workflow or event is not treated as recognized PR demand", async () => {
  for (const run of [
    { ...pr(1), path: ".github/workflows/other.yml" },
    { ...pr(1), event: "unknown" },
  ]) {
    const probe = scan([run]);
    expect(await probe.result).toMatchObject({ ok: true, otherDemand: 1, scannedRuns: 1 });
    expect(probe.jobs).toHaveLength(1);
  }
});

test("incomplete inventories remain held rather than assumed PR-only", async () => {
  expect(await scan(Array.from({ length: 101 }, (_, i) => pr(i + 1))).result).toMatchObject({
    ok: false,
    hold: "incomplete-runs",
  });
});
