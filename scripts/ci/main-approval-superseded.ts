#!/usr/bin/env bun
// Main pushes park their CI run on the `public-release` approval (the signed
// canary API image). Only the SHA a release lane chooses is ever approved, so
// older parked runs never finish and pile up, slowing every scan of active
// runs. Cancel parked runs that are clearly superseded; keep the approval gate.
import { errorMessage } from "@opengeni/contracts/values";
import { retryingFetch, type RetryOptions } from "./batch-receipt";

export type ParkedRun = {
  id: number;
  headSha: string;
  createdAt: string;
  /** Environments with a pending deployment review on this run. */
  pendingEnvironments: string[];
  /** Jobs that are not completed and not waiting for review. */
  activeJobs: number;
};

export const KEEP_NEWEST = 5;
export const KEEP_YOUNGER_THAN_MS = 3 * 60 * 60 * 1000;
export const APPROVAL_ENVIRONMENT = "public-release";

/** Runs safe to cancel: only waiting on public-release, nothing running, superseded. */
export function supersededParkedRuns(runs: ParkedRun[], mainSha: string, now: number): number[] {
  const parked = runs
    .filter(
      (r) =>
        Number.isSafeInteger(r.id) &&
        r.id > 0 &&
        r.activeJobs === 0 &&
        r.pendingEnvironments.length > 0 &&
        r.pendingEnvironments.every((e) => e === APPROVAL_ENVIRONMENT) &&
        Number.isFinite(Date.parse(r.createdAt)),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  return parked
    .filter(
      (r, index) =>
        index >= KEEP_NEWEST &&
        r.headSha !== mainSha &&
        now - Date.parse(r.createdAt) > KEEP_YOUNGER_THAN_MS,
    )
    .map((r) => r.id);
}

export type QueuedRun = {
  id: number;
  headSha: string;
  createdAt: string;
  runAttempt: number;
  /** When this attempt was requested; later than createdAt for a re-run. */
  runStartedAt: string;
  /** Jobs past queued/waiting; Infinity when the job page is incomplete. */
  startedJobs: number;
  /** A Version PR merge: releases may need its exact-SHA receipt. */
  versionMerge: boolean;
};

export const KEEP_RERUN_YOUNGER_THAN_MS = 6 * 60 * 60 * 1000;
type Job = { status: string; conclusion?: string | null };

/** Jobs that took a runner: running, or finished other than as skipped. */
export function startedJobCount(jobs: { total_count: number; jobs: Job[] }): number {
  if (jobs.total_count > jobs.jobs.length) return Infinity;
  return jobs.jobs.filter(
    (j) => j.status === "in_progress" || (j.status === "completed" && j.conclusion !== "skipped"),
  ).length;
}

/** A Version PR merge, squashed, merged or batched: releases may need its receipt. */
export const isVersionMerge = (message: string | undefined) => {
  const title = (message ?? "").split("\n", 1)[0] ?? "";
  return (
    /^chore: version packages\b/i.test(title) ||
    /\bfrom (Cloudgeni-ai\/)?changeset-release\/main\b/i.test(title)
  );
};

/**
 * Main CI runs whose jobs have not started and that are older than the newest
 * main-push CI run: the newer run tests a superset of their commits. Started
 * runs always finish, so main keeps producing complete receipts. Never touches
 * the current main SHA or a Version merge; a re-run waits six hours first.
 */
export function supersededQueuedRuns(
  queued: QueuedRun[],
  newestCreatedAt: string,
  mainSha: string,
  now: number,
): number[] {
  const newest = Date.parse(newestCreatedAt);
  if (!Number.isFinite(newest)) return [];
  return queued
    .filter(
      (r) =>
        Number.isSafeInteger(r.id) &&
        r.id > 0 &&
        r.startedJobs === 0 &&
        !r.versionMerge &&
        r.headSha !== mainSha &&
        (r.runAttempt === 1 || now - Date.parse(r.runStartedAt) > KEEP_RERUN_YOUNGER_THAN_MS) &&
        Number.isFinite(Date.parse(r.createdAt)) &&
        Date.parse(r.createdAt) < newest,
    )
    .map((r) => r.id);
}

export type MainRun = {
  id: number;
  headSha: string;
  runAttempt: number;
  /** When this attempt was requested. */
  runStartedAt: string;
  status: string;
  conclusion: string | null;
  versionMerge: boolean;
};

/** How often main runs the full suite while it changes (docs/merge-batcher.md). */
export const MAIN_CI_INTERVAL_MS = 30 * 60 * 1000;

/** The repository variable MAIN_CI_INTERVAL_MINUTES overrides the interval (minimum 5). */
export function mainCiInterval(minutes: string | undefined): number {
  const value = Number(minutes);
  return minutes && Number.isFinite(value) && value >= 5 ? value * 60_000 : MAIN_CI_INTERVAL_MS;
}

/**
 * With MAIN_CI_DEFERRED, ordinary main pushes cancel their own first attempt.
 * Re-run the newest main SHA's run when no full run is in progress and the last
 * one started at least the interval ago. A full run is any re-run, or a
 * Version merge's first attempt; a run parked on an approval is not in progress.
 */
export function dueMainRun(
  runs: MainRun[],
  mainSha: string,
  now: number,
  intervalMs = MAIN_CI_INTERVAL_MS,
): number | null {
  const head = runs.find((r) => r.headSha === mainSha);
  if (
    !head ||
    head.runAttempt > 1 ||
    head.versionMerge ||
    head.status !== "completed" ||
    head.conclusion !== "cancelled"
  )
    return null;
  const full = runs.filter((r) => r.runAttempt > 1 || r.versionMerge);
  if (full.some((r) => r.status !== "completed" && r.status !== "waiting")) return null;
  const last = Math.max(
    -Infinity,
    ...full.map((r) => Date.parse(r.runStartedAt)).filter(Number.isFinite),
  );
  return now - last >= intervalMs ? head.id : null;
}

/**
 * The newest full main run that failed on its first full attempt is re-run
 * once, failed jobs only, the same retry a batch gets: one flaky test must not
 * cost main its images for a whole interval. A failure on that retry stays.
 */
export function retryableMainRun(runs: MainRun[]): number | null {
  const newest = runs
    .filter((r) => r.runAttempt > 1 || r.versionMerge)
    .sort((a, b) => Date.parse(b.runStartedAt) - Date.parse(a.runStartedAt))[0];
  if (!newest || newest.versionMerge || newest.runAttempt !== 2) return null;
  return newest.status === "completed" && newest.conclusion === "failure" ? newest.id : null;
}

/**
 * The pass's GitHub API call. A read retries a network error, a timeout, a 5xx
 * or a 429 like the batch receipt does, so one gateway error does not end the
 * whole pass; a mutation is sent exactly once.
 */
export function cadenceApi(
  repo: string,
  token: string,
  fetcher: typeof fetch = fetch,
  retry: RetryOptions = {},
) {
  return async (path: string, init?: RequestInit): Promise<unknown> => {
    const method = init?.method ?? "GET";
    const request: RequestInit = {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    };
    const res = await retryingFetch(
      fetcher,
      `https://api.github.com/repos/${repo}/${path}`,
      request,
      30_000,
      method === "GET" ? retry : { ...retry, delaysMs: [] },
    );
    if (!res.ok && res.status !== 202) throw new Error(`${method} ${path}: ${res.status}`);
    return res.status === 202 || res.status === 204 ? null : res.json();
  };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "Cloudgeni-ai/opengeni";
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const dryRun = process.argv.includes("--dry-run");
  const api = cadenceApi(repo, token);
  const mainSha = ((await api("commits/main")) as { sha: string }).sha;
  type CiRun = {
    id: number;
    head_sha: string;
    created_at: string;
    run_attempt: number;
    run_started_at: string;
    status: string;
    conclusion: string | null;
    head_commit?: { message?: string } | null;
  };
  const ciRuns = (query: string) =>
    api(`actions/workflows/ci.yml/runs?branch=main&event=push&${query}`) as Promise<{
      workflow_runs: CiRun[];
    }>;
  const inspect = async (run: { id: number; head_sha: string; created_at: string }) => {
    const pending = (await api(`actions/runs/${run.id}/pending_deployments`)) as {
      environment: { name: string };
    }[];
    const jobs = (await api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)) as {
      total_count: number;
      jobs: { status: string }[];
    };
    // An incomplete job page could hide a running job: treat it as active.
    const active =
      jobs.total_count > jobs.jobs.length
        ? 1
        : jobs.jobs.filter((j) => j.status !== "completed" && j.status !== "waiting").length;
    return {
      id: run.id,
      headSha: run.head_sha,
      createdAt: run.created_at,
      pendingEnvironments: pending.map((p) => p.environment.name),
      activeJobs: active,
    } satisfies ParkedRun;
  };
  const runs: ParkedRun[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await ciRuns(`status=waiting&per_page=100&page=${page}`);
    for (let i = 0; i < data.workflow_runs.length; i += 8) {
      const chunk = data.workflow_runs.slice(i, i + 8);
      runs.push(...(await Promise.all(chunk.map(inspect))));
    }
    if (data.workflow_runs.length < 100) break;
  }
  const parked = supersededParkedRuns(runs, mainSha, Date.now());
  console.log(`${runs.length} parked main CI runs; ${parked.length} superseded`);

  const newest = (await ciRuns("per_page=1")).workflow_runs[0];
  const listed: CiRun[] = [];
  for (let page = 1; page <= 5; page++) {
    const data = await ciRuns(`status=queued&per_page=100&page=${page}`);
    listed.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
  }
  // A run can report `queued` while some of its jobs already run.
  const queued: QueuedRun[] = [];
  for (let i = 0; i < listed.length; i += 8) {
    const chunk = listed.slice(i, i + 8);
    queued.push(
      ...(await Promise.all(
        chunk.map(async (r) => ({
          id: r.id,
          headSha: r.head_sha,
          createdAt: r.created_at,
          runAttempt: r.run_attempt,
          runStartedAt: r.run_started_at,
          startedJobs: startedJobCount(
            (await api(`actions/runs/${r.id}/jobs?filter=latest&per_page=100`)) as {
              total_count: number;
              jobs: Job[];
            },
          ),
          versionMerge: isVersionMerge(r.head_commit?.message),
        })),
      )),
    );
  }
  const notStarted = newest
    ? supersededQueuedRuns(queued, newest.created_at, mainSha, Date.now())
    : [];
  console.log(`${queued.length} queued main CI runs; ${notStarted.length} superseded`);

  // One failed cancel (already finished, raced) must not stop the rest.
  let failed = 0;
  for (const id of [...parked, ...notStarted]) {
    console.log(`cancel ${id}${dryRun ? " (dry run)" : ""}`);
    if (dryRun) continue;
    try {
      await api(`actions/runs/${id}/cancel`, { method: "POST" });
    } catch (error) {
      failed++;
      console.log(`  skipped: ${errorMessage(error)}`);
    }
  }
  if (failed) console.log(`${failed} cancels skipped; the next pass retries`);

  if (process.env.MAIN_CI_DEFERRED === "true") {
    const recent = (await ciRuns("per_page=100")).workflow_runs;
    const mainRuns = recent.map((r) => ({
      id: r.id,
      headSha: r.head_sha,
      runAttempt: r.run_attempt,
      runStartedAt: r.run_started_at,
      status: r.status,
      conclusion: r.conclusion,
      versionMerge: isVersionMerge(r.head_commit?.message),
    }));
    const retry = retryableMainRun(mainRuns);
    if (retry) {
      console.log(`re-run the failed jobs of ${retry}${dryRun ? " (dry run)" : ""}`);
      if (!dryRun) await api(`actions/runs/${retry}/rerun-failed-jobs`, { method: "POST" });
      return;
    }
    const due = dueMainRun(
      mainRuns,
      mainSha,
      Date.now(),
      mainCiInterval(process.env.MAIN_CI_INTERVAL_MINUTES),
    );
    console.log(
      due ? `re-run ${due} for main ${mainSha}${dryRun ? " (dry run)" : ""}` : "main CI is not due",
    );
    if (due && !dryRun) await api(`actions/runs/${due}/rerun`, { method: "POST" });
  }
}

if (import.meta.main) await main();
