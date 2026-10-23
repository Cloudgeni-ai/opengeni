import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubAuth, GitHubReader } from "./github";
import { config } from "./model";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const sha = "a".repeat(40);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "github-admission-"));
  roots.push(root);
  const state = {
    commentsRead: false,
    hosted: true,
    hostedIdentity: true,
    currentAttempt: 1,
    jobCheckId: 100,
    reviewRequired: false,
    reviewDecision: "APPROVED",
    unresolved: false,
    classic: false,
    queueReady: true,
  };
  const transport = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(String(input));
    let body: any;
    if (url.pathname === "/graphql") {
      const query = JSON.parse(String(init?.body)).query;
      if (query.includes("ClassicBranchPolicy"))
        body = {
          data: {
            repository: {
              ref: {
                branchProtectionRule: state.classic
                  ? {
                      requiresApprovingReviews: true,
                      requiresConversationResolution: true,
                      requiredStatusChecks: [],
                    }
                  : null,
              },
            },
          },
        };
      else if (query.includes("BranchReview"))
        body = {
          data: {
            repository: {
              pullRequest: {
                reviewDecision: state.reviewDecision,
                reviewThreads: {
                  nodes: [{ isResolved: !state.unresolved }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        };
      else if (query.includes("ReadyTimeline"))
        body = {
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  nodes: [
                    {
                      __typename: "LabeledEvent",
                      id: "ready-1",
                      createdAt: "2026-10-23T00:00:00Z",
                      label: { name: "queue-ready" },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        };
      else throw Error("Unexpected GraphQL query");
    } else {
      const path = url.pathname.replace("/repos/Cloudgeni-ai/opengeni/", "");
      if (path === "pulls")
        body = [
          {
            number: 1,
            head: { sha, ref: "feature" },
            draft: false,
            labels: state.queueReady ? [{ name: "queue-ready" }] : [],
            auto_merge: {},
          },
        ];
      else if (path === "rules/branches/main")
        body = state.reviewRequired
          ? [
              {
                type: "pull_request",
                parameters: {
                  required_approving_review_count: 1,
                  required_review_thread_resolution: true,
                },
              },
            ]
          : [];
      else if (path === `commits/${sha}/check-runs`)
        body = {
          check_runs: [
            {
              id: 100,
              name: "PR CI",
              head_sha: sha,
              status: "completed",
              conclusion: "success",
              app: { id: 15368, slug: "github-actions" },
              details_url: "https://github.com/Cloudgeni-ai/opengeni/actions/runs/200/job/300",
            },
          ],
        };
      else if (path === "actions/runs/200")
        body = {
          id: 200,
          run_attempt: state.currentAttempt,
          path: ".github/workflows/pr-ci.yml",
          head_sha: sha,
        };
      else if (path === `actions/runs/200/attempts/${state.currentAttempt}/jobs`)
        body = {
          jobs: [
            {
              name: "PR CI",
              status: "completed",
              conclusion: "success",
              labels: state.hosted ? ["ubuntu-latest"] : ["self-hosted", "linux"],
              runner_id: 1000123456,
              runner_group_id: state.hostedIdentity ? 0 : 1,
              runner_group_name: state.hostedIdentity ? "GitHub Actions" : "Default",
              check_run_url: `https://api.github.com/repos/Cloudgeni-ai/opengeni/check-runs/${state.jobCheckId}`,
            },
          ],
        };
      else if (path === "pulls/1/files") body = [{ filename: "apps/api/a.ts" }];
      else if (path.includes("comments")) {
        state.commentsRead = true;
        throw Error("Prose is not admission");
      } else throw Error(`Unexpected path ${path}`);
    }
    return Response.json(body);
  }) as typeof fetch;
  const c = config({ BATCHER_OUTPUT_DIR: root });
  return {
    state,
    reader: new GitHubReader(c, new GitHubAuth({ GH_TOKEN: "fixture" }, transport), transport),
  };
}
test("real reader never fetches prose evidence and binds hosted exact-head proof", async () => {
  const f = await fixture();
  const result = await f.reader.ready();
  expect(result.ready).toHaveLength(1);
  expect(f.state.commentsRead).toBe(false);
  expect(result.ready[0]!.binding.evidenceId).toBe("github-ci:100");
});
test("latest attempt must contain the required check, not an older successful job", async () => {
  const f = await fixture();
  f.state.currentAttempt = 2;
  f.state.jobCheckId = 101;
  expect((await f.reader.ready()).ready).toHaveLength(0);
});
test("self-hosted jobs are not hosted-CI evidence", async () => {
  const f = await fixture();
  f.state.hosted = false;
  expect((await f.reader.ready()).ready).toHaveLength(0);
});
test("hosted-looking labels alone cannot prove a GitHub-hosted runner", async () => {
  const f = await fixture();
  f.state.hostedIdentity = false;
  expect((await f.reader.ready()).ready).toHaveLength(0);
});
test("native ruleset and classic review requirements both apply without added reviews", async () => {
  for (const field of ["classic", "reviewRequired"] as const) {
    const f = await fixture();
    f.state[field] = true;
    f.state.reviewDecision = "REVIEW_REQUIRED";
    expect((await f.reader.ready()).ready).toHaveLength(0);
    f.state.reviewDecision = "APPROVED";
    f.state.unresolved = true;
    expect((await f.reader.ready()).ready).toHaveLength(0);
    f.state.unresolved = false;
    expect((await f.reader.ready()).ready).toHaveLength(1);
  }
});
test("auto-merge alone does not admit", async () => {
  const f = await fixture();
  f.state.queueReady = false;
  expect((await f.reader.ready()).ready).toHaveLength(0);
  expect(f.state.commentsRead).toBe(false);
});
