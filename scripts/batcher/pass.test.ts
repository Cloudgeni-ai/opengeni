import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  CheckSummary,
  CommitSummary,
  GitHub,
  MergeResult,
  PullSummary,
  RunSummary,
} from "./github";
import { GitHubError, GitHubNetworkError } from "./github";
import { CI_WORKFLOW, DEFAULT_SETTINGS, PRIORITY_LABEL, QUEUE_LABEL, parseManifest } from "./model";
import { LandingMismatch, PR_WORKFLOW, run } from "./pass";
import type { RepoFile, TreeEntry } from "./renumber";

const NOW = 1_800_000_000_000;
const hash = (value: string) => createHash("sha1").update(value).digest("hex");

interface FakePull {
  number: number;
  title: string;
  head: string;
  files: string[];
  labels: string[];
  green: boolean;
  /** Its PR CI finished on this head without passing. */
  ciFailed?: boolean;
  /** Its PR CI on this head: still running, or finished another way than passing. */
  ci?: "running" | "cancelled" | "timed_out";
  /** When its head was committed, if not ten minutes ago. */
  headAt?: number;
  mergeable?: "MERGEABLE" | "CONFLICTING";
  merged?: string;
  headRef?: string;
}

/**
 * GitHub in memory. A tree is the sorted set of PR heads applied on top of the
 * root commit, so a batch candidate and the squash commits that land it agree
 * exactly when they apply the same heads.
 */
class FakeGitHub implements GitHub {
  commits = new Map<string, CommitSummary & { applied: string[]; parents: string[] }>();
  refs = new Map<string, string>();
  pulls = new Map<number, FakePull>();
  runsBySha = new Map<string, RunSummary[]>();
  comments: { number: number; body: string }[] = [];
  conflicts: [string, string][] = [];
  log: string[] = [];
  /** Lets a test corrupt what GitHub lands. */
  landedExtra: string[] = [];
  /** A head that applies exactly what another head applies, like main merged in again. */
  sameContent = new Map<string, string>();
  /** File texts, the same at every commit. */
  texts = new Map<string, string>();
  trees = new Map<string, { base: string; entries: TreeEntry[] }>();
  branchUpdates: { name: string; sha: string }[] = [];
  /** Commits that files and directory listings were read at, after observing. */
  reads: string[] = [];
  /** How GitHub answers a branch update: refuse it, or refuse it because the branch just moved. */
  updateRefusal: "refused" | "moved" | null = null;
  /** Thrown by readFiles, to stand for GitHub or the planner failing. */
  readFailure: Error | null = null;
  /** Thrown by comment, to stand for GitHub failing after a branch update. */
  commentFailure: Error | null = null;
  /** Exact branch names looked up with branchHead. */
  headLookups: string[] = [];
  /** Heads whose compare lists too many files to show. */
  tooManyFiles = new Set<string>();
  /** The `since` of every comment lookup. */
  commentLookups: number[] = [];

  constructor() {
    this.root = this.store([], [], "root");
    this.refs.set("main", this.root);
  }

  root: string;

  /** Make a PR's head a real commit: the root plus that PR. */
  headCommit(number: number) {
    const head = this.pulls.get(number)!.head;
    const tree = hash(`tree:${head}`);
    this.commits.set(head, {
      sha: head,
      tree,
      message: `head ${number}`,
      date: NOW,
      applied: [head],
      parents: [this.root],
    });
  }

  store(applied: string[], parents: string[], message: string) {
    const sorted = [...new Set(applied)].sort();
    const tree = hash(`tree:${sorted.join(",")}`);
    const sha = hash(`commit:${tree}:${parents.join(",")}:${message}`);
    this.commits.set(sha, { sha, tree, message, date: NOW, applied: sorted, parents });
    return sha;
  }

  content(head: string) {
    return this.sameContent.get(head) ?? head;
  }

  addPull(number: number, extra: Partial<FakePull> = {}) {
    this.pulls.set(number, {
      number,
      title: `Change ${number}`,
      head: hash(`head:${number}`),
      files: [`packages/p${number}/index.ts`],
      labels: [QUEUE_LABEL],
      green: true,
      ...extra,
    });
  }

  async mainSha() {
    return this.refs.get("main")!;
  }

  async queuedPulls(): Promise<PullSummary[]> {
    return [...this.pulls.values()]
      .filter((p) => !p.merged && p.labels.includes(QUEUE_LABEL))
      .map((p) => ({
        id: `node${p.number}`,
        number: p.number,
        title: p.title,
        headSha: p.head,
        headRef: this.headRef(p),
        sameRepository: true,
        draft: false,
        mergeable: p.mergeable ?? ("MERGEABLE" as const),
        labels: p.labels,
        labeledAt: NOW - 3_600_000 + p.number,
        autoMergeAt: null,
      }));
  }

  headRef(p: FakePull) {
    return p.headRef ?? (p.title === "Version" ? "changeset-release/main" : `branch-${p.number}`);
  }

  async check(headSha: string): Promise<CheckSummary | null> {
    const pull = [...this.pulls.values()].find((p) => p.head === headSha);
    if (pull?.ci)
      return {
        status: pull.ci === "running" ? "in_progress" : "completed",
        conclusion: pull.ci === "running" ? null : pull.ci,
        completedAt: pull.ci === "running" ? null : NOW - 3_600_000,
        workflow: PR_WORKFLOW,
        runHeadSha: headSha,
      };
    if (pull?.ciFailed)
      return {
        status: "completed",
        conclusion: "failure",
        completedAt: NOW - 3_600_000,
        workflow: PR_WORKFLOW,
        runHeadSha: headSha,
      };
    if (!pull?.green) return null;
    return {
      status: "completed",
      conclusion: "success",
      completedAt: NOW - 3_600_000,
      workflow: PR_WORKFLOW,
      runHeadSha: headSha,
    };
  }

  async pullFiles(number: number) {
    return this.pulls.get(number)!.files.map((path) => ({ path, status: "added" }));
  }

  /** The files of every PR applied in that commit, directly in the directory. */
  async listDirectory(path: string, ref: string) {
    if (ref !== this.refs.get("main")) this.reads.push(ref);
    const applied = new Set(this.commits.get(ref)!.applied);
    return [...this.pulls.values()]
      .filter((p) => applied.has(p.head))
      .flatMap((p) => p.files)
      .filter((file) => file.slice(0, file.lastIndexOf("/")) === path);
  }

  async readFiles(ref: string, paths: string[]) {
    this.reads.push(ref);
    if (this.readFailure) throw this.readFailure;
    const files = new Map<string, RepoFile>();
    for (const path of paths) {
      const text = this.texts.get(path);
      if (text !== undefined) files.set(path, { text, mode: "100644", oid: hash(`blob:${text}`) });
    }
    return files;
  }

  /** The merge base is `base` itself when `head` already contains it. */
  async compareFiles(base: string, head: string) {
    const from = this.commits.get(base);
    // A known commit brings what it applies; a PR head brings itself on the root.
    const to = this.commits.get(head)?.applied ?? [this.content(head)];
    const contained = from && from.applied.every((item) => to.includes(item));
    const mergeBase = contained ? base : this.root;
    const before = new Set(this.commits.get(mergeBase)!.applied);
    const changed = to.filter((item) => !before.has(item));
    const files = [...this.pulls.values()]
      .filter((p) => changed.includes(this.content(p.head)))
      .flatMap((p) => p.files);
    return { files: this.tooManyFiles.has(head) ? null : files, mergeBase };
  }

  async branches(prefix: string) {
    const pullBranches = [...this.pulls.values()].map((p) => [this.headRef(p), p.head] as const);
    return [...this.refs, ...pullBranches]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, sha]) => ({ name, sha }));
  }

  async branchHead(name: string) {
    this.headLookups.push(name);
    const pull = [...this.pulls.values()].find((p) => this.headRef(p) === name);
    return pull?.head ?? this.refs.get(name) ?? null;
  }

  async commit(sha: string) {
    const commit = this.commits.get(sha);
    if (commit) return commit;
    // A PR head the test did not make a real commit: the root plus that PR.
    const pull = [...this.pulls.values()].find((p) => p.head === sha);
    if (!pull) throw new Error(`no commit ${sha}`);
    return {
      sha,
      tree: hash(`tree:${sha}`),
      message: `head ${pull.number}`,
      date: pull.headAt ?? NOW - 600_000,
      applied: [sha],
      parents: [this.root],
    };
  }

  async runs(_branch: string, sha: string) {
    return this.runsBySha.get(sha) ?? [];
  }

  async createBranch(name: string, sha: string) {
    if (this.refs.has(name)) throw new Error(`${name} exists`);
    this.refs.set(name, sha);
    this.log.push(`create ${name}`);
  }

  async deleteBranch(name: string) {
    this.refs.delete(name);
  }

  async mergeInto(branch: string, head: string, message: string): Promise<MergeResult> {
    const base = this.commits.get(this.refs.get(branch)!)!;
    if (
      this.conflicts.some(
        ([a, b]) =>
          (a === head && base.applied.includes(b)) || (b === head && base.applied.includes(a)),
      )
    )
      return { kind: "conflict" };
    // A known commit (main) brings what it applies; a PR head brings itself.
    const incoming = this.commits.get(head)?.applied ?? [this.content(head)];
    const sha = this.store([...base.applied, ...incoming], [base.sha, head], message);
    this.refs.set(branch, sha);
    return { kind: "merged", sha, tree: this.commits.get(sha)!.tree };
  }

  async createCommit(tree: string, parents: string[], message: string) {
    const parent = this.commits.get(parents[0]!)!;
    if (this.trees.has(tree))
      return this.store([...parent.applied, `tree:${tree}`], parents, message);
    if (parent.tree !== tree) throw new Error("fake only supports reusing the parent tree");
    return this.store(parent.applied, parents, message);
  }

  async createTree(base: string, entries: TreeEntry[]) {
    const sha = hash(`tree:${base}:${JSON.stringify(entries)}`);
    this.trees.set(sha, { base, entries });
    return sha;
  }

  async updateBranch(name: string, sha: string) {
    const pull = [...this.pulls.values()].find((p) => this.headRef(p) === name)!;
    if (this.updateRefusal === "moved") pull.head = hash(`pushed meanwhile:${pull.head}`);
    if (this.updateRefusal) throw new GitHubError(422, `git/refs/heads/${name}`, "refused");
    const ancestors = new Set<string>();
    for (const queue = [sha]; queue.length;) {
      const next = queue.pop()!;
      if (ancestors.has(next)) continue;
      ancestors.add(next);
      queue.push(...(this.commits.get(next)?.parents ?? []));
    }
    if (!ancestors.has(pull.head)) throw new GitHubError(422, `git/refs/heads/${name}`, "not ff");
    this.branchUpdates.push({ name, sha });
    pull.head = sha;
    pull.green = false;
  }

  async mergePull(
    number: number,
    input: { sha: string; method: "squash" | "merge"; title?: string; message: string },
  ) {
    const pull = this.pulls.get(number)!;
    if (pull.head !== input.sha) throw new Error("head changed");
    const main = this.commits.get(this.refs.get("main")!)!;
    const parents = input.method === "merge" ? [main.sha, pull.head] : [main.sha];
    const message = `${input.title ?? `Merge pull request #${number}`}\n\n${input.message}`;
    const sha = this.store(
      [...main.applied, this.content(pull.head), ...this.landedExtra],
      parents,
      message,
    );
    this.refs.set("main", sha);
    pull.merged = sha;
    this.log.push(`merge #${number} ${input.method} ${input.title ?? ""}`.trim());
    return sha;
  }

  async cancelRun(id: number) {
    this.log.push(`cancel ${id}`);
  }

  async rerunFailedJobs(id: number) {
    this.log.push(`rerun ${id}`);
  }

  async comment(number: number, body: string) {
    if (this.commentFailure) throw this.commentFailure;
    this.comments.push({ number, body });
  }

  async commentBodies(number: number, since: number) {
    this.commentLookups.push(since);
    return this.comments.filter((c) => c.number === number).map((c) => c.body);
  }

  async removeLabel(number: number, label: string) {
    const pull = this.pulls.get(number)!;
    pull.labels = pull.labels.filter((l) => l !== label);
  }

  async disableAutoMerge() {}

  /** The single batch branch and its manifest. */
  batch() {
    const entries = [...this.refs].filter(([name]) => name.startsWith("batch/"));
    expect(entries).toHaveLength(1);
    const [name, sha] = entries[0]!;
    return { name, sha, manifest: parseManifest(this.commits.get(sha)!.message)! };
  }

  finishCi(sha: string, conclusion: string, attempt = 1) {
    this.runsBySha.set(sha, [
      {
        id: 42,
        workflow: CI_WORKFLOW,
        status: "completed",
        conclusion,
        attempt,
        url: "https://github.com/o/r/actions/runs/42",
      },
    ]);
  }
}

let ids = 0;
const options = () => ({
  settings: DEFAULT_SETTINGS,
  now: () => NOW,
  log: () => {},
  randomId: () => (++ids).toString(16).padStart(12, "0"),
  deadline: NOW,
  sleep: async () => {},
});

describe("a batcher pass", () => {
  test("builds one candidate, then lands each PR as its own squash commit", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    gh.addPull(3, { files: [".github/workflows/ci.yml"] });
    const base = await gh.mainSha();

    await run(gh, options());
    const built = gh.batch();
    expect(built.manifest.base).toBe(base);
    expect(built.manifest.members.map((m) => m.number)).toEqual([1, 2]);
    expect(gh.commits.get(built.sha)!.tree).toBe(built.manifest.members[1]!.tree);
    expect([...gh.refs.keys()].some((name) => name.startsWith("batch-build/"))).toBe(false);

    // Nothing to do while CI runs.
    await run(gh, options());
    expect(gh.batch().sha).toBe(built.sha);

    gh.finishCi(built.sha, "success");
    await run(gh, options());
    expect(gh.log.filter((l) => l.startsWith("merge"))).toEqual([
      "merge #1 squash Change 1 (#1)",
      "merge #2 squash Change 2 (#2)",
    ]);
    const main = gh.commits.get(await gh.mainSha())!;
    expect(main.tree).toBe(built.manifest.members[1]!.tree);
    expect(main.parents).toHaveLength(1);
    expect(main.message).toBe(`Change 2 (#2)\n\nBatch: ${built.manifest.id}`);

    // The CI change was held back and now runs alone.
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([3]);
  });

  test("a Version PR lands as a true merge", async () => {
    const gh = new FakeGitHub();
    gh.addPull(5, { title: "Version" });
    await run(gh, options());
    const built = gh.batch();
    expect(built.manifest.members[0]).toMatchObject({ number: 5, version: true });
    gh.finishCi(built.sha, "success");
    await run(gh, options());
    expect(gh.log).toContain("merge #5 merge");
    expect(gh.commits.get(await gh.mainSha())!.parents).toHaveLength(2);
  });

  test("a queued Version PR holds main: the batch in flight lands, then only the Version PR", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    await run(gh, options());
    const inFlight = gh.batch();

    // Queued while #1's batch runs, with its PR CI still running.
    gh.addPull(5, { title: "Version", green: false });
    gh.addPull(2, { labels: [QUEUE_LABEL, PRIORITY_LABEL] });
    gh.addPull(3, { files: [".github/workflows/ci.yml"] });
    gh.addPull(4);
    await run(gh, options());
    expect(gh.batch().sha).toBe(inFlight.sha);

    gh.finishCi(inFlight.sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    const frozen = await gh.mainSha();
    // Nothing else builds: not the priority PR, the CI change or the others.
    expect([...gh.refs.keys()].filter((name) => name.startsWith("batch/"))).toEqual([]);
    await run(gh, options());
    expect(await gh.mainSha()).toBe(frozen);
    // Announced once for this head, looked up from the head's own time.
    expect(gh.comments).toEqual([
      { number: 5, body: expect.stringContaining("holding main for this Version PR") },
    ]);
    expect(gh.comments[0]!.body).toContain("remove the queue-ready label");
    expect(new Set(gh.commentLookups)).toEqual(new Set([NOW - 600_000]));

    gh.pulls.get(5)!.green = true;
    await run(gh, options());
    const version = gh.batch();
    expect(version.manifest.base).toBe(frozen);
    expect(version.manifest.members.map((m) => m.number)).toEqual([5]);

    gh.finishCi(version.sha, "success");
    await run(gh, options());
    expect(gh.log).toContain("merge #5 merge");
    // Normal batching resumes, priority first.
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([2]);
  });

  test("a Version PR whose PR CI failed leaves the queue and stops holding it", async () => {
    const gh = new FakeGitHub();
    gh.addPull(5, { title: "Version", ciFailed: true });
    gh.addPull(1);
    await run(gh, options());
    expect(gh.pulls.get(5)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments).toEqual([
      { number: 5, body: expect.stringContaining("its PR CI failed on its current head") },
    ]);
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([1]);
  });

  test("a Version PR main overtook keeps holding, is asked once to regenerate, then lands", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/sdk/package.json"] });
    await run(gh, options());
    const inFlight = gh.batch();
    gh.addPull(5, {
      title: "Version",
      files: ["packages/sdk/package.json", "packages/sdk/CHANGELOG.md"],
    });
    gh.addPull(2);
    gh.finishCi(inFlight.sha, "success");
    await run(gh, options());
    const frozen = await gh.mainSha();
    expect([...gh.refs.keys()].filter((name) => name.startsWith("batch/"))).toEqual([]);
    expect(gh.pulls.get(5)!.labels).toContain(QUEUE_LABEL);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("Run the Open Version PR workflow");
    await run(gh, options());
    expect(gh.comments).toHaveLength(1);
    expect(await gh.mainSha()).toBe(frozen);

    // Open Version PR regenerates it from the frozen main; it keeps its label.
    const content = hash("version regenerated");
    const regenerated = gh.store(
      [...gh.commits.get(frozen)!.applied, content],
      [frozen],
      "chore: version packages",
    );
    gh.sameContent.set(regenerated, content);
    gh.pulls.get(5)!.head = regenerated;
    await run(gh, options());
    const version = gh.batch();
    expect(version.manifest.base).toBe(frozen);
    expect(version.manifest.members).toEqual([
      expect.objectContaining({ number: 5, head: regenerated }),
    ]);
  });

  test("a Version PR that conflicts with main is held for a regenerate, never ejected", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    await run(gh, options());
    const inFlight = gh.batch();
    gh.addPull(5, { title: "Version" });
    // GitHub has not yet seen the conflict #1 brings: the build's own merge finds it.
    gh.conflicts.push([gh.pulls.get(5)!.head, gh.pulls.get(1)!.head]);
    gh.addPull(2);
    gh.finishCi(inFlight.sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    const frozen = await gh.mainSha();
    expect([...gh.refs.keys()].filter((name) => name.startsWith("batch/"))).toEqual([]);
    expect(gh.pulls.get(5)!.labels).toContain(QUEUE_LABEL);

    // Each later pass skips it again; it is never ejected.
    await run(gh, options());
    expect(await gh.mainSha()).toBe(frozen);
    expect(gh.pulls.get(5)!.labels).toContain(QUEUE_LABEL);
    expect(gh.comments).toEqual([]);
  });

  test("a Version PR GitHub marks conflicting is held for a regenerate, never ejected", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/sdk/package.json"] });
    await run(gh, options());
    const inFlight = gh.batch();
    // A real conflict: both change the same file.
    gh.addPull(5, {
      title: "Version",
      files: ["packages/sdk/package.json"],
      mergeable: "CONFLICTING",
    });
    gh.conflicts.push([gh.pulls.get(5)!.head, gh.pulls.get(1)!.head]);
    gh.finishCi(inFlight.sha, "success");
    await run(gh, options());
    await run(gh, options());
    const frozen = await gh.mainSha();
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    expect([...gh.refs.keys()].filter((name) => name.startsWith("batch/"))).toEqual([]);
    expect(gh.pulls.get(5)!.labels).toContain(QUEUE_LABEL);
    expect(gh.comments).toEqual([
      { number: 5, body: expect.stringContaining("Run the Open Version PR workflow") },
    ]);
    expect(gh.comments[0]!.body).not.toContain("Merge main into the branch");
    await run(gh, options());
    expect(await gh.mainSha()).toBe(frozen);
    expect(gh.comments).toHaveLength(1);
  });

  test("a cancelled PR CI run holds a Version PR until the hour is up, then it leaves", async () => {
    const gh = new FakeGitHub();
    gh.addPull(5, { title: "Version", green: false, ci: "cancelled" });
    gh.addPull(1);
    await run(gh, options());
    expect(gh.pulls.get(5)!.labels).toContain(QUEUE_LABEL);
    expect([...gh.refs.keys()].filter((name) => name.startsWith("batch/"))).toEqual([]);

    // An hour after it was queued and pushed, with no run passing or running.
    await run(gh, { ...options(), now: () => NOW + 3_600_000 });
    expect(gh.pulls.get(5)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments.at(-1)).toEqual({
      number: 5,
      body: expect.stringContaining("no PR CI run has passed or is running on its current head"),
    });
    // Normal batching resumes.
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([1]);
  });

  test("a running PR CI keeps holding past the hour; a timed-out one leaves at once", async () => {
    const gh = new FakeGitHub();
    gh.addPull(5, { title: "Version", green: false, ci: "running" });
    gh.addPull(1);
    await run(gh, { ...options(), now: () => NOW + 7_200_000 });
    expect(gh.pulls.get(5)!.labels).toContain(QUEUE_LABEL);
    expect([...gh.refs.keys()].filter((name) => name.startsWith("batch/"))).toEqual([]);

    gh.pulls.get(5)!.ci = "timed_out";
    await run(gh, options());
    expect(gh.pulls.get(5)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments.at(-1)!.body).toContain("its PR CI failed on its current head");
  });

  test("a Version PR with more files than compare lists is checked by its own file list", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/sdk/package.json"] });
    await run(gh, options());
    const inFlight = gh.batch();
    gh.addPull(5, { title: "Version", files: [".changeset/a.md", "packages/cli/package.json"] });
    gh.tooManyFiles.add(gh.pulls.get(5)!.head);
    gh.finishCi(inFlight.sha, "success");
    await run(gh, options());
    // Main changed none of its files, so it builds instead of waiting for a regenerate.
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([5]);
    expect(gh.comments).toEqual([]);
  });

  test("a Version PR built in the same pass as a bisection carries its remaining half", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    await run(gh, options());
    const first = gh.batch();
    gh.finishCi(first.sha, "failure");
    await run(gh, options());
    gh.finishCi(first.sha, "failure", 2);
    await run(gh, options());
    const half = gh.batch();
    expect(half.manifest.pending).toEqual([[2]]);

    gh.addPull(5, { title: "Version" });
    gh.finishCi(half.sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    // The Version PR builds alone and carries the remaining half.
    const version = gh.batch();
    expect(version.manifest.members.map((m) => m.number)).toEqual([5]);
    expect(version.manifest.pending).toEqual([[2]]);
    gh.finishCi(version.sha, "success");
    await run(gh, options());
    expect(gh.log).toContain("merge #5 merge");
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([2]);
  });

  test("retries flaky jobs, then bisects and ejects the culprit", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    await run(gh, options());
    const first = gh.batch();
    gh.finishCi(first.sha, "failure");
    await run(gh, options());
    expect(gh.log).toContain("rerun 42");

    gh.finishCi(first.sha, "failure", 2);
    await run(gh, options());
    const half = gh.batch();
    expect(half.manifest.members.map((m) => m.number)).toEqual([1]);
    expect(half.manifest.pending).toEqual([[2]]);

    gh.finishCi(half.sha, "failure", 2);
    await run(gh, options());
    expect(gh.comments.at(-1)).toMatchObject({ number: 1 });
    expect(gh.pulls.get(1)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([2]);
  });

  test("defers a PR that conflicts with an earlier one in the same batch", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    gh.addPull(3);
    gh.conflicts.push([gh.pulls.get(1)!.head, gh.pulls.get(2)!.head]);
    await run(gh, options());
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([1, 3]);
    expect(gh.pulls.get(2)!.labels).toContain(QUEUE_LABEL);
  });

  test("moves a PR's migration off a number main already uses, and keeps equal numbers apart", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/db/drizzle/0007_a.sql"], labels: [] });
    const landed = gh.store([gh.pulls.get(1)!.head], [await gh.mainSha()], "Change 1 (#1)");
    gh.refs.set("main", landed);
    gh.pulls.get(1)!.merged = landed;
    gh.addPull(2, {
      files: [
        "packages/db/drizzle/0007_b.sql",
        "packages/db/test/migration-0007-b.test.ts",
        "packages/db/src/b.ts",
      ],
    });
    gh.headCommit(2);
    gh.texts.set("packages/db/drizzle/0007_b.sql", "-- 0007: add b\ncreate table b ();\n");
    gh.texts.set("packages/db/test/migration-0007-b.test.ts", 'const file = "0007_b.sql";\n');
    gh.texts.set("packages/db/src/b.ts", "export const b = 1;\n");
    gh.addPull(3, { files: ["packages/db/drizzle/0008_c.sql"] });
    gh.addPull(4, { files: ["packages/db/drizzle/0008_d.sql"] });
    gh.addPull(5);
    const head = gh.pulls.get(2)!.head;

    await run(gh, options());
    // #2 stays queued on a new head: main merged in, its migration moved above
    // every number main and the other queued PRs use.
    expect(gh.pulls.get(2)!.labels).toContain(QUEUE_LABEL);
    expect(gh.branchUpdates).toHaveLength(1);
    const moved = gh.commits.get(gh.pulls.get(2)!.head)!;
    const merge = gh.commits.get(moved.parents[0]!)!;
    expect(merge.parents).toEqual([head, landed]);
    const tree = [...gh.trees.values()][0]!;
    expect(tree.base).toBe(merge.tree);
    expect(tree.entries).toEqual([
      { path: "packages/db/drizzle/0007_b.sql", mode: "100644", sha: null },
      {
        path: "packages/db/drizzle/0009_b.sql",
        mode: "100644",
        content: "-- 0009: add b\ncreate table b ();\n",
      },
      { path: "packages/db/test/migration-0007-b.test.ts", mode: "100644", sha: null },
      {
        path: "packages/db/test/migration-0009-b.test.ts",
        mode: "100644",
        content: 'const file = "0009_b.sql";\n',
      },
    ]);
    expect(gh.comments).toEqual([
      {
        number: 2,
        body: expect.stringContaining("moved `0007_b.sql` to `0009_b.sql`"),
      },
    ]);
    expect([...gh.refs.keys()].some((name) => name.startsWith("batch-build/"))).toBe(false);
    // #4 adds the same number as #3, so it waits for the next batch.
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([3, 5]);
    expect(gh.pulls.get(4)!.labels).toContain(QUEUE_LABEL);
  });

  test("ejects with the manual command when a moved migration's number is named ambiguously", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/db/drizzle/0007_a.sql"], labels: [] });
    const landed = gh.store([gh.pulls.get(1)!.head], [await gh.mainSha()], "Change 1 (#1)");
    gh.refs.set("main", landed);
    gh.pulls.get(1)!.merged = landed;
    gh.addPull(2, { files: ["packages/db/drizzle/0007_b.sql", "docs/b.md"] });
    gh.headCommit(2);
    gh.texts.set("packages/db/drizzle/0007_b.sql", "create table b ();\n");
    gh.texts.set("docs/b.md", "Migration 0007 adds b.\n");

    await run(gh, options());
    expect(gh.branchUpdates).toEqual([]);
    expect(gh.pulls.get(2)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments).toEqual([
      {
        number: 2,
        body: expect.stringContaining(
          "`docs/b.md` mentions 0007 without naming `0007_b`, so the batcher cannot tell which migration it means. Merge main into the branch and move it to the next free number: `bun scripts/renumber-migration.ts 0007_b --next`.",
        ),
      },
    ]);
  });

  /** Main lands 0007_a. */
  async function mainTakes0007(gh: FakeGitHub) {
    gh.addPull(1, { files: ["packages/db/drizzle/0007_a.sql"], labels: [] });
    const landed = gh.store([gh.pulls.get(1)!.head], [await gh.mainSha()], "Change 1 (#1)");
    gh.refs.set("main", landed);
    gh.pulls.get(1)!.merged = landed;
  }
  /** A queued PR that adds 0007_<slug>. */
  function addsMigration0007(gh: FakeGitHub, number: number, slug: string, extra = {}) {
    const path = `packages/db/drizzle/0007_${slug}.sql`;
    gh.addPull(number, { files: [path], ...extra });
    gh.headCommit(number);
    gh.texts.set(path, `create table ${slug} ();\n`);
  }

  test("PRs moved in one pass get different numbers, planned at the merged commit", async () => {
    const gh = new FakeGitHub();
    await mainTakes0007(gh);
    addsMigration0007(gh, 2, "b");
    addsMigration0007(gh, 3, "c");
    await run(gh, options());
    expect(gh.branchUpdates).toHaveLength(2);
    expect(gh.comments.map((c) => /to `(\d+)_/.exec(c.body)?.[1])).toEqual(["0008", "0009"]);
    // Files and the migration list are read where main is merged in, never at the PR head.
    const merges = gh.branchUpdates.map((update) => gh.commits.get(update.sha)!.parents[0]!);
    expect(gh.reads.length).toBeGreaterThan(0);
    for (const ref of gh.reads) expect(merges).toContain(ref);
  });

  test("a branch GitHub will not update ejects the PR; one that just moved waits", async () => {
    for (const refusal of ["refused", "moved"] as const) {
      const gh = new FakeGitHub();
      await mainTakes0007(gh);
      addsMigration0007(gh, 2, "b");
      gh.updateRefusal = refusal;
      await run(gh, options());
      expect(gh.branchUpdates).toEqual([]);
      // The branch is looked up by its exact name, never as a prefix.
      expect(gh.headLookups).toEqual(["branch-2"]);
      expect(gh.pulls.get(2)!.labels.includes(QUEUE_LABEL)).toBe(refusal === "moved");
      if (refusal === "refused")
        expect(gh.comments[0]!.body).toContain("GitHub refused to update its branch.");
      else expect(gh.comments).toEqual([]);
      expect([...gh.refs.keys()].some((name) => name.startsWith("batch-build/"))).toBe(false);
    }
  });

  test("a refused branch whose name looks like a path is looked up as that one name", async () => {
    const gh = new FakeGitHub();
    await mainTakes0007(gh);
    const headRef = "x/%2e%2e/%2e%2e/user";
    addsMigration0007(gh, 2, "b", { headRef });
    gh.updateRefusal = "refused";
    await run(gh, options());
    expect(gh.headLookups).toEqual([headRef]);
    expect(gh.pulls.get(2)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments[0]!.body).toContain("GitHub refused to update its branch.");
  });

  test("an outage postpones a move, any other failure ejects that PR, and the queue goes on", async () => {
    for (const [failure, ejected] of [
      [new GitHubError(502, "graphql", "bad gateway"), false],
      [new GitHubError(429, "graphql", "slow down"), false],
      [new GitHubError(403, "graphql", "API rate limit exceeded for installation"), false],
      [new GitHubNetworkError("graphql", new TypeError("fetch failed")), false],
      // A bug in our own code is not an outage: it would fail every pass.
      [new TypeError("Cannot read properties of null (reading 'map')"), true],
      [new GitHubError(403, "graphql", "Resource not accessible by integration"), true],
      [new Error("GraphQL: Could not resolve to a Repository"), true],
      [new Error("10000 does not fit a four-digit migration number"), true],
    ] as const) {
      const gh = new FakeGitHub();
      await mainTakes0007(gh);
      addsMigration0007(gh, 2, "b");
      gh.addPull(5);
      gh.readFailure = failure;
      await run(gh, options());
      expect(gh.branchUpdates).toEqual([]);
      expect(gh.pulls.get(2)!.labels.includes(QUEUE_LABEL)).toBe(!ejected);
      if (ejected)
        expect(gh.comments[0]!.body).toContain(`moving it failed (${failure.message.slice(0, 20)}`);
      else expect(gh.comments).toEqual([]);
      expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([5]);
    }
  });

  test("a failure after the branch update never ejects the moved PR", async () => {
    const gh = new FakeGitHub();
    await mainTakes0007(gh);
    addsMigration0007(gh, 2, "b");
    gh.commentFailure = new Error("comments are down");
    await run(gh, options());
    expect(gh.branchUpdates).toHaveLength(1);
    expect(gh.pulls.get(2)!.labels).toContain(QUEUE_LABEL);
    expect(gh.comments).toEqual([]);
  });

  test("never moves a migration on a production or release branch", async () => {
    for (const extra of [{ headRef: "production" }, { title: "Version" }]) {
      const gh = new FakeGitHub();
      await mainTakes0007(gh);
      addsMigration0007(gh, 2, "b", extra);
      await run(gh, options());
      expect(gh.branchUpdates).toEqual([]);
      expect(gh.pulls.get(2)!.labels).not.toContain(QUEUE_LABEL);
      expect(gh.comments[0]!.body).toContain("bun scripts/renumber-migration.ts 0007_b --next");
    }
  });

  test("a Git conflict still ejects a PR whose migration number main already uses", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/db/drizzle/0007_a.sql"], labels: [] });
    const landed = gh.store([gh.pulls.get(1)!.head], [await gh.mainSha()], "Change 1 (#1)");
    gh.refs.set("main", landed);
    gh.pulls.get(1)!.merged = landed;
    gh.addPull(2, { files: ["packages/db/drizzle/0007_b.sql"], mergeable: "CONFLICTING" });

    await run(gh, options());
    expect(gh.branchUpdates).toEqual([]);
    expect(gh.pulls.get(2)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments[0]!.body).toContain("it conflicts with main");
  });

  test("stops when a landed tree differs from the tested tree", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    await run(gh, options());
    gh.finishCi(gh.batch().sha, "success");
    gh.landedExtra = ["unexpected"];
    await expect(run(gh, options())).rejects.toBeInstanceOf(LandingMismatch);
  });

  test("a member's new head with the tested tree keeps its batch and lands that head", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    await run(gh, options());
    const built = gh.batch();

    // Main merged into #2 again: a new head, the same content.
    const old = gh.pulls.get(2)!.head;
    const fresh = hash("head:2 with main merged again");
    gh.sameContent.set(fresh, old);
    gh.pulls.get(2)!.head = fresh;
    await run(gh, options());
    expect(gh.batch().sha).toBe(built.sha);
    expect([...gh.refs.keys()].some((name) => name.startsWith("batch-build/"))).toBe(false);

    gh.finishCi(built.sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    expect(gh.pulls.get(2)!.merged).toBeDefined();
    expect(gh.commits.get(await gh.mainSha())!.tree).toBe(built.manifest.members[1]!.tree);
  });

  test("the first member's new head is checked at its own place in the batch", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    await run(gh, options());
    const built = gh.batch();

    const fresh = hash("head:1 rebased");
    gh.sameContent.set(fresh, gh.pulls.get(1)!.head);
    gh.pulls.get(1)!.head = fresh;
    await run(gh, options());
    expect(gh.batch().sha).toBe(built.sha);

    gh.finishCi(built.sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    expect(gh.pulls.get(2)!.merged).toBeDefined();
    expect(gh.commits.get(await gh.mainSha())!.tree).toBe(built.manifest.members[1]!.tree);
  });

  test("a new head that now conflicts is ejected, never landed", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    await run(gh, options());
    const built = gh.batch();

    const fresh = hash("head:2 conflicting");
    gh.sameContent.set(fresh, gh.pulls.get(2)!.head);
    gh.pulls.get(2)!.head = fresh;
    gh.pulls.get(2)!.mergeable = "CONFLICTING";
    gh.finishCi(built.sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(2)!.merged).toBeUndefined();
    expect(gh.pulls.get(2)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.pulls.get(1)!.merged).toBeUndefined();
    expect(gh.refs.get(built.name)).toBeUndefined();
  });

  test("a Version PR's new head restarts its batch", async () => {
    const gh = new FakeGitHub();
    gh.addPull(5, { title: "Version" });
    await run(gh, options());
    const built = gh.batch();

    const fresh = hash("version regenerated");
    gh.sameContent.set(fresh, gh.pulls.get(5)!.head);
    gh.pulls.get(5)!.head = fresh;
    await run(gh, options());
    const rebuilt = gh.batch();
    expect(rebuilt.manifest.id).not.toBe(built.manifest.id);
    expect(rebuilt.manifest.members[0]).toMatchObject({ number: 5, head: fresh });
  });

  test("a member's new head with other content restarts its batch", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    await run(gh, options());
    const built = gh.batch();

    const fresh = hash("head:1 with a fix");
    gh.pulls.get(1)!.head = fresh;
    await run(gh, options());
    const rebuilt = gh.batch();
    expect(rebuilt.manifest.id).not.toBe(built.manifest.id);
    expect(rebuilt.manifest.members.map((m) => [m.number, m.head])).toEqual([
      [1, fresh],
      [2, gh.pulls.get(2)!.head],
    ]);
    expect([...gh.refs.keys()].some((name) => name.startsWith("batch-build/"))).toBe(false);
  });

  test("dry run only plans", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    const actions = await run(gh, { ...options(), dryRun: true });
    expect(actions.map((a) => a.kind)).toEqual(["build"]);
    expect(gh.log).toEqual([]);
  });
});
