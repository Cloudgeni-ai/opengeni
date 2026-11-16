#!/usr/bin/env bun
// Queue the bot's pin-refresh pull requests.
//
// `.github/workflows/browser-engine-pins.yml` and
// `.github/workflows/xai-client-version-pin.yml` each keep one pull request
// open on a fixed branch and dispatch PR CI on its head. Nobody queued them, so
// they sat with green CI. `.github/workflows/bot-pin-pr-queue.yml` runs this on
// a schedule: it adds `queue-ready` to such a pull request once PR CI passed on
// its exact head and it can land (open, not a draft, no conflict). The merge
// batcher still tests it on current main, and still holds it for the model
// request review when it changes a guarded file.
//
// It never queues a human's pull request: only the known bot branches, opened
// by github-actions[bot] from this repository, with every commit authored and
// committed by the bot. A human push to the branch keeps it out of the queue.
//
// Imports only Node built-ins: the workflow checks this file out alone.

import { parseArgs } from "node:util";

export const BOT_LOGIN = "github-actions[bot]";
export const QUEUE_LABEL = "queue-ready";
export const PR_CI_CHECK = "PR CI";
/** The branches the pin-refresh workflows push, and nothing else. */
export const BOT_PIN_BRANCHES = [
  "chore/browser-engine-pins-auto",
  "chore/xai-client-version-auto",
] as const;

export type PullFacts = {
  number: number;
  state: string;
  draft: boolean;
  /** The PR author's login. */
  author: string | null;
  headRef: string;
  headSha: string;
  headRepository: string | null;
  baseRepository: string;
  labels: string[];
  /** GitHub's `mergeable`: false when it conflicts, null while it computes. */
  mergeable: boolean | null;
};

export type CommitFacts = { author: string | null; committer: string | null };
export type CheckRunFacts = { name: string; status: string; conclusion: string | null };

export type QueueVerdict = { queue: true } | { queue: false; reason: string };

/** Whether a bot pin-refresh pull request should get `queue-ready` now. */
export function queueVerdict(
  pull: PullFacts,
  commits: readonly CommitFacts[],
  checkRuns: readonly CheckRunFacts[],
): QueueVerdict {
  if (pull.state !== "open") return { queue: false, reason: "it is not open" };
  if (!(BOT_PIN_BRANCHES as readonly string[]).includes(pull.headRef))
    return { queue: false, reason: `${pull.headRef} is not a bot pin-refresh branch` };
  if (pull.headRepository !== pull.baseRepository)
    return { queue: false, reason: "its head is in another repository" };
  if (pull.author !== BOT_LOGIN) return { queue: false, reason: `${BOT_LOGIN} did not open it` };
  if (commits.length === 0) return { queue: false, reason: "it has no commits" };
  if (commits.some((commit) => commit.author !== BOT_LOGIN || commit.committer !== BOT_LOGIN))
    return { queue: false, reason: `a commit is not by ${BOT_LOGIN}` };
  if (pull.labels.includes(QUEUE_LABEL)) return { queue: false, reason: "it is already queued" };
  if (pull.draft) return { queue: false, reason: "it is a draft" };
  if (pull.mergeable === false) return { queue: false, reason: "it conflicts with main" };
  const prCi = checkRuns.filter((run) => run.name === PR_CI_CHECK);
  if (prCi.length === 0) return { queue: false, reason: "PR CI has not run on its head" };
  if (prCi.some((run) => run.status !== "completed"))
    return { queue: false, reason: "PR CI is still running on its head" };
  if (!prCi.some((run) => run.conclusion === "success"))
    return { queue: false, reason: "PR CI has not passed on its head" };
  return { queue: true };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function githubApi(input: { token: string; repository: string; fetch?: Fetch }) {
  const request = input.fetch ?? fetch;
  const base = `https://api.github.com/repos/${input.repository}`;
  return async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const response = await request(`${base}/${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok)
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  };
}

type RestUser = { login: string } | null;
type RestPull = {
  number: number;
  state: string;
  draft?: boolean;
  user: RestUser;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { repo: { full_name: string } };
  labels: { name: string }[];
  mergeable?: boolean | null;
};

/** Queue every bot pin-refresh pull request that is ready. Returns what it did, one line each. */
export async function queueBotPinPulls(input: {
  api: ReturnType<typeof githubApi>;
  owner: string;
  dryRun?: boolean;
}): Promise<string[]> {
  const report: string[] = [];
  for (const branch of BOT_PIN_BRANCHES) {
    const open = await input.api<RestPull[]>(
      `pulls?state=open&head=${encodeURIComponent(`${input.owner}:${branch}`)}`,
    );
    if (open.length === 0) {
      report.push(`${branch}: no open pull request`);
      continue;
    }
    for (const listed of open) {
      // The single-PR read reports `mergeable`; the list does not.
      const pull = await input.api<RestPull>(`pulls/${listed.number}`);
      const commits = await input.api<{ author: RestUser; committer: RestUser }[]>(
        `pulls/${pull.number}/commits?per_page=100`,
      );
      const checks = await input.api<{ check_runs: CheckRunFacts[] }>(
        `commits/${pull.head.sha}/check-runs?check_name=${encodeURIComponent(PR_CI_CHECK)}&filter=all&per_page=100`,
      );
      const verdict = queueVerdict(
        {
          number: pull.number,
          state: pull.state,
          draft: pull.draft === true,
          author: pull.user?.login ?? null,
          headRef: pull.head.ref,
          headSha: pull.head.sha,
          headRepository: pull.head.repo?.full_name ?? null,
          baseRepository: pull.base.repo.full_name,
          labels: pull.labels.map((label) => label.name),
          mergeable: pull.mergeable ?? null,
        },
        commits.map((commit) => ({
          author: commit.author?.login ?? null,
          committer: commit.committer?.login ?? null,
        })),
        checks.check_runs,
      );
      if (!verdict.queue) {
        report.push(`#${pull.number}: not queued, ${verdict.reason}`);
        continue;
      }
      if (!input.dryRun) {
        await input.api(`issues/${pull.number}/labels`, {
          method: "POST",
          body: { labels: [QUEUE_LABEL] },
        });
      }
      report.push(
        `#${pull.number}: ${input.dryRun ? "would queue" : "queued"} ${pull.head.sha.slice(0, 10)}`,
      );
    }
  }
  return report;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const report = await queueBotPinPulls({
    api: githubApi({ token, repository }),
    owner: repository.split("/")[0]!,
    dryRun: values["dry-run"] === true,
  });
  for (const line of report) console.log(line);
}
