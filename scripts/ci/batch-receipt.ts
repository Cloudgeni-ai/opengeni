#!/usr/bin/env bun
// Main-push batch receipt (docs/merge-batcher.md "Main CI records the batch
// result"). The merge batcher lands a batch only after `ci.yml` passed in full,
// images included, on the batch tip's exact tree, then lands each member as one
// squash commit carrying `Batch: <id>`. For such a push this decides:
//
// - `attested`: this commit's tree is the batch tip's tested tree. Main skips
//   its test lanes, still builds images, deployment artifacts and the artifact
//   runtime, is never deferred by the main CI cadence, and its full-green
//   receipt names the batch run.
// - `intermediate`: an earlier member's tree, which no CI run tested on its
//   own. Main runs nothing else for it and it is never red; the run is
//   labelled as covered by the batch and the SHA its final tree landed as, and
//   it gets no receipt, so canary admission refuses it.
// - `full`: anything else, including every re-run, Version merge, CI or batcher
//   definition change, and any missing, ambiguous or unreadable evidence.
//
// Discovery is fail-closed: an error yields `full`, never a receipt.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH_PREFIX, CI_WORKFLOW, parseManifest } from "../batcher/model";

export const RECEIPT_FILE = "batch-receipt.json";
/** The landing commit message the batcher writes (scripts/batcher/pass.ts). */
export const BATCH_MARKER = /^Batch: ([0-9a-f]{12})$/gm;
export const PLAN_ARTIFACT = "ci-impact-plan";
/** Jobs a batch run must have passed on its latest attempt. */
export const REQUIRED_BATCH_JOBS = [
  "Explain change impact",
  "Typecheck and unit tests",
  "Deployment artifacts",
  "Workload image builds",
] as const;
/**
 * Paths that define main's lanes, required results or this receipt. A push
 * that lands any of them runs in full, so a changed definition never vouches
 * for itself. Tests and Markdown beside those scripts define nothing.
 */
export const RECEIPT_BLOCKING_PATHS = [
  /^\.github\/(workflows|actions)\//,
  /^scripts\/(ci|batcher)\/(?!.*(\.test\.ts|\.md)$)/,
] as const;

type Row = Record<string, any>;

export interface BatchEvidence {
  id: string;
  branch: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  tree: string;
  url: string;
  /** 1-based position of this commit among the batch's members. */
  member: number;
  members: number;
}

export type Receipt =
  | { kind: "full"; reason: string }
  | { kind: "attested" | "intermediate"; reason: string; batch: BatchEvidence };

export interface LocalPush {
  repository: string;
  sha: string;
  tree: string;
  message: string;
  runAttempt: number;
  /** Paths changed from `base` to this commit, or null when unknown. */
  changedSince(base: string): readonly string[] | null;
  /** The commit `n` first parents below this one, or null when unavailable. */
  firstParent(n: number): string | null;
}

export interface Reads {
  /** Every `ci.yml` run for a branch, complete. */
  runs(branch: string): Promise<Row[]>;
  commit(sha: string): Promise<{ tree: string; message: string }>;
  /** The latest attempt of every job of a run, complete. */
  jobs(runId: number): Promise<Row[]>;
  /** `mode` of the run's uploaded impact plan, or null. */
  planMode(runId: number, headSha: string): Promise<string | null>;
  /** The recent `main` commit with this tree, or null. */
  mainCommitWithTree(tree: string): Promise<string | null>;
}

const SHA = /^[0-9a-f]{40}$/;

export function isVersionMerge(message: string): boolean {
  return (
    message.startsWith("chore: version packages") || message.includes("changeset-release/main")
  );
}

export async function classifyMainPush(local: LocalPush, reads: Reads): Promise<Receipt> {
  const full = (reason: string): Receipt => ({ kind: "full", reason });
  if (local.runAttempt !== 1) return full("a re-run tests this exact SHA in full");
  if (isVersionMerge(local.message)) return full("Version merges run in full");
  const markers = [...local.message.matchAll(BATCH_MARKER)];
  if (markers.length !== 1) return full("not a merge batcher landing");
  const id = markers[0]![1]!;

  const branch = `${BATCH_PREFIX}${id}`;
  const runs = (await reads.runs(branch)).filter(
    (run) =>
      run.head_branch === branch &&
      run.event === "push" &&
      run.path === CI_WORKFLOW &&
      run.repository?.full_name === local.repository &&
      run.head_repository?.full_name === local.repository,
  );
  const heads = new Set(runs.map((run) => run.head_sha));
  if (heads.size !== 1) return full(`batch ${id} has ${heads.size} tested tips`);
  const run = runs.sort((a, b) => b.id - a.id)[0]!;
  if (
    !SHA.test(run.head_sha) ||
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    return full(`batch ${id}'s CI run did not pass`);

  const tip = await reads.commit(run.head_sha);
  const manifest = parseManifest(tip.message);
  if (!manifest || manifest.id !== id || manifest.members.at(-1)!.tree !== tip.tree)
    return full(`batch ${id}'s tip is not the candidate its manifest describes`);
  // The members land in order on the batch base, one first-parent step each.
  let position = -1;
  manifest.members.forEach((member, index) => {
    if (member.tree === local.tree && local.firstParent(index + 1) === manifest.base)
      position = index;
  });
  if (position < 0) return full(`this tree is not a member of batch ${id} landed on its base`);
  // Everything the batch landed so far, so a changed definition never vouches
  // for itself even when an earlier member carried it.
  const landed = local.changedSince(manifest.base);
  if (landed === null) return full("the landed paths are unknown");
  if (landed.some((path) => RECEIPT_BLOCKING_PATHS.some((pattern) => pattern.test(path))))
    return full("the batch lands CI or batcher definitions");

  // A batcher retry re-runs only failed jobs; their latest attempts must pass.
  const jobs = await reads.jobs(run.id);
  for (const name of REQUIRED_BATCH_JOBS) {
    const matches = jobs.filter((job) => job.name === name);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      !job ||
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      !(Number(job.run_attempt) <= run.run_attempt)
    )
      return full(`batch ${id}'s run lacks a passing '${name}'`);
  }
  if ((await reads.planMode(run.id, run.head_sha)) !== "full")
    return full(`batch ${id}'s run did not plan the full suite`);

  const batch: BatchEvidence = {
    id,
    branch,
    runId: run.id,
    runAttempt: run.run_attempt,
    headSha: run.head_sha,
    tree: tip.tree,
    url: `${run.html_url}/attempts/${run.run_attempt}`,
    member: position + 1,
    members: manifest.members.length,
  };
  return local.tree === tip.tree
    ? { kind: "attested", reason: `batch ${id} passed this exact tree`, batch }
    : {
        kind: "intermediate",
        reason: `member ${position + 1} of ${batch.members} in batch ${id}; only the last member's tree was tested`,
        batch,
      };
}

/**
 * The SHA a batch's final tree landed as. An intermediate member's push runs
 * while the batcher is still landing the rest, so look for a while.
 */
export async function findFinalSha(
  reads: Pick<Reads, "mainCommitWithTree">,
  tree: string,
  attempts = 20,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const sha = await reads.mainCommitWithTree(tree).catch(() => null);
    if (sha) return sha;
    if (attempt < attempts) await sleep(15_000);
  }
  return null;
}

/** Waits between attempts of a read that hit a transient failure. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

export interface RetryOptions {
  /** Waits before each retry; empty means a single attempt. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One read, retried after a network error, a timeout, a 5xx or a 429 so a
 * passing GitHub blip does not cost a batch its receipt. Each attempt gets a
 * fresh timeout. The last attempt's response or error is returned or thrown,
 * so persistent failures still read as unreadable evidence.
 */
export async function retryingFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  { delaysMs = RETRY_DELAYS_MS, sleep = (ms) => Bun.sleep(ms) }: RetryOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delaysMs.length;
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (last || (response.status < 500 && response.status !== 429)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (last) throw error;
    }
    await sleep(delaysMs[attempt]!);
  }
}

/**
 * GitHub reads with complete pagination; any gap throws. Each read retries
 * transient failures unless `retry.delaysMs` is empty.
 */
export function githubReads(
  repository: string,
  token: string,
  fetcher: typeof fetch = fetch,
  retry: RetryOptions = {},
): Reads {
  const api = `https://api.github.com/repos/${repository}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  const read = (url: string, init: RequestInit, timeoutMs: number) =>
    retryingFetch(fetcher, url, init, timeoutMs, retry);
  const get = async (path: string): Promise<Row> => {
    const response = await read(`${api}/${path}`, { headers }, 30_000);
    if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
    return (await response.json()) as Row;
  };
  const pages = async (path: string, key: string): Promise<Row[]> => {
    const rows: Row[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(body[key])) throw new Error(`${path}: ${key} missing`);
      rows.push(...body[key]);
      if (rows.length >= body.total_count) return rows;
      if (body[key].length < 100) break;
    }
    throw new Error(`${path}: incomplete listing`);
  };
  return {
    runs: (branch) =>
      pages(
        `actions/workflows/ci.yml/runs?event=push&branch=${encodeURIComponent(branch)}`,
        "workflow_runs",
      ),
    commit: async (sha) => {
      const body = await get(`git/commits/${sha}`);
      return { tree: String(body.tree?.sha), message: String(body.message) };
    },
    jobs: (runId) => pages(`actions/runs/${runId}/jobs?filter=latest`, "jobs"),
    mainCommitWithTree: async (tree) => {
      const commits = (await get("commits?sha=main&per_page=30")) as unknown as Row[];
      if (!Array.isArray(commits)) throw new Error("commits listing missing");
      const match = commits.find((commit) => commit.commit?.tree?.sha === tree);
      return match && SHA.test(match.sha) ? String(match.sha) : null;
    },
    planMode: async (runId, headSha) => {
      const listed = await pages(
        `actions/runs/${runId}/artifacts?name=${PLAN_ARTIFACT}`,
        "artifacts",
      );
      const artifacts = listed.filter(
        (a) => a.name === PLAN_ARTIFACT && !a.expired && a.workflow_run?.head_sha === headSha,
      );
      if (artifacts.length !== 1) return null;
      // The archive URL redirects to signed storage, which must not get the token.
      const redirect = await read(
        artifacts[0]!.archive_download_url,
        { headers, redirect: "manual" },
        30_000,
      );
      const location = redirect.headers.get("location");
      if (redirect.status !== 302 || !location) return null;
      const archive = await read(location, {}, 60_000);
      if (!archive.ok) return null;
      const directory = mkdtempSync(join(tmpdir(), "batch-receipt-"));
      try {
        const zip = join(directory, "plan.zip");
        writeFileSync(zip, new Uint8Array(await archive.arrayBuffer()));
        const plan = JSON.parse(
          execFileSync("unzip", ["-p", zip, "impact-plan.json"], {
            encoding: "utf8",
            maxBuffer: 64 << 20,
          }),
        );
        return typeof plan.mode === "string" ? plan.mode : null;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function localPush(env: Record<string, string | undefined>): LocalPush {
  const sha = String(env.GITHUB_SHA);
  return {
    repository: String(env.GITHUB_REPOSITORY),
    sha,
    tree: git(["rev-parse", `${sha}^{tree}`]) ?? "",
    message: git(["log", "-1", "--format=%B", sha]) ?? "",
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    changedSince: (base) => {
      if (!SHA.test(base)) return null;
      const diff = git(["diff", "--name-only", `${base}..${sha}`]);
      return diff === null ? null : diff.split("\n").filter(Boolean);
    },
    firstParent: (n) => git(["rev-parse", "--verify", "--quiet", `${sha}~${n}^{commit}`]),
  };
}

export function outputs(receipt: Receipt, finalSha: string | null = null): Record<string, string> {
  const batch = receipt.kind === "full" ? null : receipt.batch;
  return {
    final_sha: batch ? (finalSha ?? "") : "",
    kind: receipt.kind,
    attested: String(receipt.kind === "attested"),
    batch_run_id: batch ? String(batch.runId) : "",
    batch_run_attempt: batch ? String(batch.runAttempt) : "",
    batch_head_sha: batch?.headSha ?? "",
    batch_branch: batch?.branch ?? "",
    batch_url: batch?.url ?? "",
    tree: batch?.tree ?? "",
  };
}

if (import.meta.main) {
  const local = localPush(process.env);
  let receipt: Receipt;
  try {
    receipt = await classifyMainPush(
      local,
      githubReads(local.repository, process.env.GITHUB_TOKEN ?? ""),
    );
  } catch (error) {
    receipt = { kind: "full", reason: `evidence unreadable: ${(error as Error).message}` };
  }
  const finalSha =
    receipt.kind === "attested"
      ? local.sha
      : receipt.kind === "intermediate"
        ? await findFinalSha(
            // findFinalSha already polls, so its reads don't retry on their own:
            // that keeps a GitHub outage within the job's time limit.
            githubReads(local.repository, process.env.GITHUB_TOKEN ?? "", fetch, { delaysMs: [] }),
            receipt.batch.tree,
          )
        : null;
  writeFileSync(
    RECEIPT_FILE,
    `${JSON.stringify({ schemaVersion: 1, sha: local.sha, ...receipt, finalSha }, null, 2)}\n`,
  );
  const lines = Object.entries(outputs(receipt, finalSha)).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  const summary =
    receipt.kind === "attested"
      ? `Batch receipt: ${receipt.reason} (${receipt.batch.url}). Test lanes are skipped; images and deployment artifacts build.`
      : receipt.kind === "intermediate"
        ? `Covered by batch ${receipt.batch.id} → ${finalSha ?? `the commit with tree ${receipt.batch.tree}`}: ${receipt.reason}. Its final tree passed in full in ${receipt.batch.url}. This SHA runs nothing else and has no receipt, so canary admission refuses it.`
        : `Full main CI: ${receipt.reason}.`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (receipt.kind === "intermediate")
    console.log(`::notice title=Covered by batch ${receipt.batch.id}::${summary}`);
  console.log(summary);
}
