import { expect, test } from "bun:test";
import { scanRunnerDemand, capacityDecision } from "./model";

test("each visible Batch reserves its full fanout, preserving larger observed demand", async () => {
  const source = inventory(2);
  const result = await scanRunnerDemand({
    get: async (path) =>
      path.includes("/jobs?")
        ? {
            total_count: path.includes("runs/1/") ? 27 : 1,
            jobs: Array.from({ length: path.includes("runs/1/") ? 27 : 1 }, (_, i) => ({
              id: i + 1,
              status: "in_progress",
            })),
          }
        : source.get(path),
    batchWorkflow: "batch.yml",
    baseBranch: "main",
    maxInflight: 3,
    requireFreeBatchSlot: false,
  });
  expect(result).toMatchObject({
    ok: true,
    occupiedBatchSlots: 2,
    observedBatchDemand: 28,
    reservedBatchDemand: 45,
  });
  if (!result.ok) throw Error("Complete fixture required");
  const decision = capacityDecision({
    ...result,
    runnerBudget: 100,
    mainReserve: 30,
    providerJobLimit: 100,
    otherRepositoryAllowance: 28,
  });
  expect(decision.capacity.providerRequired).toBe(91);
  expect(decision.allowed).toBe(true);
  expect(
    capacityDecision({
      ...result,
      runnerBudget: 100,
      mainReserve: 30,
      providerJobLimit: 90,
      otherRepositoryAllowance: 28,
    }).capacity.hold,
  ).toBe("provider-limit");
});

test("provider runs and missing publication reservations share a single slot budget", async () => {
  const scan = (reservations: { branch: string; headSha: string; runId?: number }[]) =>
    scanRunnerDemand({
      get: inventory(1).get,
      batchWorkflow: "batch.yml",
      baseBranch: "main",
      maxInflight: 2,
      reservations,
    });
  const visible = { branch: "queue/live/0", headSha: "a".repeat(40) };
  expect(await scan([visible])).toMatchObject({ ok: true });
  expect(await scan([{ ...visible, runId: 1 }])).toMatchObject({ ok: true });
  expect(await scan([{ ...visible, branch: "queue/live/invisible" }])).toMatchObject({
    ok: false,
    hold: "batch-slot",
  });
  expect(await scan([{ ...visible, headSha: "b".repeat(40) }])).toMatchObject({
    ok: false,
    hold: "batch-slot",
  });
  expect(await scan([{ ...visible, runId: 2 }])).toMatchObject({ ok: false, hold: "batch-slot" });
  expect(await scan([{ ...visible, headSha: "unknown" }])).toMatchObject({
    ok: false,
    hold: "invalid-run",
  });
  expect(await scan([visible, visible])).toMatchObject({ ok: true });
});

function inventory(count: number, jobStatus = "in_progress") {
  let jobReads = 0;
  const get = async (path: string) => {
    if (path.includes("/jobs?")) {
      jobReads++;
      return { total_count: 1, jobs: [{ id: 1, status: jobStatus }] };
    }
    const status = new URLSearchParams(path.split("?")[1]).get("status");
    const runs =
      status === "waiting"
        ? Array.from({ length: count }, (_, i) => ({
            id: i + 1,
            status: "waiting",
            path: "batch.yml",
            event: "push",
            head_sha: "a".repeat(40),
            head_branch: `queue/live/${i}`,
            run_attempt: 1,
          }))
        : [];
    return { total_count: runs.length, workflow_runs: runs };
  };
  return { get, jobReads: () => jobReads };
}

test("configured second slot admits one active Batch but not two, including waiting runs", async () => {
  for (const count of [0, 1, 2, 3]) {
    const source = inventory(count);
    const result = await scanRunnerDemand({
      get: source.get,
      batchWorkflow: "batch.yml",
      baseBranch: "main",
      maxInflight: 2,
    });
    expect(result.ok).toBe(count < 2);
    if (result.ok) expect(result.activeBatchRuns).toBe(count);
    else expect(result.hold).toBe("batch-slot");
  }
});

test("landing consumes no slot but still checks complete job evidence", async () => {
  const source = inventory(2);
  expect(
    await scanRunnerDemand({
      get: source.get,
      batchWorkflow: "batch.yml",
      baseBranch: "main",
      maxInflight: 2,
      requireFreeBatchSlot: false,
    }),
  ).toMatchObject({ ok: true, activeBatchRuns: 2 });
  expect(source.jobReads()).toBe(2);
  const unknown = inventory(2, "future-provider-state");
  expect(
    await scanRunnerDemand({
      get: unknown.get,
      batchWorkflow: "batch.yml",
      baseBranch: "main",
      maxInflight: 2,
      requireFreeBatchSlot: false,
    }),
  ).toMatchObject({ ok: false, hold: "unknown-job-status" });
});

test("default remains one slot and invalid slot limits never authorize work", async () => {
  expect(
    await scanRunnerDemand({
      get: inventory(1).get,
      batchWorkflow: "batch.yml",
      baseBranch: "main",
    }),
  ).toMatchObject({ ok: false, hold: "batch-slot" });
  for (const maxInflight of [0, -1, 1.5, 17, NaN])
    expect(
      await scanRunnerDemand({
        get: inventory(0).get,
        batchWorkflow: "batch.yml",
        baseBranch: "main",
        maxInflight,
        requireFreeBatchSlot: false,
      }),
    ).toMatchObject({ ok: false });
});
