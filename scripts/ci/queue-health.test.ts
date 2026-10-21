import { test, expect } from "bun:test";
import {
  isRedMain,
  queuePullNumber,
  queueTiming,
  reportRedMain,
  summarizeQueue,
  type Pull,
  type Run,
} from "./queue-health";

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
