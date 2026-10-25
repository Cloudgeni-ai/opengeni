import { expect, test } from "bun:test";
import { scanRunnerDemand } from "./model";

function fixture() {
  const run = {
    id: 10,
    status: "waiting",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: "a".repeat(40),
    run_attempt: 1,
    updated_at: "2026-10-24T10:00:00Z",
  };
  const jobs = [
    { id: 1, name: "Source and type contracts", status: "completed" },
    { id: 2, name: "Build API workload image", status: "waiting" },
    { id: 3, name: "Workload image builds", status: "pending" },
  ];
  const cache = new Map<string, unknown>();
  let now = Date.parse("2026-10-24T11:00:00Z"),
    reads = 0;
  let skipFirstWaiting = false;
  const scan = () => {
    let waitingReads = 0;
    return scanRunnerDemand({
      batchWorkflow: "batch.yml",
      baseBranch: "main",
      now: () => now,
      approvalCache: {
        get: async (key) => cache.get(key),
        set: async (key, value) => {
          cache.set(key, value);
        },
      },
      get: async (path) => {
        if (path.includes("/jobs?")) {
          reads++;
          return { total_count: jobs.length, jobs: structuredClone(jobs) };
        }
        const status = new URLSearchParams(path.split("?")[1]).get("status");
        if (status === "waiting" && ++waitingReads === 1 && skipFirstWaiting)
          return { total_count: 0, workflow_runs: [] };
        const listed = run.status === status ? [structuredClone(run)] : [];
        return { total_count: listed.length, workflow_runs: listed };
      },
    });
  };
  return {
    run,
    jobs,
    cache,
    scan,
    skipFirstWaiting: () => {
      skipFirstWaiting = true;
    },
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("verified public-release main tail reuses zero demand without paging jobs each cycle", async () => {
  const f = fixture();
  expect(await f.scan()).toMatchObject({
    ok: true,
    mainDemand: 0,
    approvalOnlyRuns: 1,
    cachedApprovalOnlyRuns: 0,
  });
  expect(f.reads()).toBe(1);
  expect(await f.scan()).toMatchObject({
    ok: true,
    mainDemand: 0,
    approvalOnlyRuns: 1,
    cachedApprovalOnlyRuns: 1,
  });
  expect(f.reads()).toBe(1);
});

test("waiting Batch always reserves its slot even with a populated approval cache", async () => {
  const f = fixture();
  await f.scan();
  f.run.path = "batch.yml";
  expect(await f.scan()).toMatchObject({ ok: false, hold: "batch-slot" });
  expect(f.reads()).toBe(1);
});

test("one waiting listing is insufficient to reuse a previously verified approval tail", async () => {
  const f = fixture();
  await f.scan();
  f.skipFirstWaiting();
  expect(await f.scan()).toMatchObject({ ok: true, cachedApprovalOnlyRuns: 0 });
  expect(f.reads()).toBe(2);
});

test.each(["queued", "in_progress"])(
  "%s transition invalidates approval exclusion and measures active jobs",
  async (status) => {
    const f = fixture();
    await f.scan();
    f.run.status = status;
    f.jobs[1]!.status = status;
    expect(await f.scan()).toMatchObject({ ok: true, mainDemand: 1, cachedApprovalOnlyRuns: 0 });
    expect(f.reads()).toBe(2);
    f.run.status = "waiting";
    f.jobs[1]!.status = "waiting";
    expect(await f.scan()).toMatchObject({ ok: true, cachedApprovalOnlyRuns: 0 });
    expect(f.reads()).toBe(3);
  },
);

test.each(["attempt", "head", "updated", "workflow"])(
  "changed %s identity requires fresh complete jobs",
  async (change) => {
    const f = fixture();
    await f.scan();
    if (change === "attempt") f.run.run_attempt++;
    if (change === "head") f.run.head_sha = "b".repeat(40);
    if (change === "updated") f.run.updated_at = "2026-10-24T10:01:00Z";
    if (change === "workflow") f.run.path = "other.yml";
    expect(await f.scan()).toMatchObject({ ok: true, cachedApprovalOnlyRuns: 0 });
    expect(f.reads()).toBe(2);
  },
);

test.each(["unknown-gate", "unknown-status", "missing-id"])(
  "%s never seeds a verified approval cache",
  async (change) => {
    const f = fixture();
    if (change === "unknown-gate") f.jobs[1]!.name = "Some other approval";
    if (change === "unknown-status") f.jobs[1]!.status = "future-status";
    if (change === "missing-id") f.jobs[1]!.id = 0;
    await f.scan();
    await f.scan();
    expect(f.reads()).toBe(2);
    expect([...f.cache.values()].filter(Boolean)).toHaveLength(0);
  },
);

test("expired or malformed cache falls back to complete verification, not permission", async () => {
  const f = fixture();
  await f.scan();
  f.advance(15 * 60_000 + 1);
  expect(await f.scan()).toMatchObject({ ok: true, cachedApprovalOnlyRuns: 0 });
  expect(f.reads()).toBe(2);
  for (const key of f.cache.keys()) f.cache.set(key, { at: Infinity, jobs: [] });
  expect(await f.scan()).toMatchObject({ ok: true, cachedApprovalOnlyRuns: 0 });
  expect(f.reads()).toBe(3);
});
