import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  admitCanaryAncestorEvidence,
  admitCanarySource,
  canaryGit,
  verifyCanaryController,
} from "./canary-source-admission";

const source = "a".repeat(40),
  controller = "b".repeat(40);
const repository = "Cloudgeni-ai/opengeni";
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: repository,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: controller,
  GITHUB_WORKFLOW_SHA: controller,
  SOURCE_SHA: source,
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-canary.yml@refs/heads/main`,
};
const branch = { name: "main", protected: true };
const pulls = [
  {
    number: 4568,
    state: "closed",
    merged_at: "2026-10-16T08:09:44Z",
    merge_commit_sha: source,
    base: { ref: "main", repo: { full_name: repository } },
  },
];
const run = {
  id: 1234,
  run_attempt: 1,
  head_sha: source,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const jobs = ["Typecheck and unit tests", "Deployment artifacts", "Workload image builds"].map(
  (name) => ({
    name,
    run_id: 1234,
    run_attempt: 1,
    head_sha: source,
    status: "completed",
    conclusion: "success",
  }),
);

test("exact merged protected-main ancestor requires all successful exact-source gates", () => {
  expect(admitCanaryAncestorEvidence(source, branch, pulls, [run], jobs)).toEqual({
    source,
    pullRequest: 4568,
    ciRunId: "1234",
    ciAttempt: "1",
  });
  for (const patch of [{ protected: false }, { name: "other" }])
    expect(() =>
      admitCanaryAncestorEvidence(source, { ...branch, ...patch }, pulls, [run], jobs),
    ).toThrow();
  for (const patch of [
    { merged_at: null },
    { merge_commit_sha: controller },
    { base: { ref: "production" } },
    { state: "open" },
  ])
    expect(() =>
      admitCanaryAncestorEvidence(source, branch, [{ ...pulls[0], ...patch }], [run], jobs),
    ).toThrow();
  for (const patch of [
    { head_sha: controller },
    { event: "pull_request" },
    { head_branch: "feature" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "other/opengeni" } },
  ])
    expect(() =>
      admitCanaryAncestorEvidence(source, branch, pulls, [{ ...run, ...patch }], jobs),
    ).toThrow();
  for (const patch of [
    { conclusion: "skipped" },
    { conclusion: "cancelled" },
    { run_id: 1235 },
    { run_attempt: 2 },
    { head_sha: controller },
  ])
    expect(() =>
      admitCanaryAncestorEvidence(
        source,
        branch,
        pulls,
        [run],
        [{ ...jobs[0], ...patch }, ...jobs.slice(1)],
      ),
    ).toThrow();
  expect(() =>
    admitCanaryAncestorEvidence(
      source,
      branch,
      pulls,
      [run, { ...run, id: 1235, conclusion: "failure" }],
      jobs,
    ),
  ).toThrow();
  expect(() => admitCanaryAncestorEvidence(source, branch, pulls, [run], jobs.slice(1))).toThrow();
  expect(() =>
    admitCanaryAncestorEvidence(source, branch, pulls, [run], [...jobs, jobs[0]!]),
  ).toThrow();
});

test("controller cannot be a tag, PR workflow, foreign repo or substituted script", () => {
  expect(() => verifyCanaryController(env, controller)).not.toThrow();
  for (const patch of [
    { GITHUB_REF: "refs/tags/main" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_WORKFLOW_SHA: source },
    { GITHUB_SHA: source },
    { SOURCE_SHA: "main" },
    { GITHUB_REPOSITORY: "fork/opengeni" },
  ])
    expect(() => verifyCanaryController({ ...env, ...patch }, controller)).toThrow();
});

test("source is an ancestor of the frozen controller, which stays checked out", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "canary-source-"));
  const git = (...args: string[]) => canaryGit(cwd, args);
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "frozen candidate");
    const ancestor = git("rev-parse", "HEAD");
    git("checkout", "-b", "unmerged");
    git("commit", "--allow-empty", "-m", "unmerged source");
    const unrelated = git("rev-parse", "HEAD");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "controller");
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", head);
    const current = { ...env, GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head, SOURCE_SHA: head };
    expect(await admitCanarySource(cwd, current)).toEqual({
      source: head,
      controller: head,
      mode: "current-head",
    });
    await expect(admitCanarySource(cwd, { ...current, SOURCE_SHA: ancestor })).rejects.toThrow(
      "GitHub access",
    );
    await expect(admitCanarySource(cwd, { ...current, SOURCE_SHA: unrelated })).rejects.toThrow(
      "Git source check",
    );
    expect(git("rev-parse", "HEAD")).toBe(head);
    const workflow = Bun.YAML.parse(
      readFileSync(new URL("../.github/workflows/publish-canary.yml", import.meta.url), "utf8"),
    ) as any;
    const step = workflow.jobs.publish.steps.find(
      (candidate: any) => candidate.name === "Admit protected main source",
    );
    expect(
      spawnSync("bash", ["-c", step.run], {
        cwd,
        env: { ...process.env, ...current },
        encoding: "utf8",
      }).status,
    ).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
