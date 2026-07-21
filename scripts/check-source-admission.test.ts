import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT, directTreeManifest, verifySourceAdmission } from "./check-source-admission.mjs";

const repositoryRoot = join(import.meta.dir, "..");
const workflowPath = join(repositoryRoot, CONTRACT.workflowPath);
const helperPath = join(repositoryRoot, CONTRACT.helperPath);
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const baseTreeSha = "d".repeat(40);
const headTreeSha = "e".repeat(40);
const readmeBaseBlob = "1".repeat(40);
const readmeHeadBlob = "2".repeat(40);
const helperBlob = "3".repeat(40);
const pullNumber = 7;

type FixtureOptions = {
  apiBaseSha?: string;
  apiHeadSha?: string;
  comparisonBaseSha?: string;
  comparisonHeadSha?: string;
  comparisonMergeBaseSha?: string;
  comparisonStatus?: string;
  eventBaseSha?: string;
  eventHeadSha?: string;
  fileRows?: Array<Record<string, unknown>>;
  headTreeTruncated?: boolean;
  terminalBaseSha?: string;
  terminalHeadSha?: string;
  terminalHeadRepository?: string;
};

function event(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    action: "synchronize",
    number: pullNumber,
    repository: { full_name: CONTRACT.repository },
    pull_request: {
      number: pullNumber,
      state: "open",
      base: {
        ref: CONTRACT.defaultBranch,
        sha: baseSha,
        repo: { full_name: CONTRACT.repository },
      },
      head: {
        ref: "candidate/source-admission",
        sha: headSha,
        repo: { full_name: "contributor/opengeni" },
      },
    },
    ...overrides,
  };
}

function context(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_API_URL: CONTRACT.apiUrl,
    GITHUB_BASE_REF: CONTRACT.defaultBranch,
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_HEAD_REF: "candidate/source-admission",
    GITHUB_REF: `refs/heads/${CONTRACT.defaultBranch}`,
    GITHUB_REPOSITORY: CONTRACT.repository,
    GITHUB_SERVER_URL: CONTRACT.serverUrl,
    GITHUB_SHA: baseSha,
    GITHUB_TOKEN: "test-token",
    GITHUB_WORKFLOW_REF: `${CONTRACT.repository}/${CONTRACT.workflowPath}@refs/heads/${CONTRACT.defaultBranch}`,
    GITHUB_WORKFLOW_SHA: baseSha,
    OPENGENI_SOURCE_ADMISSION_ACTION: CONTRACT.action,
    ...overrides,
  };
}

function fixture(options: FixtureOptions = {}) {
  let mainReads = 0;
  let pullReads = 0;
  const methods: string[] = [];
  const requestedPaths: string[] = [];
  const logs: string[] = [];
  const apiBaseSha = options.apiBaseSha ?? baseSha;
  const apiHeadSha = options.apiHeadSha ?? headSha;
  const rows =
    options.fileRows ??
    ([
      { filename: "README.md", status: "modified" },
      { filename: CONTRACT.helperPath, status: "added" },
    ] satisfies Array<Record<string, unknown>>);

  const baseTree = {
    sha: baseTreeSha,
    truncated: false,
    tree: [{ path: "README.md", mode: "100644", type: "blob", sha: readmeBaseBlob }],
  };
  const headTree = {
    sha: headTreeSha,
    truncated: options.headTreeTruncated ?? false,
    tree: [
      { path: "README.md", mode: "100644", type: "blob", sha: readmeHeadBlob },
      {
        path: CONTRACT.helperPath,
        mode: "100644",
        type: "blob",
        sha: helperBlob,
      },
    ],
  };

  function pull(head = apiHeadSha, headRepository = "contributor/opengeni") {
    return {
      number: pullNumber,
      state: "open",
      base: {
        ref: CONTRACT.defaultBranch,
        sha: apiBaseSha,
        repo: { full_name: CONTRACT.repository },
      },
      head: {
        ref: "candidate/source-admission",
        sha: head,
        repo: { full_name: headRepository },
      },
      commits: 1,
      changed_files: rows.length,
    };
  }

  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    methods.push(init?.method ?? "GET");
    requestedPaths.push(path);
    let value: unknown;
    if (path === `/repos/${CONTRACT.repository}`) {
      value = {
        full_name: CONTRACT.repository,
        owner: { login: CONTRACT.owner, type: "Organization" },
        default_branch: CONTRACT.defaultBranch,
        archived: false,
        disabled: false,
        private: false,
      };
    } else if (path === `/repos/${CONTRACT.repository}/git/ref/heads/${CONTRACT.defaultBranch}`) {
      mainReads += 1;
      value = {
        ref: `refs/heads/${CONTRACT.defaultBranch}`,
        object: {
          type: "commit",
          sha: mainReads > 1 ? (options.terminalBaseSha ?? baseSha) : baseSha,
        },
      };
    } else if (path === `/repos/${CONTRACT.repository}/pulls/${pullNumber}`) {
      pullReads += 1;
      value = pull(
        pullReads > 1 ? (options.terminalHeadSha ?? apiHeadSha) : apiHeadSha,
        pullReads > 1
          ? (options.terminalHeadRepository ?? "contributor/opengeni")
          : "contributor/opengeni",
      );
    } else if (path === `/repos/${CONTRACT.repository}/git/commits/${baseSha}`) {
      value = {
        sha: baseSha,
        tree: { sha: baseTreeSha },
        parents: [{ sha: "a".repeat(40) }],
      };
    } else if (path === `/repos/${CONTRACT.repository}/git/commits/${headSha}`) {
      value = {
        sha: headSha,
        tree: { sha: headTreeSha },
        parents: [{ sha: baseSha }],
      };
    } else if (path === `/repos/${CONTRACT.repository}/compare/${baseSha}...${headSha}`) {
      value = {
        status: options.comparisonStatus ?? "ahead",
        base_commit: { sha: options.comparisonBaseSha ?? baseSha },
        merge_base_commit: { sha: options.comparisonMergeBaseSha ?? baseSha },
        commits: [{ sha: options.comparisonHeadSha ?? headSha }],
        behind_by: 0,
        ahead_by: 1,
      };
    } else if (
      path === `/repos/${CONTRACT.repository}/pulls/${pullNumber}/files?per_page=100&page=1`
    ) {
      value = rows;
    } else if (path === `/repos/${CONTRACT.repository}/git/trees/${baseTreeSha}?recursive=1`) {
      value = baseTree;
    } else if (path === `/repos/${CONTRACT.repository}/git/trees/${headTreeSha}?recursive=1`) {
      value = headTree;
    } else {
      return new Response(JSON.stringify({ message: `unexpected fixture path: ${path}` }), {
        status: 404,
      });
    }
    return Response.json(value);
  }

  return {
    baseTree,
    headTree,
    logs,
    methods,
    requestedPaths,
    fetchImpl,
    logger: { log: (line: string) => logs.push(line) },
  };
}

describe("source admission", () => {
  test("admits one exact current-base head and emits a deterministic direct-tree manifest", async () => {
    const api = fixture();
    const result = await verifySourceAdmission({
      env: context(),
      event: event(),
      fetchImpl: api.fetchImpl,
      logger: api.logger,
    });

    expect(result).toMatchObject({
      baseSha,
      headSha,
      baseTreeSha,
      headTreeSha,
    });
    expect(result.manifest.map(({ path }) => path)).toEqual(["README.md", CONTRACT.helperPath]);
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(api.methods.every((method) => method === "GET")).toBe(true);
    expect(api.logs).toEqual([
      `Source admission verified ${headSha} on current main ${baseSha}: 2 direct tree paths, manifest sha256 ${result.manifestSha256}.`,
    ]);
  });

  test("sorts direct blob identity instead of trusting a presentation diff", () => {
    const base = new Map([
      ["z", { mode: "100644", type: "blob", sha: "1".repeat(40) }],
      ["same", { mode: "100644", type: "blob", sha: "2".repeat(40) }],
    ]);
    const head = new Map([
      ["a", { mode: "100755", type: "blob", sha: "3".repeat(40) }],
      ["same", { mode: "100644", type: "blob", sha: "2".repeat(40) }],
    ]);

    expect(directTreeManifest(base, head).map(({ line }) => line)).toEqual([
      `a\t-\t-\t-\t100755\tblob\t${"3".repeat(40)}`,
      `z\t100644\tblob\t${"1".repeat(40)}\t-\t-\t-`,
    ]);
  });

  test.each([
    ["workflow event", { GITHUB_EVENT_NAME: "pull_request" }, "unexpected workflow event"],
    ["workflow SHA", { GITHUB_WORKFLOW_SHA: "9".repeat(40) }, "workflow SHA differs"],
    ["repository", { GITHUB_REPOSITORY: "other/repository" }, "unexpected repository"],
    ["base ref", { GITHUB_BASE_REF: "release" }, "unexpected base branch"],
    ["head ref", { GITHUB_HEAD_REF: "other-head" }, "event head ref differs"],
    [
      "action identity",
      { OPENGENI_SOURCE_ADMISSION_ACTION: "other" },
      "unexpected admission action",
    ],
  ] as const)("rejects caller context drift: %s", async (_label, envOverride, message) => {
    const api = fixture();
    await expect(
      verifySourceAdmission({
        env: context(envOverride),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow(message);
    expect(api.requestedPaths).toEqual([]);
  });

  test("rejects an event base that is not the exact current main", async () => {
    const api = fixture();
    const stale = event();
    stale.pull_request.base.sha = "8".repeat(40);
    await expect(
      verifySourceAdmission({
        env: context(),
        event: stale,
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("event base SHA differs from current main");
  });

  test("rejects a provider head that moved after the event", async () => {
    const api = fixture({ apiHeadSha: "8".repeat(40) });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("pull-request head SHA changed");
  });

  test("rejects a stale transplant whose merge base is not current main", async () => {
    const api = fixture({ comparisonMergeBaseSha: "8".repeat(40) });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("current main is not the candidate head merge base");
  });

  test("rejects a candidate that is not strictly ahead of current main", async () => {
    const api = fixture({ comparisonStatus: "diverged" });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("candidate head is not strictly ahead");
  });

  test("rejects truncated recursive trees", async () => {
    const api = fixture({ headTreeTruncated: true });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("candidate head tree is truncated");
  });

  test("rejects provider file metadata that omits a direct tree change", async () => {
    const api = fixture({
      fileRows: [{ filename: "README.md", status: "modified" }],
    });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("provider file projection differs from the direct tree delta");
  });

  test("rejects terminal main movement", async () => {
    const api = fixture({ terminalBaseSha: "8".repeat(40) });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("default branch drifted during admission");
  });

  test("rejects terminal head movement", async () => {
    const api = fixture({ terminalHeadSha: "8".repeat(40) });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("pull-request head SHA changed");
  });

  test("rejects terminal head repository movement", async () => {
    const api = fixture({ terminalHeadRepository: "other/opengeni" });
    await expect(
      verifySourceAdmission({
        env: context(),
        event: event(),
        fetchImpl: api.fetchImpl,
        logger: api.logger,
      }),
    ).rejects.toThrow("pull-request head repository changed");
  });

  test("workflow is base-owned, read-only, action-free, and helper-hash pinned", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const helper = readFileSync(helperPath);
    const helperSha256 = createHash("sha256").update(helper).digest("hex");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).not.toMatch(
      /^\s+(actions|checks|deployments|id-token|issues|packages|security-events|statuses):\s*write/m,
    );
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).not.toMatch(/^\s+uses:/m);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("--location");
    expect(workflow).toContain("base-owned trust anchor");
    expect(workflow).toContain(`ADMISSION_HELPER_SHA256: ${helperSha256}`);
    expect(workflow).toContain("ref=$GITHUB_WORKFLOW_SHA");
    expect(workflow).toContain('node "$helper"');
  });
});
