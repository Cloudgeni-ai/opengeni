import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAuth, GitHubReader } from "./github";
import { config } from "./model";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const sha = "a".repeat(40);
test("App tokens explicitly request granted administration read, never administration write", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const mode of ["active", "shadow-ci", "shadow"]) {
    let permissions: Record<string, string> = {};
    const transport = (async (_input: unknown, init?: RequestInit) => {
      permissions = JSON.parse(String(init?.body)).permissions;
      return Response.json({
        token: "fixture",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }) as typeof fetch;
    await new GitHubAuth(
      {
        BATCHER_MODE: mode,
        GITHUB_APP_ID: "1",
        GITHUB_APP_INSTALLATION_ID: "2",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      transport,
    ).token();
    expect(permissions).toEqual({
      contents: mode === "shadow" ? "read" : "write",
      ...(mode === "shadow" ? {} : { workflows: "write" }),
      actions: mode === "active" ? "write" : "read",
      pull_requests: mode === "active" ? "write" : "read",
      issues: mode === "active" ? "write" : "read",
      administration: "read",
    });
  }
});
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
    autoEnabled: false,
    protected: false,
    secondRulePage: false,
    missingRunOnce: false,
    twoPulls: false,
    inventory: null as any,
    inventoryStatus: 200,
    inventoryErrors: false,
    protectionStatus: 404,
    checkStatus: 200,
    checkAuthorization: [] as string[],
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
      else if (query.includes("ClassicProtectionInventory")) {
        return Response.json(
          {
            data: { repository: { branchProtectionRules: state.inventory } },
            ...(state.inventoryErrors ? { errors: [{ message: "not visible" }] } : {}),
          },
          { status: state.inventoryStatus },
        );
      } else if (query.includes("BranchReview"))
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
                    ...(state.autoEnabled
                      ? [
                          {
                            __typename: "AutoMergeEnabledEvent",
                            id: "auto-1",
                            createdAt: "2026-10-23T00:01:00Z",
                          },
                        ]
                      : []),
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
      else if (path === "branches/main") body = { protected: state.protected };
      else if (path === "branches/main/protection")
        return Response.json({}, { status: state.protectionStatus });
      else if (path === "rules/branches/main")
        body = state.secondRulePage
          ? url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, () => ({ type: "deletion" }))
            : [{ type: "workflows" }]
          : state.reviewRequired
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
      else if (path === `commits/${sha}/check-runs`) {
        state.checkAuthorization.push(new Headers(init?.headers).get("Authorization") ?? "");
        if (state.checkStatus !== 200) return Response.json({}, { status: state.checkStatus });
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
      } else if (path === "actions/runs/200") {
        if (state.missingRunOnce) {
          state.missingRunOnce = false;
          return new Response("missing", { status: 404 });
        }
        body = {
          id: 200,
          run_attempt: state.currentAttempt,
          path: ".github/workflows/pr-ci.yml",
          head_sha: sha,
        };
      } else if (path === `actions/runs/200/attempts/${state.currentAttempt}/jobs`)
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
      else if (["pulls/1/files", "pulls/2/files"].includes(path))
        body = [{ filename: "apps/api/a.ts" }];
      else if (path.includes("comments")) {
        state.commentsRead = true;
        throw Error("Prose is not admission");
      } else throw Error(`Unexpected path ${path}`);
    }
    if (url.pathname.endsWith("/pulls") && state.twoPulls) body.push({ ...body[0], number: 2 });
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
  expect(f.state.checkAuthorization).toEqual(["Bearer fixture"]);
});
test("denied check reads fail closed without anonymous or credential fallback", async () => {
  for (const status of [401, 403, 404, 500]) {
    const f = await fixture();
    f.state.checkStatus = status;
    if (status === 404) {
      const result = await f.reader.ready();
      expect(result.ready).toHaveLength(0);
      expect(result.excluded[0]?.reason).toBe("Exact-head hosted run or job no longer readable");
    } else await expect(f.reader.ready()).rejects.toThrow();
    // Transient reads retry with the same credential; never fall back to an
    // anonymous read or a different identity to manufacture admission evidence.
    expect(f.state.checkAuthorization).toEqual(
      Array(status === 500 ? 5 : 1).fill("Bearer fixture"),
    );
  }
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
test("auto-merge requires the actual enable event and exact-head CI", async () => {
  const f = await fixture();
  f.state.queueReady = false;
  expect((await f.reader.ready()).ready).toHaveLength(0);
  f.state.autoEnabled = true;
  expect((await f.reader.ready()).ready[0]?.binding.source).toBe("auto-merge");
  f.state.jobCheckId = 999;
  expect((await f.reader.ready()).ready).toHaveLength(0);
  expect(f.state.commentsRead).toBe(false);
});
test("required workflow on second rule page cannot be ignored", async () => {
  const f = await fixture();
  f.state.secondRulePage = true;
  await expect(f.reader.ready()).rejects.toThrow("Required workflow");
});
test("null classic policy on protected branch is unknown rather than absent", async () => {
  const f = await fixture();
  f.state.protected = true;
  await expect(f.reader.ready()).rejects.toThrow("absence is not proven");
});
test("ruleset-protected branch accepts positively complete empty classic inventory, retaining ruleset reviews", async () => {
  const f = await fixture();
  f.state.protected = true;
  f.state.inventory = {
    totalCount: 0,
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  expect((await f.reader.ready()).ready).toHaveLength(1);
  f.state.reviewRequired = true;
  f.state.reviewDecision = "REVIEW_REQUIRED";
  expect((await f.reader.ready()).ready).toHaveLength(0);
});
test("404 plus null projection never waives incomplete, errored or nonempty classic inventory", async () => {
  for (const inventory of [
    null,
    {},
    { totalCount: 0, nodes: [], pageInfo: { hasNextPage: true, endCursor: "more" } },
    { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    { totalCount: 0, nodes: [{ id: "rule" }], pageInfo: { hasNextPage: false, endCursor: null } },
    { totalCount: 1, nodes: [{ id: "rule" }], pageInfo: { hasNextPage: false, endCursor: "rule" } },
  ]) {
    const f = await fixture();
    f.state.protected = true;
    f.state.inventory = inventory;
    await expect(f.reader.ready()).rejects.toThrow("absence is not proven");
  }
  for (const field of ["inventoryErrors", "inventoryStatus", "protectionStatus"] as const) {
    const f = await fixture();
    f.state.protected = true;
    f.state.inventory = {
      totalCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    if (field === "inventoryErrors") f.state.inventoryErrors = true;
    else f.state[field] = 403;
    await expect(f.reader.ready()).rejects.toThrow();
  }
});
test("positive classic REST policy cannot be overridden by an empty inventory", async () => {
  const f = await fixture();
  f.state.protected = true;
  f.state.protectionStatus = 200;
  f.state.inventory = {
    totalCount: 0,
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  await expect(f.reader.ready()).rejects.toThrow("changed during observation");
});
test("one deleted hosted run excludes only that PR", async () => {
  const f = await fixture();
  f.state.missingRunOnce = true;
  f.state.twoPulls = true;
  const result = await f.reader.ready();
  expect(result.excluded[0]?.number).toBe(1);
  expect(result.ready[0]?.number).toBe(2);
});
test("invalid ON notice fails during configuration", () => {
  expect(() => config({ BATCHER_ON_NOTICE_ID: "bad id!" })).toThrow("BATCHER_ON_NOTICE_ID");
});
