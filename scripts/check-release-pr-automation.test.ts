import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_AUTOMATION_CONTRACT,
  beginVersionPrChecks,
  recoverReleaseHeadEvidence,
  sealReleaseHeadEvidence,
  validateVersionPrCiAdmission,
  validateVersionPrDispatch,
  verifyApprovedMerge,
} from "./check-release-pr-automation.mjs";

const root = join(import.meta.dir, "..");
const releaseWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath);
const ciWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath);
const sealWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath);
const releaseAutomationPath = join(root, "scripts/check-release-pr-automation.mjs");
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const mergeSha = "d".repeat(40);
const currentMainSha = "9".repeat(40);
const baseTreeSha = "e".repeat(40);
const headTreeSha = "f".repeat(40);
const staleEventBaseSha = "8".repeat(40);
const staleMergeBaseSha = "7".repeat(40);
const staleEventBaseTreeSha = "6".repeat(40);
const staleMergeBaseTreeSha = "5".repeat(40);
const rebasedFirstSha = "a".repeat(40);
const pullNumber = 88;
const runId = 123456;
const runAttempt = 2;
const recoveryRunId = 790;
const recoveryRunAttempt = 3;
const releaseHeadReleaseId = 7654321;

function recoveredSourceAdmissionExternalId(
  workflowRunId = recoveryRunId,
  workflowRunAttempt = recoveryRunAttempt,
) {
  return (
    `opengeni:release-automation:source-admission-recovery:v2:` +
    `pr:${pullNumber}:head:${headSha}:run:${workflowRunId}:attempt:${workflowRunAttempt}`
  );
}

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

function releaseHeadRelease(sha = headSha) {
  const tagName = `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${sha}`;
  return {
    id: releaseHeadReleaseId,
    tag_name: tagName,
    // GitHub documents target_commitish as unused when the tag already exists.
    // Keep the provider's default-branch projection here so no proof can
    // accidentally treat this cosmetic field as the retained commit identity.
    target_commitish: "main",
    name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadReleaseNamePrefix}${sha}`,
    draft: false,
    prerelease: true,
    immutable: true,
    published_at: "2026-07-27T02:00:00.000Z",
    author: RELEASE_AUTOMATION_CONTRACT.versionAuthor,
    html_url:
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
      `/releases/tag/${tagName}`,
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
    pullBases?: string[];
    pullHeads?: string[];
    stalePullReads?: number;
  } = {},
) {
  const requests: RequestRecord[] = [];
  let pullReads = 0;
  let projectedHead = headSha;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
    if (method === "GET" && url.pathname === prefix) return response(repository());
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/main`)
      return response(mainRef(options.mainSha));
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}`) {
      const readIndex = pullReads;
      pullReads += 1;
      const pullBases = options.pullBases;
      const base = pullBases
        ? pullBases[Math.min(readIndex, pullBases.length - 1)]
        : pullReads <= (options.stalePullReads ?? 0)
          ? "a".repeat(40)
          : baseSha;
      const pullHeads = options.pullHeads ?? [headSha];
      projectedHead = pullHeads[Math.min(readIndex, pullHeads.length - 1)];
      return response(
        versionPull({
          author: options.author,
          base,
          head: projectedHead,
          headRepository: options.headRepository,
        }),
      );
    }
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/changeset-release/main`)
      return response({
        ref: "refs/heads/changeset-release/main",
        object: { type: "commit", sha: projectedHead },
      });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${projectedHead}`)
      return response({
        sha: projectedHead,
        parents: [{ sha: projectedHead === headSha ? baseSha : "7".repeat(40) }],
      });
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

  test("accepts Version bot login normalization with the same stable identity", async () => {
    const fixture = dispatchFixture({
      author: {
        login: "github-actions",
        id: RELEASE_AUTOMATION_CONTRACT.versionAuthor.id,
        type: RELEASE_AUTOMATION_CONTRACT.versionAuthor.type,
      },
    });
    await expect(
      validateVersionPrDispatch({
        env: releasePushEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual({ prNumber: pullNumber, headSha, baseSha });
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);
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

  test("waits for the Version PR head and direct branch topology to converge", async () => {
    const oldHeadSha = "8".repeat(40);
    const fixture = dispatchFixture({
      pullBases: ["9".repeat(40), baseSha, baseSha, baseSha],
      pullHeads: [oldHeadSha, oldHeadSha, headSha, headSha],
    });
    const sleeps: number[] = [];
    await expect(
      validateVersionPrDispatch({
        env: releasePushEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
        projectionAttempts: 3,
        projectionDelayMs: 7,
        projectionSleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
        },
      }),
    ).resolves.toEqual({ prNumber: pullNumber, headSha, baseSha });
    expect(sleeps).toEqual([7, 7]);
    expect(
      fixture.requests.filter((request) => request.path.endsWith(`/pulls/${pullNumber}`)),
    ).toHaveLength(4);
    expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("rejects a human-authored Version PR without dispatching", async () => {
    const fixture = dispatchFixture({
      author: { login: "jorgensandhaug", id: 55702375, type: "User" },
      stalePullReads: 3,
    });
    const sleeps: number[] = [];
    await expect(
      validateVersionPrDispatch({
        env: releasePushEnv(),
        fetchImpl: fixture.fetchImpl,
        projectionAttempts: 3,
        projectionDelayMs: 7,
        projectionSleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
        },
      }),
    ).rejects.toThrow("Version PR author numeric identity changed");
    expect(sleeps).toEqual([]);
    expect(fixture.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects fork identity and stale main before dispatch", async () => {
    const fork = dispatchFixture({ headRepository: "attacker/opengeni" });
    await expect(
      validateVersionPrDispatch({
        env: releasePushEnv(),
        fetchImpl: fork.fetchImpl,
      }),
    ).rejects.toThrow("Version PR is not from the base repository");
    const stale = dispatchFixture({ mainSha: "9".repeat(40) });
    await expect(
      validateVersionPrDispatch({
        env: releasePushEnv(),
        fetchImpl: stale.fetchImpl,
      }),
    ).rejects.toThrow("default branch differs from the admitted base SHA");
  });
});

function admissionFixture(
  options: {
    seal?: boolean;
    release?: Record<string, unknown> | null;
    releaseHeadRefSha?: string;
    sourceAdmissionConclusion?: string;
    sourceConclusion?: string | null;
    sourceEvent?: string;
    sourceStatus?: string;
    pullBaseSha?: string;
    pullBaseTreeSha?: string;
    pullMergeBaseSha?: string;
    pullMergeBaseTreeSha?: string;
    terminalMainSha?: string;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const checks: Array<Record<string, any>> = [];
  let nextCheckId = 850;
  let mainReads = 0;
  let retainedHeadSha = options.releaseHeadRefSha;
  let retainedRelease = options.release ?? null;
  const pullBaseSha = options.pullBaseSha ?? baseSha;
  const pullBaseTreeSha = options.pullBaseTreeSha ?? baseTreeSha;
  const pullMergeBaseSha = options.pullMergeBaseSha ?? pullBaseSha;
  const pullMergeBaseTreeSha = options.pullMergeBaseTreeSha ?? pullBaseTreeSha;
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    if (method === "POST" && options.seal && url.pathname === `${prefix}/git/refs`) {
      retainedHeadSha = body?.sha;
      return response(
        {
          ref: body?.ref,
          object: { type: "commit", sha: body?.sha },
        },
        201,
      );
    }
    if (method === "POST" && options.seal && url.pathname === `${prefix}/releases`) {
      retainedRelease = releaseHeadRelease(headSha);
      return response(retainedRelease, 201);
    }
    if (method === "POST" && options.seal && url.pathname === `${prefix}/check-runs`) {
      const check = {
        ...body,
        id: nextCheckId++,
        app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
      };
      checks.push(check);
      return response(check, 201);
    }
    const checkMatch = url.pathname.match(new RegExp(`^${prefix}/check-runs/(\\d+)$`));
    if (method === "PATCH" && options.seal && checkMatch) {
      const check = checks.find((candidate) => candidate.id === Number(checkMatch[1]));
      if (!check) return response({ message: "missing check" }, 404);
      Object.assign(check, body);
      return response(check);
    }
    if (method !== "GET") return response({ message: "read-only fixture" }, 405);
    if (url.pathname === prefix) return response(repository());
    if (url.pathname === `${prefix}/git/ref/heads/main`) {
      mainReads += 1;
      return response(mainRef(mainReads > 2 ? (options.terminalMainSha ?? baseSha) : baseSha));
    }
    if (url.pathname === `${prefix}/pulls/${pullNumber}`)
      return response(versionPull({ base: pullBaseSha }));
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
    if (url.pathname === `${prefix}/git/commits/${pullBaseSha}`)
      return response({
        sha: pullBaseSha,
        tree: { sha: pullBaseTreeSha },
        parents: [{ sha: "a".repeat(40) }],
      });
    if (
      pullMergeBaseSha !== pullBaseSha &&
      url.pathname === `${prefix}/git/commits/${pullMergeBaseSha}`
    )
      return response({
        sha: pullMergeBaseSha,
        tree: { sha: pullMergeBaseTreeSha },
        parents: [{ sha: "4".repeat(40) }],
      });
    if (url.pathname === `${prefix}/git/commits/${headSha}`)
      return response({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: pullMergeBaseSha }],
      });
    if (url.pathname === `${prefix}/git/ref/heads/changeset-release/main`)
      return response({
        ref: "refs/heads/changeset-release/main",
        object: { type: "commit", sha: headSha },
      });
    if (
      options.seal &&
      url.pathname ===
        `${prefix}/git/ref/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`
    ) {
      if (retainedHeadSha === undefined)
        return response({ message: "missing release head ref" }, 404);
      return response({
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        object: { type: "commit", sha: retainedHeadSha },
      });
    }
    if (
      options.seal &&
      url.pathname ===
        `${prefix}/releases/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`
    )
      return retainedRelease === null
        ? response({ message: "missing release head release" }, 404)
        : response(retainedRelease);
    if (options.seal && url.pathname === `${prefix}/commits/${headSha}/check-runs`)
      return response({
        check_runs: [
          ...(!url.searchParams.get("check_name") ||
          url.searchParams.get("check_name") === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission
            ? [
                {
                  name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
                  head_sha: headSha,
                  status: "completed",
                  conclusion: options.sourceAdmissionConclusion ?? "success",
                  app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
                },
              ]
            : []),
          ...checks.filter(
            (check) =>
              !url.searchParams.get("check_name") ||
              check.name === url.searchParams.get("check_name"),
          ),
        ],
      });
    if (url.pathname === `${prefix}/compare/${pullBaseSha}...${headSha}`)
      return response({
        status: pullMergeBaseSha === pullBaseSha ? "ahead" : "diverged",
        base_commit: { sha: pullBaseSha },
        merge_base_commit: { sha: pullMergeBaseSha },
        commits: [{ sha: headSha }],
        behind_by: pullMergeBaseSha === pullBaseSha ? 0 : 4,
        ahead_by: 1,
      });
    if (url.pathname === `${prefix}/pulls/${pullNumber}/files`)
      return response([{ filename: "package.json", status: "modified" }]);
    if (url.pathname === `${prefix}/git/trees/${pullMergeBaseTreeSha}`)
      return response({
        sha: pullMergeBaseTreeSha,
        truncated: false,
        tree: [
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "1".repeat(40),
          },
        ],
      });
    if (url.pathname === `${prefix}/git/trees/${headTreeSha}`)
      return response({
        sha: headTreeSha,
        truncated: false,
        tree: [
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "2".repeat(40),
          },
        ],
      });
    return response({ message: `unexpected GET ${url.pathname}` }, 404);
  }
  return { checks, fetchImpl, requests };
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
    expect(result.admission).toMatchObject({
      baseSha,
      headSha,
      baseTreeSha,
      headTreeSha,
    });
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

function sealReleaseHeadEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
    GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
    GITHUB_SHA: baseSha,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_RUN_ID: "789",
    GITHUB_WORKFLOW_REF:
      `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
      `${RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: baseSha,
    RELEASE_HEAD_PR_NUMBER: String(pullNumber),
    RELEASE_HEAD_BASE_SHA: baseSha,
    RELEASE_HEAD_SHA: headSha,
    ...overrides,
  };
}

describe("release head evidence retention", () => {
  test("revalidates and idempotently retains an exact admitted open PR head", async () => {
    const fixture = admissionFixture({ seal: true });
    const first = await sealReleaseHeadEvidence({
      env: sealReleaseHeadEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    const second = await sealReleaseHeadEvidence({
      env: sealReleaseHeadEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(first).toMatchObject({
      prNumber: pullNumber,
      baseSha,
      headSha,
      releaseHead: {
        name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        sha: headSha,
      },
      releaseHeadRelease: {
        id: releaseHeadReleaseId,
        tagName: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadReleaseNamePrefix}${headSha}`,
        immutable: true,
        draft: false,
        prerelease: true,
        authorId: RELEASE_AUTOMATION_CONTRACT.versionAuthor.id,
        authorLogin: RELEASE_AUTOMATION_CONTRACT.versionAuthor.login,
        authorType: RELEASE_AUTOMATION_CONTRACT.versionAuthor.type,
      },
    });
    expect(second.releaseHead).toEqual(first.releaseHead);
    expect(second.releaseHeadRelease).toEqual(first.releaseHeadRelease);
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/git/refs"),
      ),
    ).toHaveLength(1);
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/releases"),
      ),
    ).toEqual([
      expect.objectContaining({
        body: {
          tag_name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
          name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadReleaseNamePrefix}${headSha}`,
          body:
            `Provider-retained exact release-source head ${headSha}. ` +
            "This prerelease exists only as immutable source-retention evidence.",
          draft: false,
          prerelease: true,
          make_latest: "false",
        },
      }),
    ]);
    expect(fixture.checks).toHaveLength(1);
    expect(fixture.checks[0]).toMatchObject({
      name: RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
    });
    expect(fixture.checks[0]?.external_id).toMatch(
      new RegExp(
        `^opengeni:release-automation:release-head-retention:v2:` +
          `pr:${pullNumber}:head:${headSha}:release-sha256:[0-9a-f]{64}$`,
      ),
    );
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/check-runs"),
      ),
    ).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(3);
  });

  test("retains an immutable stale-event head without equating its PR base to current main", async () => {
    const fixture = admissionFixture({
      seal: true,
      pullBaseSha: staleEventBaseSha,
      pullBaseTreeSha: staleEventBaseTreeSha,
      pullMergeBaseSha: staleMergeBaseSha,
      pullMergeBaseTreeSha: staleMergeBaseTreeSha,
    });
    const result = await sealReleaseHeadEvidence({
      env: sealReleaseHeadEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });

    expect(result.admission).toMatchObject({
      baseSha: staleEventBaseSha,
      baseTreeSha: staleMergeBaseTreeSha,
      currentMainSha: baseSha,
      headSha,
      patchBaseSha: staleMergeBaseSha,
      workflowSha: baseSha,
    });
    expect(result.releaseHead.sha).toBe(headSha);
    expect(result.sourceAdmission).toEqual({
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
      appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
    });
  });

  test("fails before mutation when the exact-head source-admission check is not successful", async () => {
    const fixture = admissionFixture({
      seal: true,
      sourceAdmissionConclusion: "failure",
    });
    await expect(
      sealReleaseHeadEvidence({
        env: sealReleaseHeadEnv(),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("did not complete successfully");
    expect(fixture.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects an existing mutable release before publishing retention evidence", async () => {
    const fixture = admissionFixture({
      seal: true,
      releaseHeadRefSha: headSha,
      release: { ...releaseHeadRelease(), immutable: false },
    });
    await expect(
      sealReleaseHeadEvidence({
        env: sealReleaseHeadEnv(),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("is not a published immutable prerelease");
    expect(fixture.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("rejects a conflicting retained head and workflow/base drift", async () => {
    const fixture = admissionFixture({
      seal: true,
      releaseHeadRefSha: "9".repeat(40),
    });
    await expect(
      sealReleaseHeadEvidence({
        env: sealReleaseHeadEnv(),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("release head evidence ref points to another commit");
    const drift = admissionFixture({ seal: true });
    await expect(
      sealReleaseHeadEvidence({
        env: sealReleaseHeadEnv({ GITHUB_WORKFLOW_SHA: "8".repeat(40) }),
        fetchImpl: drift.fetchImpl,
      }),
    ).rejects.toThrow("workflow source SHA differs from its event SHA");
    expect(drift.requests).toHaveLength(0);
  });
});

function recoverySealEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
    GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
    GITHUB_SHA: currentMainSha,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_RUN_ATTEMPT: String(recoveryRunAttempt),
    GITHUB_RUN_ID: String(recoveryRunId),
    GITHUB_WORKFLOW_REF:
      `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
      `${RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: currentMainSha,
    RELEASE_HEAD_PR_NUMBER: String(pullNumber),
    RELEASE_HEAD_BASE_SHA: baseSha,
    RELEASE_HEAD_SHA: headSha,
    RELEASE_HEAD_MERGED_SOURCE_SHA: mergeSha,
    ...overrides,
  };
}

function recoverySealFixture(
  options: {
    currentMainContainsSource?: boolean;
    existingSourceAdmission?: boolean;
    headRefs?: string[];
    headRepositories?: string[];
    pullAuthors?: Array<Record<string, unknown>>;
    originalSourceAdmissions?: Array<Record<string, unknown>>;
    existingRecoveryChecks?: Array<Record<string, unknown>>;
    releaseHeadRef?: Record<string, unknown> | null;
    release?: Record<string, unknown> | null;
    refCreateStatus?: number;
    retentionCheck?: Record<string, unknown>;
    tagLookupStatus?: number;
    releaseLookupStatus?: number;
    sourceTreeSha?: string;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const checks: Array<Record<string, any>> = [];
  checks.push(...(options.existingRecoveryChecks ?? []));
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  const releaseTag = `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`;
  const merger = { login: "merge-maintainer", id: 1234567, type: "User" };
  let nextCheckId = 900;
  let pullReads = 0;
  const valueAt = <T>(values: T[] | undefined, index: number, fallback: T) =>
    values?.[Math.min(index, values.length - 1)] ?? fallback;
  const mergedPull = {
    number: pullNumber,
    html_url:
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
      `/pull/${pullNumber}`,
    state: "closed",
    merged: true,
    merge_commit_sha: mergeSha,
    merged_at: "2026-07-27T09:00:00Z",
    draft: false,
    user: RELEASE_AUTOMATION_CONTRACT.releaseApprover,
    merged_by: merger,
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
    },
    head: {
      ref: "codex/release-chart-0.22.24",
      sha: headSha,
      repo: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
    },
    commits: 1,
    changed_files: 1,
    requested_reviewers: [],
  };
  const sourceAdmission = {
    name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
  };
  let releaseHeadRef =
    options.releaseHeadRef === undefined
      ? {
          ref: `refs/tags/${releaseTag}`,
          object: { type: "commit", sha: headSha },
        }
      : options.releaseHeadRef;
  let release = options.release === undefined ? releaseHeadRelease() : options.release;
  if (options.retentionCheck) checks.push(options.retentionCheck);
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    if (method === "POST" && url.pathname === `${prefix}/check-runs`) {
      const check = {
        ...body,
        id: nextCheckId++,
        app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
      };
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
    if (method === "POST" && url.pathname === `${prefix}/git/refs`) {
      if (options.refCreateStatus !== undefined)
        return response({ message: "ref create rejected" }, options.refCreateStatus);
      if (releaseHeadRef !== null) return response({ message: "ref already exists" }, 422);
      releaseHeadRef = {
        ref: body?.ref,
        object: { type: "commit", sha: body?.sha },
      };
      return response(releaseHeadRef, 201);
    }
    if (method === "POST" && url.pathname === `${prefix}/releases`) {
      if (release !== null) return response({ message: "release already exists" }, 422);
      release = releaseHeadRelease();
      return response(release, 201);
    }
    if (method !== "GET") return response({ message: "unexpected mutation" }, 405);
    if (url.pathname === prefix) return response(repository());
    if (url.pathname === `${prefix}/git/ref/heads/main`) return response(mainRef(currentMainSha));
    if (url.pathname === `${prefix}/pulls/${pullNumber}`) {
      const readIndex = pullReads;
      pullReads += 1;
      return response({
        ...mergedPull,
        user: valueAt(options.pullAuthors, readIndex, RELEASE_AUTOMATION_CONTRACT.releaseApprover),
        head: {
          ...mergedPull.head,
          ref: valueAt(options.headRefs, readIndex, mergedPull.head.ref),
          repo: {
            full_name: valueAt(
              options.headRepositories,
              readIndex,
              RELEASE_AUTOMATION_CONTRACT.repository,
            ),
          },
        },
      });
    }
    if (url.pathname === `${prefix}/git/commits/${mergeSha}`)
      return response({
        sha: mergeSha,
        tree: { sha: options.sourceTreeSha ?? headTreeSha },
        parents: [{ sha: baseSha }, { sha: headSha }],
      });
    if (url.pathname === `${prefix}/git/commits/${baseSha}`)
      return response({
        sha: baseSha,
        tree: { sha: baseTreeSha },
        parents: [{ sha: "1".repeat(40) }],
      });
    if (url.pathname === `${prefix}/git/commits/${headSha}`)
      return response({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: baseSha }],
      });
    if (url.pathname === `${prefix}/issues/${pullNumber}/timeline`)
      return response([
        {
          id: 7002,
          node_id: "ME_recovery_fixture",
          url: `${RELEASE_AUTOMATION_CONTRACT.apiUrl}${prefix}/issues/events/7002`,
          event: "merged",
          actor: merger,
          commit_id: mergeSha,
          commit_url: `${RELEASE_AUTOMATION_CONTRACT.apiUrl}${prefix}/commits/${mergeSha}`,
          created_at: "2026-07-27T09:00:00Z",
        },
      ]);
    if (url.pathname === `${prefix}/compare/${mergeSha}...${currentMainSha}`)
      return response({
        status: options.currentMainContainsSource === false ? "diverged" : "ahead",
        base_commit: { sha: mergeSha },
        merge_base_commit: {
          sha: options.currentMainContainsSource === false ? baseSha : mergeSha,
        },
        behind_by: options.currentMainContainsSource === false ? 1 : 0,
        ahead_by: 1,
      });
    if (url.pathname === `${prefix}/compare/${baseSha}...${headSha}`)
      return response({
        status: "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        behind_by: 0,
        ahead_by: 1,
        commits: [{ sha: headSha }],
      });
    if (url.pathname === `${prefix}/pulls/${pullNumber}/files`)
      return response([{ filename: "package.json", status: "modified" }]);
    if (url.pathname === `${prefix}/git/trees/${baseTreeSha}`)
      return response({
        sha: baseTreeSha,
        truncated: false,
        tree: [
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "1".repeat(40),
          },
        ],
      });
    if (url.pathname === `${prefix}/git/trees/${headTreeSha}`)
      return response({
        sha: headTreeSha,
        truncated: false,
        tree: [
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "2".repeat(40),
          },
        ],
      });
    if (url.pathname === `${prefix}/commits/${headSha}/check-runs`) {
      const checkName = url.searchParams.get("check_name");
      const originalSourceAdmissions =
        options.originalSourceAdmissions ??
        (options.existingSourceAdmission ? [sourceAdmission] : []);
      return response({
        check_runs: checkName
          ? checks.filter((check) => check.name === checkName)
          : [...originalSourceAdmissions, ...checks],
      });
    }
    if (url.pathname === `${prefix}/git/ref/tags/${releaseTag}`) {
      if (options.tagLookupStatus !== undefined)
        return response({ message: "tag lookup failed" }, options.tagLookupStatus);
      return releaseHeadRef === null
        ? response({ message: "missing release head ref" }, 404)
        : response(releaseHeadRef);
    }
    if (url.pathname === `${prefix}/releases/tags/${releaseTag}`) {
      if (options.releaseLookupStatus !== undefined)
        return response({ message: "release lookup failed" }, options.releaseLookupStatus);
      return release === null
        ? response({ message: "missing immutable release" }, 404)
        : response(release);
    }
    return response({ message: `unexpected GET ${url.pathname}` }, 404);
  }
  return { checks, fetchImpl, requests };
}

describe("release head retention recovery", () => {
  test("creates one canonical recovery receipt when draft-to-ready emitted duplicate original admissions", async () => {
    const fixture = recoverySealFixture({
      originalSourceAdmissions: [
        {
          id: 101,
          name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
          head_sha: headSha,
          status: "completed",
          conclusion: "success",
          external_id: "draft-source-admission",
          app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
        },
        {
          id: 102,
          name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
          head_sha: headSha,
          status: "completed",
          conclusion: "success",
          external_id: "ready-source-admission",
          app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
        },
      ],
    });

    const result = await recoverReleaseHeadEvidence({
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    });

    expect(result.sourceAdmission).toEqual({
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
      appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
    });
    expect(
      fixture.checks.filter(
        (check) =>
          check.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission &&
          check.external_id === recoveredSourceAdmissionExternalId(),
      ),
    ).toHaveLength(1);
  });

  test("migrates the prior deterministic recovery check in place", async () => {
    const legacyExternalId = String.raw`opengeni:release-automation:source-admission:v1:pr:${pullNumber}:head:${headSha}`;
    const fixture = recoverySealFixture({
      existingRecoveryChecks: [
        {
          id: 777,
          name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
          head_sha: headSha,
          status: "completed",
          conclusion: "success",
          external_id: legacyExternalId,
          app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
        },
      ],
    });

    await recoverReleaseHeadEvidence({
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    });

    expect(
      fixture.checks.filter(
        (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      ),
    ).toEqual([
      expect.objectContaining({
        id: 777,
        external_id: recoveredSourceAdmissionExternalId(),
        status: "completed",
        conclusion: "success",
      }),
    ]);
    expect(
      fixture.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/check-runs") &&
          request.body?.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      ),
    ).toHaveLength(0);
  });

  test("moves one prior v2 recovery check to the current seal run without duplicating it", async () => {
    const fixture = recoverySealFixture();
    const options = {
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    };

    await recoverReleaseHeadEvidence({
      ...options,
      env: recoverySealEnv(),
    });
    await recoverReleaseHeadEvidence({
      ...options,
      env: recoverySealEnv({
        GITHUB_RUN_ID: String(recoveryRunId + 1),
        GITHUB_RUN_ATTEMPT: String(recoveryRunAttempt + 1),
      }),
    });

    expect(
      fixture.checks.filter(
        (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      ),
    ).toEqual([
      expect.objectContaining({
        external_id: recoveredSourceAdmissionExternalId(recoveryRunId + 1, recoveryRunAttempt + 1),
        status: "completed",
        conclusion: "success",
      }),
    ]);
    expect(
      fixture.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/check-runs") &&
          request.body?.name === RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      ),
    ).toHaveLength(1);
  });

  test("rejects duplicate prior v2 recovery checks before mutation", async () => {
    const canonical = (id: number, workflowRunId: number) => ({
      id,
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      external_id: recoveredSourceAdmissionExternalId(workflowRunId, 1),
      app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
    });
    const fixture = recoverySealFixture({
      existingRecoveryChecks: [
        canonical(777, recoveryRunId - 2),
        canonical(778, recoveryRunId - 1),
      ],
    });

    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("multiple check runs share the idempotency marker");
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("creates a clean absent retained pair after every pre-mutation gate and replays idempotently", async () => {
    const fixture = recoverySealFixture({ releaseHeadRef: null, release: null });
    const options = {
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    };
    const result = await recoverReleaseHeadEvidence(options);
    const replay = await recoverReleaseHeadEvidence(options);

    expect(result.releaseHead).toEqual({
      name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
      ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
      sha: headSha,
    });
    expect(replay.releaseHead).toEqual(result.releaseHead);
    expect(replay.releaseHeadRelease).toEqual(result.releaseHeadRelease);
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/git/refs"),
      ),
    ).toEqual([
      expect.objectContaining({
        body: {
          ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
          sha: headSha,
        },
      }),
    ]);
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/releases"),
      ),
    ).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          tag_name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
          name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadReleaseNamePrefix}${headSha}`,
          draft: false,
          prerelease: true,
          make_latest: "false",
        }),
      }),
    ]);
    const firstMutation = fixture.requests.findIndex((request) => request.method !== "GET");
    expect(firstMutation).toBeGreaterThan(0);
    expect(
      fixture.requests.slice(0, firstMutation).every((request) => request.method === "GET"),
    ).toBe(true);
    expect(
      fixture.requests
        .slice(0, firstMutation)
        .filter((request) => request.path.endsWith(`/git/ref/tags/${result.releaseHead.name}`)),
    ).toHaveLength(2);
    expect(
      fixture.requests
        .slice(0, firstMutation)
        .filter((request) => request.path.endsWith(`/releases/tags/${result.releaseHead.name}`)),
    ).toHaveLength(2);
    expect(fixture.checks).toHaveLength(2);
  });

  test("replays recovery idempotently for a reviewed non-Version release head", async () => {
    const fixture = recoverySealFixture({
      pullAuthors: [
        RELEASE_AUTOMATION_CONTRACT.releaseApprover,
        {
          ...RELEASE_AUTOMATION_CONTRACT.releaseApprover,
          login: "Jorgen-Sandhaug",
        },
        {
          ...RELEASE_AUTOMATION_CONTRACT.releaseApprover,
          login: "renamed-maintainer",
        },
      ],
    });
    const options = {
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    };
    const result = await recoverReleaseHeadEvidence(options);
    const replay = await recoverReleaseHeadEvidence(options);
    expect(result).toMatchObject({
      prNumber: pullNumber,
      baseSha,
      headSha,
      sourceSha: mergeSha,
      mergeMethod: "merge",
      releaseHead: {
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        sha: headSha,
      },
    });
    expect(replay.releaseHead).toEqual(result.releaseHead);
    expect(replay.releaseHeadRelease).toEqual(result.releaseHeadRelease);
    expect(fixture.checks).toHaveLength(2);
    for (const name of [
      RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
    ]) {
      expect(fixture.checks.find((check) => check.name === name)).toMatchObject({
        name,
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
      });
    }
    expect(
      fixture.checks.every((check) =>
        check.external_id.includes(`pr:${pullNumber}:head:${headSha}`),
      ),
    ).toBe(true);
    expect(new Set(fixture.checks.map((check) => check.external_id)).size).toBe(2);
    expect(
      fixture.checks.find(
        (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
      )?.external_id,
    ).toMatch(
      new RegExp(
        `^opengeni:release-automation:release-head-retention:v2:` +
          `pr:${pullNumber}:head:${headSha}:release-sha256:[0-9a-f]{64}$`,
      ),
    );
    expect(
      fixture.requests.some(
        (request) =>
          request.method === "POST" &&
          (request.path.endsWith("/git/refs") || request.path.endsWith("/releases")),
      ),
    ).toBe(false);
  });

  test("rejects a conflicting retention check for an exact retained pair before mutation", async () => {
    const fixture = recoverySealFixture();
    const options = {
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    };
    await recoverReleaseHeadEvidence(options);
    const retentionCheck = fixture.checks.find(
      (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
    );
    expect(retentionCheck).toBeDefined();
    fixture.checks.splice(0, fixture.checks.length, {
      ...retentionCheck,
      external_id: "attacker-preclaim",
    });
    fixture.requests.length = 0;

    await expect(recoverReleaseHeadEvidence(options)).rejects.toThrow(
      "existing check run conflicts with the exact idempotency identity",
    );
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("rejects duplicate exact retention checks for an exact retained pair before mutation", async () => {
    const fixture = recoverySealFixture();
    const options = {
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    };
    await recoverReleaseHeadEvidence(options);
    const retentionCheck = fixture.checks.find(
      (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
    );
    expect(retentionCheck).toBeDefined();
    fixture.checks.splice(0, fixture.checks.length, retentionCheck!, {
      ...retentionCheck,
      id: Number(retentionCheck?.id) + 1,
    });
    fixture.requests.length = 0;

    await expect(recoverReleaseHeadEvidence(options)).rejects.toThrow(
      "multiple check runs share the idempotency marker",
    );
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("fails closed on recovery author identity substitution or missing identity", async () => {
    for (const [author, message] of [
      [
        { ...RELEASE_AUTOMATION_CONTRACT.releaseApprover, id: 999 },
        "release-head recovery pull-request author numeric identity changed",
      ],
      [
        { ...RELEASE_AUTOMATION_CONTRACT.releaseApprover, type: "Bot" },
        "release-head recovery pull-request author account type changed",
      ],
      [
        { id: RELEASE_AUTOMATION_CONTRACT.releaseApprover.id, type: "User" },
        "pull-request author login is missing",
      ],
    ] as const) {
      const fixture = recoverySealFixture({
        pullAuthors: [RELEASE_AUTOMATION_CONTRACT.releaseApprover, author],
      });
      await expect(
        recoverReleaseHeadEvidence({
          env: recoverySealEnv(),
          fetchImpl: fixture.fetchImpl,
        }),
      ).rejects.toThrow(message);
      expect(fixture.checks).toHaveLength(0);
    }
  });

  test("fails closed before check mutation when recovery head topology changes", async () => {
    const branch = recoverySealFixture({
      headRefs: [
        "codex/release-chart-0.22.24",
        "codex/release-chart-0.22.24",
        "codex/release-chart-0.22.24",
        "attacker/substitute",
      ],
    });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: branch.fetchImpl,
      }),
    ).rejects.toThrow("release-head recovery pull-request head branch changed");
    expect(branch.checks).toHaveLength(0);

    const movedRepository = recoverySealFixture({
      headRepositories: [
        RELEASE_AUTOMATION_CONTRACT.repository,
        RELEASE_AUTOMATION_CONTRACT.repository,
        RELEASE_AUTOMATION_CONTRACT.repository,
        "attacker/opengeni",
      ],
    });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: movedRepository.fetchImpl,
      }),
    ).rejects.toThrow("release-head recovery pull-request head repository changed");
    expect(movedRepository.checks).toHaveLength(0);
  });

  test("fails closed before mutation on partial retained evidence or main lost ancestry", async () => {
    const missing = recoverySealFixture({ release: null });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: missing.fetchImpl,
      }),
    ).rejects.toThrow("release head recovery evidence is only partially present");
    expect(missing.checks).toHaveLength(0);
    expect(missing.requests.every((request) => request.method === "GET")).toBe(true);

    const missingTag = recoverySealFixture({
      releaseHeadRef: null,
      release: releaseHeadRelease(),
    });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: missingTag.fetchImpl,
      }),
    ).rejects.toThrow("release head recovery evidence is only partially present");
    expect(missingTag.checks).toHaveLength(0);
    expect(missingTag.requests.every((request) => request.method === "GET")).toBe(true);

    const diverged = recoverySealFixture({ currentMainContainsSource: false });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: diverged.fetchImpl,
      }),
    ).rejects.toThrow("current main is not ahead of the merged source");
    expect(diverged.checks).toHaveLength(0);
  });

  test("fails closed before mutation when absent evidence has a preclaimed retention check", async () => {
    const fixture = recoverySealFixture({
      releaseHeadRef: null,
      release: null,
      retentionCheck: {
        id: 991,
        name: RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
        external_id: "attacker-preclaim",
        app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
      },
    });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("release head retention check exists without retained evidence");
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("does not normalize non-404 retained-evidence provider failures or mutate", async () => {
    for (const [fixtureOptions, message] of [
      [{ releaseHeadRef: null, release: null, tagLookupStatus: 500 }, "failed with HTTP 500"],
      [{ releaseHeadRef: null, release: null, releaseLookupStatus: 503 }, "failed with HTTP 503"],
    ] as const) {
      const fixture = recoverySealFixture(fixtureOptions);
      await expect(
        recoverReleaseHeadEvidence({
          env: recoverySealEnv(),
          fetchImpl: fixture.fetchImpl,
        }),
      ).rejects.toThrow(message);
      expect(fixture.checks).toHaveLength(0);
      expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    }
  });

  test("does not take over a tag claimed after the clean absence fence", async () => {
    const fixture = recoverySealFixture({
      releaseHeadRef: null,
      release: null,
      refCreateStatus: 422,
    });
    await expect(
      recoverReleaseHeadEvidence({
        env: recoverySealEnv(),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("GitHub API POST /repos/Cloudgeni-ai/opengeni/git/refs failed with HTTP 422");
    expect(fixture.checks).toHaveLength(0);
    expect(
      fixture.requests.filter((request) => request.method !== "GET").map((request) => request.path),
    ).toEqual([`/repos/${RELEASE_AUTOMATION_CONTRACT.repository}/git/refs`]);
  });
});

function checksFixture(
  options: {
    releaseHeadSha?: string;
    release?: Record<string, unknown> | null;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const checks: Array<Record<string, any>> = [];
  let releaseHeadRef: Record<string, any> | null = options.releaseHeadSha
    ? {
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        object: { type: "commit", sha: options.releaseHeadSha },
      }
    : null;
  let release = options.release ?? null;
  let nextId = 700;
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  const releaseHeadTag = `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
    });
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/main`)
      return response(mainRef());
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}`)
      return response(versionPull());
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/changeset-release/main`)
      return response({
        ref: "refs/heads/changeset-release/main",
        object: { type: "commit", sha: headSha },
      });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${headSha}`)
      return response({ sha: headSha, parents: [{ sha: baseSha }] });
    if (method === "GET" && url.pathname === `${prefix}/git/ref/tags/${releaseHeadTag}`)
      return releaseHeadRef === null
        ? response({ message: "missing release head ref" }, 404)
        : response(releaseHeadRef);
    if (method === "POST" && url.pathname === `${prefix}/git/refs`) {
      releaseHeadRef = {
        ref: body?.ref,
        object: { type: "commit", sha: body?.sha },
      };
      return response(releaseHeadRef, 201);
    }
    if (method === "GET" && url.pathname === `${prefix}/releases/tags/${releaseHeadTag}`) {
      const currentRelease = options.release ?? release;
      return currentRelease === null
        ? response({ message: "missing release head release" }, 404)
        : response(currentRelease);
    }
    if (method === "POST" && url.pathname === `${prefix}/releases`) {
      release = releaseHeadRelease(headSha);
      return response(release, 201);
    }
    if (method === "GET" && url.pathname === `${prefix}/commits/${headSha}/check-runs`)
      return response({
        total_count: checks.length,
        check_runs: checks.filter((check) => check.name === url.searchParams.get("check_name")),
      });
    if (method === "POST" && url.pathname === `${prefix}/check-runs`) {
      const check = {
        ...body,
        id: nextId++,
        app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
      };
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
  expect(fixture.checks).toHaveLength(3);
  expect(new Set(fixture.checks.map((check) => check.external_id)).size).toBe(3);
  expect(
    fixture.checks.find(
      (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
    )?.external_id,
  ).toMatch(
    new RegExp(
      `^opengeni:release-automation:release-head-retention:v2:` +
        `pr:${pullNumber}:head:${headSha}:release-sha256:[0-9a-f]{64}$`,
    ),
  );
  expect(
    fixture.checks.every(
      (check) => check.head_sha === headSha && check.external_id.includes(`head:${headSha}`),
    ),
  ).toBe(true);
  expect(
    fixture.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/git/refs"),
    ),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/check-runs"),
    ),
  ).toHaveLength(3);
  expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(3);
});

test("exact-head check creation rejects a conflicting retained release head", async () => {
  const fixture = checksFixture({ releaseHeadSha: "9".repeat(40) });
  await expect(
    beginVersionPrChecks({
      env: automationCiEnv(),
      fetchImpl: fixture.fetchImpl,
    }),
  ).rejects.toThrow("release head evidence ref points to another commit");
  expect(fixture.checks).toHaveLength(0);
});

test("exact-head check creation rejects a mutable retained-head release", async () => {
  const fixture = checksFixture({
    releaseHeadSha: headSha,
    release: { ...releaseHeadRelease(), immutable: false },
  });
  await expect(
    beginVersionPrChecks({
      env: automationCiEnv(),
      fetchImpl: fixture.fetchImpl,
    }),
  ).rejects.toThrow("is not a published immutable prerelease");
  expect(fixture.checks).toHaveLength(0);
  expect(
    fixture.requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/git/refs"),
    ),
  ).toBe(false);
});

test("release-head retention refuses to reuse or duplicate a changed immutable release", async () => {
  const fixtureOptions: { release: Record<string, unknown> | null } = {
    release: releaseHeadRelease(),
  };
  const fixture = checksFixture(fixtureOptions);
  await beginVersionPrChecks({
    env: automationCiEnv(),
    fetchImpl: fixture.fetchImpl,
  });
  fixtureOptions.release = {
    ...releaseHeadRelease(),
    published_at: "2026-07-27T03:00:00.000Z",
  };

  await expect(
    beginVersionPrChecks({
      env: automationCiEnv(),
      fetchImpl: fixture.fetchImpl,
    }),
  ).rejects.toThrow("conflicts with the exact idempotency identity");
  expect(
    fixture.checks.filter(
      (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
    ),
  ).toHaveLength(1);
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
    mergeMethod?: "merge" | "squash" | "rebase" | "single";
    associatedPullCount?: number;
    authorId?: number;
    pullState?: string;
    merged?: boolean;
    mergeCommitSha?: string;
    pullHeadSha?: string;
    sourceTreeSha?: string;
    terminalMainSha?: string;
    reviewCommit?: string;
    reviewState?: string;
    reviewTime?: string;
    reviewBody?: string;
    requestedReview?: boolean;
    requestedReviewer?: Record<string, unknown>;
    reviewer?: Record<string, unknown>;
    reviewDetailReviewer?: Record<string, unknown>;
    reviewerLoginSnapshot?: string;
    headChecks?: Array<Record<string, unknown>>;
    sourceChecks?: Array<Record<string, unknown>>;
    historicalHeadChecks?: Array<Record<string, unknown>>;
    historicalSourceChecks?: Array<Record<string, unknown>>;
    releaseHeadRefSha?: string | null;
    release?: Record<string, unknown> | null;
    discontinuousCompare?: boolean;
    mergeEvent?: Record<string, unknown> | null;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  const mergeMethod = options.mergeMethod ?? "merge";
  const pullHeadSha = options.pullHeadSha ?? headSha;
  const pullCommitCount = mergeMethod === "single" ? 1 : 2;
  const sourceParents =
    mergeMethod === "merge"
      ? [{ sha: baseSha }, { sha: pullHeadSha }]
      : mergeMethod === "rebase"
        ? [{ sha: rebasedFirstSha }]
        : [{ sha: baseSha }];
  const author =
    options.authorId === RELEASE_AUTOMATION_CONTRACT.releaseApprover.id ||
    (options.reviewState === "COMMENTED" && options.authorId === undefined)
      ? RELEASE_AUTOMATION_CONTRACT.releaseApprover
      : { login: "release-bot", id: options.authorId ?? 41898282, type: "Bot" };
  const merger =
    options.reviewState === "COMMENTED"
      ? RELEASE_AUTOMATION_CONTRACT.releaseApprover
      : { login: "merge-maintainer", id: 1234567, type: "User" };
  const artifact = {
    version: 3,
    kind: "opengeni-exact-head-release-review",
    repository: RELEASE_AUTOMATION_CONTRACT.repository,
    reviewedBaseSha: baseSha,
    reviewedHeadSha: pullHeadSha,
    reviewerLogin:
      options.reviewerLoginSnapshot ?? RELEASE_AUTOMATION_CONTRACT.releaseApprover.login,
    reviewProfile: "exact-head-maintainer-v1",
    verdict: "PASS",
  };
  const reviewBody =
    options.reviewBody ??
    `<!-- opengeni-exact-head-release-review:v3 -->\n\n\`\`\`json\n${JSON.stringify(artifact, null, 2)}\n\`\`\``;
  const review = {
    id: 9001,
    state: options.reviewState ?? "APPROVED",
    commit_id: options.reviewCommit ?? pullHeadSha,
    submitted_at: options.reviewTime ?? "2026-07-23T11:59:00Z",
    html_url:
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
      `/pull/${pullNumber}#pullrequestreview-9001`,
    body: reviewBody,
    user: options.reviewer ?? RELEASE_AUTOMATION_CONTRACT.releaseApprover,
  };
  const successfulCheck = (name: string, sha: string) => ({
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
  });
  const mergeEvent =
    options.mergeEvent === null
      ? []
      : [
          options.mergeEvent ?? {
            id: 7001,
            node_id: "ME_fixture",
            url: `${RELEASE_AUTOMATION_CONTRACT.apiUrl}${prefix}/issues/events/7001`,
            event: "merged",
            actor: merger,
            commit_id: mergeSha,
            commit_url: `${RELEASE_AUTOMATION_CONTRACT.apiUrl}${prefix}/commits/${mergeSha}`,
            created_at: "2026-07-23T12:00:00Z",
          },
        ];
  let mainReads = 0;
  async function fetchImpl(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname, query: url.searchParams });
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/main`) {
      mainReads += 1;
      return response(mainRef(mainReads === 1 ? mergeSha : (options.terminalMainSha ?? mergeSha)));
    }
    if (method === "GET" && url.pathname === prefix) return response(repository());
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${mergeSha}`)
      return response({
        sha: mergeSha,
        tree: { sha: options.sourceTreeSha ?? headTreeSha },
        parents: sourceParents,
      });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${baseSha}`)
      return response({
        sha: baseSha,
        tree: { sha: baseTreeSha },
        parents: [{ sha: "1".repeat(40) }],
      });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${pullHeadSha}`)
      return response({
        sha: pullHeadSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: baseSha }],
      });
    if (method === "GET" && url.pathname === `${prefix}/commits/${mergeSha}/pulls`)
      return response(
        Array.from({ length: options.associatedPullCount ?? 1 }, (_, index) => ({
          number: pullNumber + index,
          merge_commit_sha: options.mergeCommitSha ?? mergeSha,
          base: { sha: baseSha },
          head: { sha: pullHeadSha },
        })),
      );
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}`)
      return response({
        number: pullNumber,
        html_url: `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}/pull/${pullNumber}`,
        state: options.pullState ?? "closed",
        merged: options.merged ?? true,
        merge_commit_sha: options.mergeCommitSha ?? mergeSha,
        merged_at: "2026-07-23T12:00:00Z",
        user: author,
        merged_by: merger,
        base: {
          ref: "main",
          sha: baseSha,
          repo: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
        },
        head: {
          ref: "changeset-release/main",
          sha: pullHeadSha,
          repo: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
        },
        commits: pullCommitCount,
        changed_files: 1,
        requested_reviewers: options.requestedReview
          ? [options.requestedReviewer ?? RELEASE_AUTOMATION_CONTRACT.releaseApprover]
          : [],
      });
    if (method === "GET" && url.pathname === `${prefix}/compare/${baseSha}...${pullHeadSha}`)
      return response({
        status: "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        ahead_by: pullCommitCount,
        behind_by: 0,
        total_commits: pullCommitCount,
        commits: [{ sha: pullHeadSha }],
      });
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}/files`)
      return response([{ filename: "package.json", status: "modified" }]);
    if (method === "GET" && url.pathname === `${prefix}/git/trees/${baseTreeSha}`)
      return response({
        sha: baseTreeSha,
        truncated: false,
        tree: [
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "1".repeat(40),
          },
        ],
      });
    if (method === "GET" && url.pathname === `${prefix}/git/trees/${headTreeSha}`)
      return response({
        sha: headTreeSha,
        truncated: false,
        tree: [
          {
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: "2".repeat(40),
          },
        ],
      });
    if (method === "GET" && url.pathname === `${prefix}/issues/${pullNumber}/timeline`)
      return response(mergeEvent);
    if (method === "GET" && url.pathname === `${prefix}/compare/${baseSha}...${mergeSha}`) {
      const commits =
        mergeMethod === "rebase"
          ? [
              { sha: rebasedFirstSha, parents: [{ sha: baseSha }] },
              {
                sha: mergeSha,
                parents: [
                  {
                    sha: options.discontinuousCompare ? baseSha : rebasedFirstSha,
                  },
                ],
              },
            ]
          : [{ sha: mergeSha, parents: [{ sha: baseSha }] }];
      return response({
        status: "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        ahead_by: commits.length,
        behind_by: 0,
        total_commits: commits.length,
        commits,
      });
    }
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}/reviews`)
      return response([review]);
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}/reviews/9001`)
      return response({
        ...review,
        user: options.reviewDetailReviewer ?? review.user,
      });
    if (
      method === "GET" &&
      url.pathname ===
        `${prefix}/git/ref/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${pullHeadSha}`
    ) {
      if (options.releaseHeadRefSha === null)
        return response({ message: "missing release head ref" }, 404);
      return response({
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${pullHeadSha}`,
        object: {
          type: "commit",
          sha: options.releaseHeadRefSha ?? pullHeadSha,
        },
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        `${prefix}/releases/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${pullHeadSha}`
    )
      return options.release === null
        ? response({ message: "missing release head release" }, 404)
        : response(options.release ?? releaseHeadRelease(pullHeadSha));
    if (method === "GET" && url.pathname === `${prefix}/commits/${pullHeadSha}/check-runs`)
      return response({
        check_runs: [
          ...(options.headChecks ?? [
            successfulCheck(RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission, pullHeadSha),
          ]),
          ...(url.searchParams.get("filter") === "all" ? (options.historicalHeadChecks ?? []) : []),
        ],
      });
    if (method === "GET" && url.pathname === `${prefix}/commits/${mergeSha}/check-runs`)
      return response({
        check_runs: [
          ...(options.sourceChecks ??
            RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name) =>
              successfulCheck(name, mergeSha),
            )),
          ...(url.searchParams.get("filter") === "all"
            ? (options.historicalSourceChecks ?? [])
            : []),
        ],
      });
    return response({ message: `unexpected ${method} ${url.pathname}` }, 404);
  }
  return { fetchImpl, requests };
}

describe("release approval provenance", () => {
  test.each([
    ["merge", "merge"],
    ["squash", "squash"],
    ["rebase", "rebase"],
    ["single", "single-commit-squash-or-rebase"],
  ] as const)("accepts provider-proved %s provenance", async (fixtureMethod, expectedMethod) => {
    const fixture = approvalFixture({ mergeMethod: fixtureMethod });
    const result = await verifyApprovedMerge({
      env: approvalEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      mergeMethod: "forged-caller-value",
    } as any);
    expect(result).toEqual(
      expect.objectContaining({
        version: 2,
        repository: RELEASE_AUTOMATION_CONTRACT.repository,
        sourceSha: mergeSha,
        sourceTreeSha: headTreeSha,
        pullRequestNumber: pullNumber,
        mergeMethod: expectedMethod,
        reviewedBaseSha: baseSha,
        reviewedBaseTreeSha: baseTreeSha,
        reviewedHeadSha: headSha,
        reviewedHeadTreeSha: headTreeSha,
        releaseHead: {
          name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
          ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
          sha: headSha,
        },
        releaseHeadRelease: {
          id: releaseHeadReleaseId,
          tagName: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
          name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadReleaseNamePrefix}${headSha}`,
          immutable: true,
          draft: false,
          prerelease: true,
          authorId: RELEASE_AUTOMATION_CONTRACT.versionAuthor.id,
          authorLogin: RELEASE_AUTOMATION_CONTRACT.versionAuthor.login,
          authorType: RELEASE_AUTOMATION_CONTRACT.versionAuthor.type,
          publishedAt: "2026-07-27T02:00:00.000Z",
          url:
            `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
            `/releases/tag/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        },
        sourceAdmission: {
          name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
          appSlug: "github-actions",
          appId: 15368,
        },
      }),
    );
    expect(result.requiredSourceChecks.map((check: { name: string }) => check.name)).toEqual([
      ...RELEASE_AUTOMATION_CONTRACT.checks.requiredSource,
    ]);
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("accepts the provider-bound structured single-maintainer admin PASS", async () => {
    const fixture = approvalFixture({
      mergeMethod: "single",
      reviewState: "COMMENTED",
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        mergeMethod: "single-commit-squash-or-rebase",
        review: expect.objectContaining({
          type: "single-maintainer-admin-pass",
        }),
      }),
    );
  });

  test("reconstructs source admission when GitHub deletes merged-head check projections", async () => {
    const fixture = approvalFixture({ headChecks: [] });
    const result = await verifyApprovedMerge({
      env: approvalEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(result.sourceAdmission).toEqual({
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      appSlug: "github-actions",
      appId: 15368,
      reconstructed: true,
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(
      fixture.requests.filter(
        (request) =>
          request.path ===
          `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}/commits/${headSha}/check-runs`,
      ),
    ).toHaveLength(2);
  });

  test("prefers one canonical recovered admission over duplicate draft-to-ready originals", async () => {
    const original = (id: number) => ({
      id,
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      external_id: `ordinary-${id}`,
      app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
    });
    const fixture = approvalFixture({
      headChecks: [
        original(101),
        original(102),
        {
          ...original(103),
          external_id: recoveredSourceAdmissionExternalId(),
        },
      ],
    });

    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toMatchObject({
      sourceAdmission: {
        name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
        appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
        appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
      },
    });
  });

  test("rejects duplicate canonical recovered admissions", async () => {
    const externalId = recoveredSourceAdmissionExternalId();
    const canonical = {
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      external_id: externalId,
      app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
    };
    const fixture = approvalFixture({
      headChecks: [
        { ...canonical, id: 201 },
        { ...canonical, id: 202 },
      ],
    });

    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("canonical recovered source-admission check is not unique");
  });

  test("accepts reviewer login movement while preserving stable provider identity", async () => {
    const reviewer = {
      ...RELEASE_AUTOMATION_CONTRACT.releaseApprover,
      login: "renamed-maintainer",
    };
    const fixture = approvalFixture({
      reviewer,
      reviewDetailReviewer: { ...reviewer, login: "Renamed-Maintainer" },
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        review: expect.objectContaining({ type: "independent-approval" }),
      }),
    );
  });

  test("treats the legacy v3 reviewer login as a snapshot, not account authority", async () => {
    const fixture = approvalFixture({
      mergeMethod: "single",
      reviewState: "COMMENTED",
      reviewer: {
        ...RELEASE_AUTOMATION_CONTRACT.releaseApprover,
        login: "renamed-maintainer",
      },
      reviewDetailReviewer: {
        ...RELEASE_AUTOMATION_CONTRACT.releaseApprover,
        login: "RENAMED-MAINTAINER",
      },
      reviewerLoginSnapshot: "former-maintainer-login",
    });
    const result = await verifyApprovedMerge({
      env: approvalEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(result).toEqual(
      expect.objectContaining({
        review: expect.objectContaining({
          type: "single-maintainer-admin-pass",
        }),
      }),
    );
  });

  test("rejects reviewer identity substitution and missing provider identity", async () => {
    for (const [reviewDetailReviewer, message] of [
      [
        { ...RELEASE_AUTOMATION_CONTRACT.releaseApprover, id: 999 },
        "trusted review detail actor numeric identity changed",
      ],
      [
        { ...RELEASE_AUTOMATION_CONTRACT.releaseApprover, type: "Bot" },
        "trusted review detail actor account type changed",
      ],
      [
        {
          login: RELEASE_AUTOMATION_CONTRACT.releaseApprover.login,
          type: RELEASE_AUTOMATION_CONTRACT.releaseApprover.type,
        },
        "trusted review detail actor numeric identity is not a positive integer",
      ],
    ] as const) {
      const fixture = approvalFixture({ reviewDetailReviewer });
      await expect(
        verifyApprovedMerge({
          env: approvalEnv(),
          fetchImpl: fixture.fetchImpl,
        }),
      ).rejects.toThrow(message);
    }

    const missingSnapshot = approvalFixture({
      mergeMethod: "single",
      reviewState: "COMMENTED",
      reviewerLoginSnapshot: "",
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: missingSnapshot.fetchImpl,
      }),
    ).rejects.toThrow("single-maintainer admin PASS reviewer login snapshot is missing");
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
    const self = approvalFixture({
      authorId: RELEASE_AUTOMATION_CONTRACT.releaseApprover.id,
    });
    await expect(
      verifyApprovedMerge({ env: approvalEnv(), fetchImpl: self.fetchImpl }),
    ).rejects.toThrow("trusted reviewer authored the independently approved pull request");
    const requested = approvalFixture({ reviewState: "CHANGES_REQUESTED" });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: requested.fetchImpl,
      }),
    ).rejects.toThrow(
      "neither independent approval nor a provider-bound single-maintainer admin PASS",
    );
  });

  test("rejects direct pushes, ambiguous associations, and reopened or unmerged PRs", async () => {
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ associatedPullCount: 0 }).fetchImpl,
      }),
    ).rejects.toThrow("exactly one pull request");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ associatedPullCount: 2 }).fetchImpl,
      }),
    ).rejects.toThrow("exactly one pull request");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ pullState: "open", merged: false }).fetchImpl,
      }),
    ).rejects.toThrow("is not merged");
  });

  test("rejects an associated direct fast-forward with matching provider topology", async () => {
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ mergeMethod: "single", mergeEvent: null }).fetchImpl,
      }),
    ).rejects.toThrow("exactly one provider merge event");
  });

  test("rejects tree, head, topology, effective-review, and terminal-main drift", async () => {
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ sourceTreeSha: "9".repeat(40) }).fetchImpl,
      }),
    ).rejects.toThrow("tree differs");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          pullHeadSha: "8".repeat(40),
          reviewCommit: headSha,
        }).fetchImpl,
      }),
    ).rejects.toThrow("did not review the exact PR head");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          mergeMethod: "rebase",
          discontinuousCompare: true,
        }).fetchImpl,
      }),
    ).rejects.toThrow("discontinuity");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          requestedReview: true,
          requestedReviewer: {
            ...RELEASE_AUTOMATION_CONTRACT.releaseApprover,
            login: "renamed-maintainer",
          },
        }).fetchImpl,
      }),
    ).rejects.toThrow("review was re-requested");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ terminalMainSha: "7".repeat(40) }).fetchImpl,
      }),
    ).rejects.toThrow("terminal release main differs");
  });

  test("rejects duplicate, failed, or foreign source-admission and source checks", async () => {
    const success = (name: string, sha = headSha, appSlug = "github-actions", appId = 15368) => ({
      name,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      app: { slug: appSlug, id: appId },
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          headChecks: [
            success(RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission),
            success(RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission),
          ],
        }).fetchImpl,
      }),
    ).rejects.toThrow("exactly one check run");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          headChecks: [
            success(RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission, headSha, "forged-app"),
          ],
        }).fetchImpl,
      }),
    ).rejects.toThrow("not owned by the official GitHub Actions app");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          headChecks: [
            success(
              RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
              headSha,
              "github-actions",
              999,
            ),
          ],
        }).fetchImpl,
      }),
    ).rejects.toThrow("not owned by the official GitHub Actions app");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          headChecks: [success(RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission, mergeSha)],
        }).fetchImpl,
      }),
    ).rejects.toThrow("bound to another commit");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          sourceChecks: RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) => ({
            ...success(name, mergeSha),
            conclusion: index === 0 ? "failure" : "success",
          })),
        }).fetchImpl,
      }),
    ).rejects.toThrow("did not complete successfully");
  });

  test("requires the immutable reviewed-head evidence ref", async () => {
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ releaseHeadRefSha: null }).fetchImpl,
      }),
    ).rejects.toThrow("failed with HTTP 404");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ releaseHeadRefSha: "9".repeat(40) }).fetchImpl,
      }),
    ).rejects.toThrow("release head evidence ref points to another commit");
  });

  test("requires a published immutable provider-authored release for the retained head", async () => {
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ release: null }).fetchImpl,
      }),
    ).rejects.toThrow("failed with HTTP 404");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          release: { ...releaseHeadRelease(), immutable: false },
        }).fetchImpl,
      }),
    ).rejects.toThrow("is not a published immutable prerelease");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          release: { ...releaseHeadRelease(), draft: true },
        }).fetchImpl,
      }),
    ).rejects.toThrow("is not a published immutable prerelease");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          release: {
            ...releaseHeadRelease(),
            author: { login: "attacker", id: 999, type: "User" },
          },
        }).fetchImpl,
      }),
    ).rejects.toThrow("release head immutable release author numeric identity changed");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          release: {
            ...releaseHeadRelease(),
            author: {
              login: "github-actions",
              id: RELEASE_AUTOMATION_CONTRACT.versionAuthor.id,
              type: RELEASE_AUTOMATION_CONTRACT.versionAuthor.type,
            },
          },
        }).fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        releaseHeadRelease: expect.objectContaining({
          authorId: RELEASE_AUTOMATION_CONTRACT.versionAuthor.id,
          authorLogin: RELEASE_AUTOMATION_CONTRACT.versionAuthor.login,
          authorType: RELEASE_AUTOMATION_CONTRACT.versionAuthor.type,
        }),
      }),
    );
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          release: {
            ...releaseHeadRelease(),
            author: {
              ...RELEASE_AUTOMATION_CONTRACT.versionAuthor,
              type: "User",
            },
          },
        }).fetchImpl,
      }),
    ).rejects.toThrow("release head immutable release author account type changed");
  });

  test("uses all check runs so a failed run hidden by a successful rerequest is rejected", async () => {
    const successful = {
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
    };
    const fixture = approvalFixture({
      headChecks: [successful],
      historicalHeadChecks: [{ ...successful, conclusion: "failure" }],
    });
    await expect(
      verifyApprovedMerge({ env: approvalEnv(), fetchImpl: fixture.fetchImpl }),
    ).rejects.toThrow("exactly one check run");
    expect(
      fixture.requests
        .filter((request) => request.path.endsWith("/check-runs"))
        .every((request) => request.query.get("filter") === "all"),
    ).toBe(true);
  });
});

describe("workflow contracts", () => {
  const releaseText = readFileSync(releaseWorkflowPath, "utf8");
  const ciText = readFileSync(ciWorkflowPath, "utf8");
  const sealText = readFileSync(sealWorkflowPath, "utf8");
  const releaseAutomationText = readFileSync(releaseAutomationPath, "utf8");
  const release = Bun.YAML.parse(releaseText) as any;
  const ci = Bun.YAML.parse(ciText) as any;
  const seal = Bun.YAML.parse(sealText) as any;

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
    const admission = ci.jobs["automation-admission"];
    const report = ci.jobs["automation-report"];
    expect(admission.permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "write",
      "pull-requests": "read",
    });
    expect(ciText).not.toContain("pull-requests: write");
    expect(ciText).not.toMatch(/pulls\/.+\/reviews/);
    for (const jobName of ["test", "deployment", "images"])
      expect(
        ci.jobs[jobName].steps.find((step: any) => step.uses === "actions/checkout@v6").with.ref,
      ).toContain("inputs.automation_head_sha");
    expect(admission.steps[0].uses).toBe(
      "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    );
    expect(admission.steps[0].with).toEqual(
      expect.objectContaining({
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      }),
    );
    expect(admission.steps.find((step: any) => step.name === "Set up Bun").uses).toBe(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    expect(report.steps[0].uses).toBe("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(report.steps[0].with["persist-credentials"]).toBe(false);
    expect(admission.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(report.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(
      admission.steps
        .filter((step: any) => step.env?.GITHUB_TOKEN)
        .map((step: any) => [step.name, step.env.GITHUB_TOKEN]),
    ).toEqual([
      ["Begin exact-head automation checks", "${{ github.token }}"],
      ["Admit trusted dispatch and exact source tree", "${{ github.token }}"],
      ["Complete exact-head source-admission check", "${{ github.token }}"],
    ]);
    expect(
      report.steps
        .filter((step: any) => step.env?.GITHUB_TOKEN)
        .map((step: any) => [step.name, step.env.GITHUB_TOKEN]),
    ).toEqual([["Complete exact-head automation CI check", "${{ github.token }}"]]);
  });

  test("keeps release-head retention base-owned, explicit, and narrowly authorized", () => {
    expect(seal.on.workflow_dispatch.inputs).toEqual({
      pull_request_number: expect.objectContaining({ required: true }),
      reviewed_base_sha: expect.objectContaining({ required: true }),
      reviewed_head_sha: expect.objectContaining({ required: true }),
      merged_source_sha: expect.objectContaining({
        required: false,
        default: "",
      }),
    });
    expect(seal.permissions).toEqual({ contents: "read" });
    expect(seal.jobs.seal.permissions).toEqual({
      checks: "write",
      contents: "write",
      "pull-requests": "read",
    });
    expect(seal.jobs.seal.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    expect(sealText).toContain("seal-release-head");
    expect(sealText).toContain("recover-release-head");
    expect(sealText).not.toContain("pull_request_target");
    expect(sealText).not.toContain("pull-requests: write");
    expect(seal.jobs.seal.steps[0].uses).toBe(
      "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
    );
    expect(seal.jobs.seal.steps[0].with).toEqual(
      expect.objectContaining({
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      }),
    );
  });

  test("binds explicit source-admission and aggregate reports to the exact head", () => {
    expect(ciText).toContain("begin-version-checks");
    expect(ciText).toContain("admit-version-ci");
    expect(ciText).toContain("complete-version-check");
    expect(ciText).toContain("AUTOMATION_CHECK_KIND: source-admission");
    expect(ciText).toContain("AUTOMATION_CHECK_KIND: automation-ci");
    expect(releaseAutomationText).toContain("releaseHeadTagPrefix");
    expect(releaseText).toContain("verify-approved-merge");
  });

  test("writes approved provenance outputs from the provider result field names", () => {
    expect(releaseAutomationText).toContain("approved_pr_number: result.pullRequestNumber");
    expect(releaseAutomationText).toContain("approved_pr_head_sha: result.reviewedHeadSha");
    expect(releaseAutomationText).toContain("approved_review_id: result.review.id");
  });

  test("requires complete live acceptance before any publication", () => {
    expect(releaseText).not.toContain("maintainer_fast_path");
    expect(releaseText).not.toContain("maintainer-fast-path");
    expect(releaseText).toContain("Download and validate the complete acceptance bundle");
    expect(releaseText).toContain("bun scripts/verify-workbench-acceptance-bundle.ts");
    expect(releaseText).toContain("confirm_zero_gaps must be explicitly true");
    expect(releaseText).toContain("bun run typecheck");
    expect(releaseText).toContain("bun run build:packages");
    expect(releaseText).toContain("bun scripts/publish-closure-guard.ts");
  });

  test("hashes immutable GitHub artifact downloads before extraction", () => {
    expect(releaseText).toContain("/actions/artifacts/${artifact_id}/zip");
    expect(releaseText).toContain("sha256sum --check --strict");
    expect(releaseText).toContain('unzip -q "$zip"');
  });
});
