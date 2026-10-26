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

test("a transient count/row mismatch is re-read once before it holds", async () => {
  for (const key of ["workflow_runs", "jobs"] as const) {
    const source = fixture([run(1)], [{ id: 1, status: "queued" }]);
    let skewed = 0;
    const result = await scan(async (path) => {
      const data = await source.get(path);
      if (key in data && (key === "jobs") === path.includes("/jobs?") && skewed++ === 0)
        data.total_count++;
      return data;
    });
    expect(result).toMatchObject({ ok: true, scannedRuns: 1, otherDemand: 1, partialJobRuns: [] });
    expect(skewed).toBeGreaterThan(1);
  }
});

test("tolerant live scans use returned job rows after one re-read; run listings stay strict", async () => {
  const jobs = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    status: i < 2 ? "queued" : "completed",
  }));
  const tolerant = (get: (path: string) => Promise<unknown>) =>
    scanRunnerDemand({
      get,
      batchWorkflow: "batch.yml",
      baseBranch: "main",
      tolerateJobCountMismatch: true,
    });
  for (const mutation of ["over", "under", "drift", "duplicate"] as const) {
    const source = fixture([run(1)], jobs);
    const result = await tolerant(async (path) => {
      const data = await source.get(path);
      if (!path.includes("/jobs?") || !("jobs" in data)) return data;
      if (mutation === "over") data.total_count = 400;
      if (mutation === "under") data.total_count = 120;
      if (mutation === "drift" && path.endsWith("page=2")) data.total_count++;
      if (mutation === "duplicate" && path.endsWith("page=2")) data.jobs[0] = jobs[0]!;
      return data;
    });
    expect(result).toMatchObject({ ok: true, scannedRuns: 1, partialJobRuns: [1] });
    // Demand counts the distinct rows GitHub actually returned.
    expect(result).toMatchObject({ otherDemand: 2 });
  }
  // Default (traffic-shadow) scans keep the strict hold.
  const strict = fixture([run(1)], jobs);
  expect(
    await scan(async (path) => {
      const data = await strict.get(path);
      if (path.includes("/jobs?") && "jobs" in data) data.total_count = 400;
      return data;
    }),
  ).toMatchObject({ ok: false, hold: "incomplete-jobs" });
  // Run listings bound Batch slots, so their mismatch still holds when tolerant.
  const runListing = fixture([run(1)], jobs);
  expect(
    await tolerant(async (path) => {
      const data = await runListing.get(path);
      if (path.includes("status=waiting") && "workflow_runs" in data) data.total_count++;
      return data;
    }),
  ).toMatchObject({ ok: false, hold: "incomplete-runs" });
  // Malformed job pages still hold.
  const malformed = fixture([run(1)], jobs);
  expect(
    await tolerant(async (path) => {
      const data = await malformed.get(path);
      if (path.includes("/jobs?")) return { total_count: 1, jobs: null };
      return data;
    }),
  ).toMatchObject({ ok: false, hold: "incomplete-jobs" });
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

test("four read workers overlap independent runs while each run's pages stay sequential", async () => {
  const source = fixture(
    Array.from({ length: 9 }, (_, i) => run(i + 1)),
    Array.from({ length: 201 }, (_, i) => ({
      id: i + 1,
      status: i === 200 ? "queued" : "completed",
    })),
  );
  let active = 0,
    peak = 0;
  const perRun = new Set<string>();
  const result = await scan(async (path) => {
    if (!path.includes("/jobs?")) return source.get(path);
    const id = path.split("/")[2]!;
    expect(perRun.has(id)).toBe(false);
    perRun.add(id);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await source.get(path);
    } finally {
      active--;
      perRun.delete(id);
    }
  });
  expect(result).toMatchObject({ ok: true, scannedRuns: 9, otherDemand: 9 });
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(source.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(27);
});

test("job read failure drains started readers and never admits partial evidence", async () => {
  const source = fixture(Array.from({ length: 20 }, (_, i) => run(i + 1)));
  let active = 0,
    started = 0;
  await expect(
    scan(async (path) => {
      if (!path.includes("/jobs?")) return source.get(path);
      active++;
      started++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (path.includes("/1/jobs?")) throw Error("job page unavailable");
        return await source.get(path);
      } finally {
        active--;
      }
    }),
  ).rejects.toThrow("job page unavailable");
  expect(active).toBe(0);
  expect(started).toBe(4);
});

test("parallel observations retain the same deadline and fail closed after slow responses", async () => {
  const source = fixture(Array.from({ length: 12 }, (_, i) => run(i + 1)));
  let now = 0;
  const result = await scanRunnerDemand({
    batchWorkflow: "batch.yml",
    baseBranch: "main",
    now: () => now,
    get: async (path) => {
      const data = await source.get(path);
      if (path.includes("/jobs?")) now = 120001;
      return data;
    },
  });
  expect(result).toMatchObject({ ok: false, hold: "deadline" });
  expect(source.calls.filter((path) => path.includes("/jobs?"))).toHaveLength(4);
});
