// The few GitHub calls the batcher needs. All state lives in GitHub itself:
// queued PRs, the batch/* branch with its manifest commit, and its CI runs.

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`GitHub ${status} for ${path}: ${body.slice(0, 300)}`);
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
  compareFiles(base: string, head: string): Promise<{ files: string[]; mergeBase: string } | null>;
  branches(prefix: string): Promise<{ name: string; sha: string }[]>;
  commit(sha: string): Promise<CommitSummary>;
  runs(branch: string, sha: string): Promise<RunSummary[]>;
  createBranch(name: string, sha: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  mergeInto(branch: string, head: string, message: string): Promise<MergeResult>;
  createCommit(tree: string, parents: string[], message: string): Promise<string>;
  mergePull(
    number: number,
    input: { sha: string; method: "squash" | "merge"; title?: string; message: string },
  ): Promise<string>;
  cancelRun(id: number): Promise<void>;
  rerunFailedJobs(id: number): Promise<void>;
  comment(number: number, body: string): Promise<void>;
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
      const response = await this.fetchImpl(url, {
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
                timelineItems(itemTypes: [LABELED_EVENT], last: 30) {
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
        const labeled = node.timelineItems.nodes
          .filter((e) => e?.label?.name === queueLabel)
          .map((e) => time(e!.createdAt))
          .filter((t): t is number => t !== null);
        const autoMergeAt = node.autoMergeRequest ? time(node.autoMergeRequest.enabledAt) : null;
        const labeledAt =
          labels.includes(queueLabel) && labeled.length ? Math.max(...labeled) : null;
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
    if ((data.files ?? []).length >= 300) return null;
    return { files, mergeBase: data.merge_base_commit.sha };
  }

  async branches(prefix: string) {
    const refs = await this.get<{ ref: string; object: { sha: string } }[]>(
      `git/matching-refs/heads/${prefix}`,
    );
    return refs.map((r) => ({ name: r.ref.slice("refs/heads/".length), sha: r.object.sha }));
  }

  async commit(sha: string) {
    const data = await this.get<{
      sha: string;
      tree: { sha: string };
      message: string;
      committer: { date: string };
    }>(`git/commits/${sha}`);
    return {
      sha: data.sha,
      tree: data.tree.sha,
      message: data.message,
      date: time(data.committer.date) ?? 0,
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
