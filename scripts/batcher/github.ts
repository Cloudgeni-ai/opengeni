// The few GitHub calls the batcher needs. All state lives in GitHub itself:
// queued PRs, the batch/* branch with its manifest commit, and its CI runs.

import type { RepoFile, TreeEntry } from "./renumber";
import { REGENERATE_WORKFLOW, regenerationTitle, unzipText } from "./regenerate";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`GitHub ${status} for ${path}: ${body.slice(0, 300)}`);
  }
}

/** A request that never got an answer: the network failed or it timed out. */
export class GitHubNetworkError extends Error {
  constructor(
    readonly path: string,
    readonly failure: unknown,
  ) {
    super(`No answer from GitHub for ${path}: ${String(failure).slice(0, 300)}`);
  }
}

export interface PullSummary {
  id: string;
  number: number;
  title: string;
  headSha: string;
  headRef: string;
  sameRepository: boolean;
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  labels: string[];
  /** Latest time the queue-ready label was added, if it is present. */
  labeledAt: number | null;
  /** When auto-merge was enabled, if it is. */
  autoMergeAt: number | null;
}

export interface PullFile {
  path: string;
  /** GitHub's file status: added, modified, removed, renamed, copied, changed. */
  status: string;
  /** The old path of a renamed file. */
  previous?: string;
}

export interface CheckSummary {
  conclusion: string | null;
  status: string;
  completedAt: number | null;
  workflow: string | null;
  runHeadSha: string | null;
}

export interface RunSummary {
  id: number;
  workflow: string;
  status: string;
  conclusion: string | null;
  attempt: number;
  url: string;
}

export interface CommitSummary {
  sha: string;
  tree: string;
  message: string;
  date: number;
  /** Parent commit SHAs, first parent first. */
  parents: string[];
}

export type MergeResult = { kind: "merged"; sha: string; tree: string } | { kind: "conflict" };

/** The GitHub surface the batcher uses; tests substitute an in-memory fake. */
export interface GitHub {
  mainSha(): Promise<string>;
  queuedPulls(queueLabel: string): Promise<PullSummary[]>;
  check(headSha: string, name: string): Promise<CheckSummary | null>;
  /** Null when the PR changes too many files to list. */
  pullFiles(number: number): Promise<PullFile[] | null>;
  /** Paths of the files directly in a directory at a commit. */
  listDirectory(path: string, ref: string): Promise<string[]>;
  /** These files at a commit, keyed by path; a path that is not a file there is absent. */
  readFiles(ref: string, paths: string[]): Promise<Map<string, RepoFile>>;
  /** Files `head` changes since its merge base with `base`; null files when too many to list. */
  compareFiles(base: string, head: string): Promise<{ files: string[] | null; mergeBase: string }>;
  branches(prefix: string): Promise<{ name: string; sha: string }[]>;
  /** The head of exactly this branch, or null when it no longer exists. */
  branchHead(name: string): Promise<string | null>;
  commit(sha: string): Promise<CommitSummary>;
  runs(branch: string, sha: string): Promise<RunSummary[]>;
  /** Names of the jobs that failed or timed out in this attempt of a run. */
  failedJobs(runId: number, attempt: number): Promise<string[]>;
  /** Runs of the regeneration workflow for exactly this PR head, newest first. */
  regenerations(pull: number, head: string): Promise<RunSummary[]>;
  /** Start the regeneration workflow from main: merge `main` into the PR head and regenerate. */
  dispatchRegeneration(pull: number, head: string, main: string): Promise<void>;
  /** The text of one file in a run's artifact, or null when the run has no such file. */
  artifactText(runId: number, artifact: string, file: string): Promise<string | null>;
  /** Store file content given in base64; returns the blob SHA. */
  createBlob(content: string): Promise<string>;
  createBranch(name: string, sha: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  mergeInto(branch: string, head: string, message: string): Promise<MergeResult>;
  createCommit(tree: string, parents: string[], message: string): Promise<string>;
  createTree(baseTree: string, entries: TreeEntry[]): Promise<string>;
  /** Move a branch forward to a descendant of its head; fails with 422 otherwise. */
  updateBranch(name: string, sha: string): Promise<void>;
  mergePull(
    number: number,
    input: { sha: string; method: "squash" | "merge"; title?: string; message: string },
  ): Promise<string>;
  cancelRun(id: number): Promise<void>;
  rerunFailedJobs(id: number): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  /** The bodies of a PR's comments created or edited at or after `since` (epoch ms). */
  commentBodies(number: number, since: number): Promise<string[]>;
  removeLabel(number: number, label: string): Promise<void>;
  addLabel(number: number, label: string): Promise<void>;
  /** Creates the label unless it already exists. */
  ensureLabel(label: string, color: string, description: string): Promise<void>;
  /** Numbers of issues and PRs, open or closed, that carry the label. */
  labelled(label: string): Promise<number[]>;
  disableAutoMerge(pullId: string): Promise<void>;
}

const time = (value: unknown) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** GraphQL gives a tree entry's mode as a number, like 33188; Git writes it in octal, "100644". */
export function gitFileMode(mode: number): string {
  return mode.toString(8);
}

/**
 * A failure that says nothing about the request itself: GitHub down or
 * throttling, or no answer at all. Anything else, including a bug in our own
 * code, would fail the same way again.
 */
export function isTransientGitHubFailure(error: unknown): boolean {
  if (error instanceof GitHubError)
    return (
      error.status >= 500 ||
      error.status === 429 ||
      (error.status === 403 && /rate limit/i.test(error.body))
    );
  return error instanceof GitHubNetworkError;
}

/** A branch name as URL path segments, so no part of it can change the request path. */
const branchPath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/**
 * When a PR that carries the queue label was last given it, from its newest
 * label events. If other labels (such as in-batch, added on every batch) have
 * pushed that event out of the window, it was added before the oldest event
 * read, so that time stands in: the PR stays queued instead of leaving.
 */
export function queuedTime(
  events: ({ createdAt: string; label: { name: string } } | null)[],
  queueLabel: string,
): number {
  const times = (name?: string) =>
    events
      .filter((e) => e !== null && (name === undefined || e.label?.name === name))
      .map((e) => time(e!.createdAt))
      .filter((t): t is number => t !== null);
  const queued = times(queueLabel);
  if (queued.length) return Math.max(...queued);
  const all = times();
  return all.length ? Math.min(...all) : 0;
}

export class RestGitHub implements GitHub {
  private readonly api: string;
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
    this.api = `https://api.github.com/repos/${repository}`;
  }

  private async request(method: string, path: string, body?: unknown, okStatuses: number[] = []) {
    const url = path.startsWith("https://") ? path : `${this.api}/${path}`;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        // fetch rejects only when no response arrived (network failure or the
        // signal's timeout); a write's outcome is then unknown and re-observed.
        throw new GitHubNetworkError(path, error);
      }
      if (response.ok || okStatuses.includes(response.status)) {
        const text = await response.text();
        return { status: response.status, data: text ? (JSON.parse(text) as unknown) : null };
      }
      const text = await response.text();
      // Only reads are retried; a write with an unknown outcome is re-observed next pass.
      if (method === "GET" && attempt < 3 && (response.status >= 500 || response.status === 429)) {
        await Bun.sleep(2_000 * attempt);
        continue;
      }
      throw new GitHubError(response.status, path, text);
    }
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request("GET", path)).data as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.request("POST", "https://api.github.com/graphql", {
      query,
      variables,
    });
    const result = data as { data?: T; errors?: { message: string }[] };
    if (result.errors?.length || !result.data)
      throw new Error(`GraphQL: ${result.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
    return result.data;
  }

  async mainSha() {
    return (await this.get<{ object: { sha: string } }>("git/ref/heads/main")).object.sha;
  }

  async queuedPulls(queueLabel: string) {
    const [owner, name] = this.repository.split("/");
    const pulls: PullSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      type Page = {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: {
              id: string;
              number: number;
              title: string;
              headRefOid: string;
              headRefName: string;
              isCrossRepository: boolean;
              isDraft: boolean;
              mergeable: PullSummary["mergeable"];
              autoMergeRequest: { enabledAt: string } | null;
              labels: { nodes: { name: string }[] };
              timelineItems: { nodes: ({ createdAt: string; label: { name: string } } | null)[] };
            }[];
          };
        };
      };
      const data: Page = await this.graphql<Page>(
        `query($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: OPEN, baseRefName: "main", first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id number title headRefOid headRefName isCrossRepository isDraft mergeable
                autoMergeRequest { enabledAt }
                labels(first: 30) { nodes { name } }
                timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
                  nodes { ... on LabeledEvent { createdAt label { name } } }
                }
              }
            }
          }
        }`,
        { owner, name, cursor },
      );
      const { nodes, pageInfo } = data.repository.pullRequests;
      for (const node of nodes) {
        const labels = node.labels.nodes.map((l) => l.name);
        const autoMergeAt = node.autoMergeRequest ? time(node.autoMergeRequest.enabledAt) : null;
        const labeledAt = labels.includes(queueLabel)
          ? queuedTime(node.timelineItems.nodes, queueLabel)
          : null;
        if (labeledAt === null && autoMergeAt === null) continue;
        pulls.push({
          id: node.id,
          number: node.number,
          title: node.title,
          headSha: node.headRefOid,
          headRef: node.headRefName,
          sameRepository: !node.isCrossRepository,
          draft: node.isDraft,
          mergeable: node.mergeable,
          labels,
          labeledAt,
          autoMergeAt,
        });
      }
      if (!pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    return pulls;
  }

  async check(headSha: string, name: string) {
    const data = await this.get<{
      check_runs: {
        status: string;
        conclusion: string | null;
        completed_at: string | null;
        details_url: string | null;
        app: { slug: string } | null;
      }[];
    }>(`commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`);
    const run = data.check_runs.find((c) => c.app?.slug === "github-actions");
    if (!run) return null;
    // The workflow behind the check, so another workflow cannot supply it.
    const runId = /\/actions\/runs\/(\d+)/.exec(run.details_url ?? "")?.[1];
    let workflow: string | null = null,
      runHeadSha: string | null = null;
    if (runId) {
      const workflowRun = await this.get<{ path: string; head_sha: string }>(
        `actions/runs/${runId}`,
      );
      workflow = workflowRun.path;
      runHeadSha = workflowRun.head_sha;
    }
    return {
      status: run.status,
      conclusion: run.conclusion,
      completedAt: time(run.completed_at),
      workflow,
      runHeadSha,
    };
  }

  async pullFiles(number: number) {
    const files: PullFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.get<
        { filename: string; status: string; previous_filename?: string }[]
      >(`pulls/${number}/files?per_page=100&page=${page}`);
      for (const file of batch)
        files.push({
          path: file.filename,
          status: file.status,
          ...(file.previous_filename ? { previous: file.previous_filename } : {}),
        });
      if (batch.length < 100) return files;
    }
    return null;
  }

  async listDirectory(path: string, ref: string) {
    // The contents API lists up to 1,000 entries, far more than the numbered
    // directories hold.
    const entries = await this.get<{ path: string; type: string }[]>(`contents/${path}?ref=${ref}`);
    return entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
  }

  async compareFiles(base: string, head: string) {
    const data = await this.get<{
      merge_base_commit: { sha: string };
      files?: { filename: string; previous_filename?: string }[];
    }>(`compare/${base}...${head}?per_page=300`);
    const files = (data.files ?? []).flatMap((f) =>
      f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
    );
    // The compare API lists at most 300 files; more is reported as unknown.
    const listed = (data.files ?? []).length < 300;
    return { files: listed ? files : null, mergeBase: data.merge_base_commit.sha };
  }

  async readFiles(ref: string, paths: string[]) {
    const files = new Map<string, RepoFile>();
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`Not a commit SHA: ${ref}`);
    const [owner, name] = this.repository.split("/");
    const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
    for (let start = 0; start < paths.length; start += 40) {
      const chunk = paths.slice(start, start + 40);
      const directories = [...new Set(chunk.map(directory))];
      // Expressions travel as variables; a path never becomes query text.
      const variables: Record<string, unknown> = { owner, name };
      const fields: string[] = [];
      chunk.forEach((path, index) => {
        variables[`f${index}`] = `${ref}:${path}`;
        fields.push(
          `f${index}: object(expression: $f${index}) { ... on Blob { oid text isBinary isTruncated } }`,
        );
      });
      directories.forEach((path, index) => {
        variables[`d${index}`] = `${ref}:${path}`;
        fields.push(
          `d${index}: object(expression: $d${index}) { ... on Tree { entries { name mode type } } }`,
        );
      });
      const declared = Object.keys(variables)
        .filter((key) => key !== "owner" && key !== "name")
        .map((key) => `$${key}: String!`)
        .join(", ");
      type Blob = { oid: string; text: string | null; isBinary: boolean; isTruncated: boolean };
      type Tree = { entries: { name: string; mode: number; type: string }[] };
      const data = await this.graphql<{ repository: Record<string, Blob | Tree | null> }>(
        `query($owner: String!, $name: String!, ${declared}) {
          repository(owner: $owner, name: $name) { ${fields.join("\n")} }
        }`,
        variables,
      );
      const modes = new Map<string, string>();
      directories.forEach((path, index) => {
        const tree = data.repository[`d${index}`] as Tree | null;
        for (const entry of tree?.entries ?? [])
          if (entry.type === "blob")
            modes.set(path ? `${path}/${entry.name}` : entry.name, gitFileMode(entry.mode));
      });
      chunk.forEach((path, index) => {
        const blob = data.repository[`f${index}`] as Blob | null;
        const mode = modes.get(path);
        if (!blob?.oid || mode === undefined) return;
        files.set(path, {
          oid: blob.oid,
          mode,
          text: blob.isBinary || blob.isTruncated ? null : blob.text,
        });
      });
    }
    return files;
  }

  async branches(prefix: string) {
    const refs = await this.get<{ ref: string; object: { sha: string } }[]>(
      `git/matching-refs/heads/${prefix}`,
    );
    return refs.map((r) => ({ name: r.ref.slice("refs/heads/".length), sha: r.object.sha }));
  }

  async branchHead(name: string) {
    const { status, data } = await this.request(
      "GET",
      `git/ref/heads/${branchPath(name)}`,
      undefined,
      [404],
    );
    if (status === 404) return null;
    return (data as { object: { sha: string } }).object.sha;
  }

  async commit(sha: string) {
    const data = await this.get<{
      sha: string;
      tree: { sha: string };
      message: string;
      committer: { date: string };
      parents: { sha: string }[];
    }>(`git/commits/${sha}`);
    return {
      sha: data.sha,
      tree: data.tree.sha,
      message: data.message,
      date: time(data.committer.date) ?? 0,
      parents: data.parents.map((parent) => parent.sha),
    };
  }

  async runs(branch: string, sha: string) {
    const data = await this.get<{
      workflow_runs: {
        id: number;
        path: string;
        event: string;
        head_branch: string;
        head_sha: string;
        status: string;
        conclusion: string | null;
        run_attempt: number;
        html_url: string;
      }[];
    }>(`actions/runs?branch=${encodeURIComponent(branch)}&head_sha=${sha}&event=push&per_page=100`);
    return data.workflow_runs
      .filter((r) => r.head_branch === branch && r.head_sha === sha && r.event === "push")
      .map((r) => ({
        id: r.id,
        workflow: r.path,
        status: r.status,
        conclusion: r.conclusion,
        attempt: r.run_attempt,
        url: r.html_url,
      }));
  }

  async failedJobs(runId: number, attempt: number) {
    const failed: string[] = [];
    // CI has about 65 jobs; the cap only bounds a runaway listing.
    for (let page = 1; page <= 5; page++) {
      const data = await this.get<{
        total_count: number;
        jobs: { name: string; conclusion: string | null }[];
      }>(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      for (const job of data.jobs)
        if (job.conclusion === "failure" || job.conclusion === "timed_out") failed.push(job.name);
      if (page * 100 >= data.total_count || !data.jobs.length) return failed;
    }
    throw new Error(`Run ${runId} has more jobs than the batcher lists`);
  }

  async regenerations(pull: number, head: string) {
    const workflow = REGENERATE_WORKFLOW.slice(REGENERATE_WORKFLOW.lastIndexOf("/") + 1);
    const data = await this.get<{
      workflow_runs: {
        id: number;
        path: string;
        event: string;
        head_branch: string;
        display_title: string;
        status: string;
        conclusion: string | null;
        run_attempt: number;
        html_url: string;
      }[];
    }>(`actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=100`);
    const title = regenerationTitle(pull, head);
    // Only main's copy of the workflow, run for exactly this head, counts.
    return data.workflow_runs
      .filter(
        (r) =>
          r.path === REGENERATE_WORKFLOW &&
          r.event === "workflow_dispatch" &&
          r.head_branch === "main" &&
          r.display_title === title,
      )
      .sort((a, b) => b.id - a.id)
      .map((r) => ({
        id: r.id,
        workflow: r.path,
        status: r.status,
        conclusion: r.conclusion,
        attempt: r.run_attempt,
        url: r.html_url,
      }));
  }

  async dispatchRegeneration(pull: number, head: string, main: string) {
    const workflow = REGENERATE_WORKFLOW.slice(REGENERATE_WORKFLOW.lastIndexOf("/") + 1);
    await this.request("POST", `actions/workflows/${workflow}/dispatches`, {
      ref: "main",
      inputs: { pull: String(pull), head, main },
    });
  }

  async artifactText(runId: number, artifact: string, file: string) {
    const data = await this.get<{
      artifacts: { name: string; expired: boolean; archive_download_url: string }[];
    }>(`actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifact)}&per_page=10`);
    const found = data.artifacts.find((a) => a.name === artifact && !a.expired);
    if (!found) return null;
    const url = found.archive_download_url;
    const fetchOnce = async (target: string, authorized: boolean) => {
      try {
        return await this.fetchImpl(target, {
          headers: authorized
            ? {
                authorization: `Bearer ${this.token}`,
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
              }
            : {},
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new GitHubNetworkError(target, error);
      }
    };
    // GitHub answers with a redirect to short-lived storage, which takes no token.
    let response = await fetchOnce(url, true);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location)
      response = await fetchOnce(location, false);
    if (!response.ok) throw new GitHubError(response.status, url, await response.text());
    return unzipText(new Uint8Array(await response.arrayBuffer()), file);
  }

  async createBlob(content: string) {
    const { data } = await this.request("POST", "git/blobs", { content, encoding: "base64" });
    return (data as { sha: string }).sha;
  }

  async createBranch(name: string, sha: string) {
    await this.request("POST", "git/refs", { ref: `refs/heads/${name}`, sha });
  }

  async deleteBranch(name: string) {
    // Already gone is fine: the goal is that it does not exist.
    await this.request("DELETE", `git/refs/heads/${name}`, undefined, [404, 422]);
  }

  async mergeInto(branch: string, head: string, message: string): Promise<MergeResult> {
    const result = await this.request(
      "POST",
      "merges",
      { base: branch, head, commit_message: message },
      [409],
    );
    if (result.status === 409) return { kind: "conflict" };
    const data = result.data as { sha: string; commit: { tree: { sha: string } } } | null;
    if (result.status !== 201 || !data) throw new Error(`Merging ${head} made no merge commit`);
    return { kind: "merged", sha: data.sha, tree: data.commit.tree.sha };
  }

  async createCommit(tree: string, parents: string[], message: string) {
    const { data } = await this.request("POST", "git/commits", { tree, parents, message });
    return (data as { sha: string }).sha;
  }

  async createTree(baseTree: string, entries: TreeEntry[]) {
    const { data } = await this.request("POST", "git/trees", {
      base_tree: baseTree,
      tree: entries.map((entry) => ({ ...entry, type: "blob" })),
    });
    return (data as { sha: string }).sha;
  }

  async updateBranch(name: string, sha: string) {
    await this.request("PATCH", `git/refs/heads/${branchPath(name)}`, { sha, force: false });
  }

  async mergePull(
    number: number,
    input: { sha: string; method: "squash" | "merge"; title?: string; message: string },
  ) {
    const body = {
      sha: input.sha,
      merge_method: input.method,
      ...(input.title ? { commit_title: input.title } : {}),
      commit_message: input.message,
    };
    // Right after main moves, GitHub briefly answers 405 ("Base branch was
    // modified") while it recomputes mergeability. Nothing merged, so retry.
    for (let attempt = 1; ; attempt++) {
      try {
        const { data } = await this.request("PUT", `pulls/${number}/merge`, body);
        return (data as { sha: string }).sha;
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 405 || attempt >= 8) throw error;
        await Bun.sleep(3_000 * attempt);
      }
    }
  }

  async cancelRun(id: number) {
    await this.request("POST", `actions/runs/${id}/cancel`, undefined, [409]);
  }

  async rerunFailedJobs(id: number) {
    await this.request("POST", `actions/runs/${id}/rerun-failed-jobs`, {});
  }

  async comment(number: number, body: string) {
    await this.request("POST", `issues/${number}/comments`, { body });
  }

  async commentBodies(number: number, since: number) {
    const bodies: string[] = [];
    const after = encodeURIComponent(new Date(since).toISOString());
    for (let page = 1; page <= 30; page++) {
      const data = await this.get<{ body?: string | null }[]>(
        `issues/${number}/comments?since=${after}&per_page=100&page=${page}`,
      );
      bodies.push(...data.map((comment) => comment.body ?? ""));
      if (data.length < 100) break;
    }
    return bodies;
  }

  async removeLabel(number: number, label: string) {
    await this.request(
      "DELETE",
      `issues/${number}/labels/${encodeURIComponent(label)}`,
      undefined,
      [404],
    );
  }

  async addLabel(number: number, label: string) {
    await this.request("POST", `issues/${number}/labels`, { labels: [label] });
  }

  async ensureLabel(label: string, color: string, description: string) {
    // 422 means it already exists.
    await this.request("POST", "labels", { name: label, color, description }, [422]);
  }

  async labelled(label: string) {
    const numbers: number[] = [];
    // The batcher clears the label as members leave, so few issues carry it.
    for (let page = 1; page <= 10; page++) {
      const batch = await this.get<{ number: number }[]>(
        `issues?labels=${encodeURIComponent(label)}&state=all&per_page=100&page=${page}`,
      );
      numbers.push(...batch.map((issue) => issue.number));
      if (batch.length < 100) break;
    }
    return numbers;
  }

  async disableAutoMerge(pullId: string) {
    await this.graphql(
      `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`,
      { id: pullId },
    );
  }
}
