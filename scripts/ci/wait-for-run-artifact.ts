#!/usr/bin/env bun
// The sandbox and desktop image jobs build every layer that does not need the
// artifact runtime while artifact-runtime.yml is still producing it, then wait
// here for that run-local artifact. artifact-runtime.yml uploads it only after
// it proved the complete target matrix, so its presence in this run is the
// evidence a job-level `needs` gave; the image build still verifies it against
// the exact source SHA. A failed producer fails the wait at once.
import { appendFileSync } from "node:fs";
import { retryingFetch, type RetryOptions } from "./batch-receipt";

export type RunJob = { name: string; status: string; conclusion: string | null };
export type Verdict =
  | { kind: "ready" }
  | { kind: "wait"; pending: number }
  | { kind: "failed"; reason: string };

/** Polls in a row the producer may report success before its artifact is listed. */
export const SETTLED_POLLS_WITHOUT_ARTIFACT = 6;
/** Polls in a row the producer may show no job at all before the wait fails. */
export const ABSENT_POLLS_WITHOUT_PRODUCER = 30;
/**
 * Reads in a row that may be refused (401, 403 or 404, but not a rate limit)
 * before the wait fails.
 */
export const REFUSED_READS = 3;
/**
 * Leaves room under the wait step's 60-minute timeout for one last poll, whose
 * reads retry for up to about 7 minutes, so the wait reports why it failed
 * instead of being killed.
 */
export const DEADLINE_MS = 50 * 60_000;

/** A GitHub read that answered with an error status. */
export class GitHubReadError extends Error {
  constructor(
    readonly status: number,
    path: string,
    /** GitHub also answers a rate-limited read with 403. */
    readonly rateLimited = false,
  ) {
    super(`GitHub ${status}${rateLimited ? " (rate limited)" : ""} for ${path}`);
  }

  /** A permission, token or run problem that retrying will not fix. */
  get refused(): boolean {
    return [401, 403, 404].includes(this.status) && !this.rateLimited;
  }
}

/** GitHub's rate-limit answers, as scripts/ci/github-pr-ci.ts reads them. */
export function isRateLimited(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    Number(response.headers.get("retry-after")) > 0
  );
}

/**
 * `jobs` is the run's latest attempt of every job. A called workflow's jobs are
 * named `<caller job name> / <job name>`; `producer` is the caller job name.
 * The caller job itself is listed under `producer` when the called workflow
 * never started its jobs, for example when it was skipped or failed to start.
 */
export function verdict(
  artifactListed: boolean,
  jobs: readonly RunJob[],
  producer: string,
  settledPolls: number,
  absentPolls = 0,
): Verdict {
  if (artifactListed) return { kind: "ready" };
  const caller = jobs.find((job) => job.name === producer);
  if (caller?.status === "completed" && caller.conclusion !== "success")
    return {
      kind: "failed",
      reason:
        caller.conclusion === "skipped"
          ? `${producer} was skipped`
          : `${producer} concluded ${caller.conclusion}`,
    };
  const produced = jobs.filter((job) => job.name.startsWith(`${producer} / `));
  const failed = produced.find(
    (job) =>
      job.status === "completed" && job.conclusion !== "success" && job.conclusion !== "skipped",
  );
  if (failed) return { kind: "failed", reason: `${failed.name} concluded ${failed.conclusion}` };
  const pending = produced.filter((job) => job.status !== "completed").length;
  if (produced.length === 0 && absentPolls >= ABSENT_POLLS_WITHOUT_PRODUCER)
    return { kind: "failed", reason: `${producer} started no jobs in this run` };
  if (produced.length > 0 && pending === 0 && settledPolls >= SETTLED_POLLS_WITHOUT_ARTIFACT) {
    const skipped = produced.find((job) => job.conclusion === "skipped");
    return {
      kind: "failed",
      reason: skipped
        ? `${skipped.name} was skipped`
        : `${producer} finished without uploading the artifact`,
    };
  }
  return { kind: "wait", pending };
}

export type RunReads = {
  artifactListed(name: string): Promise<boolean>;
  latestJobs(): Promise<RunJob[]>;
};

export function githubRunReads(
  repository: string,
  runId: string,
  token: string,
  fetcher: typeof fetch = fetch,
  retry: RetryOptions = {},
): RunReads {
  const api = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await retryingFetch(fetcher, `${api}/${path}`, { headers }, 30_000, retry);
    if (!response.ok)
      throw new GitHubReadError(response.status, `runs/${runId}/${path}`, isRateLimited(response));
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    async artifactListed(name) {
      const page = await get(`artifacts?name=${encodeURIComponent(name)}&per_page=100`);
      const artifacts = (page.artifacts ?? []) as { name?: string; expired?: boolean }[];
      return artifacts.some((artifact) => artifact.name === name && artifact.expired !== true);
    },
    async latestJobs() {
      const jobs: RunJob[] = [];
      for (let page = 1; ; page++) {
        const body = await get(`jobs?filter=latest&per_page=100&page=${page}`);
        const rows = (body.jobs ?? []) as RunJob[];
        jobs.push(...rows);
        if (rows.length < 100 || jobs.length >= Number(body.total_count ?? 0)) return jobs;
      }
    },
  };
}

export async function waitForArtifact(
  reads: RunReads,
  name: string,
  producer: string,
  {
    pollMs = 10_000,
    deadlineMs = DEADLINE_MS,
    now = () => Date.now(),
    sleep = (ms: number) => Bun.sleep(ms),
    log = (line: string) => console.log(line),
  } = {},
): Promise<Verdict> {
  const deadline = now() + deadlineMs;
  let settledPolls = 0;
  let absentPolls = 0;
  let refusedReads = 0;
  let lastPending = -1;
  for (;;) {
    try {
      const listed = await reads.artifactListed(name);
      const jobs = listed ? [] : await reads.latestJobs();
      refusedReads = 0;
      const result = verdict(listed, jobs, producer, settledPolls, absentPolls);
      if (result.kind !== "wait") return result;
      // Only the called workflow's jobs count: a caller job listed without
      // them is a producer that never started its work.
      const present = jobs.some((job) => job.name.startsWith(`${producer} / `));
      absentPolls = present ? 0 : absentPolls + 1;
      settledPolls = present && result.pending === 0 ? settledPolls + 1 : 0;
      if (result.pending !== lastPending) {
        log(`[wait-for-run-artifact] ${name}: ${result.pending} ${producer} job(s) still running`);
        lastPending = result.pending;
      }
    } catch (error) {
      // GitHub failing to answer is not evidence about the producer; keep
      // waiting until the deadline. A read refused again and again (a missing
      // permission or a wrong run) will not recover, so fail it early.
      const refused = error instanceof GitHubReadError && error.refused;
      refusedReads = refused ? refusedReads + 1 : 0;
      if (refusedReads >= REFUSED_READS)
        return { kind: "failed", reason: `GitHub refused ${refusedReads} reads: ${String(error)}` };
      log(`[wait-for-run-artifact] read failed, retrying: ${String(error)}`);
    }
    if (now() >= deadline) return { kind: "failed", reason: `${name} did not appear in time` };
    await sleep(pollMs);
  }
}

if (import.meta.main) {
  const arg = (flag: string) => {
    const index = process.argv.indexOf(flag);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value)
      throw new Error(`usage: wait-for-run-artifact.ts --name <artifact> --producer <job>`);
    return value;
  };
  const name = arg("--name");
  const producer = arg("--producer");
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN, GITHUB_OUTPUT } = process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_TOKEN)
    throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN are required");
  const result = await waitForArtifact(
    githubRunReads(GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_TOKEN),
    name,
    producer,
  );
  if (result.kind !== "ready") {
    console.log(`::error::${result.kind === "failed" ? result.reason : "unexpected wait"}`);
    process.exit(1);
  }
  console.log(`[wait-for-run-artifact] ${name} is ready`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `artifact_name=${name}\n`);
}
