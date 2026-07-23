import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_AUTOMATION_CONTRACT,
  beginVersionPrChecks,
  validateVersionPrCiAdmission,
  validateVersionPrDispatch,
  verifyApprovedMerge,
} from "./check-release-pr-automation.mjs";

const root = join(import.meta.dir, "..");
const releaseWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath);
const ciWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath);
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const mergeSha = "d".repeat(40);
const baseTreeSha = "e".repeat(40);
const headTreeSha = "f".repeat(40);
const pullNumber = 88;
const runId = 123456;
const runAttempt = 2;

type RequestRecord = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: Record<string, any>;
};

function repository() {
  return {
    full_name: RELEASE_AUTOMATION_CONTRACT.repository,
    owner: { login: RELEASE_AUTOMATION_CONTRACT.owner, type: "Organization" },
    default_branch: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
    archived: false,
    disabled: false,
    private: false,
  };
}

function mainRef(sha = baseSha) {
  return { ref: "refs/heads/main", object: { type: "commit", sha } };
}

function versionPull(
  overrides: {
    author?: Record<string, unknown>;
    base?: string;
    head?: string;
    headRepository?: string;
  } = {},
) {
  return {
    number: pullNumber,
    state: "open",
    merged: false,
    draft: false,
    user: overrides.author ?? RELEASE_AUTOMATION_CONTRACT.versionAuthor,
    base: {
      ref: "main",
      sha: overrides.base ?? baseSha,
      repo: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
    },
    head: {
      ref: "changeset-release/main",
      sha: overrides.head ?? headSha,
      repo: {
        full_name: overrides.headRepository ?? RELEASE_AUTOMATION_CONTRACT.repository,
      },
    },
    commits: 1,
    changed_files: 1,
  };
}

function releasePushEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
    GITHUB_RUN_ATTEMPT: String(runAttempt),
    GITHUB_RUN_ID: String(runId),
    GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
    GITHUB_SHA: baseSha,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_WORKFLOW_REF:
      `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
      `${RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: baseSha,
    VERSION_PR_NUMBER: String(pullNumber),
    ...overrides,
  };
}

function automationCiEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
    GITHUB_RUN_ID: "987654",
    GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
    GITHUB_SHA: baseSha,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_WORKFLOW_REF:
      `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
      `${RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: baseSha,
    AUTOMATION_PR_NUMBER: String(pullNumber),
    AUTOMATION_HEAD_SHA: headSha,
    AUTOMATION_BASE_SHA: baseSha,
    AUTOMATION_SOURCE_RUN_ID: String(runId),
    AUTOMATION_SOURCE_RUN_ATTEMPT: String(runAttempt),
    ...overrides,
  };
}

function response(value: unknown, status = 200) {
  if (status === 204) return new Response(null, { status });
  return Response.json(value, { status });
}

function dispatchFixture(
  options: {
    author?: Record<string, unknown>;
    headRepository?: string;
    mainSha?: string;
    stalePullReads?: number;
  } = {},
) {
  const requests: RequestRecord[] = [];
  let pullReads = 0;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname, query: url.searchParams, body });
    const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
    if (method === "GET" && url.pathname === prefix) return response(repository());
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/main`)
      return response(mainRef(options.mainSha));
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}`) {
      pullReads += 1;
      return response(
        versionPull({
          author: options.author,
          base: pullReads <= (options.stalePullReads ?? 0) ? "a".repeat(40) : baseSha,
          headRepository: options.headRepository,
        }),
      );
    }
    if (method === "POST" && url.pathname === `${prefix}/actions/workflows/ci.yml/dispatches`)
      return response(null, 204);
    return response({ message: `unexpected ${method} ${url.pathname}` }, 404);
  }
  return { fetchImpl, requests };
}

describe("Version PR dispatch identity", () => {
  test("dispatches trusted main CI for an exact github-actions[bot] Version PR", async () => {
    const fixture = dispatchFixture();
    const result = await validateVersionPrDispatch({
      env: releasePushEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(result).toEqual({ prNumber: pullNumber, headSha, baseSha });
    const dispatch = fixture.requests.find((request) => request.method === "POST");
    expect(dispatch?.body).toEqual({
      ref: "main",
      inputs: {
        automation_pr_number: String(pullNumber),
        automation_head_sha: headSha,
        automation_base_sha: baseSha,
        source_release_run_id: String(runId),
        source_release_run_attempt: String(runAttempt),
      },
    });
  });

  test("waits for the exact Version PR base projection before dispatching", async () => {
    const fixture = dispatchFixture({ stalePullReads: 1 });
    const sleeps: number[] = [];
    const result = await validateVersionPrDispatch({
      env: releasePushEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      projectionAttempts: 2,
      projectionDelayMs: 7,
      projectionSleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    });
    expect(result).toEqual({ prNumber: pullNumber, headSha, baseSha });
    expect(sleeps).toEqual([7]);
    expect(
      fixture.requests.filter((request) => request.path.endsWith(`/pulls/${pullNumber}`)),
    ).toHaveLength(3);
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("fails closed when the Version PR projection never converges", async () => {
    const fixture = dispatchFixture({ stalePullReads: 3 });
    await expect(
      validateVersionPrDispatch({
        env: releasePushEnv(),
        fetchImpl: fixture.fetchImpl,
        projectionAttempts: 2,
        projectionDelayMs: 0,
        projectionSleep: async () => {},
      }),
    ).rejects.toThrow("Version PR base SHA changed");
    expect(fixture.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects a human-authored Version PR without dispatching", async () => {
    const fixture = dispatchFixture({
      author: { login: "jorgensandhaug", id: 55702375, type: "User" },
    });
    await expect(
      validateVersionPrDispatch({ env: releasePushEnv(), fetchImpl: fixture.fetchImpl }),
    ).rejects.toThrow("Version PR author login changed");
    expect(fixture.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects fork identity and stale main before dispatch", async () => {
    const fork = dispatchFixture({ headRepository: "attacker/opengeni" });
    await expect(
      validateVersionPrDispatch({ env: releasePushEnv(), fetchImpl: fork.fetchImpl }),
    ).rejects.toThrow("Version PR is not from the base repository");
    const stale = dispatchFixture({ mainSha: "9".repeat(40) });
    await expect(
      validateVersionPrDispatch({ env: releasePushEnv(), fetchImpl: stale.fetchImpl }),
    ).rejects.toThrow("default branch differs from the admitted base SHA");
  });
});

function admissionFixture(
  options: {
    sourceConclusion?: string | null;
    sourceEvent?: string;
    sourceStatus?: string;
    terminalMainSha?: string;
  } = {},
) {
  const requests: RequestRecord[] = [];
  let mainReads = 0;
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, query: url.searchParams });
    if (method !== "GET") return response({ message: "read-only fixture" }, 405);
    if (url.pathname === prefix) return response(repository());
    if (url.pathname === `${prefix}/git/ref/heads/main`) {
      mainReads += 1;
      return response(mainRef(mainReads > 2 ? (options.terminalMainSha ?? baseSha) : baseSha));
    }
    if (url.pathname === `${prefix}/pulls/${pullNumber}`) return response(versionPull());
    if (url.pathname === `${prefix}/actions/runs/${runId}`)
      return response({
        id: runId,
        run_attempt: runAttempt,
        event: options.sourceEvent ?? "push",
        status: options.sourceStatus ?? "completed",
        conclusion: options.sourceConclusion === undefined ? "success" : options.sourceConclusion,
        path: RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath,
        head_branch: "main",
        head_sha: baseSha,
        repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
        head_repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
      });
    if (url.pathname === `${prefix}/git/commits/${baseSha}`)
      return response({
        sha: baseSha,
        tree: { sha: baseTreeSha },
        parents: [{ sha: "a".repeat(40) }],
      });
    if (url.pathname === `${prefix}/git/commits/${headSha}`)
      return response({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: baseSha }],
      });
    if (url.pathname === `${prefix}/compare/${baseSha}...${headSha}`)
      return response({
        status: "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        commits: [{ sha: headSha }],
        behind_by: 0,
        ahead_by: 1,
      });
    if (url.pathname === `${prefix}/pulls/${pullNumber}/files`)
      return response([{ filename: "package.json", status: "modified" }]);
    if (url.pathname === `${prefix}/git/trees/${baseTreeSha}`)
      return response({
        sha: baseTreeSha,
        truncated: false,
        tree: [{ path: "package.json", mode: "100644", type: "blob", sha: "1".repeat(40) }],
      });
    if (url.pathname === `${prefix}/git/trees/${headTreeSha}`)
      return response({
        sha: headTreeSha,
        truncated: false,
        tree: [{ path: "package.json", mode: "100644", type: "blob", sha: "2".repeat(40) }],
      });
    return response({ message: `unexpected GET ${url.pathname}` }, 404);
  }
  return { fetchImpl, requests };
}

describe("automation CI admission", () => {
  test("reuses exact current-base source admission for the trusted source run", async () => {
    const fixture = admissionFixture();
    const result = await validateVersionPrCiAdmission({
      env: automationCiEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(result).toMatchObject({ prNumber: pullNumber, baseSha, headSha });
    expect(result.admission).toMatchObject({ baseSha, headSha, baseTreeSha, headTreeSha });
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("rejects a source run that was not an exact push-triggered Release run", async () => {
    const fixture = admissionFixture({ sourceEvent: "workflow_dispatch" });
    await expect(
      validateVersionPrCiAdmission({
        env: automationCiEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("source Release run was not triggered by a push");
  });

  test("rejects a failed source Release run", async () => {
    const fixture = admissionFixture({ sourceConclusion: "failure" });
    await expect(
      validateVersionPrCiAdmission({
        env: automationCiEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("neither in progress nor successfully completed");
  });

  test("rejects dispatch context drift before reading provider state", async () => {
    const fixture = admissionFixture();
    await expect(
      validateVersionPrCiAdmission({
        env: automationCiEnv({ GITHUB_WORKFLOW_SHA: "9".repeat(40) }),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("workflow source SHA differs from its event SHA");
    expect(fixture.requests).toHaveLength(0);
  });
});

function checksFixture() {
  const requests: RequestRecord[] = [];
  const checks: Array<Record<string, any>> = [];
  let nextId = 700;
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname, query: url.searchParams, body });
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/main`)
      return response(mainRef());
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}`)
      return response(versionPull());
    if (method === "GET" && url.pathname === `${prefix}/commits/${headSha}/check-runs`)
      return response({
        total_count: checks.length,
        check_runs: checks.filter((check) => check.name === url.searchParams.get("check_name")),
      });
    if (method === "POST" && url.pathname === `${prefix}/check-runs`) {
      const check = { ...body, id: nextId++, app: { slug: "github-actions" } };
      checks.push(check);
      return response(check, 201);
    }
    const checkMatch = url.pathname.match(new RegExp(`^${prefix}/check-runs/(\\d+)$`));
    if (method === "PATCH" && checkMatch) {
      const check = checks.find((candidate) => candidate.id === Number(checkMatch[1]));
      if (!check) return response({ message: "missing check" }, 404);
      Object.assign(check, body);
      return response(check);
    }
    return response({ message: `unexpected ${method} ${url.pathname}` }, 404);
  }
  return { checks, fetchImpl, requests };
}

test("exact-head check markers update idempotently instead of duplicating", async () => {
  const fixture = checksFixture();
  const options = {
    env: automationCiEnv(),
    fetchImpl: fixture.fetchImpl,
    now: () => new Date("2026-07-23T12:00:00Z"),
  };
  await beginVersionPrChecks(options);
  await beginVersionPrChecks(options);
  expect(fixture.checks).toHaveLength(2);
  expect(new Set(fixture.checks.map((check) => check.external_id)).size).toBe(2);
  expect(
    fixture.checks.every(
      (check) => check.head_sha === headSha && check.external_id.includes(`head:${headSha}`),
    ),
  ).toBe(true);
  expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(2);
});

function approvalEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
    GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
    GITHUB_SHA: mergeSha,
    GITHUB_TOKEN: "fixture-token",
    SOURCE_SHA: mergeSha,
    ...overrides,
  };
}

function approvalFixture(
  options: {
    authorId?: number;
    reviewCommit?: string;
    reviewState?: string;
    reviewTime?: string;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, query: url.searchParams });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${mergeSha}`)
      return response({ sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] });
    if (method === "GET" && url.pathname === `${prefix}/commits/${mergeSha}/pulls`)
      return response([
        {
          number: pullNumber,
          state: "closed",
          merge_commit_sha: mergeSha,
          merged_at: "2026-07-23T12:00:00Z",
          user: { login: "release-bot", id: options.authorId ?? 41898282, type: "Bot" },
          base: {
            ref: "main",
            sha: baseSha,
            repo: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
          },
          head: { sha: headSha },
        },
      ]);
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}/reviews`)
      return response([
        {
          id: 9001,
          state: options.reviewState ?? "APPROVED",
          commit_id: options.reviewCommit ?? headSha,
          submitted_at: options.reviewTime ?? "2026-07-23T11:59:00Z",
          user: RELEASE_AUTOMATION_CONTRACT.releaseApprover,
        },
      ]);
    return response({ message: `unexpected ${method} ${url.pathname}` }, 404);
  }
  return { fetchImpl, requests };
}

describe("release approval provenance", () => {
  test("accepts a distinct trusted user's native exact-head approval before merge", async () => {
    const fixture = approvalFixture();
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual({ sourceSha: mergeSha, baseSha, headSha, pullNumber, reviewId: 9001 });
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("rejects stale-head and post-merge approvals", async () => {
    const stale = approvalFixture({ reviewCommit: "9".repeat(40) });
    await expect(
      verifyApprovedMerge({ env: approvalEnv(), fetchImpl: stale.fetchImpl }),
    ).rejects.toThrow("did not review the exact PR head");
    const late = approvalFixture({ reviewTime: "2026-07-23T12:01:00Z" });
    await expect(
      verifyApprovedMerge({ env: approvalEnv(), fetchImpl: late.fetchImpl }),
    ).rejects.toThrow("was not submitted before merge");
  });

  test("rejects self-approval and a non-approval decision", async () => {
    const self = approvalFixture({ authorId: RELEASE_AUTOMATION_CONTRACT.releaseApprover.id });
    await expect(
      verifyApprovedMerge({ env: approvalEnv(), fetchImpl: self.fetchImpl }),
    ).rejects.toThrow("trusted reviewer authored the pull request");
    const requested = approvalFixture({ reviewState: "CHANGES_REQUESTED" });
    await expect(
      verifyApprovedMerge({ env: approvalEnv(), fetchImpl: requested.fetchImpl }),
    ).rejects.toThrow("does not currently approve the exact head");
  });
});

describe("workflow contracts", () => {
  const releaseText = readFileSync(releaseWorkflowPath, "utf8");
  const ciText = readFileSync(ciWorkflowPath, "utf8");
  const release = Bun.YAML.parse(releaseText) as any;
  const ci = Bun.YAML.parse(ciText) as any;

  test("uses only the scoped token for Changesets and grants narrow dispatch rights", () => {
    expect(releaseText).not.toContain("RELEASE_PAT");
    const versionChangesets = release.jobs.version.steps.find(
      (step: any) => step.uses === "changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
    );
    const publishChangesets = release.jobs.publish.steps.find(
      (step: any) => step.id === "changesets",
    );
    expect(versionChangesets.env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(publishChangesets.env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(release.jobs.version.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      actions: "write",
    });
    expect(release.jobs.publish.permissions["pull-requests"]).toBe("read");
  });

  test("dispatches trusted main CI and preserves ordinary CI events", () => {
    const dispatch = release.jobs.version.steps.find(
      (step: any) => step.name === "Dispatch exact-head Version PR CI",
    );
    expect(dispatch.run).toContain("dispatch-version-ci");
    expect(ci.on.push.branches).toEqual(["main"]);
    expect(ci.on.pull_request).not.toBeUndefined();
    expect(ci.on.workflow_dispatch.inputs).toEqual(
      expect.objectContaining({
        automation_pr_number: expect.objectContaining({ required: true }),
        automation_head_sha: expect.objectContaining({ required: true }),
        automation_base_sha: expect.objectContaining({ required: true }),
        source_release_run_id: expect.objectContaining({ required: true }),
        source_release_run_attempt: expect.objectContaining({ required: true }),
      }),
    );
  });

  test("keeps admission least-privilege and candidate execution exact-head-bound", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.jobs["automation-admission"].permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(ciText).not.toContain("pull-requests: write");
    expect(ciText).not.toMatch(/pulls\/.+\/reviews/);
    for (const jobName of ["test", "deployment", "images"])
      expect(
        ci.jobs[jobName].steps.find((step: any) => step.uses === "actions/checkout@v6").with.ref,
      ).toContain("inputs.automation_head_sha");
    expect(ci.jobs["automation-admission"].steps[0].with.ref).toBe("${{ github.sha }}");
  });

  test("binds explicit source-admission and aggregate reports to the exact head", () => {
    expect(ciText).toContain("begin-version-checks");
    expect(ciText).toContain("admit-version-ci");
    expect(ciText).toContain("complete-version-check");
    expect(ciText).toContain("AUTOMATION_CHECK_KIND: source-admission");
    expect(ciText).toContain("AUTOMATION_CHECK_KIND: automation-ci");
    expect(releaseText).toContain("verify-approved-merge");
  });
});
