#!/usr/bin/env bun
// Main pushes park their CI run on the `public-release` approval (the signed
// canary API image). Only the SHA a release lane chooses is ever approved, so
// older parked runs never finish and pile up, slowing every scan of active
// runs. Cancel parked runs that are clearly superseded; keep the approval gate.

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
export function supersededParkedRuns(
  runs: ParkedRun[],
  mainSha: string,
  now: number,
): number[] {
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
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id,
    );
  return parked
    .filter(
      (r, index) =>
        index >= KEEP_NEWEST &&
        r.headSha !== mainSha &&
        now - Date.parse(r.createdAt) > KEEP_YOUNGER_THAN_MS,
    )
    .map((r) => r.id);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? "Cloudgeni-ai/opengeni";
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const dryRun = process.argv.includes("--dry-run");
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok && res.status !== 202)
      throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status}`);
    return res.status === 202 || res.status === 204 ? null : res.json();
  };
  const mainSha = ((await api("commits/main")) as { sha: string }).sha;
  const inspect = async (run: {
    id: number;
    head_sha: string;
    created_at: string;
  }) => {
    const pending = (await api(
      `actions/runs/${run.id}/pending_deployments`,
    )) as {
      environment: { name: string };
    }[];
    const jobs = (await api(
      `actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    )) as {
      total_count: number;
      jobs: { status: string }[];
    };
    // An incomplete job page could hide a running job: treat it as active.
    const active =
      jobs.total_count > jobs.jobs.length
        ? 1
        : jobs.jobs.filter(
            (j) => j.status !== "completed" && j.status !== "waiting",
          ).length;
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
    const data = (await api(
      `actions/workflows/ci.yml/runs?branch=main&event=push&status=waiting&per_page=100&page=${page}`,
    )) as {
      workflow_runs: { id: number; head_sha: string; created_at: string }[];
    };
    for (let i = 0; i < data.workflow_runs.length; i += 8) {
      const chunk = data.workflow_runs.slice(i, i + 8);
      runs.push(...(await Promise.all(chunk.map(inspect))));
    }
    if (data.workflow_runs.length < 100) break;
  }
  const cancel = supersededParkedRuns(runs, mainSha, Date.now());
  console.log(
    `${runs.length} parked main CI runs; cancelling ${cancel.length} superseded${dryRun ? " (dry run)" : ""}`,
  );
  for (const id of cancel) {
    console.log(`cancel ${id}`);
    if (!dryRun) await api(`actions/runs/${id}/cancel`, { method: "POST" });
  }
}

if (import.meta.main) await main();
