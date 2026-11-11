import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "Cloudgeni-ai/opengeni";
const requiredJobs = ["Typecheck and unit tests", "Deployment artifacts", "Workload image builds"];
type Row = Record<string, any>;

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function verifyCanaryController(
  env: Record<string, string | undefined>,
  head: string,
): void {
  requireThat(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_SERVER_URL === "https://github.com" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW_REF ===
        `${repository}/.github/workflows/publish-canary.yml@refs/heads/main` &&
      /^[0-9a-f]{40}$/.test(head) &&
      head === env.GITHUB_SHA &&
      head === env.GITHUB_WORKFLOW_SHA &&
      /^[0-9a-f]{40}$/.test(env.SOURCE_SHA ?? ""),
    "Canary protected-main controller identities must agree",
  );
}

export function admitCanaryAncestorEvidence(
  source: string,
  branch: Row,
  pulls: Row[],
  runs: Row[],
  jobs: Row[],
) {
  requireThat(
    branch.name === "main" && branch.protected === true,
    "Canary main branch is not protected",
  );
  const merged = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === source &&
      pr.base?.ref === "main" &&
      pr.base?.repo?.full_name === repository &&
      pr.state === "closed",
  );
  requireThat(merged.length > 0, "Canary source is not an exact normally merged main PR commit");
  const run = runs
    .filter(
      (candidate) =>
        candidate.head_sha === source &&
        candidate.head_branch === "main" &&
        candidate.event === "push" &&
        candidate.path === ".github/workflows/ci.yml" &&
        candidate.repository?.full_name === repository &&
        candidate.head_repository?.full_name === repository,
    )
    .sort((a, b) => b.id - a.id)[0];
  requireThat(
    run && run.status === "completed" && run.conclusion === "success",
    "Canary exact-source main CI is not successful",
  );
  for (const name of requiredJobs) {
    const matches = jobs.filter(
      (job) =>
        job.name === name &&
        job.run_id === run.id &&
        job.head_sha === source &&
        job.run_attempt === run.run_attempt,
    );
    requireThat(
      matches.length === 1 &&
        matches[0]!.status === "completed" &&
        matches[0]!.conclusion === "success",
      `Canary required exact-source CI job is not successful: ${name}`,
    );
  }
  return {
    source,
    pullRequest: merged[0]!.number,
    ciRunId: String(run.id),
    ciAttempt: String(run.run_attempt),
  };
}

export function canaryGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
  requireThat(result.status === 0, "Canary immutable Git source check failed");
  return result.stdout.trim();
}

export async function admitCanarySource(root: string, env = process.env) {
  const controller = canaryGit(root, ["rev-parse", "HEAD"]);
  verifyCanaryController(env, controller);
  const source = env.SOURCE_SHA!;
  canaryGit(root, ["merge-base", "--is-ancestor", source, controller]);
  canaryGit(root, ["merge-base", "--is-ancestor", controller, "origin/main"]);
  // The established current-head lane is unchanged. Older source needs positive
  // merge and exact-source CI evidence, not merely a reachable commit or PR head.
  if (source === controller) return { source, controller, mode: "current-head" as const };
  requireThat(env.GH_TOKEN, "Canary ancestor admission requires read-only GitHub access");
  const get = async (path: string): Promise<Row | Row[]> => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GH_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    requireThat(response.ok, `Canary GitHub admission read failed: ${response.status}`);
    // A truncated inventory cannot authorize a publication.
    requireThat(
      !response.headers.get("link")?.includes('rel="next"'),
      "Canary admission inventory needs pagination",
    );
    return (await response.json()) as Row | Row[];
  };
  const [branch, pulls, listed] = await Promise.all([
    get("branches/main"),
    get(`commits/${source}/pulls?per_page=100`),
    get(`actions/workflows/ci.yml/runs?head_sha=${source}&event=push&per_page=100`),
  ]);
  const runs = (listed as Row).workflow_runs as Row[];
  requireThat(
    Array.isArray(runs) && (listed as Row).total_count === runs.length,
    "Canary CI inventory incomplete",
  );
  const run = runs.sort((a, b) => b.id - a.id)[0];
  requireThat(
    run && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt),
    "Canary exact-source main CI absent",
  );
  const jobs: Row[] = [];
  // CI has more than 100 shards; fetch every page of the selected exact attempt.
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GH_TOKEN}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    requireThat(response.ok, `Canary CI jobs read failed: ${response.status}`);
    const body = (await response.json()) as Row;
    requireThat(Array.isArray(body.jobs), "Canary CI jobs inventory invalid");
    jobs.push(...body.jobs);
    if (jobs.length === body.total_count) break;
    requireThat(body.jobs.length === 100 && page < 20, "Canary CI jobs inventory incomplete");
  }
  return {
    ...admitCanaryAncestorEvidence(source, branch as Row, pulls as Row[], runs, jobs),
    controller,
    mode: "main-ancestor" as const,
  };
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const admission = await admitCanarySource(root);
  mkdirSync(join(root, ".release"), { recursive: true });
  writeFileSync(
    join(root, ".release/canary-source-admission.json"),
    `${JSON.stringify(admission, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(JSON.stringify(admission));
}
