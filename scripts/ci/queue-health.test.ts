import { test, expect } from "bun:test";
import {
  isRedMain,
  isBatchRun,
  batchTiming,
  collectBatchTimings,
  collectBatchReport,
  summarizeBatches,
  publicAlertsEnabled,
  queuePullNumber,
  queueTiming,
  reportRedMain,
  summarizeQueue,
  type Pull,
  type Run,
} from "./queue-health";

test("landing telemetry is read-only; only explicitly opted-in reconciliation publishes alerts", () => {
  expect(publicAlertsEnabled({}, undefined)).toBe(false);
  expect(publicAlertsEnabled({}, "false")).toBe(false);
  expect(publicAlertsEnabled({}, "true")).toBe(true);
  expect(publicAlertsEnabled({ workflow_run: { id: 42 } }, "true")).toBe(false);
});

const run: Run = {
  id: 42,
  run_attempt: 1,
  head_sha: "a".repeat(40),
  head_branch: "gh-readonly-queue/main/pr-123-abcd",
  event: "merge_group",
  path: ".github/workflows/merge-queue.yml",
  created_at: "2026-10-21T10:02:00Z",
  updated_at: "2026-10-21T10:20:00Z",
  html_url: "https://example.invalid/runs/42",
  status: "completed",
  conclusion: "success",
  head_commit: { timestamp: "2026-10-21T10:01:00Z" },
};
const pull: Pull = {
  number: 123,
  url: "https://example.invalid/pr/123",
  mergedAt: "2026-10-21T10:18:00Z",
  timelineItems: {
    nodes: [{ __typename: "AddedToMergeQueueEvent", createdAt: "2026-10-21T10:00:00Z" }],
  },
};
const jobs = [
  {
    started_at: "2026-10-21T10:03:00Z",
    completed_at: "2026-10-21T10:17:00Z",
    conclusion: "success",
  },
];

test("batch telemetry binds exact attempt jobs but never invents readiness, build, landing or culprit evidence", () => {
  const candidate = {
    ...run,
    event: "push",
    head_branch: "queue/shadow-traffic/abc",
    path: ".github/workflows/batch-ci.yml",
    run_attempt: 2,
    run_started_at: "2026-10-21T10:02:00Z",
    conclusion: "failure",
  };
  const calls: string[] = [];
  const rows = collectBatchTimings(
    (path, method) => {
      expect(method).toBeUndefined();
      calls.push(path);
      return { jobs };
    },
    "owner/repo",
    [candidate, run],
  );
  expect(calls).toEqual(["repos/owner/repo/actions/runs/42/attempts/2/jobs?per_page=100&page=1"]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    attempt: 2,
    readyAt: null,
    builtAt: null,
    landedAt: null,
    verifiedOutcome: "unknown",
    providerConclusion: "failure",
  });
  const summary = summarizeBatches(rows);
  expect(summary.ci.p95Minutes).toBe(14);
  expect(summary.providerStartDelay.p95Minutes).toBe(1);
  expect(summary.providerRedRuns).toBe(1);
  expect(summary.queueWait.p95Minutes).toBeNull();
  expect(summary.stopSignal).toBeNull();
});

test("batch run filtering excludes ordinary pushes and unrelated workflow paths", () => {
  expect(
    isBatchRun({
      ...run,
      event: "push",
      head_branch: "queue/live/abc",
      path: ".github/workflows/batch-ci.yml",
    }),
  ).toBe(true);
  expect(
    isBatchRun({
      ...run,
      event: "push",
      head_branch: "main",
      path: ".github/workflows/batch-ci.yml",
    }),
  ).toBe(false);
  expect(isBatchRun({ ...run, event: "push", head_branch: "queue/live/abc" })).toBe(false);
});

test("batch cancellation is not a failing PR and empty samples remain unknown", () => {
  const summary = summarizeBatches([batchTiming({ ...run, conclusion: "cancelled" }, jobs)]);
  expect(summary.cancellations).toBe(1);
  expect(summary.providerRedRuns).toBe(0);
  expect(summarizeBatches([]).ci.p95Minutes).toBeNull();
  expect(batchTiming({ ...run, status: "in_progress" }, jobs).ciFinishedAt).toBeNull();
});

test("retry start delay uses the selected attempt and is unknown without an attempt timestamp", () => {
  const retry = {
    ...run,
    run_attempt: 2,
    created_at: "2026-10-20T10:00:00Z",
    run_started_at: "2026-10-21T10:02:00Z",
  };
  expect(summarizeBatches([batchTiming(retry, jobs)]).providerStartDelay.p95Minutes).toBe(1);
  expect(
    summarizeBatches([batchTiming({ ...retry, run_started_at: null }, jobs)]).providerStartDelay
      .p95Minutes,
  ).toBeNull();
});

test("a batch job lookup failure reports unavailable rather than a partial healthy sample", () => {
  const report = collectBatchReport(
    (path) => {
      if (path.includes("/workflows/"))
        return {
          workflow_runs: [
            {
              ...run,
              event: "push",
              head_branch: "queue/live/abc",
              path: ".github/workflows/batch-ci.yml",
            },
          ],
        };
      throw new Error("provider response not for public output");
    },
    "owner/repo",
    run.created_at,
  );
  expect(report.batchSummary).toBeNull();
  expect(report.batchRows).toEqual([]);
  expect(report.batchError).toContain("unavailable");
  expect(report.batchError).not.toContain("provider response");
});

test("stage evidence binds queue event, exact attempt jobs and landed PR; metadata update time is not CI finish", () => {
  expect(queuePullNumber(run.head_branch)).toBe(123);
  expect(queuePullNumber("ordinary-branch")).toBeNull();
  const row = queueTiming(run, jobs, pull);
  expect(row.ciFinishedAt).toBe("2026-10-21T10:17:00Z");
  const summary = summarizeQueue([row], "2026-10-21T11:00:00Z");
  expect(summary.readyToCandidate.medianMinutes).toBe(1);
  expect(summary.candidateToCi.medianMinutes).toBe(2);
  expect(summary.ci.medianMinutes).toBe(14);
  expect(summary.resultToMerge.medianMinutes).toBe(1);
  expect(summary.queueWait.p95Minutes).toBe(3);
  expect(summary.stopSignal).toBe(false);
});

test("one enqueue counts once despite rebuilds; missing timestamps are unknown, not zero", () => {
  const row = queueTiming(run, jobs, pull);
  const summary = summarizeQueue(
    [row, { ...row, runId: 43, ciStartedAt: "2026-10-21T10:15:00Z" }],
    "2026-10-21T11:00:00Z",
  );
  expect(summary.queueWait).toMatchObject({ samples: 1, p95Minutes: 3 });
  const missing = queueTiming(run, jobs, { ...pull, timelineItems: { nodes: [] } });
  expect(summarizeQueue([missing], "2026-10-21T11:00:00Z").queueWait.p95Minutes).toBeNull();
});

test("rolling-day p95 above thirty minutes flags true batching; old samples expire", () => {
  const row = { ...queueTiming(run, jobs, pull), ciStartedAt: "2026-10-21T10:31:00Z" };
  const summary = summarizeQueue([row], "2026-10-21T11:00:00Z");
  expect(summary.stopSignal).toBe(true);
  expect(summary.recommendation).toContain("option B");
  expect(summarizeQueue([row], "2026-10-22T11:00:00Z").queueWait.samples).toBe(0);
});

test.each(["cancelled", "success", "skipped", "neutral", null])(
  "never alerts or reverts %s",
  (conclusion) => {
    const candidate = {
      ...run,
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      conclusion,
    };
    expect(isRedMain(candidate)).toBe(false);
    expect(
      reportRedMain(
        () => {
          throw new Error("must not call provider");
        },
        "owner/repo",
        candidate,
      ).reported,
    ).toBe(false);
  },
);

test("red-main alert comments on the exact landing PR without pretending causality or reverting", () => {
  const batch = collectBatchReport(
    () => {
      throw new Error("404: batch-ci not on main");
    },
    "owner/repo",
    run.created_at,
  );
  expect(batch.batchSummary).toBeNull();
  expect(batch.batchError).toContain("unavailable");
  const candidate = {
    ...run,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    conclusion: "failure",
  };
  const calls: { path: string; method: string | undefined; body: any }[] = [];
  const result = reportRedMain(
    (path, method, body) => {
      calls.push({ path, method, body });
      if (path.includes("/pulls?"))
        return [
          {
            number: 123,
            merged_at: "2026-10-21T10:18:00Z",
            base: { ref: "main" },
            merge_commit_sha: candidate.head_sha,
          },
        ];
      if (path.includes("/comments?") || path.includes("/issues?")) return [];
      if (method === "POST" && path.endsWith("/issues"))
        return { number: 99, html_url: "https://example.invalid/issues/99" };
      return {};
    },
    "owner/repo",
    candidate,
  );
  expect(result).toMatchObject({ reported: true, landingPulls: [123], causeProven: false });
  const comment = calls.find((call) => call.path.endsWith("/issues/123/comments"));
  expect(comment?.body.body).toContain("not a proven culprit");
  expect(
    calls
      .filter((call) => call.method)
      .every((call) => call.method === "POST" && call.path.includes("/issues")),
  ).toBe(true);
});

test("duplicate run delivery does not duplicate incident or PR comments", () => {
  const candidate = {
    ...run,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    conclusion: "failure",
  };
  const marker = "<!-- opengeni-full-ci:42:1 -->";
  const result = reportRedMain(
    (path, method) => {
      if (method) throw new Error("duplicate mutation");
      if (path.includes("/pulls?"))
        return [
          {
            number: 123,
            merged_at: "yes",
            base: { ref: "main" },
            merge_commit_sha: candidate.head_sha,
          },
        ];
      if (path.includes("/comments?")) return [{ body: marker }];
      return [
        {
          number: 99,
          title: "Main CI health: failed full-suite runs",
          body: marker,
          html_url: "https://example.invalid/issues/99",
        },
      ];
    },
    "owner/repo",
    candidate,
  );
  expect(result.reported).toBe(true);
});
