import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT,
  TEMPORARY_PATHS,
  assertTemporaryBaseTree,
  runBootstrap,
} from "./ope25-admission-bootstrap.mjs";

const repositoryRoot = join(import.meta.dir, "..");
const workflowPath = join(repositoryRoot, CONTRACT.workflowPath);
const helperPath = join(repositoryRoot, CONTRACT.helperPath);
const baseSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const headSha = "e".repeat(40);
const temporaryTreeSha = "f".repeat(40);
const readmeBlobSha = "1".repeat(40);

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

type PullRequest = Record<string, unknown>;

function fixture(options: { headParent?: string; headTree?: string; conflict?: boolean } = {}) {
  let postCount = 0;
  let requestCount = 0;
  let postedBody: Record<string, unknown> | undefined;
  const pulls: PullRequest[] = options.conflict
    ? [
        {
          number: 9,
          title: CONTRACT.title,
          body: `<!-- ${CONTRACT.marker} -->`,
          state: "open",
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
        },
      ]
    : [];

  const originalTree = {
    sha: CONTRACT.originalTreeSha,
    truncated: false,
    tree: [{ path: "README.md", mode: "100644", type: "blob", sha: readmeBlobSha }],
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
        sha: String(index + 2).repeat(40),
      })),
    ],
  };

  function detail(number: number): PullRequest {
    if (number === 9) return pulls[0]!;
    return {
      number,
      title: postedBody?.title,
      body: postedBody?.body,
      state: "open",
      draft: true,
      user: { login: "github-actions[bot]", type: "Bot" },
      base: { ref: CONTRACT.defaultBranch, sha: baseSha, repo: { full_name: CONTRACT.repository } },
      head: { ref: CONTRACT.headBranch, sha: headSha, repo: { full_name: CONTRACT.repository } },
      maintainer_can_modify: false,
      commits: 1,
      changed_files: TEMPORARY_PATHS.length,
    };
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
      return Response.json({
        ref: `refs/heads/${CONTRACT.headBranch}`,
        object: { type: "commit", sha: headSha },
      });
    }
    if (method === "GET" && url.pathname.startsWith(`${prefix}/git/commits/`)) {
      const sha = url.pathname.slice(`${prefix}/git/commits/`.length);
      if (sha === baseSha) {
        return Response.json({
          sha,
          tree: { sha: temporaryTreeSha },
          parents: [{ sha: CONTRACT.originalMainSha }, { sha: candidateSha }],
        });
      }
      if (sha === CONTRACT.originalMainSha) {
        return Response.json({
          sha,
          tree: { sha: CONTRACT.originalTreeSha },
          parents: [{ sha: "0".repeat(40) }],
        });
      }
      if (sha === candidateSha) {
        return Response.json({
          sha,
          tree: { sha: temporaryTreeSha },
          parents: [{ sha: CONTRACT.originalMainSha }],
        });
      }
      if (sha === headSha) {
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
    if (method === "GET" && url.pathname === `${prefix}/git/trees/${temporaryTreeSha}`) {
      return Response.json(temporaryTree);
    }
    if (method === "GET" && url.pathname === `${prefix}/pulls` && url.searchParams.has("state")) {
      return Response.json(pulls);
    }
    if (method === "POST" && url.pathname === `${prefix}/pulls`) {
      postCount += 1;
      postedBody = JSON.parse(String(init?.body));
      pulls.push({
        number: 1,
        title: postedBody?.title,
        body: postedBody?.body,
        state: "open",
        draft: true,
        head: { ref: CONTRACT.headBranch, sha: headSha },
      });
      return Response.json({ number: 1 }, { status: 201 });
    }
    const pullMatch = new RegExp(`^${prefix}/pulls/([1-9][0-9]*)$`).exec(url.pathname);
    if (method === "GET" && pullMatch) return Response.json(detail(Number(pullMatch[1])));
    const filesMatch = new RegExp(`^${prefix}/pulls/([1-9][0-9]*)/files$`).exec(url.pathname);
    if (method === "GET" && filesMatch) {
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
    get requestCount() {
      return requestCount;
    },
    get postedBody() {
      return postedBody;
    },
    originalTree,
    temporaryTree,
  };
}

describe("temporary OPE-25 admission bootstrap", () => {
  test("opens exactly one canonical draft and makes reruns mutation-free", async () => {
    const api = fixture();
    const logger = { log() {} };
    const created = await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
    expect(created).toMatchObject({ action: "created", number: 1, baseSha, headSha });
    expect(api.postCount).toBe(1);
    expect(api.postedBody).toMatchObject({
      title: CONTRACT.title,
      head: `${CONTRACT.owner}:${CONTRACT.headBranch}`,
      base: CONTRACT.defaultBranch,
      draft: true,
      maintainer_can_modify: false,
    });
    expect(String(api.postedBody?.body)).toContain(
      "close and reopen this same draft PR using a human token",
    );
    expect(String(api.postedBody?.body)).toContain("Typecheck and unit tests");

    const existing = await runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger });
    expect(existing).toMatchObject({ action: "existing", number: 1, baseSha, headSha });
    expect(api.postCount).toBe(1);
  });

  test("rejects caller context drift before any API request", async () => {
    const api = fixture();
    await expect(
      runBootstrap({
        env: context({ GITHUB_REF: "refs/heads/not-main" }),
        fetchImpl: api.fetchImpl,
        logger: { log() {} },
      }),
    ).rejects.toThrow("workflow was not dispatched from main");
    expect(api.requestCount).toBe(0);
    expect(api.postCount).toBe(0);
  });

  test("rejects a head that is not the one-commit restoration of the temporary base", async () => {
    const api = fixture({ headParent: "9".repeat(40) });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger: { log() {} } }),
    ).rejects.toThrow("governance head is not one commit on the temporary base");
    expect(api.postCount).toBe(0);
  });

  test("rejects a head whose tree is not the authorized original tree", async () => {
    const api = fixture({ headTree: "8".repeat(40) });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger: { log() {} } }),
    ).rejects.toThrow("governance head does not restore the exact original tree");
    expect(api.postCount).toBe(0);
  });

  test("rejects any pre-existing equivalent PR instead of creating a second one", async () => {
    const api = fixture({ conflict: true });
    await expect(
      runBootstrap({ env: context(), fetchImpl: api.fetchImpl, logger: { log() {} } }),
    ).rejects.toThrow("bootstrap pull-request title or body changed");
    expect(api.postCount).toBe(0);
  });

  test("requires the temporary base to add exactly the complete removable path set", () => {
    const api = fixture();
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

  test("workflow is inputless, least-privileged, action-free, and helper-hash pinned", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const helper = readFileSync(helperPath);
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
  });
});
