import { describe, expect, test } from "bun:test";
import {
  GITHUB_REST_ACCOUNT_TOOL_NAMES,
  GITHUB_REST_MCP_PERSONAL_DESCRIPTOR,
  GITHUB_REST_READ_TOOL_NAMES,
  GITHUB_REST_TOOL_NAMES,
  readLogWindow,
  githubRestConnectorActionOutcome,
  GitHubRestMcpServer,
  GitHubRestMutationNotExecutedError,
  GitHubRestMutationOutcomeUnknownError,
  GitHubRestRepositoryDetachedError,
  type GitHubRestRepository,
} from "../src/github-rest-mcp";

const repository: GitHubRestRepository = {
  repositoryId: "42",
  fullName: "Cloudgeni-ai/opengeni",
  canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
  defaultRef: "main",
  access: "write",
  authorityKind: "personal_oauth",
  connectionId: "11111111-1111-4111-8111-111111111111",
};

describe("GitHubRestMcpServer", () => {
  test("publishes a static reviewed surface with no authority selector", async () => {
    const server = buildServer(async () => response({ id: 42 }));
    const tools = await server.listTools();
    // Account-level reads need account authority; this server has none.
    expect(tools.map((tool) => tool.name)).toEqual(
      GITHUB_REST_TOOL_NAMES.filter(
        (name) => !(GITHUB_REST_ACCOUNT_TOOL_NAMES as readonly string[]).includes(name),
      ),
    );
    expect(server.bridge).toEqual(GITHUB_REST_MCP_PERSONAL_DESCRIPTOR);
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(properties.connectionId).toBeUndefined();
      expect(properties.authority).toBeUndefined();
    }
  });

  test("rejects repositories outside the accepted set before network use", async () => {
    let calls = 0;
    const server = buildServer(async () => {
      calls += 1;
      return response({});
    });
    const result = await server.callToolResult("repository_get", { repository: "other/repo" });
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test("revalidates immediately before a safe read and retries one 401", async () => {
    const forceRefresh: boolean[] = [];
    let providerAuthorizations = 0;
    let calls = 0;
    const server = new GitHubRestMcpServer({
      serverId: "github_personal",
      authorityKind: "personal_oauth",
      repositories: [repository],
      resolveAuthority: async (input) => {
        forceRefresh.push(input.forceRefresh);
        return {
          headers: { authorization: "Bearer secret-that-must-not-escape" },
          connectionId: repository.connectionId,
          actor: { kind: "personal_oauth", login: "bendik" },
          authorizeProviderRequest: async () => {
            providerAuthorizations += 1;
            return true;
          },
        };
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer secret-that-must-not-escape",
        );
        return calls === 1
          ? response({ message: "expired" }, 401)
          : response({ id: 42, full_name: repository.fullName, default_branch: "main" }, 200, {
              "x-github-request-id": "REQ_123",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4999",
            });
      },
    });
    const result = await server.callToolResult("repository_get", {
      repository: repository.fullName,
    });
    expect(forceRefresh).toEqual([false, true]);
    expect(providerAuthorizations).toBe(2);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret-that-must-not-escape");
    expect(result.structuredContent).toMatchObject({
      attribution: { kind: "personal_oauth", login: "bendik" },
      provider: {
        requestId: "REQ_123",
        rateLimit: { limit: 5000, remaining: 4999 },
      },
    });
  });

  test("never replays a mutation after an ambiguous transport failure", async () => {
    let calls = 0;
    const server = buildServer(async () => {
      calls += 1;
      throw new Error("socket reset with provider details");
    });
    const result = await server.callToolResult("issue_create", {
      repository: repository.fullName,
      title: "Test",
    });
    expect(githubRestConnectorActionOutcome(result)).toBe("uncertain");
    await expect(
      server.callToolResult(
        "issue_create",
        { repository: repository.fullName, title: "Test" },
        { opengeniOperationId: crypto.randomUUID() },
      ),
    ).rejects.toBeInstanceOf(GitHubRestMutationOutcomeUnknownError);
    expect(calls).toBe(2);
  });

  test("marks a mutation rejected before I/O as not executed", async () => {
    const server = buildServer(async () => response({}));
    const result = await server.callToolResult("issue_create", {
      repository: "other/repo",
      title: "Test",
    });
    expect(githubRestConnectorActionOutcome(result)).toBe("not_executed");
    await expect(
      server.callToolResult(
        "issue_create",
        { repository: "other/repo", title: "Test" },
        { opengeniOperationId: crypto.randomUUID() },
      ),
    ).rejects.toBeInstanceOf(GitHubRestMutationNotExecutedError);
  });

  test("submits a review through the personal actor", async () => {
    const server = buildServer(async (url, init) => {
      expect(String(url)).toBe(
        "https://api.github.com/repos/Cloudgeni-ai/opengeni/pulls/17/reviews",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        event: "APPROVE",
        body: "Looks good",
        commit_id: "a".repeat(40),
      });
      return response({
        id: 91,
        state: "APPROVED",
        body: "Looks good",
        commit_id: "a".repeat(40),
        user: { id: 7, login: "bendik" },
      });
    });
    const result = await server.callToolResult("pull_request_review_submit", {
      repository: repository.fullName,
      pullNumber: 17,
      event: "APPROVE",
      body: "Looks good",
      commitId: "a".repeat(40),
    });
    expect(result.structuredContent).toMatchObject({
      data: { id: 91, state: "APPROVED", author: { login: "bendik" } },
      attribution: { kind: "personal_oauth", login: "bendik" },
    });
  });

  test("keeps line breaks and tabs in Markdown bodies", async () => {
    const markdown = "## Summary\n\n- one\n- two\r\n\n```ts\n\tcode\n```";
    const server = buildServer(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ body: markdown });
      return response({ id: 5, body: markdown, user: { id: 7, login: "bendik" } });
    });
    const result = await server.callToolResult("pull_request_comment", {
      repository: repository.fullName,
      pullNumber: 17,
      body: markdown,
    });
    expect(result.isError).toBeFalsy();
    const rejected = await server.callToolResult("pull_request_comment", {
      repository: repository.fullName,
      pullNumber: 17,
      body: "bell \u0007",
    });
    expect(rejected.isError).toBe(true);
    expect(githubRestConnectorActionOutcome(rejected)).toBe("not_executed");
  });

  test("requires review text for comments and change requests before provider I/O", async () => {
    let calls = 0;
    const server = buildServer(async () => {
      calls += 1;
      return response({});
    });
    const result = await server.callToolResult("pull_request_review_submit", {
      repository: repository.fullName,
      pullNumber: 17,
      event: "REQUEST_CHANGES",
    });
    expect(result.isError).toBe(true);
    expect(githubRestConnectorActionOutcome(result)).toBe("not_executed");
    expect(JSON.stringify(result.content)).toContain("body is required");
    expect(calls).toBe(0);
  });

  test("merges only through the write-authorized repository", async () => {
    const server = buildServer(async (url, init) => {
      expect(String(url)).toBe("https://api.github.com/repos/Cloudgeni-ai/opengeni/pulls/17/merge");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        merge_method: "squash",
        sha: "b".repeat(40),
      });
      return response({ sha: "c".repeat(40), merged: true, message: "Pull Request merged" });
    });
    const result = await server.callToolResult("pull_request_merge", {
      repository: repository.fullName,
      pullNumber: 17,
      method: "squash",
      expectedHeadSha: "b".repeat(40),
    });
    expect(result.structuredContent).toMatchObject({
      data: { sha: "c".repeat(40), merged: true },
    });
  });
});

describe("GitHubRestMcpServer with a repository removed from the chat", () => {
  const kept: GitHubRestRepository = {
    ...repository,
    repositoryId: "43",
    fullName: "Cloudgeni-ai/docs",
    canonicalUrl: "https://github.com/Cloudgeni-ai/docs",
  };
  function serverWithRemoved(fetchImpl: () => Promise<Response>) {
    return new GitHubRestMcpServer({
      serverId: "github_personal",
      authorityKind: "personal_oauth",
      repositories: [repository, kept],
      resolveAuthority: async (input) => {
        if (input.repository.repositoryId === repository.repositoryId) {
          throw new GitHubRestRepositoryDetachedError(
            `${input.repository.fullName} was removed from this chat`,
          );
        }
        return {
          headers: { authorization: "Bearer secret" },
          connectionId: repository.connectionId,
          actor: { kind: "personal_oauth", login: "bendik" },
          authorizeProviderRequest: async () => true,
        };
      },
      fetchImpl,
    });
  }

  test("refuses its tools before any provider call", async () => {
    let calls = 0;
    const server = serverWithRemoved(async () => {
      calls += 1;
      return response({ id: 42 });
    });
    const read = await server.callToolResult("repository_get", {
      repository: repository.fullName,
    });
    expect(read.isError).toBe(true);
    expect(read.content[0].text).toBe("Cloudgeni-ai/opengeni was removed from this chat");
    const write = await server.callToolResult("issue_create", {
      repository: repository.fullName,
      title: "t",
      body: "b",
    });
    expect(write.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test("leaves it out of repositories_list", async () => {
    const server = serverWithRemoved(async () => response({}));
    const listed = await server.callToolResult("repositories_list", {});
    expect(
      listed.structuredContent.repositories.map((entry: { fullName: string }) => entry.fullName),
    ).toEqual(["Cloudgeni-ai/docs"]);
  });
});

function buildServer(fetchImpl: (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  return new GitHubRestMcpServer({
    serverId: "github_personal",
    authorityKind: "personal_oauth",
    repositories: [repository],
    resolveAuthority: async () => ({
      headers: { authorization: "Bearer secret" },
      connectionId: repository.connectionId,
      actor: { kind: "personal_oauth", login: "bendik" },
      authorizeProviderRequest: async () => true,
    }),
    fetchImpl,
  });
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const personalAccount = {
  connectionId: repository.connectionId,
  resolveAuthority: async () => ({
    headers: { authorization: "Bearer secret" },
    connectionId: repository.connectionId,
    actor: { kind: "personal_oauth" as const, login: "bendik" },
    authorizeProviderRequest: async () => true,
  }),
};

function openServer(
  fetchImpl: (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
  resolveRepository: (fullName: string) => Promise<GitHubRestRepository | null> = async (
    fullName,
  ) =>
    fullName.toLowerCase() === "acme/widgets"
      ? {
          repositoryId: "77",
          fullName: "acme/widgets",
          canonicalUrl: "https://github.com/acme/widgets",
          defaultRef: "trunk",
          access: "read",
          authorityKind: "personal_oauth",
          connectionId: repository.connectionId,
        }
      : null,
) {
  return new GitHubRestMcpServer({
    serverId: "github_personal",
    authorityKind: "personal_oauth",
    repositories: [],
    resolveRepository,
    account: personalAccount,
    resolveAuthority: personalAccount.resolveAuthority,
    fetchImpl,
  });
}

describe("GitHub read tools", () => {
  test("the new tools are reads", () => {
    for (const name of [
      "workflow_runs_list",
      "workflow_run_get",
      "workflow_job_logs_get",
      "organizations_list",
      "owner_repositories_list",
    ]) {
      expect((GITHUB_REST_READ_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
    }
  });

  test("All my repositories: no attached repositories, any repository by name", async () => {
    const urls: string[] = [];
    const server = openServer(async (url) => {
      urls.push(String(url));
      return response({ id: 77, full_name: "acme/widgets", default_branch: "trunk" });
    });
    const tools = await server.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...GITHUB_REST_TOOL_NAMES]);
    const result = await server.callToolResult("repository_get", { repository: "acme/widgets" });
    expect(result.isError).toBeUndefined();
    expect(urls).toEqual(["https://api.github.com/repos/acme/widgets"]);
    const unknown = await server.callToolResult("repository_get", { repository: "acme/secret" });
    expect(unknown.isError).toBe(true);
    // Read access from the resolver blocks writes before any request.
    const write = await server.callToolResult("issue_create", {
      repository: "acme/widgets",
      title: "t",
    });
    expect(githubRestConnectorActionOutcome(write)).toBe("not_executed");
    expect(urls).toHaveLength(1);
    const listed = await server.callToolResult("repositories_list", {});
    expect(listed.structuredContent).toEqual({ repositories: [], allRepositories: true });
  });

  test("lists organizations and an organization's repositories with a name filter", async () => {
    const urls: string[] = [];
    const server = openServer(async (url) => {
      const href = String(url);
      urls.push(href);
      if (href.startsWith("https://api.github.com/user/repos")) {
        return response([
          {
            id: 77,
            full_name: "acme/widgets",
            owner: { id: 1, login: "acme", type: "Organization" },
          },
          {
            id: 78,
            full_name: "acme/gadgets",
            owner: { id: 1, login: "acme", type: "Organization" },
          },
          { id: 79, full_name: "friend/tool", owner: { id: 9, login: "friend", type: "User" } },
        ]);
      }
      if (href === "https://api.github.com/users/acme") {
        return response({ login: "acme", type: "Organization" });
      }
      return response({
        total_count: 1,
        items: [{ id: 77, full_name: "acme/widgets", private: true, default_branch: "trunk" }],
      });
    });
    const orgs = await server.callToolResult("organizations_list", {});
    expect(orgs.isError).toBeUndefined();
    expect(orgs.structuredContent.data).toEqual({
      organizations: [{ id: 1, login: "acme" }],
      complete: true,
    });
    const scan = new URL(urls[0]!);
    expect(scan.pathname).toBe("/user/repos");
    // /user/orgs needs read:org, which Your GitHub does not hold.
    expect(urls.some((url) => url.includes("/user/orgs"))).toBe(false);
    expect(scan.searchParams.get("affiliation")).toBe("organization_member,collaborator");
    const repos = await server.callToolResult("owner_repositories_list", {
      owner: "acme",
      filter: "widg",
    });
    expect(repos.isError).toBeUndefined();
    expect(repos.structuredContent.data.repositories[0]).toMatchObject({
      fullName: "acme/widgets",
      private: true,
    });
    const search = new URL(urls[2]!);
    expect(search.pathname).toBe("/search/repositories");
    expect(search.searchParams.get("q")).toBe("widg in:name org:acme");
  });

  test("lists the person's own repositories, private ones included", async () => {
    const urls: string[] = [];
    const server = openServer(async (url) => {
      urls.push(String(url));
      return String(url) === "https://api.github.com/users/Bendik"
        ? response({ login: "bendik", type: "User" })
        : response([]);
    });
    await server.callToolResult("owner_repositories_list", { owner: "Bendik" });
    expect(new URL(urls[1]!).pathname).toBe("/user/repos");
    expect(new URL(urls[1]!).searchParams.get("affiliation")).toBe("owner");
  });

  test("an enterprise managed user's login is a valid owner", async () => {
    const urls: string[] = [];
    const server = openServer(async (url) => {
      urls.push(String(url));
      return String(url) === "https://api.github.com/users/octocat_acme"
        ? response({ login: "octocat_acme", type: "User" })
        : response([]);
    });
    const result = await server.callToolResult("owner_repositories_list", {
      owner: "octocat_acme",
    });
    expect(result.isError).toBeUndefined();
    expect(new URL(urls[0]!).pathname).toBe("/users/octocat_acme");
  });

  test("filters workflow runs by pull request head", async () => {
    const urls: string[] = [];
    const sha = "a".repeat(40);
    const server = buildServer(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/pulls/9")) return response({ head: { sha } });
      return response({
        total_count: 1,
        workflow_runs: [
          {
            id: 5,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            head_sha: sha,
            pull_requests: [{ number: 9 }],
          },
        ],
      });
    });
    const result = await server.callToolResult("workflow_runs_list", {
      repository: repository.fullName,
      pullNumber: 9,
      status: "failure",
      workflow: "ci.yml",
    });
    expect(result.isError).toBeUndefined();
    const runs = new URL(urls[1]!);
    expect(runs.pathname).toBe("/repos/Cloudgeni-ai/opengeni/actions/workflows/ci.yml/runs");
    expect(runs.searchParams.get("head_sha")).toBe(sha);
    expect(runs.searchParams.get("status")).toBe("failure");
    expect(result.structuredContent.data.runs[0]).toMatchObject({
      id: 5,
      conclusion: "failure",
      pullRequests: [9],
    });
  });

  test("gets a run with its jobs and steps", async () => {
    const server = buildServer(async (url) =>
      String(url).includes("/jobs")
        ? response({
            total_count: 1,
            jobs: [
              {
                id: 11,
                name: "test",
                conclusion: "failure",
                steps: [{ number: 1, name: "Run tests", conclusion: "failure" }],
              },
            ],
          })
        : response({ id: 5, name: "CI" }),
    );
    const result = await server.callToolResult("workflow_run_get", {
      repository: repository.fullName,
      runId: 5,
    });
    expect(result.structuredContent.data).toMatchObject({
      run: { id: 5, name: "CI" },
      totalJobs: 1,
      jobs: [{ id: 11, steps: [{ number: 1, name: "Run tests", conclusion: "failure" }] }],
    });
  });

  test("reads the end of a job log from the redirect without the GitHub credential", async () => {
    const seen: Array<{ url: string; authorization: string | null; redirect?: string }> = [];
    const log = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n");
    const server = buildServer(async (url, init) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      });
      if (String(url).startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://results.blob.example/job-11.txt?sig=abc" },
        });
      }
      return new Response(log, { status: 200 });
    });
    const result = await server.callToolResult("workflow_job_logs_get", {
      repository: repository.fullName,
      jobId: 11,
      maxBytes: 2_048,
    });
    expect(result.isError).toBeUndefined();
    expect(seen[0]).toEqual({
      url: "https://api.github.com/repos/Cloudgeni-ai/opengeni/actions/jobs/11/logs",
      authorization: "Bearer secret",
      redirect: "manual",
    });
    expect(seen[1]?.url).toBe("https://results.blob.example/job-11.txt?sig=abc");
    expect(seen[1]?.authorization).toBeNull();
    // This host ignores Range (200), so the log is streamed.
    const data = result.structuredContent.data;
    expect(data.text.endsWith("line 4999")).toBe(true);
    expect(data.text.startsWith("line ")).toBe(true);
    expect(data.totalBytes).toBe(new TextEncoder().encode(log).byteLength);
    expect(data.endByte).toBe(data.totalBytes);
    expect(data.nextOffset).toBeNull();
    expect(JSON.stringify(result)).not.toContain("sig=abc");
  });

  test("reads only the wanted bytes from a host that honours Range", async () => {
    const log = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n");
    const bytes = new TextEncoder().encode(log);
    const ranges: Array<string | null> = [];
    const server = buildServer(async (url, init) => {
      if (String(url).startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://results.blob.example/job-11.txt?sig=abc" },
        });
      }
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      const suffix = /^bytes=-(\d+)$/u.exec(range ?? "");
      const span = /^bytes=(\d+)-(\d+)$/u.exec(range ?? "");
      const start = suffix ? bytes.length - Number(suffix[1]) : Number(span![1]);
      if (start >= bytes.length) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${bytes.length}` },
        });
      }
      const end = suffix ? bytes.length - 1 : Math.min(Number(span![2]), bytes.length - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
      });
    });
    const tail = await server.callToolResult("workflow_job_logs_get", {
      repository: repository.fullName,
      jobId: 11,
      maxBytes: 2_048,
    });
    const data = tail.structuredContent.data;
    expect(ranges[0]).toBe("bytes=-2048");
    expect(data.text.endsWith("line 4999")).toBe(true);
    expect(data.text.startsWith("line ")).toBe(true);
    expect(data).toMatchObject({
      endByte: bytes.length,
      totalBytes: bytes.length,
      nextOffset: null,
    });
    const page = await server.callToolResult("workflow_job_logs_get", {
      repository: repository.fullName,
      jobId: 11,
      offset: 100,
      maxBytes: 1_024,
    });
    expect(ranges[1]).toBe("bytes=100-1123");
    expect(page.structuredContent.data).toMatchObject({
      startByte: 100,
      endByte: 1_124,
      totalBytes: bytes.length,
      nextOffset: 1_124,
    });
    const past = await server.callToolResult("workflow_job_logs_get", {
      repository: repository.fullName,
      jobId: 11,
      offset: bytes.length + 10,
    });
    expect(past.structuredContent.data).toMatchObject({
      text: "",
      totalBytes: bytes.length,
      nextOffset: null,
    });
  });

  test("refuses a log location that is not https", async () => {
    const server = buildServer(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://insecure.example/log" } }),
    );
    const result = await server.callToolResult("workflow_job_logs_get", {
      repository: repository.fullName,
      jobId: 11,
    });
    expect(result.isError).toBe(true);
  });
});

describe("readLogWindow", () => {
  const stream = (text: string, chunk = 7) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let index = 0; index < bytes.length; index += chunk) {
          controller.enqueue(bytes.subarray(index, index + chunk));
        }
        controller.close();
      },
    });

  test("pages from an offset", async () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const first = await readLogWindow(stream(text), { offset: 0, maxBytes: 10 });
    expect(first).toMatchObject({ text: "abcdefghij", startByte: 0, endByte: 10, nextOffset: 10 });
    const last = await readLogWindow(stream(text), { offset: 20, maxBytes: 10 });
    expect(last).toMatchObject({ text: "uvwxyz", startByte: 20, endByte: 26, nextOffset: null });
    expect(last.totalBytes).toBe(26);
  });

  test("keeps the tail on whole lines", async () => {
    const text = "one\ntwo\nthree\nfour\n";
    const tail = await readLogWindow(stream(text, 3), { maxBytes: 9 });
    expect(tail.text).toBe("four\n");
    expect(tail.endByte).toBe(text.length);
    expect(tail.totalBytes).toBe(text.length);
  });

  test("keeps what it read when the stream fails part way", async () => {
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("timed out"));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode("first part\n"));
      },
    });
    const window = await readLogWindow(failing, { offset: 0, maxBytes: 100 });
    expect(window).toMatchObject({ text: "first part\n", totalBytes: null, nextOffset: 11 });
  });

  test("stops at the scan limit and says where to continue", async () => {
    const window = await readLogWindow(stream("x".repeat(100), 10), {
      maxBytes: 20,
      scanMaxBytes: 50,
    });
    expect(window.totalBytes).toBeNull();
    expect(window.endByte).toBe(50);
    expect(window.nextOffset).toBe(50);
    // An offset past the scan never pages back to an earlier offset.
    const beyond = await readLogWindow(stream("x".repeat(100), 10), {
      offset: 80,
      maxBytes: 20,
      scanMaxBytes: 50,
    });
    expect(beyond).toMatchObject({ text: "", nextOffset: null, totalBytes: null });
  });
});
