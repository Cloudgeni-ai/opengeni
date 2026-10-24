import { expect, test } from "bun:test";
import { scanRunnerDemand } from "./model";

const run = (id: number) => ({
  id,
  status: "waiting",
  path: "other.yml",
  event: "push",
  head_sha: "a".repeat(40),
  run_attempt: 1,
});
const runs = Array.from({ length: 205 }, (_, i) => run(i + 1));
function fixture(entries = runs, jobs = [{ id: 1, status: "completed" }]) {
  const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path);
    const query = new URLSearchParams(path.split("?")[1]);
    expect(query.get("per_page")).toBe("100");
    const page = Number(query.get("page"));
    if (path.includes("/jobs?"))
      return { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) };
    const selected = entries.filter((entry) => entry.status === query.get("status"));
    return {
      total_count: selected.length,
      workflow_runs: selected.slice((page - 1) * 100, page * 100),
    };
  };
  return { calls, get };
}
const scan = (get: (path: string) => Promise<unknown>) =>
  scanRunnerDemand({ get, batchWorkflow: "batch.yml", baseBranch: "main" });

test("complete 205-run inventory crosses former100/64/32 limits without dropping demand", async () => {
  const source = fixture();
  expect(await scan(source.get)).toMatchObject({
    ok: true,
    scannedRuns: 205,
    runnerRelevantRuns: 205,
    otherDemand: 0,
  });
  expect(source.calls.filter((path) => path.includes("status=waiting"))).toHaveLength(6);
  expect(source.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(205);
});

test("latest jobs paginate and retain demand beyond the first100", async () => {
  const jobs = Array.from({ length: 201 }, (_, i) => ({
    id: i + 1,
    status: i === 200 ? "queued" : "completed",
  }));
  const source = fixture([run(1)], jobs);
  expect(await scan(source.get)).toMatchObject({ ok: true, otherDemand: 1, scannedRuns: 1 });
  expect(source.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(3);
});

test("duplicate page identities, changed totals and short pages hold without partial admission", async () => {
  for (const mutation of ["duplicate", "total", "short"] as const) {
    const source = fixture();
    const result = await scan(async (path) => {
      const data = await source.get(path);
      if (path.includes("status=waiting") && path.endsWith("page=2") && "workflow_runs" in data) {
        if (mutation === "duplicate") data.workflow_runs[0] = run(1);
        if (mutation === "total") data.total_count++;
        if (mutation === "short") data.workflow_runs.pop();
      }
      return data;
    });
    expect(result).toMatchObject({ ok: false, hold: "incomplete-runs", scannedRuns: 0 });
  }
});

test("duplicate job page and job total drift hold", async () => {
  for (const mutation of ["duplicate", "total"] as const) {
    const source = fixture(
      [run(1)],
      Array.from({ length: 101 }, (_, i) => ({ id: i + 1, status: "completed" })),
    );
    expect(
      await scan(async (path) => {
        const data = await source.get(path);
        if (path.includes("/jobs?") && path.endsWith("page=2") && "jobs" in data) {
          if (mutation === "duplicate") data.jobs[0] = { id: 1, status: "completed" };
          else data.total_count++;
        }
        return data;
      }),
    ).toMatchObject({ ok: false, hold: "incomplete-jobs" });
  }
});

test("same run repeated across complete passes counts once, identity drift holds", async () => {
  const source = fixture([run(1)]);
  expect(await scan(source.get)).toMatchObject({ ok: true, scannedRuns: 1 });
  let waitingReads = 0;
  expect(
    await scan(async (path) => {
      const data = await source.get(path);
      if (path.includes("status=waiting") && ++waitingReads === 2 && "workflow_runs" in data)
        data.workflow_runs = [{ ...run(1), head_sha: "b".repeat(40) }];
      return data;
    }),
  ).toMatchObject({ ok: false, hold: "invalid-run" });
});

test("later-page API failure propagates instead of admitting an incomplete inventory", async () => {
  const source = fixture();
  await expect(
    scan(async (path) => {
      if (path.includes("status=waiting") && path.endsWith("page=2"))
        throw Error("provider unavailable");
      return source.get(path);
    }),
  ).rejects.toThrow("provider unavailable");
});

test("a Batch reservation on a later page still blocks admission", async () => {
  const entries = runs.map((entry) => ({ ...entry }));
  entries[204]!.path = "batch.yml";
  expect(await scan(fixture(entries).get)).toMatchObject({
    ok: false,
    hold: "batch-slot",
    scannedRuns: 0,
  });
});
