#!/usr/bin/env bun
// Classifies the main CI lanes that Batch CI runs on its exact candidate
// (`Main CI lanes`, the reusable `.github/workflows/ci.yml` call) into one
// process exit code for `batch-result.ts run --job lanes`.
//
// 0 means every lane job of this attempt completed green or was skipped by the
// candidate's own impact plan, including the aggregates canary admission needs.
// A failed assertion is a code failure (1, or 70 for a process leak). Setup,
// upload, deadline, runner-loss and unreadable evidence are infrastructure
// (75, 124 or the signal code), so they never incriminate a PR. Cancellation is
// 130. See docs/merge-batcher.md "Main CI lanes in Batch CI".
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage } from "@opengeni/contracts/values";

export interface LaneStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}
export interface LaneJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps: LaneStep[];
}
export interface LaneVerdict {
  job: string;
  conclusion: string | null;
  exitCode: number;
  reason: string;
}
export interface LanesSummary {
  schemaVersion: 1;
  caller: string;
  lanesResult: string;
  exitCode: number;
  reason: string;
  jobCount: number;
  failed: LaneVerdict[];
}

/** Aggregates that fail only because another lane failed. */
export const LANE_AGGREGATES = [
  "Typecheck and unit tests",
  "Workload image builds",
  "Validation before release image",
] as const;
/** Jobs canary admission requires green on the exact main SHA (scripts/canary-source-admission.ts). */
export const CANARY_REQUIRED_LANES = [
  "Typecheck and unit tests",
  "Deployment artifacts",
  "Workload image builds",
] as const;
/** A failed step with one of these names never produced a test verdict. */
const SETUP_STEP =
  /^(Set up|Check out|Restore complete checkout|Cache|Install|Download|Stabilize|Log in|Upload|Complete job|Post |Run (actions\/(checkout|setup-|cache|download-artifact|upload-artifact)|oven-sh\/setup-bun|docker\/(setup-|login-)))/;
const INFRA_LOG =
  /(has exceeded the maximum execution time|has timed out after|The runner has received a shutdown signal|lost communication with the server|The operation was canceled)/;
const EXIT_LINE = /##\[error\]Process completed with exit code (\d+)\./;
/** docker/build-push-action reports its failure here instead of a process exit line. */
const BUILDX_ERROR = /##\[error\]buildx failed with:/;
const BUILD_STEP_EXIT = /did not complete successfully: exit code: (\d+)/;
/** Registry, download and runner-resource failures inside an image build. */
const BUILD_INFRA =
  /(\btimed? ?out\b|\btimeout\b|connection (reset|refused|closed)|TLS handshake|Too Many Requests|\b429\b|Service Unavailable|Bad Gateway|Gateway Time-?out|could not resolve|name resolution|no such host|unexpected EOF|context deadline exceeded|failed to do request|no space left on device|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/i;
/** Deterministic Dockerfile and build-context errors. */
const BUILD_DEFINITION =
  /(dockerfile|failed to compute cache key|failed to calculate checksum|unknown instruction|parse error|not found)/i;
const BUILD_WINDOW_LINES = 200;

export function isInfrastructureExit(code: number): boolean {
  return code === 75 || code === 124 || code === 126 || code === 127 || code >= 128;
}

/** Maps one recorded step exit to the receipt vocabulary of batch-result.ts. */
export function normalizeExit(code: number): number {
  if (isInfrastructureExit(code) || code === 70) return code;
  return 1;
}

/** Keeps only this caller's nested jobs and strips the `<caller> / ` prefix. */
export function laneJobs(rows: readonly unknown[], caller: string): LaneJob[] {
  const prefix = `${caller} / `;
  const jobs: LaneJob[] = [];
  for (const row of rows) {
    const job = row as Partial<LaneJob> | null;
    if (!job || typeof job.name !== "string" || !job.name.startsWith(prefix)) continue;
    jobs.push({
      id: Number(job.id),
      name: job.name.slice(prefix.length),
      status: String(job.status ?? ""),
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
      steps: Array.isArray(job.steps) ? job.steps : [],
    });
  }
  return jobs;
}

function firstFailedStep(job: LaneJob): LaneStep | undefined {
  return [...job.steps]
    .sort((a, b) => a.number - b.number)
    .find((step) => step.conclusion === "failure" || step.conclusion === "timed_out");
}

/** Classifies one failed or timed-out job; the log is read only when its step can be a test. */
export async function classifyFailedJob(
  job: LaneJob,
  readLog: (job: LaneJob) => Promise<string | null>,
): Promise<LaneVerdict> {
  const verdict = (exitCode: number, reason: string): LaneVerdict => ({
    job: job.name,
    conclusion: job.conclusion,
    exitCode,
    reason,
  });
  if (job.conclusion === "timed_out") return verdict(124, "job deadline");
  const step = firstFailedStep(job);
  if (step?.conclusion === "timed_out") return verdict(124, `step deadline: ${step.name}`);
  if (step && SETUP_STEP.test(step.name))
    return verdict(75, `setup or upload step failed: ${step.name}`);
  let log: string | null = null;
  try {
    log = await readLog(job);
  } catch (error) {
    return verdict(75, `job log unreadable: ${errorMessage(error)}`);
  }
  if (log === null) return verdict(75, "job log unavailable");
  const lines = log.split(/\r?\n/);
  const buildx = lines.findIndex((line) => BUILDX_ERROR.test(line));
  if (buildx >= 0) {
    const { exitCode, reason } = classifyBuildFailure(
      lines.slice(Math.max(0, buildx - BUILD_WINDOW_LINES), buildx + 1),
    );
    return verdict(exitCode, `${step?.name ?? "image build"}: ${reason}`);
  }
  const recorded = lines.map((line) => EXIT_LINE.exec(line)).find(Boolean);
  if (recorded) {
    const code = normalizeExit(Number(recorded[1]));
    return verdict(code, `${step?.name ?? "step"} exited ${recorded[1]}`);
  }
  if (lines.some((line) => INFRA_LOG.test(line)))
    return verdict(124, "runner deadline, loss or provider cancellation");
  return verdict(75, `no recorded step exit${step ? ` for ${step.name}` : ""}`);
}

/**
 * An image build failed inside buildx. Only error lines of the failing build
 * count: a registry, download, timeout or disk failure is infrastructure; a
 * failed Dockerfile step or a missing build input is a code failure with that
 * step's exit (137 and other signals stay infrastructure). Anything else holds
 * no verdict.
 */
export function classifyBuildFailure(window: readonly string[]): {
  exitCode: number;
  reason: string;
} {
  const errors = window.filter((line) => /error/i.test(line));
  const network = errors.find((line) => BUILD_INFRA.test(line));
  if (network) return { exitCode: 75, reason: "registry, download or runner failure during build" };
  const step = errors
    .map((line) => BUILD_STEP_EXIT.exec(line))
    .filter(Boolean)
    .at(-1);
  if (step) {
    const code = normalizeExit(Number(step[1]));
    return { exitCode: code, reason: `Dockerfile step exited ${step[1]}` };
  }
  if (errors.some((line) => BUILD_DEFINITION.test(line)))
    return { exitCode: 1, reason: "Dockerfile or build context error" };
  return { exitCode: 75, reason: "build failed without a step verdict" };
}

/** The single receipt exit code for every main lane of this attempt. */
export async function classifyLanes(
  lanesResult: string,
  jobs: readonly LaneJob[],
  readLog: (job: LaneJob) => Promise<string | null>,
): Promise<{ exitCode: number; reason: string; failed: LaneVerdict[] }> {
  if (lanesResult === "cancelled")
    return { exitCode: 130, reason: "Main CI lanes were cancelled", failed: [] };
  if (lanesResult === "success") {
    if (!jobs.length) return { exitCode: 75, reason: "No main lane jobs were listed", failed: [] };
    const unsettled = jobs.filter(
      (job) => job.status !== "completed" || !["success", "skipped"].includes(job.conclusion ?? ""),
    );
    if (unsettled.length)
      return {
        exitCode: 75,
        reason: `Lane jobs not green despite a green caller: ${unsettled.map((j) => j.name).join(", ")}`,
        failed: [],
      };
    const missing = CANARY_REQUIRED_LANES.filter(
      (name) => !jobs.some((job) => job.name === name && job.conclusion === "success"),
    );
    if (missing.length)
      return {
        exitCode: 1,
        reason: `Canary admission lanes did not succeed: ${missing.join(", ")}`,
        failed: [],
      };
    return {
      exitCode: 0,
      reason: `All ${jobs.length} main lane jobs passed or were skipped`,
      failed: [],
    };
  }
  if (lanesResult !== "failure")
    return { exitCode: 75, reason: `Main CI lanes ended ${lanesResult || "unknown"}`, failed: [] };
  const failing = jobs.filter(
    (job) => job.conclusion === "failure" || job.conclusion === "timed_out",
  );
  // Aggregates only repeat another lane's failure. One that fails while every
  // other lane is green or skipped is a topology verdict (a code failure);
  // next to a cancelled or unsettled lane it holds no verdict.
  const aggregate = (job: LaneJob) => (LANE_AGGREGATES as readonly string[]).includes(job.name);
  const real = failing.filter((job) => !aggregate(job));
  if (
    !real.length &&
    failing.length &&
    jobs.some(
      (job) =>
        !aggregate(job) &&
        (job.status !== "completed" || !["success", "skipped"].includes(job.conclusion ?? "")),
    )
  )
    return {
      exitCode: 75,
      reason: "Only aggregates failed, next to a cancelled or unsettled lane",
      failed: [],
    };
  const selected = real.length ? real : failing;
  if (!selected.length)
    return {
      exitCode: 75,
      reason: "Main CI lanes failed without a failed lane job (fail-fast or startup)",
      failed: [],
    };
  const failed: LaneVerdict[] = [];
  for (const job of selected) failed.push(await classifyFailedJob(job, readLog));
  const code = failed.filter((row) => !isInfrastructureExit(row.exitCode));
  const describe = (rows: LaneVerdict[]) =>
    rows.map((row) => `${row.job} (${row.reason})`).join("; ");
  if (code.length)
    return {
      exitCode: code.some((row) => row.exitCode === 70) ? 70 : 1,
      reason: `Main lane code failure: ${describe(code)}`,
      failed,
    };
  return {
    exitCode: failed[0]!.exitCode,
    reason: `Main lanes failed without a code verdict: ${describe(failed)}`,
    failed,
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function apiHeaders(env: Record<string, string | undefined>) {
  return {
    authorization: `Bearer ${env.GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

/** Every job of this exact run attempt; totals and identities must be complete. */
export async function readAttemptJobs(
  fetcher: Fetch,
  env: Record<string, string | undefined>,
): Promise<unknown[]> {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (!repo || !run || !attempt || !env.GH_TOKEN) throw new Error("Missing run identity or token");
  const rows: unknown[] = [];
  const ids = new Set<number>();
  for (let page = 1; page <= 20; page++) {
    const response = await fetcher(
      `${api}/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      { headers: apiHeaders(env) },
    );
    if (!response.ok) throw new Error(`jobs page ${page}: HTTP ${response.status}`);
    const body = (await response.json()) as { total_count?: unknown; jobs?: unknown };
    if (!Number.isSafeInteger(body.total_count) || !Array.isArray(body.jobs))
      throw new Error("malformed jobs page");
    for (const job of body.jobs) {
      const id = Number((job as { id?: unknown } | null)?.id);
      if (!Number.isSafeInteger(id) || ids.has(id)) throw new Error("duplicate or invalid job id");
      ids.add(id);
      rows.push(job);
    }
    if (rows.length >= Number(body.total_count)) {
      if (rows.length !== body.total_count) throw new Error("job count exceeds reported total");
      return rows;
    }
    if (!body.jobs.length) break;
  }
  throw new Error("incomplete job listing");
}

/** Reads a bounded job log; the signed redirect target never receives the token. */
export async function readJobLog(
  fetcher: Fetch,
  env: Record<string, string | undefined>,
  jobId: number,
  maxBytes = 64 * 1024 * 1024,
): Promise<string | null> {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const first = await fetcher(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs`, {
    redirect: "manual",
    headers: apiHeaders(env),
  });
  let response = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) return null;
    response = await fetcher(location, { redirect: "follow" });
  }
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (import.meta.main) {
  const caller = argument("--caller");
  const output = argument("--output");
  const lanesResult = process.env.LANES_RESULT ?? "";
  let summary: LanesSummary;
  try {
    let jobs: LaneJob[] = [];
    // The caller's `needs` settled, but the jobs listing can trail by seconds.
    for (let read = 0; read < 6; read++) {
      jobs = laneJobs(await readAttemptJobs(fetch, process.env), caller);
      if (jobs.every((job) => job.status === "completed")) break;
      await Bun.sleep(5000);
    }
    const verdict = await classifyLanes(lanesResult, jobs, (job) =>
      readJobLog(fetch, process.env, job.id),
    );
    summary = { schemaVersion: 1, caller, lanesResult, jobCount: jobs.length, ...verdict };
  } catch (error) {
    summary = {
      schemaVersion: 1,
      caller,
      lanesResult,
      jobCount: 0,
      exitCode: lanesResult === "cancelled" ? 130 : 75,
      reason: `Main lane evidence unreadable: ${errorMessage(error)}`,
      failed: [],
    };
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
  console.log(summary.reason);
  for (const row of summary.failed) console.log(`- ${row.job}: ${row.reason} -> ${row.exitCode}`);
  process.exit(summary.exitCode);
}
