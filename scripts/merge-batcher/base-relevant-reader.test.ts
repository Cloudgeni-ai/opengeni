import { expect, test } from "bun:test";
import { GitHubAuth, GitHubReader } from "./github";
import { config } from "./model";
import { failedBaseHold } from "./base-failure";
import type { Run } from "./model";
const sha = "a".repeat(40);
async function observe(kind: string) {
  let listings = 0;
  const pages: number[] = [];
  const row = {
    id: 51,
    run_attempt: 2,
    head_sha: sha,
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    event: "push",
    status: kind === "waiting" ? "waiting" : "in_progress",
    conclusion: null,
  };
  const job = (id: number, name: string) => ({
    id,
    run_id: 51,
    run_attempt: 2,
    name,
    status: "completed",
    conclusion: "success" as string | null,
  });
  const jobs = [
    job(1, "Source and type contracts"),
    job(2, "Unit tests (shard 1/2)"),
    job(3, "Unit tests (shard 2/2)"),
    { ...job(4, "Public-release image"), status: "waiting", conclusion: null },
  ];
  if (kind === "pending-unit") Object.assign(jobs[2]!, { status: "in_progress", conclusion: null });
  if (kind === "red-unit") jobs[2]!.conclusion = "failure";
  if (kind === "missing-unit") jobs.splice(2, 1);
  if (kind === "wrong-job-attempt") jobs[2]!.run_attempt = 1;
  if (kind === "duplicate-job") jobs.push(jobs[2]!);
  if (["pages", "count-drift", "short-page", "duplicate-page"].includes(kind)) {
    while (jobs.length < 105) jobs.push(job(jobs.length + 1, "Unrelated completed job"));
  }
  const transport = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/workflows/ci.yml/runs")) {
      listings++;
      return Response.json({
        workflow_runs: [
          {
            ...row,
            ...(listings > 1 && kind === "rerun" ? { run_attempt: 3 } : {}),
            ...(listings > 1 && kind === "new-run" ? { id: 52 } : {}),
          },
        ],
      });
    }
    if (url.pathname.endsWith("/attempts/2"))
      return Response.json({
        ...row,
        ...(kind === "wrong-head" ? { head_sha: "b".repeat(40) } : {}),
        ...(kind === "wrong-attempt" ? { run_attempt: 1 } : {}),
      });
    if (url.pathname.endsWith("/attempts/2/jobs")) {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      if (kind === "api-error") return Response.json({}, { status: 403 });
      let selected = jobs.slice((page - 1) * 100, page * 100);
      if (kind === "short-page") selected = selected.slice(0, 10);
      if (kind === "duplicate-page" && page === 2) selected = [jobs[0]!, ...selected.slice(1)];
      return Response.json({
        total_count: jobs.length + (kind === "count-drift" && page === 2 ? 1 : 0),
        jobs: selected,
      });
    }
    throw Error(`Unexpected path ${url.pathname}`);
  }) as typeof fetch;
  const reader = new GitHubReader(
    config({ BATCHER_REPOSITORY: "Cloudgeni-ai/opengeni" }),
    new GitHubAuth({ GH_TOKEN: "fixture" }),
    transport,
  );
  return { evidence: await reader.baseCI(sha), pages };
}
test.each(["running", "waiting", "pages"])(
  "completed relevant classes are comparable while unrelated work is %s",
  async (kind) => {
    const { evidence, pages } = await observe(kind);
    expect(evidence.status).toBe("classes");
    expect(evidence.classes).toEqual({ source: "green", units: "green" });
    expect(evidence.attempt).toBe(2);
    expect(failedBaseHold({ failedClasses: ["units"] } as Run, sha, evidence)).toBeNull();
    expect(pages).toEqual(kind === "pages" ? [1, 2] : [1]);
  },
);
test.each(["pending-unit", "red-unit", "missing-unit"])(
  "relevant %s remains a hold",
  async (kind) => {
    const { evidence } = await observe(kind);
    expect(evidence.status).toBe("classes");
    expect(failedBaseHold({ failedClasses: ["units"] } as Run, sha, evidence)).not.toBeNull();
    expect(failedBaseHold({ failedClasses: ["source"] } as Run, sha, evidence)).toBeNull();
  },
);
test.each([
  "wrong-head",
  "wrong-attempt",
  "wrong-job-attempt",
  "rerun",
  "new-run",
  "api-error",
  "count-drift",
  "short-page",
  "duplicate-job",
  "duplicate-page",
])("incomplete or inconsistent %s is never clearance", async (kind) => {
  const { evidence } = await observe(kind);
  expect(evidence.status).toBe("unknown");
  expect(failedBaseHold({ failedClasses: ["units"] } as Run, sha, evidence)).not.toBeNull();
});
