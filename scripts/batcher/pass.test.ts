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
import { CI_WORKFLOW, DEFAULT_SETTINGS, IN_BATCH_LABEL, QUEUE_LABEL, parseManifest } from "./model";
import { LandingMismatch, PR_WORKFLOW, run } from "./pass";

const NOW = 1_800_000_000_000;
const hash = (value: string) => createHash("sha1").update(value).digest("hex");

interface FakePull {
  number: number;
  title: string;
  head: string;
  files: string[];
  labels: string[];
  green: boolean;
  merged?: string;
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
  /** Lets a test make label writes fail. */
  labelsFail = false;
  createdLabels: string[] = [];

  constructor() {
    this.refs.set("main", this.store([], [], "root"));
  }

  store(applied: string[], parents: string[], message: string) {
    const sorted = [...new Set(applied)].sort();
    const tree = hash(`tree:${sorted.join(",")}`);
    const sha = hash(`commit:${tree}:${parents.join(",")}:${message}`);
    this.commits.set(sha, { sha, tree, message, date: NOW, applied: sorted, parents });
    return sha;
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
        headRef: p.title === "Version" ? "changeset-release/main" : `branch-${p.number}`,
        sameRepository: true,
        draft: false,
        mergeable: "MERGEABLE" as const,
        labels: p.labels,
        labeledAt: NOW - 3_600_000 + p.number,
        autoMergeAt: null,
      }));
  }

  async check(headSha: string): Promise<CheckSummary | null> {
    const pull = [...this.pulls.values()].find((p) => p.head === headSha);
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
    const applied = new Set(this.commits.get(ref)!.applied);
    return [...this.pulls.values()]
      .filter((p) => applied.has(p.head))
      .flatMap((p) => p.files)
      .filter((file) => file.slice(0, file.lastIndexOf("/")) === path);
  }

  async compareFiles() {
    return { files: [], mergeBase: this.refs.get("main")! };
  }

  async branches(prefix: string) {
    return [...this.refs]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, sha]) => ({ name, sha }));
  }

  async commit(sha: string) {
    const commit = this.commits.get(sha);
    if (!commit) throw new Error(`no commit ${sha}`);
    return commit;
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
    const sha = this.store([...base.applied, head], [base.sha, head], message);
    this.refs.set(branch, sha);
    return { kind: "merged", sha, tree: this.commits.get(sha)!.tree };
  }

  async createCommit(tree: string, parents: string[], message: string) {
    const parent = this.commits.get(parents[0]!)!;
    if (parent.tree !== tree) throw new Error("fake only supports reusing the parent tree");
    return this.store(parent.applied, parents, message);
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
    const sha = this.store([...main.applied, pull.head, ...this.landedExtra], parents, message);
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
    this.comments.push({ number, body });
  }

  async removeLabel(number: number, label: string) {
    if (label === IN_BATCH_LABEL && this.labelsFail) throw new Error("labels are down");
    const pull = this.pulls.get(number)!;
    pull.labels = pull.labels.filter((l) => l !== label);
  }

  async addLabel(number: number, label: string) {
    if (this.labelsFail) throw new Error("labels are down");
    const pull = this.pulls.get(number)!;
    if (!pull.labels.includes(label)) pull.labels.push(label);
  }

  async ensureLabel(label: string) {
    if (this.labelsFail) throw new Error("labels are down");
    if (!this.createdLabels.includes(label)) this.createdLabels.push(label);
  }

  async labelled(label: string) {
    return [...this.pulls.values()].filter((p) => p.labels.includes(label)).map((p) => p.number);
  }

  /** PRs carrying the in-batch label, in number order. */
  marked() {
    return [...this.pulls.values()]
      .filter((p) => p.labels.includes(IN_BATCH_LABEL))
      .map((p) => p.number)
      .sort((a, b) => a - b);
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

  test("ejects a PR whose migration number main already uses, and keeps equal numbers apart", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1, { files: ["packages/db/drizzle/0007_a.sql"], labels: [] });
    const landed = gh.store([gh.pulls.get(1)!.head], [await gh.mainSha()], "Change 1 (#1)");
    gh.refs.set("main", landed);
    gh.pulls.get(1)!.merged = landed;
    gh.addPull(2, { files: ["packages/db/drizzle/0007_b.sql", "packages/db/src/b.ts"] });
    gh.addPull(3, { files: ["packages/db/drizzle/0008_c.sql"] });
    gh.addPull(4, { files: ["packages/db/drizzle/0008_d.sql"] });
    gh.addPull(5);

    await run(gh, options());
    expect(gh.pulls.get(2)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.comments).toEqual([
      {
        number: 2,
        body: expect.stringContaining(
          "`0007_b.sql` uses number 0007, which main already uses for `0007_a.sql`. Merge main into the branch and move it to the next free number: `bun scripts/renumber-migration.ts 0007_b --next`.",
        ),
      },
    ]);
    // #4 adds the same number as #3, so it waits for the next batch.
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([3, 5]);
    expect(gh.pulls.get(4)!.labels).toContain(QUEUE_LABEL);
  });

  test("stops when a landed tree differs from the tested tree", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    await run(gh, options());
    gh.finishCi(gh.batch().sha, "success");
    gh.landedExtra = ["unexpected"];
    await expect(run(gh, options())).rejects.toBeInstanceOf(LandingMismatch);
  });

  test("dry run only plans", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    const actions = await run(gh, { ...options(), dryRun: true });
    expect(actions.map((a) => a.kind)).toEqual(["build"]);
    expect(gh.log).toEqual([]);
    expect(gh.marked()).toEqual([]);
  });
});

describe("the in-batch label", () => {
  test("names exactly the running batch's members, from build to landing", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    gh.addPull(3, { files: [".github/workflows/ci.yml"] });
    await run(gh, options());
    expect(gh.createdLabels).toEqual([IN_BATCH_LABEL]);
    expect(gh.marked()).toEqual([1, 2]);

    gh.finishCi(gh.batch().sha, "success");
    await run(gh, options());
    // The landed PRs lose it; the CI change now running alone gets it.
    expect(gh.pulls.get(1)!.merged).toBeDefined();
    expect(gh.marked()).toEqual([3]);

    gh.finishCi(gh.batch().sha, "success");
    await run(gh, options());
    expect(gh.marked()).toEqual([]);
  });

  test("a pushed member restarts the batch without it, says so on the PR, and moves the label", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    gh.addPull(2);
    gh.addPull(3);
    await run(gh, options());
    const first = gh.batch();
    gh.runsBySha.set(first.sha, [
      {
        id: 7,
        workflow: CI_WORKFLOW,
        status: "in_progress",
        conclusion: null,
        attempt: 1,
        url: "u",
      },
    ]);

    // A new head is not green yet, so the batch is rebuilt from the other two.
    Object.assign(gh.pulls.get(2)!, { head: hash("head:2b"), green: false });
    await run(gh, options());
    expect(gh.log).toContain("cancel 7");
    const second = gh.batch();
    expect(second.manifest.members.map((m) => m.number)).toEqual([1, 3]);
    expect(gh.marked()).toEqual([1, 3]);
    expect(gh.comments).toEqual([
      {
        number: 2,
        body: expect.stringContaining(
          `Merge batch \`${first.manifest.id}\` was cancelled because #2 has a new head while CI was testing it. It restarted CI for #1, #3, which are tested again without this PR.`,
        ),
      },
    ]);
  });

  test("a member leaving the queue keeps the bisection that was in progress", async () => {
    const gh = new FakeGitHub();
    for (const n of [1, 2, 3, 4]) gh.addPull(n);
    await run(gh, options());
    gh.finishCi(gh.batch().sha, "failure", 2);
    await run(gh, options());
    expect(gh.batch().manifest).toMatchObject({ pending: [[3, 4]] });
    expect(gh.marked()).toEqual([1, 2]);

    const pull = gh.pulls.get(2)!;
    pull.labels = pull.labels.filter((l) => l !== QUEUE_LABEL);
    await run(gh, options());
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([1]);
    expect(gh.batch().manifest.pending).toEqual([[3, 4]]);
    expect(gh.marked()).toEqual([1]);
    expect(gh.comments.at(-1)!.body).toContain("because #2 left the queue");
  });

  test("an ejected culprit loses the label", async () => {
    const gh = new FakeGitHub();
    gh.addPull(1);
    await run(gh, options());
    expect(gh.marked()).toEqual([1]);
    gh.finishCi(gh.batch().sha, "failure", 2);
    await run(gh, options());
    expect(gh.pulls.get(1)!.labels).not.toContain(QUEUE_LABEL);
    expect(gh.marked()).toEqual([]);
  });

  test("label failures never stop batching", async () => {
    const gh = new FakeGitHub();
    gh.labelsFail = true;
    const lines: string[] = [];
    gh.addPull(1);
    await run(gh, { ...options(), log: (line) => lines.push(line) });
    expect(gh.batch().manifest.members.map((m) => m.number)).toEqual([1]);
    expect(lines.some((l) => l.startsWith("Could not mark #1"))).toBe(true);

    gh.finishCi(gh.batch().sha, "success");
    await run(gh, options());
    expect(gh.pulls.get(1)!.merged).toBeDefined();
  });
});
