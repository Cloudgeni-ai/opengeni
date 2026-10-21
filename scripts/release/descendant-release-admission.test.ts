import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RELEASE_AUTOMATION_CONTRACT,
  auditDescendantMergeContent,
  verifyApprovedMerge,
} from "../check-release-pr-automation.mjs";

// Tested-descendant release admission against real Git history. Every commit,
// tree, ancestry comparison and merge-tree audit below is computed from an
// actual repository built by `git merge --no-ff`, the same one-merge-per-PR
// topology that the in-house batcher lands; only provider-owned PR, check,
// status and artifact metadata is synthetic.

const contract = RELEASE_AUTOMATION_CONTRACT;
const repository = contract.repository;
const prefix = `/repos/${repository}`;
const serverRepo = `${contract.serverUrl}/${repository}`;
const versionBot = contract.versionAuthor;
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

class Repo {
  readonly dir: string;
  private readonly env: Record<string, string>;

  constructor(root: string) {
    this.dir = join(root, "repo");
    mkdirSync(this.dir, { recursive: true });
    this.env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-10-21T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-21T10:00:00Z",
      LC_ALL: "C",
    };
    this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  write(path: string, content: string) {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
  }

  remove(path: string) {
    unlinkSync(join(this.dir, path));
  }

  commit(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.head();
  }

  branch(name: string, from: string) {
    this.git("checkout", "-q", "-B", name, from);
  }

  merge(branch: string, message: string): string {
    this.git("checkout", "-q", "main");
    this.git("merge", "-q", "--no-ff", "--no-edit", "-m", message, branch);
    return this.head();
  }

  head(): string {
    return this.git("rev-parse", "HEAD");
  }

  parents(sha: string): string[] {
    return this.git("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
  }

  tree(sha: string): string {
    return this.git("rev-parse", `${sha}^{tree}`);
  }

  exists(sha: string): boolean {
    try {
      return this.git("cat-file", "-t", sha) === "commit";
    } catch {
      return false;
    }
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    try {
      this.git("merge-base", "--is-ancestor", ancestor, descendant);
      return true;
    } catch {
      return false;
    }
  }
}

type PullFixture = {
  number: number;
  mergeSha: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  user: { login: string; id: number; type: string };
  commits: number;
};

type Variant =
  | "good"
  | "exact-merge"
  | "squash-provenance"
  | "tampered-provenance"
  | "side-branch"
  | "bad-tree"
  | "conflict-resolved"
  | "direct-commit"
  | "mutate-version"
  | "pending-changeset";

type Scenario = {
  repo: Repo;
  reviewedBase: string;
  versionHead: string;
  provenance: string;
  firstIntervening: string;
  candidate: string;
  later: string;
  pulls: PullFixture[];
};

const human = { login: "contributor", id: 5150, type: "User" };
const scenarios = new Map<Variant, Scenario>();

function scenario(variant: Variant): Scenario {
  const cached = scenarios.get(variant);
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), "opengeni-descendant-admission-"));
  temporaryRoots.push(root);
  const repo = new Repo(root);
  repo.write("package.json", '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  repo.write(".changeset/README.md", "Changesets\n");
  repo.write(".changeset/feature.md", "---\n'fixture': patch\n---\n\nFeature.\n");
  repo.write("src/a.txt", "a1\nshared\n");
  repo.write("src/b.txt", "b1\n");
  const reviewedBase = repo.commit("initial");

  repo.branch(contract.versionBranch, reviewedBase);
  repo.write("package.json", '{\n  "name": "fixture",\n  "version": "1.0.1"\n}\n');
  repo.remove(".changeset/feature.md");
  repo.write("CHANGELOG.md", "# 1.0.1\n\n- Feature.\n");
  const versionHead = repo.commit("chore: version packages");

  const pulls: PullFixture[] = [];
  const pull = (
    number: number,
    mergeSha: string,
    headSha: string,
    baseSha: string,
    headRef: string,
    user = human,
    commits = 1,
  ) => pulls.push({ number, mergeSha, headSha, baseSha, headRef, user, commits });

  repo.git("checkout", "-q", "main");
  let mainBeforeVersion = reviewedBase;
  if (variant !== "exact-merge") {
    repo.branch("pr0", reviewedBase);
    repo.write("src/b.txt", "b2\n");
    const pr0Head = repo.commit("pr0");
    mainBeforeVersion = repo.merge("pr0", "Merge pull request #90 from pr0");
    pull(90, mainBeforeVersion, pr0Head, reviewedBase, "pr0");
  }

  let provenance: string;
  if (variant === "squash-provenance") {
    repo.git("checkout", "-q", "main");
    repo.git("cherry-pick", versionHead);
    provenance = repo.head();
  } else if (variant === "side-branch") {
    repo.branch("side", mainBeforeVersion);
    repo.git(
      "merge",
      "-q",
      "--no-ff",
      "--no-edit",
      "-m",
      "Merge Version into side",
      contract.versionBranch,
    );
    provenance = repo.head();
  } else {
    provenance = repo.merge(
      contract.versionBranch,
      "Merge pull request #100 from changeset-release/main",
    );
    if (variant === "tampered-provenance") {
      // Correct Version topology, but an unreviewed extra delta in the merge.
      repo.write("src/unreviewed.txt", "masquerading as Version provenance\n");
      repo.git("add", "-A");
      repo.git("commit", "-q", "--amend", "--no-edit");
      provenance = repo.head();
    }
  }
  pull(100, provenance, versionHead, reviewedBase, contract.versionBranch, versionBot, 1);

  // First intervening PR is based on the old reviewed base (moving main).
  repo.branch("pr1", reviewedBase);
  if (variant === "conflict-resolved") {
    repo.write("src/b.txt", "b-conflict\n");
  } else {
    repo.write("src/a.txt", "a2\nshared\n");
  }
  const pr1Head = repo.commit("pr1");
  repo.git("checkout", "-q", "main");
  let firstIntervening: string;
  if (variant === "conflict-resolved") {
    try {
      repo.git(
        "merge",
        "-q",
        "--no-ff",
        "--no-edit",
        "-m",
        "Merge pull request #101 from pr1",
        "pr1",
      );
    } catch {
      // Expected conflict on src/b.txt; a hand resolution is not reproducible.
    }
    repo.write("src/b.txt", "b-resolved\n");
    firstIntervening = repo.commit("Merge pull request #101 from pr1");
  } else {
    firstIntervening = repo.merge("pr1", "Merge pull request #101 from pr1");
  }
  if (variant === "bad-tree") {
    repo.write("src/hidden.txt", "unreviewed\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "--amend", "--no-edit");
    firstIntervening = repo.head();
  }
  pull(101, firstIntervening, pr1Head, reviewedBase, "pr1");

  if (variant === "direct-commit") {
    repo.write("src/direct.txt", "direct push\n");
    repo.commit("direct push to main");
  }

  let candidate: string;
  if (variant === "side-branch") {
    candidate = repo.merge("side", "Merge pull request #102 from side");
    pull(102, candidate, provenance, mainBeforeVersion, "side");
  } else {
    repo.branch("pr2", provenance);
    repo.write("src/c.txt", "c1\n");
    if (variant === "mutate-version") {
      repo.write("package.json", '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
    }
    if (variant === "pending-changeset") {
      repo.write(".changeset/next.md", "---\n'fixture': minor\n---\n\nNext.\n");
    }
    const pr2Head = repo.commit("pr2");
    candidate = repo.merge("pr2", "Merge pull request #102 from pr2");
    pull(102, candidate, pr2Head, provenance, "pr2");
  }

  repo.branch("pr3", candidate);
  repo.write("src/d.txt", "d1\n");
  const pr3Head = repo.commit("pr3");
  const later = repo.merge("pr3", "Merge pull request #103 from pr3");
  pull(103, later, pr3Head, candidate, "pr3");

  const built = {
    repo,
    reviewedBase,
    versionHead,
    provenance,
    firstIntervening,
    candidate,
    later,
    pulls,
  };
  scenarios.set(variant, built);
  return built;
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function retainedRelease(sha: string) {
  const tagName = `${contract.releaseHeadTagPrefix}${sha}`;
  return {
    id: 4242,
    tag_name: tagName,
    target_commitish: "main",
    name: `${contract.releaseHeadReleaseNamePrefix}${sha}`,
    draft: false,
    prerelease: true,
    immutable: true,
    published_at: "2026-10-21T10:30:00.000Z",
    author: versionBot,
    html_url: `${serverRepo}/releases/tag/${tagName}`,
  };
}

const ciJobNames = [...contract.checks.requiredSource, ...contract.checks.fullGreenJobs];
const ciRunAttempt = 2;
const ciCheckSuiteId = 99_000;

type Run = Record<string, any>;
type Job = Record<string, any>;

type CiFixture = {
  run: Run;
  jobs: Job[];
  checks: Job[];
  statuses: Job[];
  artifacts: Job[];
  receipts: Map<number, Map<string, Buffer>>;
};

// Stored ZIP fixtures follow reconcile-canary-publication.test.ts's byte format.
// They exercise the real unzip/digest boundary without a registry or zip CLI.
function receiptZip(members: Map<string, Buffer>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let position = 0;
  for (const [name, body] of members) {
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const path = Buffer.from(name),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(body.length, 22);
    h.writeUInt16LE(path.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(path.length, 28);
    c.writeUInt32LE(position, 42);
    local.push(h, path, body);
    central.push(c, path);
    position += h.length + path.length + body.length;
  }
  const entries = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.size, 8);
  end.writeUInt16LE(members.size, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...local, entries, end]);
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function changeReceipt(fixture: CiFixture, artifactPrefix: string, mutate: (body: any) => void) {
  const artifact = fixture.artifacts.find((item) => item.name.startsWith(artifactPrefix))!;
  const files = fixture.receipts.get(artifact.id)!;
  const file =
    artifactPrefix === "full-green-main-" ? "full-green-main.json" : "canary-images.json";
  const body = JSON.parse(files.get(file)!.toString());
  mutate(body);
  const bytes = Buffer.from(JSON.stringify(body) + "\n");
  files.set(file, bytes);
  if (file === "canary-images.json")
    files.set("canary-images.sha256", Buffer.from(`${hash(bytes)}  canary-images.json\n`));
  artifact.digest = `sha256:${hash(receiptZip(files))}`;
}

function attemptUrl(runId: number, attempt: number) {
  return `${serverRepo}/actions/runs/${runId}/attempts/${attempt}`;
}

function ciFor(sha: string, runId: number): CiFixture {
  const receipts = new Map<number, Map<string, Buffer>>();
  const jobs = ciJobNames.map((name, index) => {
    const id = runId * 10 + index;
    return {
      id,
      name,
      status: "completed",
      conclusion: "success",
      html_url: `${serverRepo}/actions/runs/${runId}/job/${id}`,
      check_run_url: `${contract.apiUrl}${prefix}/check-runs/${id}`,
    };
  });
  return {
    run: {
      id: runId,
      run_attempt: ciRunAttempt,
      run_started_at: "2026-10-21T10:00:00Z",
      status: "completed",
      conclusion: "success",
      event: "push",
      path: contract.ciWorkflowPath,
      head_sha: sha,
      head_branch: contract.defaultBranch,
      check_suite_id: ciCheckSuiteId + runId,
      html_url: `${serverRepo}/actions/runs/${runId}`,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    jobs,
    checks: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      external_id: `ci-${job.id}`,
      details_url: job.html_url,
      check_suite: { id: ciCheckSuiteId + runId },
      app: contract.githubActionsApp,
    })),
    statuses: [
      {
        id: runId * 100 + 2,
        context: "Batch ready",
        state: "success",
        target_url: `${serverRepo}/actions/runs/1`,
        created_at: "2026-10-21T11:05:00Z",
        creator: { login: "merge-batcher[bot]", id: 777, type: "Bot" },
      },
      {
        id: runId * 100 + 1,
        context: contract.checks.fullGreenStatus,
        state: "success",
        target_url: attemptUrl(runId, ciRunAttempt),
        created_at: "2026-10-21T11:00:00Z",
        creator: versionBot,
      },
    ],
    receipts,
    artifacts: [
      `${contract.descendant.fullGreenArtifactPrefix}${sha}`,
      `${contract.descendant.canaryImageArtifactPrefix}${sha}`,
    ].map((name, index) => {
      const id = runId * 10 + 100 + index;
      const file = index === 0 ? "full-green-main.json" : "canary-images.json";
      const receipt =
        index === 0
          ? {
              schemaVersion: 1,
              sha,
              runId: String(runId),
              runAttempt: String(ciRunAttempt),
              url: attemptUrl(runId, ciRunAttempt),
              mode: "full",
            }
          : {
              schemaVersion: 1,
              source: { repository, ref: "refs/heads/main", sha },
              producer: {
                workflow: contract.ciWorkflowPath,
                runId: String(runId),
                runAttempt: String(ciRunAttempt),
              },
              chartVersion: "1.0.0",
              imageTag: `canary-sha-${sha}`,
              images: Object.fromEntries(
                [
                  "api",
                  "worker",
                  "web",
                  "sandbox",
                  "relay",
                  "artifact-materializer",
                  "artifact-outbox-dispatcher",
                  "desktop",
                ].map((role) => [
                  role,
                  {
                    repository: `ghcr.io/cloudgeni-ai/opengeni-${role}`,
                    digest: `sha256:${"1".repeat(64)}`,
                  },
                ]),
              ),
            };
      const bytes = Buffer.from(JSON.stringify(receipt) + "\n");
      const files = new Map([[file, bytes]]);
      if (index === 1)
        files.set("canary-images.sha256", Buffer.from(`${hash(bytes)}  canary-images.json\n`));
      receipts.set(id, files);
      return {
        id,
        name,
        expired: false,
        created_at: "2026-10-21T10:50:00Z",
        digest: `sha256:${hash(receiptZip(files))}`,
        workflow_run: { id: runId, head_sha: sha, head_branch: contract.defaultBranch },
      };
    }),
  };
}

type FixtureOptions = {
  initialMainSha?: string;
  terminalMainSha?: string;
  controllerSha?: string;
  // SHA -> CI fixture. Defaults to a complete green push run on the candidate.
  ci?: (fixtures: Map<string, CiFixture>, s: Scenario) => void;
  pulls?: (pulls: PullFixture[], s: Scenario) => void;
  associations?: Record<string, unknown[]>;
};

function apiFixture(s: Scenario, options: FixtureOptions = {}) {
  const pulls = s.pulls.map((pull) => ({ ...pull }));
  options.pulls?.(pulls, s);
  const ci = new Map<string, CiFixture>([[s.candidate, ciFor(s.candidate, 5001)]]);
  options.ci?.(ci, s);
  const runsById = new Map<number, CiFixture>();
  for (const fixture of ci.values()) runsById.set(fixture.run.id, fixture);
  const retained = new Set([s.versionHead, options.controllerSha ?? s.reviewedBase]);
  const requests: string[] = [];
  let mainReads = 0;

  const pullSummary = (pull: PullFixture) => ({
    number: pull.number,
    state: "closed",
    merged_at: "2026-10-21T10:45:00Z",
    merge_commit_sha: pull.mergeSha,
    user: pull.user,
    base: { ref: "main", sha: pull.baseSha, repo: { full_name: repository } },
    head: { ref: pull.headRef, sha: pull.headSha, repo: { full_name: repository } },
  });
  const merger = { login: "merge-batcher[bot]", id: 777, type: "Bot" };
  const pullDetail = (pull: PullFixture) => ({
    ...pullSummary(pull),
    html_url: `${serverRepo}/pull/${pull.number}`,
    merged: true,
    merged_by: merger,
    commits: pull.commits,
    changed_files: 3,
    requested_reviewers: [],
  });
  const compare = (left: string, right: string, query: URLSearchParams) => {
    const mergeBase = s.repo.git("merge-base", left, right);
    const ahead = s.repo
      .git("rev-list", "--reverse", "--topo-order", `${left}..${right}`)
      .split("\n")
      .filter(Boolean);
    const behind = s.repo.git("rev-list", `${right}..${left}`).split("\n").filter(Boolean);
    const status =
      ahead.length === 0 && behind.length === 0
        ? "identical"
        : behind.length === 0
          ? "ahead"
          : ahead.length === 0
            ? "behind"
            : "diverged";
    const perPage = Number(query.get("per_page") ?? 250);
    const page = Number(query.get("page") ?? 1);
    const commits = ahead.slice((page - 1) * perPage, page * perPage).map((sha) => ({
      sha,
      commit: { tree: { sha: s.repo.tree(sha) } },
      parents: s.repo.parents(sha).map((parent) => ({ sha: parent })),
    }));
    return {
      status,
      base_commit: { sha: left },
      merge_base_commit: { sha: mergeBase },
      ahead_by: ahead.length,
      behind_by: behind.length,
      total_commits: ahead.length,
      commits,
    };
  };
  const tree = (sha: string) => ({
    sha,
    truncated: false,
    tree: s.repo
      .git("ls-tree", "-r", "-t", sha)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, type, objectSha] = meta!.split(" ");
        return { path, mode, type, sha: objectSha };
      }),
  });

  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (method !== "GET") return response({ message: "unexpected write" }, 405);
    const path = url.pathname;
    const page = Number(url.searchParams.get("page") ?? 1);
    if (path === `${prefix}/git/ref/heads/main`) {
      mainReads += 1;
      const sha =
        mainReads === 1
          ? (options.initialMainSha ?? s.later)
          : (options.terminalMainSha ?? options.initialMainSha ?? s.later);
      return response({ ref: "refs/heads/main", object: { type: "commit", sha } });
    }
    let match = path.match(new RegExp(`^${prefix}/git/commits/([0-9a-f]{40})$`));
    if (match) {
      const sha = match[1]!;
      if (!s.repo.exists(sha)) return response({ message: "missing" }, 404);
      return response({
        sha,
        tree: { sha: s.repo.tree(sha) },
        parents: s.repo.parents(sha).map((parent) => ({ sha: parent })),
      });
    }
    match = path.match(new RegExp(`^${prefix}/git/trees/([0-9a-f]{40})$`));
    if (match) return response(tree(match[1]!));
    match = path.match(new RegExp(`^${prefix}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`));
    if (match) return response(compare(match[1]!, match[2]!, url.searchParams));
    match = path.match(new RegExp(`^${prefix}/commits/([0-9a-f]{40})/pulls$`));
    if (match) {
      const sha = match[1]!;
      if (page > 1) return response([]);
      const explicit = options.associations?.[sha];
      if (explicit) return response(explicit);
      return response(pulls.filter((pull) => pull.mergeSha === sha).map(pullSummary));
    }
    match = path.match(new RegExp(`^${prefix}/pulls/([0-9]+)$`));
    if (match) {
      const pull = pulls.find((candidate) => candidate.number === Number(match![1]));
      return pull ? response(pullDetail(pull)) : response({ message: "missing" }, 404);
    }
    match = path.match(new RegExp(`^${prefix}/issues/([0-9]+)/timeline$`));
    if (match) {
      const pull = pulls.find((candidate) => candidate.number === Number(match![1]));
      if (!pull || page > 1) return response([]);
      const eventId = 9000 + pull.number;
      return response([
        {
          id: eventId,
          node_id: `ME_${eventId}`,
          url: `${contract.apiUrl}${prefix}/issues/events/${eventId}`,
          event: "merged",
          actor: merger,
          commit_id: pull.mergeSha,
          commit_url: `${contract.apiUrl}${prefix}/commits/${pull.mergeSha}`,
          created_at: "2026-10-21T10:45:01Z",
        },
      ]);
    }
    match = path.match(new RegExp(`^${prefix}/commits/([0-9a-f]{40})/check-runs$`));
    if (match) {
      const sha = match[1]!;
      if (page > 1) return response({ check_runs: [] });
      if (sha === s.versionHead) {
        return response({
          check_runs: [
            {
              name: contract.checks.sourceAdmission,
              head_sha: sha,
              status: "completed",
              conclusion: "success",
              app: contract.githubActionsApp,
            },
          ],
        });
      }
      return response({ check_runs: ci.get(sha)?.checks ?? [] });
    }
    match = path.match(new RegExp(`^${prefix}/commits/([0-9a-f]{40})/statuses$`));
    if (match) {
      if (page > 1) return response([]);
      return response(ci.get(match[1]!)?.statuses ?? []);
    }
    match = path.match(new RegExp(`^${prefix}/actions/runs/([0-9]+)$`));
    if (match) {
      const fixture = runsById.get(Number(match[1]));
      return fixture ? response(fixture.run) : response({ message: "missing" }, 404);
    }
    match = path.match(new RegExp(`^${prefix}/actions/runs/([0-9]+)/attempts/([0-9]+)/jobs$`));
    if (match) {
      const fixture = runsById.get(Number(match[1]));
      if (!fixture || Number(match[2]) !== fixture.run.run_attempt) {
        return response({ message: "missing" }, 404);
      }
      return response({ total_count: fixture.jobs.length, jobs: page > 1 ? [] : fixture.jobs });
    }
    match = path.match(new RegExp(`^${prefix}/actions/runs/([0-9]+)/attempts/([0-9]+)$`));
    if (match) {
      const fixture = runsById.get(Number(match[1]));
      return fixture && Number(match[2]) === fixture.run.run_attempt
        ? response(fixture.run)
        : response({ message: "missing attempt" }, 404);
    }
    match = path.match(new RegExp(`^${prefix}/actions/artifacts/([0-9]+)/zip$`));
    if (match) {
      const id = Number(match[1]);
      for (const fixture of ci.values()) {
        const files = fixture.receipts.get(id);
        if (files) return new Response(receiptZip(files));
      }
      return response({ message: "missing archive" }, 404);
    }
    match = path.match(new RegExp(`^${prefix}/actions/runs/([0-9]+)/artifacts$`));
    if (match) {
      const fixture = runsById.get(Number(match[1]));
      if (!fixture) return response({ message: "missing" }, 404);
      return response({
        total_count: fixture.artifacts.length,
        artifacts: page > 1 ? [] : fixture.artifacts,
      });
    }
    match = path.match(
      new RegExp(`^${prefix}/git/ref/tags/${contract.releaseHeadTagPrefix}([0-9a-f]{40})$`),
    );
    if (match) {
      const sha = match[1]!;
      if (!retained.has(sha)) return response({ message: "missing" }, 404);
      return response({
        ref: `refs/tags/${contract.releaseHeadTagPrefix}${sha}`,
        object: { type: "commit", sha },
      });
    }
    match = path.match(
      new RegExp(`^${prefix}/releases/tags/${contract.releaseHeadTagPrefix}([0-9a-f]{40})$`),
    );
    if (match) {
      const sha = match[1]!;
      return retained.has(sha)
        ? response(retainedRelease(sha))
        : response({ message: "missing" }, 404);
    }
    return response({ message: `unexpected ${method} ${path}` }, 404);
  }
  return { fetchImpl, requests };
}

function admissionEnv(
  s: Scenario,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const controller = overrides.RELEASE_CONTROLLER_SHA ?? s.reviewedBase;
  return {
    GITHUB_API_URL: contract.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: repository,
    GITHUB_SERVER_URL: contract.serverUrl,
    GITHUB_REF: `refs/tags/${contract.releaseHeadTagPrefix}${controller}`,
    GITHUB_SHA: controller,
    GITHUB_WORKFLOW_SHA: controller,
    GITHUB_TOKEN: "fixture-token",
    RELEASE_CONTROLLER_SHA: controller,
    SOURCE_SHA: s.candidate,
    RELEASE_PROVENANCE_SHA: s.provenance,
    RELEASE_DESCENDANT_GIT_DIR: s.repo.dir,
    ...overrides,
  };
}

const quietLogger = { log() {} };

async function admit(
  s: Scenario,
  env: Record<string, string | undefined> = {},
  options: FixtureOptions = {},
  extra: Record<string, unknown> = {},
) {
  const controllerSha = env.RELEASE_CONTROLLER_SHA ?? options.controllerSha;
  const fixture = apiFixture(s, { ...options, ...(controllerSha ? { controllerSha } : {}) });
  const result = await verifyApprovedMerge({
    env: admissionEnv(s, env),
    fetchImpl: fixture.fetchImpl,
    logger: quietLogger,
    ...extra,
  });
  return { result: result as Record<string, any>, requests: fixture.requests };
}

describe("tested-descendant release admission", () => {
  test("keeps the exact Version-tip lane unchanged when provenance is omitted or equal", async () => {
    const s = scenario("good");
    const exactCi = (ci: Map<string, CiFixture>) => {
      ci.clear();
      ci.set(s.provenance, ciFor(s.provenance, 5002));
    };
    for (const provenance of [undefined, s.provenance]) {
      const { result } = await admit(
        s,
        {
          SOURCE_SHA: s.provenance,
          RELEASE_PROVENANCE_SHA: provenance,
          RELEASE_DESCENDANT_GIT_DIR: undefined,
        },
        { ci: exactCi },
      );
      expect(result.version).toBe(2);
      expect(result.admissionMode).toBeUndefined();
      expect(result.sourceSha).toBe(s.provenance);
      expect(result.pullRequestNumber).toBe(100);
      expect(result.mergeMethod).toBe("provider-verified-moving-main-merge");
      expect(result.requiredSourceChecks.map((check: { name: string }) => check.name)).toEqual([
        ...contract.checks.requiredSource,
      ]);
    }
  });

  test("admits a fully green descendant containing the independently verified Version merge", async () => {
    const s = scenario("good");
    const { result, requests } = await admit(s);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(result.version).toBe(3);
    expect(result.admissionMode).toBe("tested-descendant");
    expect(result.sourceSha).toBe(s.candidate);
    expect(result.sourceTreeSha).toBe(s.repo.tree(s.candidate));
    expect(result.pullRequestNumber).toBe(100);
    expect(result.reviewedHeadSha).toBe(s.versionHead);
    const provenance = result.versionProvenance;
    expect(provenance.sha).toBe(s.provenance);
    expect(provenance.sha).not.toBe(result.sourceSha);
    expect(provenance.mergeMethod).toBe("provider-verified-moving-main-merge");
    expect(provenance.sourceComposition.type).toBe("exact-reviewed-delta-on-moving-main");
    expect(provenance.reviewedBaseSha).toBe(s.reviewedBase);
    expect(provenance.reviewedHeadSha).toBe(s.versionHead);
    expect(provenance.releaseHead.sha).toBe(s.versionHead);
    expect(provenance.retainedContent.reviewedPathCount).toBe(3);
    expect(
      result.descendant.interveningMerges.map(
        (merge: { sha: string; pullRequestNumber: number }) => [merge.sha, merge.pullRequestNumber],
      ),
    ).toEqual([
      [s.firstIntervening, 101],
      [s.candidate, 102],
    ]);
    expect(result.descendant.mergeContent).toMatchObject({
      method: "git-merge-tree-write-tree",
      auditedMergeCount: 3,
    });
    expect(result.requiredSourceChecks.map((check: { name: string }) => check.name)).toEqual(
      ciJobNames,
    );
    expect(
      result.requiredSourceChecks.every(
        (check: { workflowRunId: number; workflowRunAttempt: number }) =>
          check.workflowRunId === 5001 && check.workflowRunAttempt === ciRunAttempt,
      ),
    ).toBe(true);
    expect(result.fullGreen.status.targetUrl).toBe(attemptUrl(5001, ciRunAttempt));
    expect(result.fullGreen.artifacts.map((artifact: { name: string }) => artifact.name)).toEqual([
      `full-green-main-${s.candidate}`,
      `canary-images-${s.candidate}`,
    ]);
    // No evidence is read from the provenance commit's own CI lane.
    expect(requests).not.toContain(`GET ${prefix}/commits/${s.provenance}/check-runs`);
    expect(requests).not.toContain(`GET ${prefix}/commits/${s.provenance}/statuses`);
  });

  test("admits an exact-tree Version merge and a controller retained after the candidate", async () => {
    const exact = scenario("exact-merge");
    const { result } = await admit(exact);
    expect(result.versionProvenance.mergeMethod).toBe("merge");
    expect(result.versionProvenance.sourceComposition.type).toBe("exact-reviewed-tree");

    const s = scenario("good");
    const { result: laterController } = await admit(s, { RELEASE_CONTROLLER_SHA: s.later });
    expect(laterController.controller.sha).toBe(s.later);
  });

  test("rejects a controller between the provenance and the released candidate", async () => {
    const s = scenario("good");
    await expect(admit(s, { RELEASE_CONTROLLER_SHA: s.firstIntervening })).rejects.toThrow(
      "release controller is not ahead of the release candidate",
    );
  });

  test("rejects unrelated, non-main and non-descendant candidates", async () => {
    const s = scenario("good");
    // Candidate no longer retained by protected main.
    await expect(admit(s, {}, { initialMainSha: s.provenance })).rejects.toThrow(
      "initial release main is not ahead of the admitted source",
    );
    await expect(admit(s, {}, { terminalMainSha: s.firstIntervening })).rejects.toThrow(
      "terminal release main is not ahead of the admitted source",
    );
    // Candidate that is an ancestor, not a descendant, of the provenance.
    await expect(admit(s, { SOURCE_SHA: scenario("good").pulls[0]!.mergeSha })).rejects.toThrow(
      "release candidate is not strictly ahead of the Version provenance",
    );
    // A main commit unrelated to this Version PR cannot pose as provenance.
    await expect(
      admit(
        s,
        { RELEASE_PROVENANCE_SHA: s.firstIntervening, SOURCE_SHA: s.later },
        {
          ci: (ci) => {
            ci.clear();
            ci.set(s.later, ciFor(s.later, 5003));
          },
        },
      ),
    ).rejects.toThrow("Version provenance pull-request author numeric identity changed");
    // Malformed provenance input never falls back to the exact lane.
    await expect(admit(s, { RELEASE_PROVENANCE_SHA: "HEAD" })).rejects.toThrow(
      "Version provenance SHA is not a lowercase Git SHA",
    );
  });

  test("rejects provenance reachable only through a side branch", async () => {
    const s = scenario("side-branch");
    await expect(admit(s)).rejects.toThrow(
      "Version provenance is not on the release candidate's first-parent main history",
    );
  });

  test("rejects a squashed Version provenance that is not a true merge", async () => {
    const s = scenario("squash-provenance");
    await expect(admit(s)).rejects.toThrow(
      "Version provenance provider-verified-moving-main-squash is not a true merge commit",
    );
  });

  test("rejects a Version provenance whose landed delta exceeds the reviewed head", async () => {
    await expect(admit(scenario("tampered-provenance"))).rejects.toThrow(
      "release source tree differs from the exact reviewed moving-main composition",
    );
    const s = scenario("good");
    // An ordinary PR merge carrying the Version head as provenance has extra delta.
    await expect(
      admit(
        s,
        { RELEASE_PROVENANCE_SHA: s.firstIntervening },
        {
          pulls: (pulls) => {
            const version = pulls.find((pull) => pull.number === 100)!;
            version.mergeSha = s.firstIntervening;
            pulls.splice(
              pulls.findIndex((pull) => pull.number === 101),
              1,
            );
          },
        },
      ),
    ).rejects.toThrow(
      "release source tree differs from the exact reviewed head and is not a moving-main squash or exact-head merge",
    );
  });

  test("rejects a stale provenance when a competing Version PR lands in between", async () => {
    const s = scenario("good");
    await expect(
      admit(
        s,
        {},
        {
          pulls: (pulls) => {
            const competing = pulls.find((pull) => pull.number === 101)!;
            competing.headRef = contract.versionBranch;
            competing.user = versionBot;
          },
        },
      ),
    ).rejects.toThrow(
      `intervening merge ${s.firstIntervening} lands competing Version PR #101; release that newer Version provenance instead`,
    );
  });

  test("rejects intervening merges without exact PR provenance", async () => {
    const s = scenario("good");
    await expect(admit(s, {}, { associations: { [s.firstIntervening]: [] } })).rejects.toThrow(
      `intervening merge ${s.firstIntervening} is not associated with exactly one pull request`,
    );
    await expect(
      admit(
        s,
        {},
        {
          pulls: (pulls) => {
            pulls.find((pull) => pull.number === 101)!.headSha = s.versionHead;
          },
        },
      ),
    ).rejects.toThrow(`does not retain PR #101's exact head`);
    await expect(
      admit(
        s,
        {},
        {
          pulls: (pulls) => {
            const unrelated = pulls.find((pull) => pull.number === 101)!;
            pulls.push({ ...unrelated, number: 111 });
          },
        },
      ),
    ).rejects.toThrow(`is not associated with exactly one pull request`);
  });

  test("rejects direct single-parent commits between provenance and candidate", async () => {
    const s = scenario("direct-commit");
    await expect(admit(s)).rejects.toThrow("is not a two-parent merge");
  });

  test("rejects a hand-modified intervening merge tree through the merge-tree audit", async () => {
    const s = scenario("bad-tree");
    await expect(admit(s)).rejects.toThrow(
      `landed merge content mismatch at ${s.firstIntervening}`,
    );
  });

  test("rejects a conflict-resolved intervening merge that cannot be recomputed", async () => {
    const s = scenario("conflict-resolved");
    await expect(admit(s)).rejects.toThrow(
      `landed merge ${s.firstIntervening} cannot be recomputed without conflict resolution`,
    );
  });

  test("rejects mutated Version content and later pending changesets", async () => {
    await expect(admit(scenario("mutate-version"))).rejects.toThrow(
      "release candidate changes reviewed Version content at package.json",
    );
    await expect(admit(scenario("pending-changeset"))).rejects.toThrow(
      "release candidate has a pending changeset after the Version provenance: .changeset/next.md",
    );
  });

  test("requires the merge-tree audit to run and match provider history exactly", async () => {
    const s = scenario("good");
    await expect(admit(s, { RELEASE_DESCENDANT_GIT_DIR: undefined })).rejects.toThrow(
      "RELEASE_DESCENDANT_GIT_DIR is missing",
    );
    const real = auditDescendantMergeContent({
      gitDir: s.repo.dir,
      provenanceSha: s.provenance,
      candidateSha: s.candidate,
    });
    await expect(
      admit(
        s,
        {},
        {},
        {
          auditMergeContent: () => ({ ...real, merges: real.merges.slice(0, -1) }),
        },
      ),
    ).rejects.toThrow("descendant merge-content audit differs from provider first-parent history");
    await expect(
      admit(
        s,
        {},
        {},
        {
          auditMergeContent: () => ({
            ...real,
            merges: real.merges.map((merge: { sha: string; treeSha: string }, index: number) =>
              index === 1 ? { ...merge, treeSha: s.repo.tree(s.provenance) } : merge,
            ),
          }),
        },
      ),
    ).rejects.toThrow(
      `descendant merge-content audit differs from provider evidence at ${s.firstIntervening}`,
    );
    await expect(
      admit(s, {}, {}, { auditMergeContent: () => ({ ...real, candidateSha: s.later }) }),
    ).rejects.toThrow("descendant merge-content audit covers another range");
  });

  test("rejects wrong workflow, branch, event and attempt evidence on the candidate", async () => {
    const s = scenario("good");
    for (const [patch, message] of [
      [
        { event: "workflow_dispatch" },
        "required source checks do not identify exactly one push CI workflow run",
      ],
      [
        { head_branch: "production" },
        "required source checks do not identify exactly one push CI workflow run",
      ],
      [
        { path: ".github/workflows/merge-queue.yml" },
        "required source checks do not identify exactly one push CI workflow run",
      ],
      [{ conclusion: "failure" }, "required source workflow did not complete successfully"],
      [
        { status: "in_progress", conclusion: null },
        "required source workflow did not complete successfully",
      ],
    ] as const) {
      await expect(
        admit(
          s,
          {},
          {
            ci: (ci) => Object.assign(ci.get(s.candidate)!.run, patch),
          },
        ),
      ).rejects.toThrow(message);
    }
  });

  test("rejects foreign-app checks and missing full-green jobs", async () => {
    const s = scenario("good");
    await expect(
      admit(
        s,
        {},
        {
          ci: (ci) => {
            ci.get(s.candidate)!.checks[0]!.app = { slug: "merge-batcher", id: 4242 };
          },
        },
      ),
    ).rejects.toThrow("Typecheck and unit tests is not owned by the official GitHub Actions app");
    for (const name of contract.checks.fullGreenJobs) {
      await expect(
        admit(
          s,
          {},
          {
            ci: (ci) => {
              const fixture = ci.get(s.candidate)!;
              fixture.checks = fixture.checks.filter((check) => check.name !== name);
              fixture.jobs = fixture.jobs.filter((job) => job.name !== name);
            },
          },
        ),
      ).rejects.toThrow(`${name} check run is missing on ${s.candidate}`);
    }
    await expect(
      admit(
        s,
        {},
        {
          ci: (ci) => {
            const job = ci
              .get(s.candidate)!
              .jobs.find((candidate) => candidate.name === "Publish fully green main SHA")!;
            job.conclusion = "skipped";
          },
        },
      ),
    ).rejects.toThrow(
      "Publish fully green main SHA did not complete successfully in the authoritative workflow attempt",
    );
  });

  test("requires the GitHub Actions bot Full CI status for the exact run attempt", async () => {
    const s = scenario("good");
    const fullCi = (fixture: CiFixture) =>
      fixture.statuses.find((status) => status.context === "Full CI")!;
    const cases: Array<[(fixture: CiFixture) => void, string]> = [
      [
        (fixture) => {
          fixture.statuses = fixture.statuses.filter((status) => status.context !== "Full CI");
        },
        `Full CI status is missing on ${s.candidate}`,
      ],
      [
        (fixture) => {
          fullCi(fixture).target_url = attemptUrl(5001, 1);
        },
        "latest Full CI status is not a success for the exact authoritative run attempt",
      ],
      [
        (fixture) => {
          fullCi(fixture).target_url = attemptUrl(4999, ciRunAttempt);
        },
        "Full CI status references another workflow run",
      ],
      [
        (fixture) => {
          fullCi(fixture).creator = { login: "contributor", id: 5150, type: "User" };
        },
        "Full CI status creator numeric identity changed",
      ],
      [
        (fixture) => {
          fullCi(fixture).creator = { ...versionBot, login: "github-actions" };
        },
        "Full CI status was not created by the GitHub Actions bot",
      ],
      [
        (fixture) => {
          fixture.statuses.unshift({
            ...fullCi(fixture),
            id: fullCi(fixture).id + 10,
            state: "failure",
            created_at: "2026-10-21T11:30:00Z",
          });
        },
        "latest Full CI status is not a success for the exact authoritative run attempt",
      ],
      [
        (fixture) => {
          fixture.statuses.push({
            ...fullCi(fixture),
            id: 1,
            creator: { login: "spoofer", id: 31337, type: "User" },
          });
        },
        "Full CI status creator numeric identity changed",
      ],
      [
        (fixture) => {
          // Fast batch/queue readiness never substitutes for full green.
          fixture.statuses = [
            ...fixture.statuses.filter((status) => status.context !== "Full CI"),
            { ...fullCi(fixture), context: "Queue ready" },
          ];
        },
        `Full CI status is missing on ${s.candidate}`,
      ],
    ];
    for (const [mutate, message] of cases) {
      await expect(admit(s, {}, { ci: (ci) => mutate(ci.get(s.candidate)!) })).rejects.toThrow(
        message,
      );
    }
  });

  test("requires image and full-green receipts from the candidate's own run", async () => {
    const s = scenario("good");
    const canary = (fixture: CiFixture) =>
      fixture.artifacts.find((artifact) => artifact.name.startsWith("canary-images-"))!;
    const cases: Array<[(fixture: CiFixture) => void, string]> = [
      [
        (fixture) => {
          fixture.artifacts = fixture.artifacts.filter((artifact) => artifact !== canary(fixture));
        },
        `canary-images-${s.candidate} is not exactly one artifact of run 5001`,
      ],
      [
        (fixture) => {
          // Ancestor images cannot be mixed with descendant tests.
          canary(fixture).name = `canary-images-${s.provenance}`;
        },
        `canary-images-${s.candidate} is not exactly one artifact of run 5001`,
      ],
      [
        (fixture) => {
          canary(fixture).workflow_run.head_sha = s.provenance;
        },
        `canary-images-${s.candidate} is bound to another workflow run or commit`,
      ],
      [
        (fixture) => {
          canary(fixture).expired = true;
        },
        `canary-images-${s.candidate} has expired`,
      ],
      [
        (fixture) => {
          canary(fixture).digest = null;
        },
        `canary-images-${s.candidate} digest is missing`,
      ],
      [
        (fixture) => {
          fixture.artifacts.push({ ...canary(fixture), id: 1 });
        },
        `canary-images-${s.candidate} is not exactly one artifact of run 5001`,
      ],
      [
        (fixture) => {
          fixture.artifacts = fixture.artifacts.filter(
            (artifact) => !artifact.name.startsWith("full-green-main-"),
          );
        },
        `full-green-main-${s.candidate} is not exactly one artifact of run 5001`,
      ],
      [
        (fixture) => {
          fixture.checks = fixture.checks.filter((check) => check.name !== "Workload image builds");
          fixture.jobs = fixture.jobs.filter((job) => job.name !== "Workload image builds");
        },
        `Workload image builds check run is missing on ${s.candidate}`,
      ],
    ];
    for (const [mutate, message] of cases) {
      await expect(admit(s, {}, { ci: (ci) => mutate(ci.get(s.candidate)!) })).rejects.toThrow(
        message,
      );
    }
  });

  test("downloads and validates current-attempt receipt bodies and exact image identities", async () => {
    const s = scenario("good");
    const cases: Array<[(fixture: CiFixture) => void, string]> = [
      [
        (fixture) => {
          fixture.artifacts[0]!.created_at = "2026-10-21T09:59:00Z";
        },
        "predates the selected CI attempt",
      ],
      [
        (fixture) => {
          fixture.artifacts[0]!.digest = `sha256:${"0".repeat(64)}`;
        },
        "archive digest differs",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "full-green-main-", (body) => {
            body.runAttempt = "1";
          }),
        "full-green receipt names another run attempt",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "full-green-main-", (body) => {
            body.sha = s.provenance;
          }),
        "full-green receipt names another source",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "full-green-main-", (body) => {
            body.mode = "focused";
          }),
        "full-green receipt names another source or mode",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "canary-images-", (body) => {
            body.producer.runAttempt = "1";
          }),
        "canary receipt names another run attempt",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "canary-images-", (body) => {
            body.source.sha = s.provenance;
          }),
        "canary receipt names another source",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "canary-images-", (body) => {
            body.images = {};
          }),
        "canary api image",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "canary-images-", (body) => {
            body.images.api.repository = "ghcr.io/foreign/image";
          }),
        "canary api image identity is invalid",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "canary-images-", (body) => {
            body.images.desktop.digest = "latest";
          }),
        "canary desktop image identity is invalid",
      ],
      [
        (fixture) =>
          changeReceipt(fixture, "canary-images-", (body) => {
            body.imageTag = `canary-sha-${s.provenance}`;
          }),
        "canary image tag names another source",
      ],
    ];
    for (const [mutate, message] of cases) {
      await expect(admit(s, {}, { ci: (ci) => mutate(ci.get(s.candidate)!) })).rejects.toThrow(
        message,
      );
    }
    const { requests, result } = await admit(s);
    for (const artifact of result.fullGreen.artifacts) {
      expect(requests).toContain(`GET ${prefix}/actions/artifacts/${artifact.id}/zip`);
      expect(artifact.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("never borrows complete evidence from the provenance commit", async () => {
    const s = scenario("good");
    await expect(
      admit(
        s,
        {},
        {
          ci: (ci) => {
            ci.clear();
            ci.set(s.provenance, ciFor(s.provenance, 5004));
          },
        },
      ),
    ).rejects.toThrow(`Typecheck and unit tests check run is missing on ${s.candidate}`);
  });

  test("requires retained Version head evidence and source admission at the provenance", async () => {
    const s = scenario("good");
    const fixture = apiFixture(s);
    const withoutRetainedHead = async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes(`/git/ref/tags/${contract.releaseHeadTagPrefix}${s.versionHead}`)
        ? response({ message: "missing" }, 404)
        : fixture.fetchImpl(input, init);
    await expect(
      verifyApprovedMerge({
        env: admissionEnv(s),
        fetchImpl: withoutRetainedHead,
        logger: quietLogger,
      }),
    ).rejects.toThrow("failed with HTTP 404");
  });
});

describe("descendant merge-content audit", () => {
  test("recomputes the provenance and every intervening first-parent merge", () => {
    const s = scenario("good");
    const audit = auditDescendantMergeContent({
      gitDir: s.repo.dir,
      provenanceSha: s.provenance,
      candidateSha: s.candidate,
    });
    expect(audit.merges.map((merge: { sha: string }) => merge.sha)).toEqual([
      s.provenance,
      s.firstIntervening,
      s.candidate,
    ]);
    expect(audit.merges[2]?.treeSha).toBe(s.repo.tree(s.candidate));
  });

  test("fails closed for every unsupported or unverifiable history", () => {
    const audit = (variant: Variant, overrides: Record<string, unknown> = {}) => {
      const s = scenario(variant);
      return () =>
        auditDescendantMergeContent({
          gitDir: s.repo.dir,
          provenanceSha: s.provenance,
          candidateSha: s.candidate,
          ...overrides,
        });
    };
    const good = scenario("good");
    expect(audit("bad-tree")).toThrow("landed merge content mismatch");
    expect(audit("conflict-resolved")).toThrow("cannot be recomputed without conflict resolution");
    expect(audit("direct-commit")).toThrow("is not a two-parent merge");
    expect(audit("side-branch")).toThrow(
      "Version provenance is not on the release candidate's first-parent main history",
    );
    expect(audit("squash-provenance")).toThrow("is not a two-parent merge");
    expect(audit("good", { maximumMerges: 1 })).toThrow(
      "descendant first-parent history length is outside the admitted bound",
    );
    expect(audit("good", { provenanceSha: good.candidate, candidateSha: good.provenance })).toThrow(
      "release candidate does not contain the Version provenance commit",
    );
    expect(audit("good", { candidateSha: "0".repeat(40) })).toThrow(
      `descendant Git object ${"0".repeat(40)} is missing`,
    );
    expect(audit("good", { gitDir: join(good.repo.dir, "..") })).toThrow(
      "descendant Git history is unavailable",
    );

    const shallowRoot = mkdtempSync(join(tmpdir(), "opengeni-descendant-shallow-"));
    temporaryRoots.push(shallowRoot);
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "2", `file://${good.repo.dir}`, join(shallowRoot, "clone")],
      { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: shallowRoot } },
    );
    expect(audit("good", { gitDir: join(shallowRoot, "clone") })).toThrow(
      "descendant Git history is shallow",
    );
  });
});
