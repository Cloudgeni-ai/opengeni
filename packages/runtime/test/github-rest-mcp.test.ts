import { describe, expect, test } from "bun:test";
import {
  GITHUB_REST_MCP_PERSONAL_DESCRIPTOR,
  GITHUB_REST_TOOL_NAMES,
  githubRestConnectorActionOutcome,
  GitHubRestMcpServer,
  GitHubRestMutationNotExecutedError,
  GitHubRestMutationOutcomeUnknownError,
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
    expect(tools.map((tool) => tool.name)).toEqual([...GITHUB_REST_TOOL_NAMES]);
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
