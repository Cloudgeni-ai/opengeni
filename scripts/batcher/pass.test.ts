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
import { GitHubError } from "./github";
import { CI_WORKFLOW, DEFAULT_SETTINGS, QUEUE_LABEL, parseManifest } from "./model";
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
  mergeable?: "MERGEABLE" | "CONFLICTING";
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
  /** A head that applies exactly what another head applies, like main merged in again. */
  sameContent = new Map<string, string>();
  /** File texts, the same at every commit. */
  texts = new Map<string, string>();
  trees = new Map<string, { base: string; entries: TreeEntry[] }>();
  branchUpdates: { name: string; sha: string }[] = [];

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
        headRef: p.title === "Version" ? "changeset-release/main" : `branch-${p.number}`,
        sameRepository: true,
        draft: false,
        mergeable: p.mergeable ?? ("MERGEABLE" as const),
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

  async readFiles(_ref: string, paths: string[]) {
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
    const to = this.commits.get(head);
    const contained = from && to && from.applied.every((item) => to.applied.includes(item));
    return { files: [], mergeBase: contained ? base : this.root };
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
    const pull = [...this.pulls.values()].find((p) => `branch-${p.number}` === name)!;
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
    this.comments.push({ number, body });
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
