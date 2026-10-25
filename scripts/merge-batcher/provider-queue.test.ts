import { expect, test } from "bun:test";
import { GitHubAuth, GitHubReader } from "./github";
import { config } from "./model";

function reader(
  jobs: Array<{ status: string; created_at?: string }>,
  options: {
    batch?: boolean;
    unknown?: boolean;
    error?: boolean;
    invalidCapacity?: boolean;
    maxInflight?: number;
    withMain?: boolean;
  } = {},
) {
  const cfg = config({
    BATCHER_MODE: "active",
    BATCHER_RUNNER_BUDGET: "52",
    BATCHER_MAIN_RESERVE: "30",
    BATCHER_PROVIDER_JOB_LIMIT: "60",
    BATCHER_OTHER_REPOSITORY_ALLOWANCE: "28",
  });
  if (options.invalidCapacity) cfg.otherRepositoryAllowance = 61;
  if (options.maxInflight !== undefined) cfg.maxInflight = options.maxInflight;
  const transport = (async (url: string | URL | Request) => {
    if (options.error) return new Response("unavailable", { status: 503 });
    const path = String(url);
    if (path.includes("/jobs?"))
      return Response.json({
        total_count: jobs.length,
        jobs: options.unknown ? [{ status: "unknown" }] : jobs,
      });
    const status = new URL(path).searchParams.get("status");
    const runs =
      status === "in_progress"
        ? [
            {
              id: 1,
              status,
              path: options.batch ? ".github/workflows/batch-ci.yml" : ".github/workflows/ci.yml",
              head_branch: "main",
              event: "push",
            },
          ]
        : [];
    if (status === "in_progress" && options.withMain)
      runs.push({
        id: 2,
        status,
        path: ".github/workflows/ci.yml",
        head_branch: "main",
        event: "push",
      });
    return Response.json({ total_count: runs.length, workflow_runs: runs });
  }) as typeof fetch;
  return new GitHubReader(cfg, new GitHubAuth({}), transport);
}

test("pre-fan-out main demand is retained but does not withhold one Batch", async () => {
  const live = reader([]);
  expect(await live.mainBusy()).toBe(false);
  expect(live.lastHeadroom).toMatchObject({
    allowed: true,
    capacityInformational: true,
    capacity: { hold: "main-pre-fanout", preFanoutMainRuns: [1] },
  });
});

test("live reader honors two hosted slots and uses non-reserving complete observations for landing", async () => {
  const pipeline = reader([{ status: "in_progress" }], { batch: true, maxInflight: 2 });
  expect(await pipeline.mainBusy("publish")).toBe(false);
  expect(pipeline.lastHeadroom?.reason).toContain("1/2 active provider slots");
  const full = reader([{ status: "in_progress" }], { batch: true });
  expect(await full.mainBusy("publish")).toBe(true);
  expect(await full.mainBusy("land")).toBe(false);
  expect(await full.mainBusy("observe")).toBe(false);
  const unknown = reader([], { batch: true, unknown: true });
  expect(await unknown.mainBusy("land")).toBe(true);
});

test("queued main demand and queue-wait telemetry remain informational", async () => {
  const live = reader([
    { status: "queued", created_at: "2026-01-01T00:00:00Z" },
    ...Array.from({ length: 4 }, () => ({ status: "completed" })),
  ]);
  expect(await live.mainBusy()).toBe(false);
  expect(live.lastHeadroom).toMatchObject({
    occupied: 1,
    capacityInformational: true,
    capacity: { hold: "main-queued", mainQueuedJobs: 1, latestMain: { queuedJobs: 1 } },
  });
  expect(live.lastHeadroom!.capacity!.latestMain!.oldestQueuedSeconds).toBeGreaterThan(0);
});

test("second slot holds on queued main while landing remains slot-neutral", async () => {
  const live = reader(
    [
      { status: "queued", created_at: "2026-01-01T00:00:00Z" },
      ...Array.from({ length: 4 }, () => ({ status: "completed" })),
    ],
    { batch: true, withMain: true, maxInflight: 2 },
  );
  expect(await live.mainBusy("publish")).toBe(true);
  expect(live.lastHeadroom).toMatchObject({
    occupiedBatchSlots: 1,
    publicationBlocked: true,
    capacityInformational: false,
    capacity: { hold: "main-queued" },
  });
  expect(await live.mainBusy("observe")).toBe(false);
  expect(live.lastHeadroom?.publicationBlocked).toBe(true);
  expect(await live.mainBusy("land")).toBe(false);
});

test("unseen reservation makes queued main capacity binding for slot two", async () => {
  const live = reader([{ status: "queued" }], { maxInflight: 2 });
  expect(
    await live.mainBusy("publish", [{ branch: "queue/unseen", headSha: "a".repeat(40) }]),
  ).toBe(true);
  expect(live.lastHeadroom).toMatchObject({ occupiedBatchSlots: 1, publicationBlocked: true });
});

test("provider and repository demand are truthful observations, not a capacity promise", async () => {
  const live = reader(Array.from({ length: 70 }, () => ({ status: "in_progress" })));
  expect(await live.mainBusy()).toBe(false);
  expect(live.lastHeadroom).toMatchObject({
    occupied: 70,
    reservedMain: 70,
    capacityInformational: true,
    capacity: { providerRequired: 116, hold: "repository-budget" },
  });
  expect(live.lastHeadroom?.reason).toContain("provider slots");
});

test("Batch reservation, unknown jobs, invalid configuration and API failures still hold", async () => {
  const batch = reader([], { batch: true });
  expect(await batch.mainBusy()).toBe(true);
  expect(batch.lastHeadroom?.reason).toContain("candidate slots");
  const unknown = reader([{ status: "completed" }], { unknown: true });
  expect(await unknown.mainBusy()).toBe(true);
  expect(unknown.lastHeadroom?.reason).toContain("Unrecognized");
  const invalid = reader([], { invalidCapacity: true });
  expect(await invalid.mainBusy()).toBe(true);
  expect(invalid.lastHeadroom).toMatchObject({
    capacityInformational: false,
    capacity: { hold: "invalid-capacity" },
  });
  await expect(reader([], { error: true }).mainBusy()).rejects.toThrow();
});
