import { expect, test } from "bun:test";
import {
  supersededParkedRuns,
  isVersionMerge,
  startedJobCount,
  supersededQueuedRuns,
  type ParkedRun,
  type QueuedRun,
} from "./main-approval-superseded";

const now = Date.parse("2026-10-25T16:00:00Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const run = (
  id: number,
  h: number,
  extra: Partial<ParkedRun> = {},
): ParkedRun => ({
  id,
  headSha: `${id}`.padStart(40, "a"),
  createdAt: hoursAgo(h),
  pendingEnvironments: ["public-release"],
  activeJobs: 0,
  ...extra,
});

test("keeps the newest five parked runs and cancels older superseded ones", () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(100 + i, 10 + i));
  expect(supersededParkedRuns(runs, "f".repeat(40), now)).toEqual([
    105, 106, 107,
  ]);
});

test("never cancels runs younger than three hours or the current main SHA", () => {
  const runs = [
    ...Array.from({ length: 5 }, (_, i) => run(10 + i, 1)),
    run(20, 2),
    run(21, 20, { headSha: "c".repeat(40) }),
    run(22, 20),
  ];
  expect(supersededParkedRuns(runs, "c".repeat(40), now)).toEqual([22]);
});

test("never cancels runs with running jobs or other pending environments", () => {
  const runs = [
    ...Array.from({ length: 5 }, (_, i) => run(10 + i, 1)),
    run(30, 20, { activeJobs: 1 }),
    run(31, 20, { pendingEnvironments: ["public-release", "package-release"] }),
    run(32, 20, { pendingEnvironments: [] }),
    run(33, 20),
  ];
  expect(supersededParkedRuns(runs, "f".repeat(40), now)).toEqual([33]);
});

test("cancels only not-started main runs older than the newest main run", () => {
  const queuedRun = (
    id: number,
    created: number,
    extra: Partial<QueuedRun> = {},
  ): QueuedRun => ({
    id,
    headSha: String(id).repeat(40).slice(0, 40),
    createdAt: hoursAgo(created),
    runAttempt: 1,
    runStartedAt: hoursAgo(created),
    startedJobs: 0,
    versionMerge: false,
    ...extra,
  });
  const queued = [
    queuedRun(1, 30),
    queuedRun(2, 20, { runAttempt: 2, runStartedAt: hoursAgo(2) }),
    queuedRun(3, 20, { runAttempt: 3, runStartedAt: hoursAgo(7) }),
    queuedRun(4, 1),
  ];
  // The newest main run is itself queued: it is kept. A recent re-run is kept.
  expect(
    supersededQueuedRuns(queued, hoursAgo(1), "f".repeat(40), now),
  ).toEqual([1, 3]);
  // A newer run already started: every older not-started run is superseded.
  expect(
    supersededQueuedRuns(queued, hoursAgo(0), "f".repeat(40), now),
  ).toEqual([1, 3, 4]);
  expect(
    supersededQueuedRuns(queued, "not a date", "f".repeat(40), now),
  ).toEqual([]);
});

test("keeps started runs, the main SHA and Version merges", () => {
  const base = {
    createdAt: hoursAgo(5),
    runAttempt: 1,
    runStartedAt: hoursAgo(5),
    versionMerge: false,
  };
  const queued: QueuedRun[] = [
    { ...base, id: 1, headSha: "a".repeat(40), startedJobs: 3 },
    { ...base, id: 2, headSha: "b".repeat(40), startedJobs: Infinity },
    { ...base, id: 3, headSha: "c".repeat(40), startedJobs: 0 },
    {
      ...base,
      id: 4,
      headSha: "d".repeat(40),
      startedJobs: 0,
      versionMerge: true,
    },
    { ...base, id: 5, headSha: "e".repeat(40), startedJobs: 0 },
  ];
  expect(
    supersededQueuedRuns(queued, hoursAgo(0), "c".repeat(40), now),
  ).toEqual([5]);
});

test("counts started jobs and treats an incomplete page as started", () => {
  const job = (status: string, conclusion: string | null = null) => ({
    status,
    conclusion,
  });
  const page = (jobs: ReturnType<typeof job>[], total = jobs.length) => ({
    total_count: total,
    jobs,
  });
  // A main push skips the dispatch-only admission job within a second.
  expect(
    startedJobCount(
      page([job("completed", "skipped"), job("queued"), job("waiting")]),
    ),
  ).toBe(0);
  expect(
    startedJobCount(
      page([job("queued"), job("in_progress"), job("completed", "success")]),
    ),
  ).toBe(2);
  expect(startedJobCount(page([job("queued")], 101))).toBe(Infinity);
  expect(isVersionMerge("chore: version packages (#5772)")).toBe(true);
  expect(
    isVersionMerge(
      "Merge pull request #5786 from Cloudgeni-ai/changeset-release/main\n\nVersion",
    ),
  ).toBe(true);
  expect(
    isVersionMerge("Batch 1a2b: PR #5786 from changeset-release/main"),
  ).toBe(true);
  expect(isVersionMerge("fix: version packages are read")).toBe(false);
  expect(isVersionMerge("docs: x\n\nfrom changeset-release/main")).toBe(false);
});
