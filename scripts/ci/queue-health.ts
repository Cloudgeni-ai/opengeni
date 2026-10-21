#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

type Job = { started_at: string | null; completed_at: string | null; conclusion: string | null };
export type Run = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  head_commit?: { timestamp?: string };
};
type QueueEvent = { __typename: string; createdAt: string; reason?: string };
export type Pull = {
  number: number;
  mergedAt: string | null;
  url: string;
  timelineItems: { nodes: QueueEvent[] };
};
export type QueueTiming = {
  pr: number;
  runId: number;
  attempt: number;
  sha: string;
  url: string;
  enqueuedAt: string | null;
  candidateBuiltAt: string | null;
  candidateObservedAt: string;
  ciStartedAt: string | null;
  ciFinishedAt: string | null;
  conclusion: string | null;
  mergedAt: string | null;
  removedAt: string | null;
  removalReason: string | null;
};

export function queuePullNumber(branch: string): number | null {
  const match = /^gh-readonly-queue\/main\/pr-(\d+)-/.exec(branch);
  return match ? Number(match[1]) : null;
}

export function publicAlertsEnabled(
  event: { workflow_run?: unknown },
  setting: string | undefined,
) {
  // The hourly/manual lane is the single writer; event receipts stay read-only.
  return !event.workflow_run && setting === "true";
}

export function isBatchRun(run: Run): boolean {
  return (
    run.path === ".github/workflows/batch-ci.yml" &&
    run.event === "push" &&
    run.head_branch.startsWith("queue/")
  );
}

/** Provider timing only. A failed workflow is not a verified code-failure receipt,
 * and deterministic Git commit dates are not candidate construction timestamps. */
export function batchTiming(run: Run, jobs: Job[]) {
  const row = queueTiming(run, jobs, {
    number: 0,
    url: "",
    mergedAt: null,
    timelineItems: { nodes: [] },
  });
  return {
    runId: run.id,
    attempt: run.run_attempt,
    sha: run.head_sha,
    branch: run.head_branch,
    url: run.html_url,
    candidateObservedAt: run.created_at,
    attemptObservedAt: run.run_started_at ?? (run.run_attempt === 1 ? run.created_at : null),
    ciStartedAt: row.ciStartedAt,
    ciFinishedAt: row.ciFinishedAt,
    providerConclusion: run.conclusion,
    verifiedOutcome: "unknown" as const,
    readyAt: null,
    builtAt: null,
    landedAt: null,
  };
}

export function summarizeBatches(rows: ReturnType<typeof batchTiming>[]) {
  const durations = rows
    .map((row) => minutes(row.ciStartedAt, row.ciFinishedAt))
    .filter((value): value is number => value !== null);
  const waits = rows
    .map((row) => minutes(row.attemptObservedAt, row.ciStartedAt))
    .filter((value): value is number => value !== null);
  return {
    samples: rows.length,
    ci: {
      samples: durations.length,
      medianMinutes: percentile(durations, 0.5),
      p95Minutes: percentile(durations, 0.95),
    },
    providerStartDelay: {
      samples: waits.length,
      medianMinutes: percentile(waits, 0.5),
      p95Minutes: percentile(waits, 0.95),
    },
    cancellations: rows.filter((row) => row.providerConclusion === "cancelled").length,
    providerRedRuns: rows.filter((row) =>
      ["failure", "timed_out"].includes(row.providerConclusion ?? ""),
    ).length,
    queueWait: { samples: 0, p95Minutes: null },
    stopSignal: null,
    interpretation:
      "Provider timings only; ready/build/landing stages and verified code versus infrastructure outcomes require the controller stage ledger. Unknown queue wait is not a healthy capacity verdict.",
  };
}

export function queueTiming(run: Run, jobs: Job[], pull: Pull): QueueTiming {
  const candidateAt = run.head_commit?.timestamp ?? run.created_at;
  const enqueues = pull.timelineItems.nodes.filter(
    (event) => event.__typename === "AddedToMergeQueueEvent" && event.createdAt <= candidateAt,
  );
  const enqueue = enqueues.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const removal = pull.timelineItems.nodes
    .filter(
      (event) =>
        event.__typename === "RemovedFromMergeQueueEvent" &&
        event.createdAt >= (enqueue?.createdAt ?? candidateAt),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const starts = jobs
    .filter((job) => job.conclusion !== "skipped")
    .map((job) => job.started_at)
    .filter((s): s is string => !!s)
    .sort();
  const ends = jobs
    .map((job) => job.completed_at)
    .filter((s): s is string => !!s)
    .sort();
  return {
    pr: pull.number,
    runId: run.id,
    attempt: run.run_attempt,
    sha: run.head_sha,
    url: run.html_url,
    enqueuedAt: enqueue?.createdAt ?? null,
    candidateBuiltAt: run.head_commit?.timestamp ?? null,
    candidateObservedAt: run.created_at,
    ciStartedAt: starts[0] ?? null,
    ciFinishedAt: run.status === "completed" ? (ends.at(-1) ?? null) : null,
    conclusion: run.conclusion,
    mergedAt: pull.mergedAt,
    removedAt: removal?.createdAt ?? null,
    removalReason: removal?.reason ?? null,
  };
}

function minutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = (Date.parse(end) - Date.parse(start)) / 60000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
export function summarizeQueue(rows: QueueTiming[], now = new Date().toISOString()) {
  const cutoff = Date.parse(now) - 86400000;
  const recent = rows.filter((row) => Date.parse(row.candidateObservedAt) >= cutoff);
  const waitsByEntry = new Map<string, number>();
  for (const row of recent) {
    const wait = minutes(row.enqueuedAt, row.ciStartedAt);
    if (wait === null) continue;
    const key = `${row.pr}:${row.enqueuedAt}`;
    waitsByEntry.set(key, Math.min(waitsByEntry.get(key) ?? Infinity, wait));
  }
  const stages = (start: keyof QueueTiming, end: keyof QueueTiming) => {
    const values = recent
      .map((row) => minutes(row[start] as string | null, row[end] as string | null))
      .filter((v): v is number => v !== null);
    return {
      samples: values.length,
      medianMinutes: percentile(values, 0.5),
      p95Minutes: percentile(values, 0.95),
    };
  };
  const waits = [...waitsByEntry.values()];
  const p95 = percentile(waits, 0.95);
  return {
    schemaVersion: 1,
    generatedAt: now,
    windowHours: 24,
    samples: recent.length,
    queueWait: { samples: waits.length, medianMinutes: percentile(waits, 0.5), p95Minutes: p95 },
    readyToCandidate: stages("enqueuedAt", "candidateBuiltAt"),
    candidateToCi: stages("candidateBuiltAt", "ciStartedAt"),
    ci: stages("ciStartedAt", "ciFinishedAt"),
    resultToMerge: stages("ciFinishedAt", "mergedAt"),
    cancellations: recent.filter((row) => row.conclusion === "cancelled").length,
    failures: recent.filter((row) => ["failure", "timed_out"].includes(row.conclusion ?? ""))
      .length,
    missingEnqueueEvidence: recent.filter((row) => !row.enqueuedAt).length,
    stopSignal: p95 !== null && p95 > 30,
    recommendation:
      p95 !== null && p95 > 30
        ? "STOP: rolling-day p95 queue wait exceeds 30 minutes; evaluate true batching (option B), do not weaken checks."
        : "Observe runner waits and retry rate; insufficient samples are not proof of capacity.",
  };
}

export function isRedMain(run: Run): boolean {
  return (
    run.path === ".github/workflows/ci.yml" &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.status === "completed" &&
    ["failure", "timed_out"].includes(run.conclusion ?? "")
  );
}

type Api = (path: string, method?: string, body?: unknown) => any;
const gh: Api = (path, method, body) =>
  JSON.parse(
    execFileSync(
      "gh",
      ["api", path, ...(method ? ["--method", method] : []), ...(body ? ["--input", "-"] : [])],
      {
        encoding: "utf8",
        ...(body ? { input: JSON.stringify(body) } : {}),
      },
    ),
  );

function paginated(api: Api, path: string, key?: string): any[] {
  const rows: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key ? result[key] : result;
    if (!Array.isArray(batch)) throw new Error(`Malformed paginated GitHub response: ${path}`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error(
    `GitHub pagination exceeded 2000 rows: ${path}; do not publish a partial healthy report`,
  );
}

export function collectQueueTimings(api: Api, repository: string, runs: Run[]): QueueTiming[] {
  const [owner, name] = repository.split("/");
  const pulls = new Map<number, Pull>();
  const rows: QueueTiming[] = [];
  for (const run of runs) {
    const number = queuePullNumber(run.head_branch);
    if (run.event !== "merge_group" || number === null) continue;
    if (!pulls.has(number)) {
      const response = api("graphql", "POST", {
        query: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url mergedAt timelineItems(last:100,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{createdAt reason}}}}}}`,
        variables: { owner, name, number },
      });
      if (response.errors)
        throw new Error(`Queue timeline query failed: ${JSON.stringify(response.errors)}`);
      const pull = response.data?.repository?.pullRequest;
      if (!pull) throw new Error(`Missing queue PR #${number}`);
      pulls.set(number, pull);
    }
    const jobs = paginated(
      api,
      `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
      "jobs",
    );
    rows.push(queueTiming(run, jobs, pulls.get(number)!));
  }
  return rows;
}

export function collectBatchTimings(api: Api, repository: string, runs: Run[]) {
  return runs
    .filter(isBatchRun)
    .map((run) =>
      batchTiming(
        run,
        paginated(
          api,
          `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
          "jobs",
        ),
      ),
    );
}

/** Optional instrumentation must never disable the independent main watch. */
export function collectBatchReport(api: Api, repository: string, since: string) {
  try {
    const runs = paginated(
      api,
      `repos/${repository}/actions/workflows/batch-ci.yml/runs?event=push&created=%3E%3D${encodeURIComponent(since)}`,
      "workflow_runs",
    ) as Run[];
    const batchRows = collectBatchTimings(api, repository, runs);
    return { batchRows, batchSummary: summarizeBatches(batchRows), batchError: null };
  } catch {
    // Do not expose provider response bodies or publish a partial healthy sample.
    return {
      batchRows: [],
      batchSummary: null,
      batchError:
        "Batch telemetry unavailable; collection failed. Full-main reconciliation remains independent.",
    };
  }
}

/** The associated landing PR is a suspect, not proven causality: coalesced full
 * CI covers intervening commits too. Never automatically revert it. */
export function reportRedMain(api: Api, repository: string, run: Run) {
  if (!isRedMain(run)) return { reported: false, reason: "not a failed completed main push" };
  const marker = `<!-- opengeni-full-ci:${run.id}:${run.run_attempt} -->`;
  const pulls = paginated(api, `repos/${repository}/commits/${run.head_sha}/pulls`).filter(
    (pull) => pull.merged_at && pull.base?.ref === "main" && pull.merge_commit_sha === run.head_sha,
  );
  const body =
    `${marker}\nFull CI is **${run.conclusion}** on main commit \`${run.head_sha}\`: ${run.html_url}.\n\n` +
    `Landing PR${pulls.length === 1 ? "" : "s"}: ${pulls.map((pull) => `#${pull.number}`).join(", ") || "not uniquely identified"}. ` +
    "This identifies the landing commit, not a proven culprit: coalesced full CI may contain earlier untested merges. Inspect the failing leaf and last fully green SHA before attributing. Once confirmed, revert the culprit PR first through the queue, then fix it afterwards (AGENTS.md). No automatic revert was performed. Cancelled CI is never classified as a failure.";
  for (const pull of pulls) {
    const comments = paginated(api, `repos/${repository}/issues/${pull.number}/comments`);
    if (!comments.some((comment) => comment.body?.includes(marker)))
      api(`repos/${repository}/issues/${pull.number}/comments`, "POST", { body });
  }
  // One durable GitHub issue is the alert channel; per-run comments deduplicate
  // repeated workflow delivery. The workflow serializes this reporter.
  const title = "Main CI health: failed full-suite runs";
  const issues = paginated(
    api,
    `repos/${repository}/issues?state=open&creator=github-actions%5Bbot%5D`,
  );
  let issue = issues.find((candidate) => !candidate.pull_request && candidate.title === title);
  if (!issue) issue = api(`repos/${repository}/issues`, "POST", { title, body });
  else {
    const comments = paginated(api, `repos/${repository}/issues/${issue.number}/comments`);
    if (
      !issue.body?.includes(marker) &&
      !comments.some((comment) => comment.body?.includes(marker))
    )
      api(`repos/${repository}/issues/${issue.number}/comments`, "POST", { body });
  }
  return {
    reported: true,
    issue: issue.html_url,
    landingPulls: pulls.map((pull) => pull.number),
    causeProven: false,
  };
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  const now = new Date().toISOString();
  const alertsEnabled = publicAlertsEnabled(event, process.env.QUEUE_HEALTH_ALERTS);
  if (event.workflow_run) {
    const run: Run = gh(`repos/${repository}/actions/runs/${event.workflow_run.id}`);
    const rows = collectQueueTimings(gh, repository, [run]);
    const batchRows = collectBatchTimings(gh, repository, [run]);
    const alert = {
      reported: false,
      redMain: isRedMain(run),
      reason: "event receipt; public alerts belong to opted-in reconciliation",
    };
    writeFileSync(
      "queue-health.json",
      JSON.stringify(
        { generatedAt: now, rows, batchRows, batchSummary: summarizeBatches(batchRows), alert },
        null,
        2,
      ) + "\n",
    );
  } else {
    const since = new Date(Date.now() - 86400000).toISOString();
    const runs = paginated(
      gh,
      `repos/${repository}/actions/workflows/merge-queue.yml/runs?event=merge_group&created=%3E%3D${encodeURIComponent(since)}`,
      "workflow_runs",
    ) as Run[];
    const rows = collectQueueTimings(gh, repository, runs);
    const summary = summarizeQueue(rows, now);
    const { batchRows, batchSummary, batchError } = collectBatchReport(gh, repository, since);
    // The report lane coalesces pending invocations. Reconcile completed red
    // main runs too, so a queue-report burst cannot hide a full-CI failure.
    const redRuns = paginated(
      gh,
      `repos/${repository}/actions/workflows/ci.yml/runs?event=push&branch=main&created=%3E%3D${encodeURIComponent(new Date(Date.now() - 2 * 86400000).toISOString())}`,
      "workflow_runs",
    ) as Run[];
    const alerts = redRuns
      .filter((run) => isRedMain(run) && Date.parse(run.updated_at) >= Date.now() - 86400000)
      .map((run) =>
        alertsEnabled
          ? reportRedMain(gh, repository, run)
          : { reported: false, runId: run.id, reason: "QUEUE_HEALTH_ALERTS is not enabled" },
      );
    writeFileSync(
      "queue-health.json",
      JSON.stringify(
        { ...summary, rows, batchRows, batchSummary, batchError, alertsEnabled, alerts },
        null,
        2,
      ) + "\n",
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Queue health\n\n${summary.recommendation}\n\n\`\`\`json\n${JSON.stringify({ nativeQueue: summary, batchCi: batchSummary, batchError }, null, 2)}\n\`\`\`\n`,
      );
    if (summary.stopSignal) console.log("::warning::" + summary.recommendation);
  }
}
