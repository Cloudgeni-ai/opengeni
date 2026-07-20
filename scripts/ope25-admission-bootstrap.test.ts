import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT,
  ManualInterventionError,
  REVIEWED_PREDECESSOR_BLOBS,
  SOURCE_PREDECESSOR_CHAIN,
  TEMPORARY_PATHS,
  assertTemporaryBaseTree,
  inspectSourceIdentity,
  runBootstrap,
} from "./ope25-admission-bootstrap.mjs";

const repositoryRoot = join(import.meta.dir, "..");
const workflowPath = join(repositoryRoot, CONTRACT.workflowPath);
const helperPath = join(repositoryRoot, CONTRACT.helperPath);
const baseSha = "b".repeat(40);
const finalCandidateSha = "c".repeat(40);
const fifthCandidateSha = "4".repeat(40);
const headSha = "e".repeat(40);
const temporaryTreeSha = "f".repeat(40);
const readmeBlobSha = "1".repeat(40);
const movedHeadSha = "a".repeat(40);

const oldRevision = Object.freeze({
  headBranch: "ope25-admission-governance",
  marker: "ope25-admission-governance-pr:v1",
  title: "chore: restore exact OPE-25 admission tree",
});

function context(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_ACTOR: CONTRACT.dispatcherLogin,
    GITHUB_ACTOR_ID: CONTRACT.dispatcherId,
    GITHUB_API_URL: CONTRACT.apiUrl,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: `refs/heads/${CONTRACT.defaultBranch}`,
    GITHUB_REF_NAME: CONTRACT.defaultBranch,
    GITHUB_REPOSITORY: CONTRACT.repository,
    GITHUB_SERVER_URL: CONTRACT.serverUrl,
    GITHUB_SHA: baseSha,
    GITHUB_TOKEN: "test-token",
    GITHUB_TRIGGERING_ACTOR: CONTRACT.dispatcherLogin,
    GITHUB_WORKFLOW_REF: `${CONTRACT.repository}/${CONTRACT.workflowPath}@refs/heads/${CONTRACT.defaultBranch}`,
    GITHUB_WORKFLOW_SHA: baseSha,
    OPENGENI_BOOTSTRAP_ACTION: "open_exact_governance_pr",
    ...overrides,
  };
}

type PullRequest = Record<string, any>;
type CreatedMismatch = "author" | "base" | "body" | "files" | "head";

type FixtureOptions = {
  baseFirstParent?: string;
  baseSecondParent?: string;
  baseTree?: string;
  bootstrapAuthor?: string;
  bootstrapBaseSha?: string;
  bootstrapCommitCount?: number;
  bootstrapHeadRef?: string;
  bootstrapHeadRepo?: string;
  bootstrapHeadSha?: string;
  bootstrapMergeSha?: string;
  cleanupFailure?: "patch" | "readback";
  closedCurrentEquivalent?: boolean;
  finalParent?: string;
  finalTree?: string;
  createdMismatch?: CreatedMismatch;
  headParent?: string;
  headTree?: string;
  historicalV1?: boolean;
  initialConflict?: boolean;
  moveHeadAfterCreatedTerminalList?: boolean;
  moveHeadAfterPost?: boolean;
  postCompetingEquivalent?: boolean;
  predecessorBlobOverrides?: Record<string, string>;
  predecessorParent?: string;
  predecessorTree?: string;
};

function fixture(options: FixtureOptions = {}) {
  let postCount = 0;
  let patchCount = 0;
  let mutationCount = 0;
  let requestCount = 0;
  let postedBody: Record<string, any> | undefined;
  let createdState = "open";
  let currentHeadSha = headSha;
  let existingCompetitorAfterDetailArmed = false;
  let existingCompetitorInjected = false;
  let existingTerminalRefMovementArmed = false;
  let createdTerminalRefMovementInjected = false;
  let headRefReadsAfterPost = 0;
  let pullListCallsAfterTerminalMovementArm = 0;
  const patchedNumbers: number[] = [];

  const originalTree = {
    sha: CONTRACT.originalTreeSha,
    truncated: false,
    tree: [{ path: "README.md", mode: "100644", type: "blob", sha: readmeBlobSha }],
  };
  const predecessorTree = {
    sha: CONTRACT.reviewedPredecessorTreeSha,
    truncated: false,
    tree: [
      ...originalTree.tree,
      ...TEMPORARY_PATHS.map((path) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: options.predecessorBlobOverrides?.[path] ?? REVIEWED_PREDECESSOR_BLOBS[path],
      })),
    ],
  };
  const temporaryTree = {
    sha: temporaryTreeSha,
    truncated: false,
    tree: [
      ...originalTree.tree,
      ...TEMPORARY_PATHS.map((path, index) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: String(index + 5).repeat(40),
      })),
    ],
  };

  function bootstrapPullRequest(): PullRequest {
    return {
      number: CONTRACT.bootstrapPullRequestNumber,
      title: CONTRACT.bootstrapTitle,
      state: "closed",
      merged: true,
      merged_at: "2026-07-20T16:00:00Z",
      merge_commit_sha: options.bootstrapMergeSha ?? baseSha,
      user: { login: options.bootstrapAuthor ?? CONTRACT.dispatcherLogin, type: "User" },
      merged_by: { login: CONTRACT.dispatcherLogin, type: "User" },
      base: {
        ref: CONTRACT.defaultBranch,
        sha: options.bootstrapBaseSha ?? CONTRACT.originalMainSha,
        repo: { full_name: CONTRACT.repository },
      },
      head: {
        ref: options.bootstrapHeadRef ?? CONTRACT.bootstrapHeadBranch,
        sha: options.bootstrapHeadSha ?? finalCandidateSha,
        repo: { full_name: options.bootstrapHeadRepo ?? CONTRACT.repository },
      },
      commits: options.bootstrapCommitCount ?? CONTRACT.bootstrapCommitCount,
      changed_files: TEMPORARY_PATHS.length,
    };
  }

  const pulls: PullRequest[] = [bootstrapPullRequest()];
  if (options.historicalV1) {
    pulls.push({
      number: 8,
      title: oldRevision.title,
      body: `<!-- ${oldRevision.marker} -->`,
      state: "closed",
      draft: true,
      user: { login: "github-actions[bot]", type: "Bot" },
      base: { ref: CONTRACT.defaultBranch, sha: baseSha },
      head: { ref: oldRevision.headBranch, sha: headSha },
    });
  }
  if (options.initialConflict || options.closedCurrentEquivalent) {
    pulls.push({
      number: 9,
      title: CONTRACT.title,
      body: `<!-- ${CONTRACT.marker} -->`,
      state: options.closedCurrentEquivalent ? "closed" : "open",
      draft: true,
      user: { login: "somebody-else", type: "User" },
      base: {
        ref: CONTRACT.defaultBranch,
        sha: baseSha,
        repo: { full_name: CONTRACT.repository },
      },
      head: {
        ref: CONTRACT.headBranch,
        sha: headSha,
        repo: { full_name: CONTRACT.repository },
      },
    });
  }

  function createdDetail(): PullRequest {
    const createdPull: PullRequest = {
      number: 1,
      title: postedBody?.title,
      body: postedBody?.body,
      state: createdState,
      draft: true,
      merged: false,
      user: { login: "github-actions[bot]", type: "Bot" },
      base: {
        ref: CONTRACT.defaultBranch,
        sha: baseSha,
        repo: { full_name: CONTRACT.repository },
      },
      head: {
        ref: CONTRACT.headBranch,
        sha: currentHeadSha,
        repo: { full_name: CONTRACT.repository },
      },
      maintainer_can_modify: false,
      commits: 1,
      changed_files: TEMPORARY_PATHS.length,
    };
    if (options.createdMismatch === "author") {
      createdPull.user = { login: "not-github-actions", type: "User" };
    } else if (options.createdMismatch === "base") {
      createdPull.base = { ...createdPull.base, sha: "7".repeat(40) };
    } else if (options.createdMismatch === "body") {
      createdPull.body = `${createdPull.body}\nchanged`;
    } else if (options.createdMismatch === "head") {
      createdPull.head = { ...createdPull.head, sha: movedHeadSha };
    }
    return createdPull;
  }

  function detail(number: number): PullRequest {
    if (number === CONTRACT.bootstrapPullRequestNumber) return bootstrapPullRequest();
    if (number === 1) return createdDetail();
    const found = pulls.find((pull) => pull.number === number);
    if (found) return found;
    throw new Error(`missing fixture pull request #${number}`);
  }

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requestCount += 1;
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    expect(url.origin).toBe(CONTRACT.apiUrl);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    const method = init?.method ?? "GET";
    if (method !== "GET") mutationCount += 1;
    const prefix = `/repos/${CONTRACT.repository}`;

    if (method === "GET" && url.pathname === prefix) {
      return Response.json({
        full_name: CONTRACT.repository,
        owner: { login: CONTRACT.owner, type: "Organization" },
        default_branch: CONTRACT.defaultBranch,
        archived: false,
        disabled: false,
        private: false,
      });
    }
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/${CONTRACT.defaultBranch}`) {
      return Response.json({
        ref: `refs/heads/${CONTRACT.defaultBranch}`,
        object: { type: "commit", sha: baseSha },
      });
    }
    if (method === "GET" && url.pathname === `${prefix}/git/ref/heads/${CONTRACT.headBranch}`) {
      if (postCount > 0) headRefReadsAfterPost += 1;
      return Response.json({
        ref: `refs/heads/${CONTRACT.headBranch}`,
        object: { type: "commit", sha: currentHeadSha },
      });
    }
    if (method === "GET" && url.pathname.startsWith(`${prefix}/git/commits/`)) {
      const sha = url.pathname.slice(`${prefix}/git/commits/`.length);
      if (sha === baseSha) {
        return Response.json({
          sha,
          tree: { sha: options.baseTree ?? temporaryTreeSha },
          parents: [
            { sha: options.baseFirstParent ?? CONTRACT.originalMainSha },
            { sha: options.baseSecondParent ?? finalCandidateSha },
          ],
        });
      }
      if (sha === CONTRACT.originalMainSha) {
        return Response.json({
          sha,
          tree: { sha: CONTRACT.originalTreeSha },
          parents: [{ sha: "0".repeat(40) }],
        });
      }
      const predecessorIndex = SOURCE_PREDECESSOR_CHAIN.findIndex(
        (predecessor) => predecessor.sha === sha,
      );
      if (predecessorIndex >= 0) {
        const expected = SOURCE_PREDECESSOR_CHAIN[predecessorIndex];
        const isDirectPredecessor = sha === CONTRACT.reviewedPredecessorSha;
        return Response.json({
          sha,
          tree: {
            sha:
              isDirectPredecessor && options.predecessorTree
                ? options.predecessorTree
                : expected.treeSha,
          },
          parents: [
            {
              sha:
                isDirectPredecessor && options.predecessorParent
                  ? options.predecessorParent
                  : expected.parentSha,
            },
          ],
        });
      }
      if (sha === finalCandidateSha || sha === options.baseSecondParent) {
        return Response.json({
          sha,
          tree: { sha: options.finalTree ?? temporaryTreeSha },
          parents: [{ sha: options.finalParent ?? CONTRACT.reviewedPredecessorSha }],
        });
      }
      if (sha === currentHeadSha || sha === headSha || sha === movedHeadSha) {
        return Response.json({
          sha,
          tree: { sha: options.headTree ?? CONTRACT.originalTreeSha },
          parents: [{ sha: options.headParent ?? baseSha }],
        });
      }
    }
    if (method === "GET" && url.pathname === `${prefix}/git/trees/${CONTRACT.originalTreeSha}`) {
      return Response.json(originalTree);
    }
    if (
      method === "GET" &&
      url.pathname === `${prefix}/git/trees/${CONTRACT.reviewedPredecessorTreeSha}`
    ) {
      return Response.json(predecessorTree);
    }
    if (method === "GET" && url.pathname === `${prefix}/git/trees/${temporaryTreeSha}`) {
      return Response.json(temporaryTree);
    }
    if (method === "GET" && url.pathname === `${prefix}/pulls` && url.searchParams.has("state")) {
      const response = Response.json(pulls);
      if (existingTerminalRefMovementArmed) {
        pullListCallsAfterTerminalMovementArm += 1;
        if (pullListCallsAfterTerminalMovementArm === 2) currentHeadSha = movedHeadSha;
      }
      if (
        options.moveHeadAfterCreatedTerminalList &&
        postCount > 0 &&
        !createdTerminalRefMovementInjected
      ) {
        createdTerminalRefMovementInjected = true;
        currentHeadSha = movedHeadSha;
      }
      return response;
    }
    if (method === "POST" && url.pathname === `${prefix}/pulls`) {
      postCount += 1;
      postedBody = JSON.parse(String(init?.body));
      if (options.moveHeadAfterPost) currentHeadSha = movedHeadSha;
      pulls.push({ number: 1, title: postedBody?.title, body: postedBody?.body });
      if (options.postCompetingEquivalent) {
        pulls.push({
          number: 2,
          title: CONTRACT.title,
          body: `<!-- ${CONTRACT.marker} -->`,
          head: { ref: CONTRACT.headBranch, sha: currentHeadSha },
        });
      }
      return Response.json({ number: 1 }, { status: 201 });
    }
    const pullMatch = new RegExp(`^${prefix}/pulls/([1-9][0-9]*)$`).exec(url.pathname);
    if (method === "GET" && pullMatch) {
      const number = Number(pullMatch[1]);
      const response = Response.json(detail(number));
      if (number === 1 && existingCompetitorAfterDetailArmed && !existingCompetitorInjected) {
        existingCompetitorInjected = true;
        pulls.push({
          number: 2,
          title: CONTRACT.title,
          body: `<!-- ${CONTRACT.marker} -->`,
          head: { ref: CONTRACT.headBranch, sha: currentHeadSha },
        });
      }
      return response;
    }
    if (method === "PATCH" && pullMatch) {
      const number = Number(pullMatch[1]);
      patchCount += 1;
      patchedNumbers.push(number);
      expect(JSON.parse(String(init?.body))).toEqual({ state: "closed" });
      if (options.cleanupFailure === "patch") {
        return Response.json({ message: "cleanup failed" }, { status: 500 });
      }
      const response = { ...detail(number), state: "closed", merged: false };
      if (options.cleanupFailure !== "readback") createdState = "closed";
      return Response.json(response);
    }
    const filesMatch = new RegExp(`^${prefix}/pulls/([1-9][0-9]*)/files$`).exec(url.pathname);
    if (method === "GET" && filesMatch) {
      if (Number(filesMatch[1]) === 1 && options.createdMismatch === "files") {
        return Response.json([{ filename: CONTRACT.helperPath, status: "modified" }]);
      }
      return Response.json(TEMPORARY_PATHS.map((filename) => ({ filename, status: "removed" })));
    }
    return Response.json(
      { message: `unhandled ${method} ${url.pathname}${url.search}` },
      { status: 404 },
    );
  };

  return {
    fetchImpl,
    get postCount() {
      return postCount;
    },
    get patchCount() {
      return patchCount;
    },
    get mutationCount() {
      return mutationCount;
    },
    get requestCount() {
      return requestCount;
    },
    get headRefReadsAfterPost() {
      return headRefReadsAfterPost;
    },
    get postedBody() {
      return postedBody;
    },
    get createdState() {
      return createdState;
    },
    armExistingCompetitorAfterDetail() {
      existingCompetitorAfterDetailArmed = true;
    },
    armExistingTerminalRefMovement() {
      existingTerminalRefMovementArmed = true;
      pullListCallsAfterTerminalMovementArm = 0;
    },
    patchedNumbers,
    originalTree,
    predecessorTree,
    temporaryTree,
    async api(path: string) {
      const response = await fetchImpl(`${CONTRACT.apiUrl}${path}`, {
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer test-token" },
      });
      if (!response.ok) throw new Error(`fixture API failed with HTTP ${response.status}`);
      return response.json();
    },
  };
}

const logger = { log() {} };

describe("temporary OPE-25 admission bootstrap", () => {
  test("opens exactly one revisioned canonical draft and makes reruns mutation-free", async () => {
    const api = fixture({ historicalV1: true });
    const created = await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
    expect(created).toMatchObject({
      action: "created",
      number: 1,
      baseSha,
      headSha,
      candidateHeadSha: finalCandidateSha,
    });
    expect(api.postCount).toBe(1);
    expect(api.patchCount).toBe(0);
    expect(api.postedBody).toMatchObject({
      title: CONTRACT.title,
      head: `${CONTRACT.owner}:${CONTRACT.headBranch}`,
      base: CONTRACT.defaultBranch,
      draft: true,
      maintainer_can_modify: false,
    });
    expect(CONTRACT.marker).toEndWith(":v2");
    expect(CONTRACT.headBranch).toEndWith("-v2");
    expect(String(api.postedBody?.body)).toContain("may hold workflows");
    expect(String(api.postedBody?.body)).toContain("repository approval");
    expect(String(api.postedBody?.body)).toContain("deterministic fallback");
    expect(String(api.postedBody?.body)).not.toContain("suppresses recursive");
    expect(String(api.postedBody?.body)).toContain("Typecheck and unit tests");

    const existing = await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
    expect(existing).toMatchObject({ action: "existing", number: 1, baseSha, headSha });
    expect(api.postCount).toBe(1);
    expect(api.patchCount).toBe(0);
  });

  test("accepts an exact synthetic merge B with the final candidate as parent 2", async () => {
    const api = fixture();
    await expect(inspectSourceIdentity(api.api, baseSha)).resolves.toEqual({
      baseSha,
      headSha,
      temporaryTreeSha,
      candidateHeadSha: finalCandidateSha,
    });
    expect(api.mutationCount).toBe(0);
  });

  test("fails without mutation when a competitor appears after existing PR detail", async () => {
    const api = fixture();
    await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
    const postCount = api.postCount;
    const patchCount = api.patchCount;
    const mutationCount = api.mutationCount;
    api.armExistingCompetitorAfterDetail();

    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow("existing bootstrap pull request is not globally unique");
    expect(api.postCount).toBe(postCount);
    expect(api.patchCount).toBe(patchCount);
    expect(api.mutationCount).toBe(mutationCount);
  });

  test("fails without mutation when refs move after existing PR terminal uniqueness", async () => {
    const api = fixture();
    await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
    const postCount = api.postCount;
    const patchCount = api.patchCount;
    const mutationCount = api.mutationCount;
    api.armExistingTerminalRefMovement();

    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow("governance head drifted during bootstrap");
    expect(api.postCount).toBe(postCount);
    expect(api.patchCount).toBe(patchCount);
    expect(api.mutationCount).toBe(mutationCount);
  });

  test("rejects caller context drift before any API request", async () => {
    const api = fixture();
    await expect(
      runBootstrap({
        env: context({ GITHUB_REF: "refs/heads/not-main" }),
        fetchImpl: api.fetchImpl,
        logger,
      }),
    ).rejects.toThrow("workflow was not dispatched from main");
    expect(api.requestCount).toBe(0);
    expect(api.postCount).toBe(0);
  });

  test.each([
    [
      "stale three-commit source count",
      {
        baseSecondParent: CONTRACT.reviewedPredecessorSha,
        bootstrapCommitCount: 3,
        bootstrapHeadSha: CONTRACT.reviewedPredecessorSha,
      },
      "bootstrap source pull-request commit count changed",
    ],
    [
      "fifth source commit",
      {
        baseSecondParent: fifthCandidateSha,
        bootstrapCommitCount: 5,
        bootstrapHeadSha: fifthCandidateSha,
        finalParent: finalCandidateSha,
      },
      "bootstrap source pull-request commit count changed",
    ],
    [
      "alternate final-candidate parent SHA",
      { finalParent: "9".repeat(40) },
      "final candidate is not the sole fourth commit on the reviewed predecessor",
    ],
    [
      "alternate predecessor parent SHA",
      { predecessorParent: "9".repeat(40) },
      "source predecessor commit 3 parent changed",
    ],
    [
      "alternate predecessor tree",
      { predecessorTree: "8".repeat(40) },
      "source predecessor commit 3 tree changed",
    ],
    [
      "alternate predecessor helper blob",
      { predecessorBlobOverrides: { [CONTRACT.helperPath]: "6".repeat(40) } },
      `reviewed predecessor blob changed: ${CONTRACT.helperPath}`,
    ],
    [
      "B/final-candidate tree mismatch",
      { finalTree: "7".repeat(40) },
      "temporary merge tree differs from the final candidate tree",
    ],
    [
      "alternate B parent 1",
      { baseFirstParent: "9".repeat(40) },
      "temporary base does not descend directly from the authorized main",
    ],
    [
      "alternate B parent 2",
      { baseSecondParent: "9".repeat(40) },
      "bootstrap source pull-request head changed",
    ],
  ] as const)("rejects %s", async (_name, options, message) => {
    const api = fixture(options);
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow(message);
    expect(api.postCount).toBe(0);
    expect(api.patchCount).toBe(0);
  });

  test.each([
    ["alternate PR head SHA", { bootstrapHeadSha: "9".repeat(40) }],
    ["alternate PR source branch", { bootstrapHeadRef: "other-bootstrap" }],
    ["alternate PR source repository", { bootstrapHeadRepo: "other/repository" }],
    ["alternate PR base SHA", { bootstrapBaseSha: "9".repeat(40) }],
    ["alternate PR merge SHA", { bootstrapMergeSha: "9".repeat(40) }],
    ["alternate PR author", { bootstrapAuthor: "somebody-else" }],
  ] as const)("rejects merged bootstrap source identity: %s", async (_name, options) => {
    const api = fixture(options);
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow(/bootstrap source/);
    expect(api.postCount).toBe(0);
  });

  test("rejects H unless it is the one-commit restoration of B and exact T", async () => {
    const wrongParent = fixture({ headParent: "9".repeat(40) });
    await expect(
      runBootstrap({ env: context(), fetchImpl: wrongParent.fetchImpl, logger }),
    ).rejects.toThrow("governance head is not one commit on the temporary base");
    expect(wrongParent.postCount).toBe(0);

    const wrongTree = fixture({ headTree: "8".repeat(40) });
    await expect(
      runBootstrap({ env: context(), fetchImpl: wrongTree.fetchImpl, logger }),
    ).rejects.toThrow("governance head does not restore the exact original tree");
    expect(wrongTree.postCount).toBe(0);
  });

  test("rejects a pre-existing current-revision equivalent instead of creating a second", async () => {
    const api = fixture({ initialConflict: true });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow("bootstrap pull-request title or body changed");
    expect(api.postCount).toBe(0);
  });

  test("treats a closed current-revision equivalent as terminal without retrying", async () => {
    const api = fixture({ closedCurrentEquivalent: true });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow("is closed; marker ope25-admission-governance-pr:v2 is terminal");
    expect(api.postCount).toBe(0);
    expect(api.patchCount).toBe(0);
  });

  test("requires both predecessor and final trees to contain only the removable path set", () => {
    const api = fixture();
    expect(() =>
      assertTemporaryBaseTree(
        api.originalTree,
        api.predecessorTree,
        CONTRACT.reviewedPredecessorTreeSha,
      ),
    ).not.toThrow();
    expect(() =>
      assertTemporaryBaseTree(api.originalTree, api.temporaryTree, temporaryTreeSha),
    ).not.toThrow();

    const extraTree = structuredClone(api.temporaryTree);
    extraTree.tree.push({
      path: "unexpected.txt",
      mode: "100644",
      type: "blob",
      sha: "7".repeat(40),
    });
    expect(() => assertTemporaryBaseTree(api.originalTree, extraTree, temporaryTreeSha)).toThrow(
      "temporary base changes more than the bootstrap files",
    );

    const gitlinkTree = structuredClone(api.temporaryTree);
    gitlinkTree.tree.push({
      path: "unexpected-submodule",
      mode: "160000",
      type: "commit",
      sha: "6".repeat(40),
    });
    expect(() => assertTemporaryBaseTree(api.originalTree, gitlinkTree, temporaryTreeSha)).toThrow(
      "temporary base changes more than the bootstrap files",
    );
  });

  test.each([
    ["head", "bootstrap pull-request head changed"],
    ["base", "bootstrap pull-request base changed"],
    ["author", "not provider-authored"],
    ["body", "title or body changed"],
    ["files", "does not remove exactly the temporary paths"],
  ] as const)("closes and proves cleanup for a wrong created PR %s", async (mismatch, cause) => {
    const api = fixture({ createdMismatch: mismatch });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow(new RegExp(`failed verification and was closed.*${cause}`));
    expect(api.postCount).toBe(1);
    expect(api.patchCount).toBe(1);
    expect(api.patchedNumbers).toEqual([1]);
    expect(api.createdState).toBe("closed");
  });

  test("closes only the created PR when H moves between the final precheck and POST", async () => {
    const api = fixture({ moveHeadAfterPost: true });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow(/failed verification and was closed.*bootstrap pull-request head changed/);
    expect(api.patchCount).toBe(1);
    expect(api.patchedNumbers).toEqual([1]);
    expect(api.createdState).toBe("closed");
  });

  test("closes only the created PR when a competing equivalent appears after POST", async () => {
    const api = fixture({ postCompetingEquivalent: true });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow(/failed verification and was closed.*not globally unique/);
    expect(api.patchCount).toBe(1);
    expect(api.patchedNumbers).toEqual([1]);
    expect(api.createdState).toBe("closed");
  });

  test("returns created only after stable refs pass both post-POST readbacks", async () => {
    const api = fixture();
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).resolves.toMatchObject({ action: "created", number: 1, headSha });
    expect(api.headRefReadsAfterPost).toBe(2);
    expect(api.postCount).toBe(1);
    expect(api.patchCount).toBe(0);
    expect(api.mutationCount).toBe(1);
    expect(api.createdState).toBe("open");
  });

  test("closes and proves cleanup when H moves after created terminal uniqueness", async () => {
    const api = fixture({ moveHeadAfterCreatedTerminalList: true });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger }),
    ).rejects.toThrow(/failed verification and was closed.*governance head drifted/);
    expect(api.headRefReadsAfterPost).toBe(2);
    expect(api.postCount).toBe(1);
    expect(api.patchCount).toBe(1);
    expect(api.mutationCount).toBe(2);
    expect(api.patchedNumbers).toEqual([1]);
    expect(api.createdState).toBe("closed");
  });

  test.each(["patch", "readback"] as const)(
    "emits explicit manual intervention when %s cleanup fails",
    async (cleanupFailure) => {
      const api = fixture({ createdMismatch: "author", cleanupFailure });
      try {
        await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
        throw new Error("expected runBootstrap to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ManualInterventionError);
        expect((error as ManualInterventionError).code).toBe("OPE25_BOOTSTRAP_MANUAL_INTERVENTION");
        expect((error as ManualInterventionError).pullRequestNumber).toBe(1);
        expect(String(error)).toContain("Close only PR #1 manually and do not rerun");
      }
      expect(api.postCount).toBe(1);
      expect(api.patchCount).toBe(1);
      expect(api.patchedNumbers).toEqual([1]);
      expect(api.createdState).toBe("open");
    },
  );

  test("workflow is inputless, least-privileged, action-free, and helper-hash pinned", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const helper = readFileSync(helperPath);
    const helperText = helper.toString("utf8");
    const helperSha256 = createHash("sha256").update(helper).digest("hex");
    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).not.toMatch(/\binputs:/);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).not.toMatch(
      /^\s+(actions|checks|deployments|id-token|issues|packages|security-events|statuses):/m,
    );
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toMatch(/^\s+uses:/m);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("--location");
    expect(workflow).toContain(`BOOTSTRAP_HELPER_SHA256: ${helperSha256}`);
    expect(workflow).toContain(`ref=$GITHUB_SHA`);
    expect(workflow).toContain('node "$helper"');
    expect(helperText).toContain(CONTRACT.reviewedPredecessorSha);
    expect(helperText).toContain(CONTRACT.reviewedPredecessorTreeSha);
    expect(helperText).toContain(`bootstrapCommitCount: ${CONTRACT.bootstrapCommitCount}`);
    expect(helperText).toContain(
      `bootstrapPullRequestNumber: ${CONTRACT.bootstrapPullRequestNumber}`,
    );
    expect(helperText).toContain("pulls/${CONTRACT.bootstrapPullRequestNumber}");
    expect(helperText).toContain("OPE25_BOOTSTRAP_MANUAL_INTERVENTION");
  });
});
