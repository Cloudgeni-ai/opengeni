import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_AUTOMATION_CONTRACT,
  beginVersionPrChecks,
  completeVersionPrChecks,
  recoverReleaseHeadEvidence,
  retainCurrentMainControllerEvidence,
  sealReleaseHeadEvidence,
  validateVersionPrCiAdmission,
  validateVersionPrDispatch,
  verifyApprovedMerge,
} from "./check-release-pr-automation.mjs";

const root = join(import.meta.dir, "..");
const releaseWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath);
const ciWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath);
const sealWorkflowPath = join(root, RELEASE_AUTOMATION_CONTRACT.sealWorkflowPath);
const retainControllerWorkflowPath = join(
  root,
  RELEASE_AUTOMATION_CONTRACT.retainControllerWorkflowPath,
);
const releaseSourceAdmissionPath = join(root, ".github/workflows/release-source-admission.yml");
const releasePublicationAdmissionPath = join(
  root,
  ".github/workflows/release-publication-admission.yml",
);
const releaseAutomationPath = join(root, "scripts/check-release-pr-automation.mjs");
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const mergeSha = "d".repeat(40);
const controllerSha = baseSha;
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
const sourceCiRunId = 654321;
const sourceCiRunAttempt = 1;
const sourceCiCheckSuiteId = 876543;

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

function sourceCiCheck(name: string, index: number, overrides: Record<string, unknown> = {}) {
  const jobId = Number(overrides.id ?? 7000 + index);
  return {
    id: jobId,
    name,
    head_sha: mergeSha,
    status: "completed",
    conclusion: "success",
    external_id: `source-ci-${jobId}`,
    details_url:
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
      `/actions/runs/${sourceCiRunId}/job/${jobId}`,
    check_suite: { id: sourceCiCheckSuiteId },
    app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
    ...overrides,
  };
}

function sourceCiJob(name: string, index: number, overrides: Record<string, unknown> = {}) {
  const jobId = Number(overrides.id ?? 7000 + index);
  return {
    id: jobId,
    name,
    status: "completed",
    conclusion: "success",
    html_url:
      `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
      `/actions/runs/${sourceCiRunId}/job/${jobId}`,
    check_run_url:
      `${RELEASE_AUTOMATION_CONTRACT.apiUrl}/repos/${RELEASE_AUTOMATION_CONTRACT.repository}` +
      `/check-runs/${jobId}`,
    ...overrides,
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

function mergedVersionPull(overrides: { merge?: string } = {}) {
  return {
    ...versionPull(),
    state: "closed",
    merged: true,
    merge_commit_sha: overrides.merge ?? mergeSha,
    merged_at: "2026-08-09T06:08:35Z",
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

function openVersionPrEnv(overrides: Record<string, string> = {}) {
  return releasePushEnv({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF:
      `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
      `${RELEASE_AUTOMATION_CONTRACT.openVersionPrWorkflowPath}@refs/heads/main`,
    ...overrides,
  });
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
    requests.push({ method, path: url.pathname, query: url.searchParams, body });
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

  test("dispatches trusted main CI from the manual Open Version PR workflow", async () => {
    const fixture = dispatchFixture();
    const result = await validateVersionPrDispatch({
      env: openVersionPrEnv(),
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
    sourcePath?: string;
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
    if (url.pathname === `${prefix}/git/ref/heads/main`)
      return response(mainRef(options.terminalMainSha ?? baseSha));
    if (url.pathname === `${prefix}/pulls/${pullNumber}`)
      return response(versionPull({ base: pullBaseSha }));
    if (url.pathname === `${prefix}/actions/runs/${runId}`)
      return response({
        id: runId,
        run_attempt: runAttempt,
        event: options.sourceEvent ?? "push",
        status: options.sourceStatus ?? "completed",
        conclusion: options.sourceConclusion === undefined ? "success" : options.sourceConclusion,
        path: options.sourcePath ?? RELEASE_AUTOMATION_CONTRACT.releaseWorkflowPath,
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
        total_commits: 1,
      });
    if (
      options.terminalMainSha !== undefined &&
      url.pathname === `${prefix}/compare/${baseSha}...${options.terminalMainSha}`
    )
      return response({
        status: "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        commits: [{ sha: options.terminalMainSha }],
        behind_by: 0,
        ahead_by: 1,
        total_commits: 1,
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

  test("rejects a source run that is not a trusted Version PR producer", async () => {
    const fixture = admissionFixture({ sourceEvent: "pull_request" });
    await expect(
      validateVersionPrCiAdmission({
        env: automationCiEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("source run is not a trusted Version PR producer");
  });

  test("admits a workflow_dispatch Open Version PR producer run", async () => {
    const fixture = admissionFixture({
      sourceEvent: "workflow_dispatch",
      sourcePath: RELEASE_AUTOMATION_CONTRACT.openVersionPrWorkflowPath,
    });
    const result = await validateVersionPrCiAdmission({
      env: automationCiEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(result).toMatchObject({ prNumber: pullNumber, baseSha, headSha });
  });

  test("keeps an admitted Version PR valid while main advances", async () => {
    const advancedMainSha = "9".repeat(40);
    const fixture = admissionFixture({ terminalMainSha: advancedMainSha });
    const result = await validateVersionPrCiAdmission({
      env: automationCiEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(result).toMatchObject({ prNumber: pullNumber, baseSha, headSha });
    expect(result.admission.currentMainSha).toBe(advancedMainSha);
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

function retainControllerEnv(overrides: Record<string, string> = {}) {
  return {
    GITHUB_API_URL: RELEASE_AUTOMATION_CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: RELEASE_AUTOMATION_CONTRACT.repository,
    GITHUB_SERVER_URL: RELEASE_AUTOMATION_CONTRACT.serverUrl,
    GITHUB_SHA: headSha,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_WORKFLOW_REF:
      `${RELEASE_AUTOMATION_CONTRACT.repository}/` +
      `${RELEASE_AUTOMATION_CONTRACT.retainControllerWorkflowPath}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: headSha,
    RELEASE_CONTROLLER_SHA: headSha,
    ...overrides,
  };
}

function retainControllerFixture() {
  const requests: RequestRecord[] = [];
  let refRetained = false;
  let releaseRetained = false;
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
    if (method === "POST" && url.pathname === `${prefix}/git/refs`) {
      refRetained = true;
      return response({ ref: body?.ref, object: { type: "commit", sha: body?.sha } }, 201);
    }
    if (method === "POST" && url.pathname === `${prefix}/releases`) {
      releaseRetained = true;
      return response(releaseHeadRelease(headSha), 201);
    }
    if (method !== "GET") return response({ message: "unsupported" }, 405);
    if (url.pathname === prefix) return response(repository());
    if (url.pathname === `${prefix}/git/ref/heads/main`) return response(mainRef(headSha));
    if (url.pathname === `${prefix}/git/commits/${headSha}`)
      return response({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: baseSha }],
      });
    if (
      url.pathname ===
      `${prefix}/git/ref/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`
    ) {
      return refRetained
        ? response({
            ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
            object: { type: "commit", sha: headSha },
          })
        : response({ message: "missing" }, 404);
    }
    if (
      url.pathname ===
      `${prefix}/releases/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`
    ) {
      return releaseRetained
        ? response(releaseHeadRelease(headSha))
        : response({ message: "missing" }, 404);
    }
    return response({ message: `unexpected ${method} ${url.pathname}` }, 404);
  }
  return { fetchImpl, requests };
}

describe("current-main release controller retention", () => {
  test("idempotently retains only the exact current workflow SHA", async () => {
    const fixture = retainControllerFixture();
    const first = await retainCurrentMainControllerEvidence({
      env: retainControllerEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    const second = await retainCurrentMainControllerEvidence({
      env: retainControllerEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });
    expect(first.controllerSha).toBe(headSha);
    expect(first.releaseHead.sha).toBe(headSha);
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
    ).toHaveLength(1);
  });

  test("rejects a target that differs from the workflow SHA before provider access", async () => {
    const fixture = retainControllerFixture();
    await expect(
      retainCurrentMainControllerEvidence({
        env: retainControllerEnv({ RELEASE_CONTROLLER_SHA: baseSha }),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("retained controller differs from workflow SHA");
    expect(fixture.requests).toHaveLength(0);
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
        total_commits: 1,
      });
    if (url.pathname === `${prefix}/compare/${baseSha}...${headSha}`)
      return response({
        status: "ahead",
        base_commit: { sha: baseSha },
        merge_base_commit: { sha: baseSha },
        behind_by: 0,
        ahead_by: 1,
        total_commits: 1,
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

  test("creates one recovery receipt when duplicate legacy idempotency markers exist", async () => {
    const legacyExternalId = String.raw`opengeni:release-automation:source-admission:v1:pr:${pullNumber}:head:${headSha}`;
    const legacy = (id: number) => ({
      id,
      name: RELEASE_AUTOMATION_CONTRACT.checks.sourceAdmission,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      external_id: legacyExternalId,
      app: RELEASE_AUTOMATION_CONTRACT.githubActionsApp,
    });
    const fixture = recoverySealFixture({
      existingRecoveryChecks: [legacy(777), legacy(778)],
    });

    await recoverReleaseHeadEvidence({
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    });

    expect(
      fixture.checks.filter((check) => check.external_id === recoveredSourceAdmissionExternalId()),
    ).toHaveLength(1);
    expect(fixture.checks.filter((check) => check.external_id === legacyExternalId)).toHaveLength(
      2,
    );
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
    const fixture = recoverySealFixture({
      releaseHeadRef: null,
      release: null,
    });
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

  test("retains the reviewed head when the provider squashes it after disjoint main movement", async () => {
    const fixture = recoverySealFixture({
      sourceTreeSha: "9".repeat(40),
      releaseHeadRef: null,
      release: null,
    });

    const result = await recoverReleaseHeadEvidence({
      env: recoverySealEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
      now: () => new Date("2026-07-27T09:30:00Z"),
    });

    expect(result).toMatchObject({
      baseSha,
      headSha,
      sourceSha: mergeSha,
      mergeMethod: "provider-verified-moving-main",
      releaseHead: {
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`,
        sha: headSha,
      },
    });
    expect(
      fixture.requests.filter(
        (request) => request.method === "POST" && request.path.endsWith("/git/refs"),
      ),
    ).toHaveLength(1);
    expect(
      fixture.checks.find(
        (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
      ),
    ).toMatchObject({
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
    });
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

  test("accepts successful exact retention projections from one check suite", async () => {
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
    Object.assign(retentionCheck!, { check_suite: { id: 123 } });
    fixture.checks.push({
      ...retentionCheck,
      id: Number(retentionCheck?.id) + 1,
      check_suite: { id: 123 },
    });
    fixture.requests.length = 0;

    await expect(recoverReleaseHeadEvidence(options)).resolves.toBeDefined();
    expect(
      fixture.checks.filter(
        (check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
      ),
    ).toHaveLength(2);
    expect(
      fixture.requests.filter(
        (request) =>
          request.method === "PATCH" &&
          request.body?.name === RELEASE_AUTOMATION_CONTRACT.checks.releaseHeadRetention,
      ),
    ).toHaveLength(0);
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
    ).rejects.toThrow(
      "GitHub API GET /repos/Cloudgeni-ai/opengeni/git/ref/tags/opengeni-release-head-cccccccccccccccccccccccccccccccccccccccc failed with HTTP 404",
    );
    expect(fixture.checks).toHaveLength(0);
    expect(
      fixture.requests.filter((request) => request.method !== "GET").map((request) => request.path),
    ).toEqual([`/repos/${RELEASE_AUTOMATION_CONTRACT.repository}/git/refs`]);
  });
});

function checksFixture(
  options: {
    concurrentRetentionRace?: boolean;
    merged?: boolean;
    mergedTreeSha?: string;
    missingVersionBranch?: boolean;
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
  let releaseControllerRef: Record<string, any> | null = null;
  let releaseController: Record<string, any> | null = null;
  let nextId = 700;
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  const releaseHeadTag = `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${headSha}`;
  const releaseControllerTag = `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${baseSha}`;
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
      return response(options.merged ? mergedVersionPull() : versionPull());
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/changeset-release/main`)
      return options.missingVersionBranch
        ? response({ message: "missing version branch" }, 404)
        : response({
            ref: "refs/heads/changeset-release/main",
            object: { type: "commit", sha: headSha },
          });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${headSha}`)
      return response({
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: baseSha }],
      });
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${mergeSha}`)
      return response({
        sha: mergeSha,
        tree: { sha: options.mergedTreeSha ?? headTreeSha },
        parents: [{ sha: baseSha }],
      });
    if (method === "GET" && url.pathname === `${prefix}/git/ref/tags/${releaseHeadTag}`)
      return releaseHeadRef === null
        ? response({ message: "missing release head ref" }, 404)
        : response(releaseHeadRef);
    if (method === "GET" && url.pathname === `${prefix}/git/ref/tags/${releaseControllerTag}`)
      return releaseControllerRef === null
        ? response({ message: "missing release controller ref" }, 404)
        : response(releaseControllerRef);
    if (method === "POST" && url.pathname === `${prefix}/git/refs`) {
      const created = {
        ref: body?.ref,
        object: { type: "commit", sha: body?.sha },
      };
      if (body?.ref === `refs/tags/${releaseControllerTag}`) releaseControllerRef = created;
      else releaseHeadRef = created;
      return options.concurrentRetentionRace
        ? response({ message: "Reference already exists" }, 422)
        : response(created, 201);
    }
    if (method === "GET" && url.pathname === `${prefix}/releases/tags/${releaseHeadTag}`) {
      const currentRelease = options.release ?? release;
      return currentRelease === null
        ? response({ message: "missing release head release" }, 404)
        : response(currentRelease);
    }
    if (method === "GET" && url.pathname === `${prefix}/releases/tags/${releaseControllerTag}`) {
      return releaseController === null
        ? response({ message: "missing immutable controller release" }, 404)
        : response(releaseController);
    }
    if (method === "POST" && url.pathname === `${prefix}/releases`) {
      const created = releaseHeadRelease(
        body?.tag_name === releaseControllerTag ? baseSha : headSha,
      );
      if (body?.tag_name === releaseControllerTag) releaseController = created;
      else release = created;
      return options.concurrentRetentionRace
        ? response({ message: "Release already exists" }, 422)
        : response(created, 201);
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
  const first = await beginVersionPrChecks(options);
  await beginVersionPrChecks(options);
  expect(first.releaseController).toEqual({
    name: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${baseSha}`,
    ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${baseSha}`,
    sha: baseSha,
  });
  expect(first.releaseControllerRelease).toEqual(
    expect.objectContaining({
      tagName: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${baseSha}`,
      immutable: true,
    }),
  );
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
  ).toHaveLength(2);
  expect(
    fixture.requests.filter(
      (request) => request.method === "POST" && request.path.endsWith("/check-runs"),
    ),
  ).toHaveLength(3);
  expect(fixture.requests.filter((request) => request.method === "PATCH")).toHaveLength(3);
});

test("exact-head retention accepts concurrent creation of the same immutable evidence", async () => {
  const fixture = checksFixture({ concurrentRetentionRace: true });
  const result = await beginVersionPrChecks({
    env: automationCiEnv(),
    fetchImpl: fixture.fetchImpl,
    now: () => new Date("2026-07-23T12:00:00Z"),
  });

  expect(result.releaseHead.sha).toBe(headSha);
  expect(result.releaseController.sha).toBe(baseSha);
  expect(result.releaseHeadRelease).toMatchObject({
    immutable: true,
    tagName: expect.any(String),
  });
  expect(result.releaseControllerRelease).toMatchObject({
    immutable: true,
    tagName: expect.any(String),
  });
});

test("exact-head check completion succeeds while the Version PR remains unchanged", async () => {
  const fixture = checksFixture();
  const options = {
    env: automationCiEnv(),
    fetchImpl: fixture.fetchImpl,
    now: () => new Date("2026-08-09T06:00:00Z"),
  };
  await beginVersionPrChecks(options);
  await completeVersionPrChecks({
    ...options,
    kind: "automation-ci",
    conclusion: "success",
  });
  expect(
    fixture.checks.find((check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.automationCi),
  ).toMatchObject({ status: "completed", conclusion: "success" });
  expect(fixture.requests.some((request) => request.path.endsWith("/git/ref/heads/main"))).toBe(
    false,
  );
});

test("exact-head check completion accepts an exact-tree merge after branch deletion", async () => {
  const fixtureOptions = { merged: false, missingVersionBranch: false };
  const fixture = checksFixture(fixtureOptions);
  const options = {
    env: automationCiEnv(),
    fetchImpl: fixture.fetchImpl,
    now: () => new Date("2026-08-09T06:11:17Z"),
  };
  await beginVersionPrChecks(options);
  fixtureOptions.merged = true;
  fixtureOptions.missingVersionBranch = true;

  await completeVersionPrChecks({
    ...options,
    kind: "automation-ci",
    conclusion: "success",
  });

  expect(
    fixture.checks.find((check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.automationCi),
  ).toMatchObject({ status: "completed", conclusion: "success" });
});

test("exact-head check completion rejects a merged tree that differs from the admitted head", async () => {
  const fixtureOptions = {
    merged: false,
    mergedTreeSha: "1".repeat(40),
    missingVersionBranch: false,
  };
  const fixture = checksFixture(fixtureOptions);
  const options = {
    env: automationCiEnv(),
    fetchImpl: fixture.fetchImpl,
    now: () => new Date("2026-08-09T06:11:17Z"),
  };
  await beginVersionPrChecks(options);
  fixtureOptions.merged = true;
  fixtureOptions.missingVersionBranch = true;

  await expect(
    completeVersionPrChecks({
      ...options,
      kind: "automation-ci",
      conclusion: "success",
    }),
  ).rejects.toThrow("merged Version commit tree differs from its exact head");
  expect(
    fixture.checks.find((check) => check.name === RELEASE_AUTOMATION_CONTRACT.checks.automationCi),
  ).toMatchObject({ status: "completed", conclusion: "failure" });
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
    GITHUB_REF: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${controllerSha}`,
    GITHUB_SHA: controllerSha,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_WORKFLOW_SHA: controllerSha,
    RELEASE_CONTROLLER_SHA: controllerSha,
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
    controllerSha?: string;
    controllerTreeSha?: string;
    controllerRefSha?: string | null;
    controllerRelease?: Record<string, unknown> | null;
    initialMainSha?: string;
    terminalMainSha?: string;
    sourceAncestorMainShas?: string[];
    sourceAncestorTotalCommitsByMainSha?: Record<string, number | null>;
    controllerAncestorMainShas?: string[];
    controllerAncestorTotalCommitsByMainSha?: Record<string, number | null>;
    reviewCommit?: string;
    reviewState?: string;
    reviewTime?: string;
    reviewBody?: string;
    requestedReview?: boolean;
    requestedReviewer?: Record<string, unknown>;
    reviewer?: Record<string, unknown>;
    reviewDetailReviewer?: Record<string, unknown>;
    reviewerLoginSnapshot?: string;
    author?: Record<string, unknown>;
    merger?: Record<string, unknown>;
    headChecks?: Array<Record<string, unknown>>;
    sourceChecks?: Array<Record<string, unknown>>;
    historicalHeadChecks?: Array<Record<string, unknown>>;
    historicalSourceChecks?: Array<Record<string, unknown>>;
    sourceRun?: Record<string, unknown>;
    otherSourceRuns?: Record<string, Record<string, unknown>>;
    sourceAttemptJobs?: Array<Record<string, unknown>>;
    releaseHeadRefSha?: string | null;
    release?: Record<string, unknown> | null;
    reviewedBaseSha?: string;
    discontinuousCompare?: boolean;
    mergeEvent?: Record<string, unknown> | null;
  } = {},
) {
  const requests: RequestRecord[] = [];
  const prefix = `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}`;
  const mergeMethod = options.mergeMethod ?? "merge";
  const pullHeadSha = options.pullHeadSha ?? headSha;
  const reviewedBaseSha = options.reviewedBaseSha ?? baseSha;
  const retainedControllerSha = options.controllerSha ?? controllerSha;
  const pullCommitCount = mergeMethod === "single" ? 1 : 2;
  const sourceParents =
    mergeMethod === "merge"
      ? [{ sha: baseSha }, { sha: pullHeadSha }]
      : mergeMethod === "rebase"
        ? [{ sha: rebasedFirstSha }]
        : [{ sha: baseSha }];
  const author =
    options.author ??
    (options.authorId === RELEASE_AUTOMATION_CONTRACT.releaseApprover.id ||
    (options.reviewState === "COMMENTED" && options.authorId === undefined)
      ? RELEASE_AUTOMATION_CONTRACT.releaseApprover
      : {
          login: "release-bot",
          id: options.authorId ?? 41898282,
          type: "Bot",
        });
  const merger =
    options.merger ??
    (options.reviewState === "COMMENTED"
      ? RELEASE_AUTOMATION_CONTRACT.releaseApprover
      : { login: "merge-maintainer", id: 1234567, type: "User" });
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
      return response(
        mainRef(
          mainReads === 1
            ? (options.initialMainSha ?? mergeSha)
            : (options.terminalMainSha ?? mergeSha),
        ),
      );
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
    if (method === "GET" && url.pathname === `${prefix}/git/commits/${retainedControllerSha}`)
      return response({
        sha: retainedControllerSha,
        tree: { sha: options.controllerTreeSha ?? baseTreeSha },
        parents: [{ sha: "3".repeat(40) }],
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
          base: { sha: reviewedBaseSha },
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
          sha: reviewedBaseSha,
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
    const sourceMainComparisonPrefix = `${prefix}/compare/${mergeSha}...`;
    if (method === "GET" && url.pathname.startsWith(sourceMainComparisonPrefix)) {
      const observedMainSha = url.pathname.slice(sourceMainComparisonPrefix.length);
      const retained = options.sourceAncestorMainShas?.includes(observedMainSha) ?? false;
      return response(
        retained
          ? {
              status: "ahead",
              base_commit: { sha: mergeSha },
              merge_base_commit: { sha: mergeSha },
              ahead_by: 1,
              behind_by: 0,
              total_commits: Object.prototype.hasOwnProperty.call(
                options.sourceAncestorTotalCommitsByMainSha ?? {},
                observedMainSha,
              )
                ? options.sourceAncestorTotalCommitsByMainSha?.[observedMainSha]
                : 1,
              commits: [{ sha: observedMainSha, parents: [{ sha: mergeSha }] }],
            }
          : {
              status: "diverged",
              base_commit: { sha: mergeSha },
              merge_base_commit: { sha: "6".repeat(40) },
              ahead_by: 1,
              behind_by: 1,
              total_commits: 1,
              commits: [{ sha: observedMainSha, parents: [{ sha: "6".repeat(40) }] }],
            },
      );
    }
    const controllerMainComparisonPrefix = `${prefix}/compare/${retainedControllerSha}...`;
    if (
      options.controllerSha !== undefined &&
      method === "GET" &&
      url.pathname.startsWith(controllerMainComparisonPrefix)
    ) {
      const observedMainSha = url.pathname.slice(controllerMainComparisonPrefix.length);
      const retained = options.controllerAncestorMainShas?.includes(observedMainSha) ?? false;
      return response(
        retained
          ? {
              status: "ahead",
              base_commit: { sha: retainedControllerSha },
              merge_base_commit: { sha: retainedControllerSha },
              ahead_by: 1,
              behind_by: 0,
              total_commits: Object.prototype.hasOwnProperty.call(
                options.controllerAncestorTotalCommitsByMainSha ?? {},
                observedMainSha,
              )
                ? options.controllerAncestorTotalCommitsByMainSha?.[observedMainSha]
                : 1,
              commits: [{ sha: observedMainSha, parents: [{ sha: retainedControllerSha }] }],
            }
          : {
              status: "diverged",
              base_commit: { sha: retainedControllerSha },
              merge_base_commit: { sha: "6".repeat(40) },
              ahead_by: 1,
              behind_by: 1,
              total_commits: 1,
              commits: [{ sha: observedMainSha, parents: [{ sha: "6".repeat(40) }] }],
            },
      );
    }
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}/reviews`)
      return response([review]);
    if (method === "GET" && url.pathname === `${prefix}/pulls/${pullNumber}/reviews/9001`)
      return response({
        ...review,
        user: options.reviewDetailReviewer ?? review.user,
      });
    if (method === "GET" && url.pathname === `${prefix}/actions/runs/${sourceCiRunId}`)
      return response(
        options.sourceRun ?? {
          id: sourceCiRunId,
          run_attempt: sourceCiRunAttempt,
          status: "completed",
          conclusion: "success",
          event: "push",
          path: RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
          head_sha: mergeSha,
          head_branch: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
          check_suite_id: sourceCiCheckSuiteId,
          html_url:
            `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
            `/actions/runs/${sourceCiRunId}`,
          repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
          head_repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
        },
      );
    const otherSourceRunMatch = url.pathname.match(
      new RegExp(`^${prefix}/actions/runs/([1-9][0-9]*)$`),
    );
    if (method === "GET" && otherSourceRunMatch) {
      const otherRun = options.otherSourceRuns?.[otherSourceRunMatch[1]];
      if (otherRun) return response(otherRun);
    }
    if (
      method === "GET" &&
      url.pathname === `${prefix}/actions/runs/${sourceCiRunId}/attempts/${sourceCiRunAttempt}/jobs`
    )
      return response({
        total_count: (options.sourceAttemptJobs ?? []).length,
        jobs:
          options.sourceAttemptJobs ??
          RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) =>
            sourceCiJob(name, index),
          ),
      });
    if (
      method === "GET" &&
      url.pathname ===
        `${prefix}/git/ref/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${retainedControllerSha}`
    ) {
      if (options.controllerRefSha === null)
        return response({ message: "missing controller ref" }, 404);
      return response({
        ref: `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${retainedControllerSha}`,
        object: {
          type: "commit",
          sha: options.controllerRefSha ?? retainedControllerSha,
        },
      });
    }
    if (
      method === "GET" &&
      url.pathname ===
        `${prefix}/releases/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${retainedControllerSha}`
    )
      return options.controllerRelease === null
        ? response({ message: "missing controller release" }, 404)
        : response(options.controllerRelease ?? releaseHeadRelease(retainedControllerSha));
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
            RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) =>
              sourceCiCheck(name, index),
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
  test("requires the workflow graph and dispatch ref to be the retained controller", async () => {
    const fixture = approvalFixture();
    await expect(
      verifyApprovedMerge({
        env: approvalEnv({ GITHUB_WORKFLOW_SHA: "9".repeat(40) }),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("workflow definition differs from release controller SHA");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv({ GITHUB_REF: "refs/heads/main" }),
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow("not running from the retained controller ref");
  });

  test("accepts a retained controller after the source on protected main ancestry", async () => {
    const retainedControllerSha = "4".repeat(40);
    const initialMainSha = "5".repeat(40);
    const terminalMainSha = "6".repeat(40);
    const fixture = approvalFixture({
      controllerSha: retainedControllerSha,
      controllerTreeSha: "7".repeat(40),
      initialMainSha,
      terminalMainSha,
      sourceAncestorMainShas: [retainedControllerSha, initialMainSha, terminalMainSha],
      controllerAncestorMainShas: [initialMainSha, terminalMainSha],
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv({
          GITHUB_REF:
            `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}` + retainedControllerSha,
          GITHUB_SHA: retainedControllerSha,
          GITHUB_WORKFLOW_SHA: retainedControllerSha,
          RELEASE_CONTROLLER_SHA: retainedControllerSha,
        }),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        controller: expect.objectContaining({
          sha: retainedControllerSha,
          treeSha: "7".repeat(40),
        }),
      }),
    );
  });

  test("rejects a retained controller outside the admitted source to protected main chain", async () => {
    const retainedControllerSha = "4".repeat(40);
    const initialMainSha = "5".repeat(40);
    const env = approvalEnv({
      GITHUB_REF:
        `refs/tags/${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}` + retainedControllerSha,
      GITHUB_SHA: retainedControllerSha,
      GITHUB_WORKFLOW_SHA: retainedControllerSha,
      RELEASE_CONTROLLER_SHA: retainedControllerSha,
    });
    await expect(
      verifyApprovedMerge({
        env,
        fetchImpl: approvalFixture({
          controllerSha: retainedControllerSha,
          initialMainSha,
          sourceAncestorMainShas: [initialMainSha],
        }).fetchImpl,
      }),
    ).rejects.toThrow("release controller is not ahead of the admitted source");

    await expect(
      verifyApprovedMerge({
        env,
        fetchImpl: approvalFixture({
          controllerSha: retainedControllerSha,
          initialMainSha,
          sourceAncestorMainShas: [retainedControllerSha, initialMainSha],
        }).fetchImpl,
      }),
    ).rejects.toThrow("initial release main is not ahead of the release controller");
  });

  test("requires immutable retained evidence for the workflow controller", async () => {
    const missing = approvalFixture({ controllerRefSha: null });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: missing.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("GitHub API GET");

    const mutable = approvalFixture({
      controllerRelease: {
        ...releaseHeadRelease(controllerSha),
        immutable: false,
      },
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: mutable.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("immutable");
  });

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
        controller: {
          sha: controllerSha,
          treeSha: baseTreeSha,
          release: expect.objectContaining({
            tagName: `${RELEASE_AUTOMATION_CONTRACT.releaseHeadTagPrefix}${controllerSha}`,
            immutable: true,
          }),
        },
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

  test("accepts an exact release source retained as a strict ancestor across both main fences", async () => {
    const initialMainSha = "4".repeat(40);
    const terminalMainSha = "5".repeat(40);
    const fixture = approvalFixture({
      initialMainSha,
      terminalMainSha,
      sourceAncestorMainShas: [initialMainSha, terminalMainSha],
    });

    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: fixture.fetchImpl,
        logger: { log() {} },
      }),
    ).resolves.toEqual(expect.objectContaining({ sourceSha: mergeSha }));
    expect(
      fixture.requests.filter((request) =>
        request.path.startsWith(
          `/repos/${RELEASE_AUTOMATION_CONTRACT.repository}/compare/${mergeSha}...`,
        ),
      ),
    ).toHaveLength(2);
  });

  test("rejects diverged main at either release-source fence", async () => {
    const movedMain = "4".repeat(40);
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ initialMainSha: movedMain }).fetchImpl,
      }),
    ).rejects.toThrow("initial release main is not ahead of the admitted source");

    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ terminalMainSha: movedMain }).fetchImpl,
      }),
    ).rejects.toThrow("terminal release main is not ahead of the admitted source");
  });

  test("rejects incomplete ancestry comparison at either release-source fence", async () => {
    const initialMainSha = "4".repeat(40);
    const terminalMainSha = "5".repeat(40);
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          initialMainSha,
          sourceAncestorMainShas: [initialMainSha],
          sourceAncestorTotalCommitsByMainSha: { [initialMainSha]: null },
        }).fetchImpl,
      }),
    ).rejects.toThrow("initial release main ancestry comparison is incomplete");

    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          terminalMainSha,
          sourceAncestorMainShas: [terminalMainSha],
          sourceAncestorTotalCommitsByMainSha: { [terminalMainSha]: 2 },
        }).fetchImpl,
      }),
    ).rejects.toThrow("terminal release main ancestry comparison is incomplete");
  });

  test("records merged-source identity instead of a GitHub review PASS", async () => {
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
          type: "merged-source",
          id: pullNumber,
        }),
      }),
    );
  });

  test("does not require a configured maintainer GitHub review", async () => {
    const fixture = approvalFixture({
      mergeMethod: "single",
      reviewState: "COMMENTED",
      author: RELEASE_AUTOMATION_CONTRACT.releaseApprovers[1],
      merger: RELEASE_AUTOMATION_CONTRACT.releaseApprovers[1],
      reviewer: RELEASE_AUTOMATION_CONTRACT.releaseApprovers[1],
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
          type: "merged-source",
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

  test("rejects tree, topology, and terminal-main drift", async () => {
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
          mergeMethod: "rebase",
          discontinuousCompare: true,
        }).fetchImpl,
      }),
    ).rejects.toThrow("discontinuity");
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({ terminalMainSha: "7".repeat(40) }).fetchImpl,
      }),
    ).rejects.toThrow("terminal release main is not ahead of the admitted source");
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
            ...sourceCiCheck(name, index),
            conclusion: index === 0 ? "failure" : "success",
          })),
        }).fetchImpl,
      }),
    ).rejects.toThrow("authoritative check run did not complete successfully");
  });

  test("accepts official failed-job retry history when the latest CI attempt succeeds", async () => {
    const latestChecks = RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) =>
      sourceCiCheck(name, index, { id: 7100 + index }),
    );
    const historicalChecks = RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) =>
      sourceCiCheck(name, index, {
        id: 7000 + index,
        conclusion: index === 0 ? "failure" : "success",
      }),
    );
    const fixture = approvalFixture({
      sourceChecks: latestChecks,
      historicalSourceChecks: historicalChecks,
      sourceRun: {
        id: sourceCiRunId,
        run_attempt: sourceCiRunAttempt,
        status: "completed",
        conclusion: "success",
        event: "push",
        path: RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
        head_sha: mergeSha,
        head_branch: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
        check_suite_id: sourceCiCheckSuiteId,
        html_url:
          `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
          `/actions/runs/${sourceCiRunId}`,
        repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
        head_repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
      },
      sourceAttemptJobs: RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) =>
        sourceCiJob(name, index, { id: 7100 + index }),
      ),
    });

    const result = await verifyApprovedMerge({
      env: approvalEnv(),
      fetchImpl: fixture.fetchImpl,
      logger: { log() {} },
    });

    expect(result.requiredSourceChecks).toEqual(
      RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) => ({
        name,
        appSlug: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.slug,
        appId: RELEASE_AUTOMATION_CONTRACT.githubActionsApp.id,
        workflowRunId: sourceCiRunId,
        workflowRunAttempt: sourceCiRunAttempt,
        workflowJobId: 7100 + index,
      })),
    );
  });

  test("rejects failed latest CI attempts", async () => {
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          sourceRun: {
            id: sourceCiRunId,
            run_attempt: sourceCiRunAttempt,
            status: "completed",
            conclusion: "failure",
            event: "push",
            path: RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
            head_sha: mergeSha,
            head_branch: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
            check_suite_id: sourceCiCheckSuiteId,
            html_url:
              `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
              `/actions/runs/${sourceCiRunId}`,
            repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
            head_repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
          },
        }).fetchImpl,
      }),
    ).rejects.toThrow("required source workflow did not complete successfully");
  });

  test("ignores same-name pull-request checks and binds the unique push CI run", async () => {
    const pullRequestRunId = 999999;
    const pullRequestCheckSuiteId = 999998;
    const pullRequestChecks = RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map(
      (name, index) => {
        const jobId = 8050 + index;
        return sourceCiCheck(name, 50 + index, {
          id: jobId,
          details_url:
            `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
            `/actions/runs/${pullRequestRunId}/job/${jobId}`,
          check_suite: { id: pullRequestCheckSuiteId },
        });
      },
    );
    const result = await verifyApprovedMerge({
      env: approvalEnv(),
      fetchImpl: approvalFixture({
        historicalSourceChecks: pullRequestChecks,
        otherSourceRuns: {
          [pullRequestRunId]: {
            id: pullRequestRunId,
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
            event: "pull_request",
            path: RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
            head_sha: mergeSha,
            head_branch: "main",
            check_suite_id: pullRequestCheckSuiteId,
            html_url:
              `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
              `/actions/runs/${pullRequestRunId}`,
            repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
            head_repository: {
              full_name: RELEASE_AUTOMATION_CONTRACT.repository,
            },
          },
        },
      }).fetchImpl,
      logger: { log() {} },
    });

    expect(
      result.requiredSourceChecks.every((check) => check.workflowRunId === sourceCiRunId),
    ).toBe(true);
  });

  test("rejects multiple push CI workflow runs on the source SHA", async () => {
    const duplicateRunId = 999999;
    const duplicateCheckSuiteId = 999998;
    const duplicateChecks = RELEASE_AUTOMATION_CONTRACT.checks.requiredSource.map((name, index) => {
      const jobId = 8050 + index;
      return sourceCiCheck(name, 50 + index, {
        id: jobId,
        details_url:
          `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
          `/actions/runs/${duplicateRunId}/job/${jobId}`,
        check_suite: { id: duplicateCheckSuiteId },
      });
    });
    await expect(
      verifyApprovedMerge({
        env: approvalEnv(),
        fetchImpl: approvalFixture({
          historicalSourceChecks: duplicateChecks,
          otherSourceRuns: {
            [duplicateRunId]: {
              id: duplicateRunId,
              run_attempt: 1,
              status: "completed",
              conclusion: "success",
              event: "push",
              path: RELEASE_AUTOMATION_CONTRACT.ciWorkflowPath,
              head_sha: mergeSha,
              head_branch: RELEASE_AUTOMATION_CONTRACT.defaultBranch,
              check_suite_id: duplicateCheckSuiteId,
              html_url:
                `${RELEASE_AUTOMATION_CONTRACT.serverUrl}/${RELEASE_AUTOMATION_CONTRACT.repository}` +
                `/actions/runs/${duplicateRunId}`,
              repository: { full_name: RELEASE_AUTOMATION_CONTRACT.repository },
              head_repository: {
                full_name: RELEASE_AUTOMATION_CONTRACT.repository,
              },
            },
          },
        }).fetchImpl,
      }),
    ).rejects.toThrow("required source checks do not identify exactly one push CI workflow run");
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
  const retainControllerText = readFileSync(retainControllerWorkflowPath, "utf8");
  const releaseSourceAdmissionText = readFileSync(releaseSourceAdmissionPath, "utf8");
  const releasePublicationAdmissionText = readFileSync(releasePublicationAdmissionPath, "utf8");
  const releaseAutomationText = readFileSync(releaseAutomationPath, "utf8");
  const release = Bun.YAML.parse(releaseText) as any;
  const ci = Bun.YAML.parse(ciText) as any;
  const seal = Bun.YAML.parse(sealText) as any;
  const retainController = Bun.YAML.parse(retainControllerText) as any;

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

  test("dispatches trusted main CI and preserves ordinary plus scheduled safety events", () => {
    const dispatch = release.jobs.version.steps.find(
      (step: any) => step.name === "Dispatch exact-head Version PR CI",
    );
    expect(dispatch.run).toContain("dispatch-version-ci");
    expect(release.jobs.version.if).toBe(
      "${{ github.event_name == 'push' && vars.VERSION_PR_ON_PUSH == 'true' }}",
    );
    expect(ci.on.push.branches).toEqual(["main", "production"]);
    expect(ci.on.pull_request).not.toBeUndefined();
    expect(ci.on.schedule).toEqual([{ cron: "0 3 * * 1" }]);
    expect(ci.on.workflow_dispatch.inputs).toEqual(
      expect.objectContaining({
        automation_pr_number: expect.objectContaining({ required: true }),
        automation_head_sha: expect.objectContaining({ required: true }),
        automation_base_sha: expect.objectContaining({ required: true }),
        source_release_run_id: expect.objectContaining({ required: true }),
        source_release_run_attempt: expect.objectContaining({ required: true }),
      }),
    );
    expect(release.on.schedule).toBeUndefined();
    expect(ci.jobs.deployment.if).toBe(
      "${{ always() && needs.plan.result == 'success' && needs.plan.outputs.mode != 'docs' && (github.event_name != 'workflow_dispatch' || needs.automation-admission.result == 'success') }}",
    );
    expect(ci.jobs.images.if).toBe(
      "${{ always() && needs.plan.result == 'success' && needs.plan.outputs.bake_images == 'true' && (github.event_name != 'workflow_dispatch' || needs.automation-admission.result == 'success') }}",
    );
    const imageLeaves = [
      "api-image",
      "worker-web-images",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
      "relay-image",
      "sandbox-image",
    ];
    for (const jobName of [
      "worker-web-images",
      "artifact-outbox-dispatcher-image",
      "relay-image",
    ]) {
      expect(ci.jobs[jobName].if).toBe(ci.jobs.images.if);
    }
    for (const jobName of ["api-image", "artifact-materializer-image", "sandbox-image"]) {
      expect(ci.jobs[jobName].if).toContain("needs.plan.outputs.bake_images == 'true'");
      expect(ci.jobs[jobName].if).toContain("needs.artifact-runtime.result == 'success'");
    }
    const imageSteps = imageLeaves.flatMap((jobName) =>
      ci.jobs[jobName].steps.filter((candidate: any) => candidate.with?.push),
    );
    expect(imageSteps.map((step: any) => step.name)).toEqual([
      "Build API image",
      "Build worker image",
      "Build web image",
      "Build artifact materializer image",
      "Build artifact outbox dispatcher image",
      "Build relay image",
      "Build headless sandbox image",
    ]);
    for (const imageStep of imageSteps)
      expect(imageStep.with.push).toBe(
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
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
    const exactSelectorJobs = new Set([
      "deployment",
      "api-image",
      "worker-web-images",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
      "relay-image",
      "sandbox-image",
      "images",
    ]);
    for (const jobName of [
      "plan",
      "source-contracts",
      "unit-shards",
      "integration-shards",
      "e2e-shards",
      "test-suite",
      "browser-acceptance",
      "package-contracts",
      "test",
      "deployment",
      "api-image",
      "worker-web-images",
      "artifact-materializer-image",
      "artifact-outbox-dispatcher-image",
      "relay-image",
      "sandbox-image",
      "images",
    ]) {
      const checkout = ci.jobs[jobName].steps.find(
        (step: any) => step.uses === "actions/checkout@v6",
      );
      expect(checkout.with.ref).toBe(
        exactSelectorJobs.has(jobName)
          ? "${{ github.event_name == 'workflow_dispatch' && inputs.automation_head_sha || github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}"
          : "${{ github.event_name == 'workflow_dispatch' && inputs.automation_head_sha || github.event.pull_request.head.sha || github.sha }}",
      );
      expect(checkout.with["persist-credentials"]).toBe(false);
    }
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

  test("shards selected work while preserving current acceptance and full-mode safety gates", () => {
    const plan = ci.jobs.plan;
    expect(plan.name).toBe("Explain change impact");
    expect(plan.needs).toBe("automation-admission");
    expect(plan.if).toBe(
      "${{ always() && (github.event_name != 'workflow_dispatch' || needs.automation-admission.result == 'success') }}",
    );
    expect(plan.outputs).toEqual(
      expect.objectContaining({
        mode: "${{ steps.plan.outputs.mode }}",
        unit_count: "${{ steps.plan.outputs.unit_count }}",
        integration_count: "${{ steps.plan.outputs.integration_count }}",
        e2e_count: "${{ steps.plan.outputs.e2e_count }}",
        browser_lane_count: "${{ steps.plan.outputs.browser_lane_count }}",
        artifact_runtime_required: "${{ steps.plan.outputs.artifact_runtime_required }}",
        build_count: "${{ steps.plan.outputs.build_count }}",
        unit_matrix: "${{ steps.plan.outputs.unit_matrix }}",
        integration_matrix: "${{ steps.plan.outputs.integration_matrix }}",
        e2e_matrix: "${{ steps.plan.outputs.e2e_matrix }}",
        browser_lane_matrix: "${{ steps.plan.outputs.browser_lane_matrix }}",
      }),
    );
    const planScript = plan.steps.find((step: any) => step.id === "plan").run;
    expect(planScript).toContain('bun scripts/ci/impact.ts --base "$BASE_SHA" --head "$HEAD_SHA"');
    expect(planScript).toContain("bun scripts/ci/impact.ts --full --output impact-plan.json");
    expect(planScript).toContain(
      "unit_matrix=$(matrix \"$(jq '.unitTests | length' impact-plan.json)\" 6)",
    );

    const source = ci.jobs["source-contracts"];
    expect(source.needs).toEqual(["automation-admission", "plan"]);
    const sourceInstallIndex = source.steps.findIndex(
      (step: any) => step.name === "Install dependencies",
    );
    const sourceInstall = source.steps[sourceInstallIndex];
    expect(sourceInstall.run.trim().split("\n")).toEqual([
      "bun install --frozen-lockfile --ignore-scripts",
      "bun scripts/workflow-execution-graph.ts --git-tree 'HEAD^{tree}'",
    ]);
    expect(source.steps.slice(0, sourceInstallIndex).filter((step: any) => step.run)).toEqual([]);
    expect(source.steps.filter((step: any) => step.run)[0]?.name).toBe("Install dependencies");
    for (const stepName of [
      "Validate changeset release plan",
      "Profile impacted TypeScript 7 projects",
      "Run exactly the explained source guards",
      "Impact, resource, and profiling contracts",
      "Upload source-contract resource profiles",
    ]) {
      expect(source.steps.some((step: any) => step.name === stepName)).toBe(true);
    }
    const releasePlan = source.steps.find(
      (step: any) => step.name === "Validate changeset release plan",
    ).run;
    expect(releasePlan).toContain('version_base_ref="$AUTOMATION_BASE_SHA"');
    expect(releasePlan).toContain('git worktree add --detach "$expected" "$version_base_ref"');
    expect(releasePlan).not.toContain(
      '[ "$(git rev-parse refs/remotes/origin/main)" = "$AUTOMATION_BASE_SHA" ]',
    );
    expect(
      source.steps.find((step: any) => step.name === "Profile impacted TypeScript 7 projects").run,
    ).toContain("scripts/ci/run-typecheck-plan.ts");
    expect(
      source.steps.find((step: any) => step.name === "Run exactly the explained source guards").run,
    ).toContain("scripts/ci/run-guards-plan.ts");

    for (const jobName of [
      "source-contracts",
      "unit-shards",
      "integration-shards",
      "e2e-shards",
      "test-suite",
      "browser-acceptance",
      "package-contracts",
      "deployment",
    ]) {
      const setup = ci.jobs[jobName].steps.find((step: any) => step.name === "Set up Bun");
      expect(setup.with).toEqual({ "bun-version-file": ".bun-version" });
    }

    const shards = ci.jobs["unit-shards"];
    expect(shards.name).toBe("Unit tests (shard ${{ matrix.number }}/${{ matrix.total }})");
    expect(shards.needs).toEqual(["automation-admission", "plan"]);
    expect(shards.if).not.toContain("github.event_name == 'pull_request'");
    expect(shards.if).toContain("needs.plan.outputs.unit_count != '0'");
    expect(shards.strategy).toEqual({
      "fail-fast": true,
      matrix: { include: "${{ fromJSON(needs.plan.outputs.unit_matrix) }}" },
    });
    const shardStep = shards.steps.find((step: any) => step.name === "Unit test shard");
    expect(shardStep.env).toEqual({ OPENGENI_REQUIRE_REAL_DB: "1" });
    expect(shardStep.run).toContain("scripts/ci/profile-command.ts");
    expect(shardStep.run).toContain("scripts/ci/run-unit-shard.ts");

    const integration = ci.jobs["integration-shards"];
    expect(integration.strategy.matrix.include).toBe(
      "${{ fromJSON(needs.plan.outputs.integration_matrix) }}",
    );
    expect(
      integration.steps.find((step: any) => step.name.startsWith("Run real PostgreSQL")).run,
    ).toContain("scripts/ci/run-test-shard.ts --plan impact-plan.json --tier integration");

    const e2e = ci.jobs["e2e-shards"];
    expect(e2e.strategy.matrix.include).toBe("${{ fromJSON(needs.plan.outputs.e2e_matrix) }}");
    expect(e2e.if).toContain("needs.plan.outputs.e2e_count != '0'");
    expect(
      e2e.steps.find((step: any) => step.name === "Run exactly the impacted E2E tests").run,
    ).toContain("scripts/ci/run-test-shard.ts --plan impact-plan.json --tier e2e");

    for (const jobName of ["e2e-shards", "browser-acceptance", "package-contracts"]) {
      const aptStabilizer = ci.jobs[jobName].steps.find(
        (step: any) => step.name === "Stabilize Ubuntu package downloads",
      );
      expect(aptStabilizer.run).toContain(
        "https://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu",
      );
      expect(aptStabilizer.run).toContain('Acquire::Retries "3";');
      expect(aptStabilizer.run).toContain('Acquire::http::Timeout "30";');
      expect(aptStabilizer.run).toContain('Acquire::https::Timeout "30";');
    }

    const expectedGateNames = {
      "test-suite": [
        "React warning-free test gate",
        "Real workspace capture acceptance",
        "Recovery integration regressions",
      ],
      "browser-acceptance": [
        "Stabilize Ubuntu package downloads",
        "Install pinned lane browser runtimes",
        "Browser account session-set acceptance",
        "Editable artifact browser acceptance",
        "Install pinned artifact native toolchain",
        "Editable artifact full-stack browser acceptance",
        "Codex quota and entitlement browser acceptance",
        "Queue surface browser acceptance",
        "Long user-message disclosure browser acceptance",
        "Timeline pagination browser regressions",
        "Public realtime SDK demo browser acceptance",
        "Session pin browser acceptance",
        "Responsive knowledge surfaces browser acceptance",
        "Organization onboarding lifecycle acceptance",
        "Workbench browser acceptance",
        "Upload browser account acceptance evidence",
        "Upload session pin visual evidence",
        "Upload Codex quota visual evidence",
        "Upload responsive knowledge-surface evidence",
        "Upload organization onboarding evidence",
        "Upload workbench visual evidence",
        "Upload editable artifact visual evidence",
      ],
      "package-contracts": [
        "Install pinned artifact-kernel build toolchain",
        "Production native artifact contracts",
        "Build client packages (contracts + SDK + React)",
        "Reproduce committed modality WASM packages from clean Rust sources",
        "Stabilize Ubuntu package downloads",
        "Install Chromium for packed WASM package proof",
        "Packed SDK Worker and modality WASM packages",
        "Publish closure guard",
        "Clean published consumer",
        "Runtime embedding consumer",
        "Portable ogtool package",
        "Build React demo harness",
        "Web bundle budget",
      ],
    } as const;
    for (const [jobName, gateNames] of Object.entries(expectedGateNames)) {
      expect(ci.jobs[jobName].needs).toEqual(["automation-admission", "plan"]);
      for (const gateName of gateNames) {
        expect(ci.jobs[jobName].steps.some((step: any) => step.name === gateName)).toBe(true);
      }
    }
    expect(
      ci.jobs["package-contracts"].steps.find(
        (step: any) => step.name === "Build client packages (contracts + SDK + React)",
      ).run,
    ).toContain("scripts/ci/run-build-plan.ts");

    const browser = ci.jobs["browser-acceptance"];
    const expectedBrowserGates = new Map([
      [
        "Browser account session-set acceptance",
        {
          lane: "accounts",
          run: "bun test --max-concurrency=1 --timeout 180000 \\\n  ./packages/db/test/migration-0356-managed-auth-session-sets.test.ts \\\n  ./apps/api/test/managed-auth-session-sets.integration.test.ts\nbun scripts/run-browser-e2e.ts \\\n  ./test/e2e/browser-accounts-acceptance.e2e.ts\n",
        },
      ],
      [
        "Codex quota and entitlement browser acceptance",
        {
          lane: "interaction",
          run: "bun scripts/run-browser-e2e.ts ./test/e2e/codex-overview.e2e.ts",
        },
      ],
      [
        "Queue surface browser acceptance",
        {
          lane: "interaction",
          run: "bun scripts/run-browser-e2e.ts ./test/e2e/queue-surface.browser.e2e.ts",
        },
      ],
      [
        "Long user-message disclosure browser acceptance",
        {
          lane: "interaction",
          run: "bun scripts/run-browser-e2e.ts ./test/e2e/user-message-disclosure.browser.e2e.ts",
        },
      ],
      [
        "Timeline pagination browser regressions",
        {
          lane: "interaction",
          run: "bun scripts/run-browser-e2e.ts ./test/e2e/timeline-scroll.browser.e2e.ts",
        },
      ],
      [
        "Public realtime SDK demo browser acceptance",
        {
          lane: "interaction",
          run: "bun scripts/run-browser-e2e.ts ./test/e2e/realtime-demo.browser.e2e.ts",
        },
      ],
      [
        "Session pin browser acceptance",
        {
          lane: "knowledge",
          run: "bun test --max-concurrency=1 --timeout 180000 ./test/e2e/session-pins.browser.e2e.ts",
        },
      ],
      [
        "Responsive knowledge surfaces browser acceptance",
        {
          lane: "knowledge",
          run: "bun test --max-concurrency=1 --timeout 300000 ./test/e2e/knowledge-surfaces.browser.e2e.ts",
        },
      ],
      [
        "Organization onboarding lifecycle acceptance",
        {
          lane: "onboarding",
          run: "bun scripts/run-browser-e2e.ts ./test/e2e/organization-onboarding-acceptance.e2e.ts",
        },
      ],
      [
        "Workbench browser acceptance",
        {
          lane: "workbench",
          run: "bun test --max-concurrency=1 --timeout 180000 ./test/e2e/workbench.browser.e2e.ts",
        },
      ],
    ]);
    const hasCompleteBrowserLaneContract = (candidate: any) =>
      candidate.name === "Browser and visual acceptance (${{ matrix.lane }})" &&
      candidate.strategy?.["fail-fast"] === false &&
      candidate.strategy?.matrix?.include ===
        "${{ fromJSON(needs.plan.outputs.browser_lane_matrix) }}" &&
      [...expectedBrowserGates].every(([stepName, expected]) => {
        const step = candidate.steps.find((entry: any) => entry.name === stepName);
        return (
          step?.if === `\${{ matrix.lane == '${expected.lane}' }}` && step.run === expected.run
        );
      });
    expect(hasCompleteBrowserLaneContract(browser)).toBe(true);
    const missingWorkbenchLane = structuredClone(browser);
    missingWorkbenchLane.strategy.matrix.include = "${{ fromJSON(needs.plan.outputs.other) }}";
    expect(hasCompleteBrowserLaneContract(missingWorkbenchLane)).toBe(false);
    const misroutedWorkbenchGate = structuredClone(browser);
    misroutedWorkbenchGate.steps.find(
      (step: any) => step.name === "Workbench browser acceptance",
    ).if = "${{ matrix.lane == 'knowledge' }}";
    expect(hasCompleteBrowserLaneContract(misroutedWorkbenchGate)).toBe(false);

    // Browser runtimes install through the shared composite action so the
    // download is cached and every attempt is bounded by a hard wall clock. An
    // unbounded install can wedge for the 360-minute job default while holding
    // a runner, which starves every other pull request in the account.
    const browserInstalls = browser.steps.filter((step: any) =>
      String(step.uses ?? "").includes("playwright-browsers"),
    );
    expect(browserInstalls).toEqual([
      {
        name: "Install pinned lane browser runtimes",
        uses: "./.github/actions/playwright-browsers",
        "timeout-minutes": 17,
        with: {
          browsers:
            "${{ matrix.lane == 'workbench' && 'chromium firefox webkit' || matrix.lane == 'accounts' && matrix.engine || 'chromium' }}",
        },
      },
    ]);
    expect(
      browser.steps.filter((step: any) => String(step.run ?? "").includes("playwright install")),
    ).toEqual([]);
    for (const stepName of [
      "Editable artifact browser acceptance",
      "Install pinned artifact native toolchain",
      "Editable artifact full-stack browser acceptance",
    ]) {
      expect(browser.steps.find((step: any) => step.name === stepName).if).toBe(
        "${{ matrix.lane == 'workbench' }}",
      );
    }
    expect(
      browser.steps.find((step: any) => step.name === "Upload editable artifact visual evidence")
        .if,
    ).toBe(
      "${{ always() && matrix.lane == 'workbench' && (steps.editable_artifact_browser.outcome == 'success' || steps.editable_artifact_browser.outcome == 'failure') }}",
    );
    // Supersedes the former "browser lanes never cache ms-playwright" lock.
    // The browser cache now lives one level down in the shared composite
    // action, so assert it there rather than asserting its absence here - an
    // absence check against this job would silently guard nothing.
    expect(
      browser.steps.some(
        (step: any) =>
          String(step.uses ?? "").startsWith("actions/cache@") &&
          JSON.stringify(step.with ?? {}).includes("ms-playwright"),
      ),
    ).toBe(false);
    const browserAction = readFileSync(
      join(root, ".github/actions/playwright-browsers/action.yml"),
      "utf8",
    );
    expect(browserAction).toContain("path: ~/.cache/ms-playwright");
    expect(
      browser.steps.find((step: any) => step.name === "Browser account session-set acceptance").env,
    ).toEqual({
      OPENGENI_REQUIRE_REAL_DB: "1",
      OPENGENI_ACCOUNT_BROWSER_ENGINE: "${{ matrix.engine }}",
      OPENGENI_ACCOUNT_EVIDENCE_DIR: "/tmp/opengeni-account-acceptance",
    });
    expect(
      browser.steps.find(
        (step: any) => step.name === "Codex quota and entitlement browser acceptance",
      ).env,
    ).toEqual({
      OPENGENI_REQUIRE_REAL_DB: "1",
      OPENGENI_CODEX_QUOTA_EVIDENCE_DIR: "/tmp/codex-quota-evidence",
    });
    for (const stepName of [
      "Session pin browser acceptance",
      "Responsive knowledge surfaces browser acceptance",
    ])
      expect(browser.steps.find((step: any) => step.name === stepName).env).toEqual({
        OPENGENI_REQUIRE_REAL_DB: "1",
      });
    expect(
      browser.steps.find(
        (step: any) => step.name === "Organization onboarding lifecycle acceptance",
      ).env,
    ).toEqual({
      OPENGENI_REQUIRE_REAL_DB: "1",
      OPENGENI_ONBOARDING_EVIDENCE_DIR: "/tmp/opengeni-onboarding-evidence",
    });

    const expectedEvidence = {
      "Upload browser account acceptance evidence": {
        if: "${{ matrix.lane == 'accounts' && steps.browser_accounts.outcome == 'success' }}",
        name: "browser-account-acceptance-${{ matrix.engine }}",
        path: ["/tmp/opengeni-account-acceptance"],
      },
      "Upload session pin visual evidence": {
        if: "${{ always() && matrix.lane == 'knowledge' && (steps.session_pin_browser.outcome == 'success' || steps.session_pin_browser.outcome == 'failure') }}",
        name: "sessionpin-session-pin-visual-evidence",
        path: [
          "/tmp/sessionpin-session-pin-desktop-light.png",
          "/tmp/sessionpin-session-pin-desktop-dark.png",
          "/tmp/sessionpin-session-pin-mobile-light.png",
          "/tmp/sessionpin-session-pin-mobile-dark.png",
          "/tmp/sessionpin-session-pin-mobile-375-light.png",
          "/tmp/sessionpin-session-pin-mobile-375-dark.png",
        ],
      },
      "Upload Codex quota visual evidence": {
        if: "${{ always() && matrix.lane == 'interaction' }}",
        name: "codex-quota-codex-quota-entitlement-visual-evidence",
        path: [
          "/tmp/codex-quota-evidence/codex-quota-desktop-light.png",
          "/tmp/codex-quota-evidence/codex-quota-desktop-dark.png",
          "/tmp/codex-quota-evidence/codex-quota-mobile-light.png",
          "/tmp/codex-quota-evidence/codex-quota-mobile-dark.png",
        ],
      },
      "Upload responsive knowledge-surface evidence": {
        if: "${{ always() && matrix.lane == 'knowledge' }}",
        name: "responsive-knowledge-surface-evidence",
        path: [
          "/tmp/knowledge-surfaces-320-light-memory.png",
          "/tmp/knowledge-surfaces-320-dark-memory.png",
          "/tmp/knowledge-surfaces-375-light-variable-sets.png",
          "/tmp/knowledge-surfaces-375-dark-variable-sets.png",
          "/tmp/knowledge-surfaces-768-light-documents.png",
          "/tmp/knowledge-surfaces-768-dark-documents.png",
          "/tmp/knowledge-surfaces-desktop-light-memory.png",
          "/tmp/knowledge-surfaces-desktop-dark-memory.png",
          "/tmp/agent-knowledge-320-light-overview.png",
          "/tmp/agent-knowledge-375-dark-overview.png",
          "/tmp/agent-knowledge-768-light-overview.png",
          "/tmp/agent-knowledge-desktop-dark-overview.png",
        ],
      },
      "Upload workbench visual evidence": {
        if: "${{ always() && matrix.lane == 'workbench' && (steps.workbench_browser.outcome == 'success' || steps.workbench_browser.outcome == 'failure') }}",
        name: "workbench-visual-evidence",
        path: [
          "/tmp/workbench-mobile-dark-dense.png",
          "/tmp/workbench-tablet-light-offline.png",
          "/tmp/workbench-desktop-dark-changes.png",
          "/tmp/workbench-desktop-light-files.png",
        ],
      },
      "Upload organization onboarding evidence": {
        if: "${{ always() && matrix.lane == 'onboarding' && (steps.organization_onboarding.outcome == 'success' || steps.organization_onboarding.outcome == 'failure') }}",
        name: "organization-onboarding-acceptance-evidence",
        path: [
          "/tmp/opengeni-onboarding-evidence/organization-onboarding-evidence.json",
          "/tmp/opengeni-onboarding-evidence/onboarding-owner-desktop-1440.png",
          "/tmp/opengeni-onboarding-evidence/onboarding-setup-mobile-390.png",
          "/tmp/opengeni-onboarding-evidence/onboarding-registered-mobile-320.png",
        ],
      },
    } as const;
    for (const [stepName, expected] of Object.entries(expectedEvidence)) {
      const upload = browser.steps.find((step: any) => step.name === stepName);
      expect(upload.uses).toBe("actions/upload-artifact@v7.0.1");
      expect(upload.if).toBe(expected.if);
      expect(upload.with.name).toBe(expected.name);
      expect(upload.with["if-no-files-found"]).toBe("error");
      expect(upload.with["retention-days"]).toBe(14);
      expect(upload.with.path.trim().split("\n")).toEqual(expected.path);
    }

    const aggregate = ci.jobs.test;
    expect(aggregate.name).toBe("Typecheck and unit tests");
    expect(aggregate.needs).toEqual([
      "plan",
      "source-contracts",
      "unit-shards",
      "integration-shards",
      "e2e-shards",
      "test-suite",
      "browser-acceptance",
      "package-contracts",
      "deployment",
      "artifact-runtime",
      "images",
    ]);
    expect(aggregate.if).toBe("${{ always() }}");
    expect(aggregate.permissions ?? ci.permissions).toEqual({
      contents: "read",
    });
    expect(aggregate.steps.some((step: any) => step.env?.GITHUB_TOKEN)).toBe(false);
    expect(
      aggregate.steps.find(
        (step: any) =>
          step.name === "Require successful impact planning before candidate execution",
      ).run,
    ).toBe('test "$PLAN_RESULT" = "success"');
    const requireLanes = aggregate.steps.find(
      (step: any) => step.name === "Require every split CI lane",
    );
    expect(requireLanes.env).toEqual({
      RESULTS: "${{ toJSON(needs) }}",
      EVENT_NAME: "${{ github.event_name }}",
      MODE: "${{ needs.plan.outputs.mode }}",
      UNIT_COUNT: "${{ needs.plan.outputs.unit_count }}",
      INTEGRATION_COUNT: "${{ needs.plan.outputs.integration_count }}",
      E2E_COUNT: "${{ needs.plan.outputs.e2e_count }}",
      BROWSER_LANE_COUNT: "${{ needs.plan.outputs.browser_lane_count }}",
      ARTIFACT_RUNTIME_REQUIRED: "${{ needs.plan.outputs.artifact_runtime_required }}",
      BAKE_IMAGES: "${{ needs.plan.outputs.bake_images }}",
      BUILD_COUNT: "${{ needs.plan.outputs.build_count }}",
    });
    expect(requireLanes.run).toContain("scripts/ci/required-results.jq");
    expect(ci.jobs["automation-report"].needs).toEqual([
      "automation-admission",
      "test",
      "deployment",
      "images",
    ]);
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

  test("retains only exact current main as post-source workflow authority", () => {
    expect(retainController.on.workflow_dispatch.inputs).toEqual({
      controller_sha: expect.objectContaining({ required: true }),
    });
    expect(retainController.permissions).toEqual({ contents: "read" });
    expect(retainController.jobs.retain.permissions).toEqual({ contents: "write" });
    expect(retainController.jobs.retain.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    expect(retainControllerText).toContain("retain-release-controller");
    expect(retainControllerText).not.toContain("pull_request_target");
    expect(retainControllerText).not.toContain("pull-requests: write");
  });

  test("binds explicit source-admission and aggregate reports to the exact head", () => {
    expect(ciText).toContain("begin-version-checks");
    expect(ciText).toContain("admit-version-ci");
    expect(ciText).toContain("complete-version-check");
    expect(ciText).toContain("AUTOMATION_CHECK_KIND: source-admission");
    expect(ciText).toContain("AUTOMATION_CHECK_KIND: automation-ci");
    expect(releaseAutomationText).toContain("releaseHeadTagPrefix");
    expect(releaseSourceAdmissionText).toContain("verify-approved-merge");
  });

  test("runs final publication behind the historical retained-controller gate", () => {
    expect(release.on.workflow_dispatch.inputs.controller_sha).toEqual(
      expect.objectContaining({ required: true }),
    );
    expect(release.jobs.admission).toEqual(
      expect.objectContaining({
        uses: "./.github/workflows/release-publication-admission.yml",
        with: {
          source_sha: "${{ inputs.source_sha }}",
          controller_sha: "${{ inputs.controller_sha }}",
          candidate_run_id: "${{ inputs.candidate_run_id }}",
          acceptance_run_id: "${{ inputs.acceptance_run_id }}",
        },
        permissions: { actions: "read", contents: "read" },
      }),
    );
    expect(release.jobs.publish.needs).toBe("admission");
    expect(releasePublicationAdmissionText).toContain("ref: ${{ github.sha }}");
    expect(releasePublicationAdmissionText).toContain(
      'git -C .release/source merge-base --is-ancestor "$SOURCE_SHA" origin/production',
    );
    expect(releasePublicationAdmissionText).toContain("--kind candidate");
    expect(releasePublicationAdmissionText).toContain("--kind acceptance");
    expect(releasePublicationAdmissionText).toContain('--controller-sha "$CONTROLLER_SHA"');
    expect(releasePublicationAdmissionText).not.toContain("verify-approved-merge");
    expect(releaseText).toContain("uses: ./.release/controller/.github/actions/public-oci-login");
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
