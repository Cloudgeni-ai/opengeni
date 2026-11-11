import { describe, expect, spyOn, test } from "bun:test";
import type { ResourceRef, SessionTurn } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { prefixedMcpToolName } from "@opengeni/runtime";
import {
  GITHUB_REST_MCP_APP_SERVER_ID,
  GITHUB_REST_MCP_PERSONAL_SERVER_ID,
  GitHubRestAuthorityError,
} from "@opengeni/runtime/github-rest-mcp";
import { PERSONAL_GITHUB_RECONNECT_MESSAGE } from "@opengeni/contracts/personal-github";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildGitHubRestMcpForTurn,
  personalConnectionNeedsReconnect,
  personalReconnectOr,
} from "../src/github-rest-mcp";

const appResource: ResourceRef = {
  kind: "repository",
  uri: "https://github.com/Cloudgeni-ai/opengeni.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 71,
  githubRepositoryId: 72,
};

describe("buildGitHubRestMcpForTurn", () => {
  test("is inert while the rollout flag is off", async () => {
    const result = await build({ enabled: false });
    expect(result.localMcpServers).toEqual([]);
    expect(result.connectorBindings).toEqual([]);
    expect(result.tools).toEqual([]);
  });

  test("adds the workspace-App actor without exposing a connection selector", async () => {
    const result = await build({ enabled: true });
    expect(result.localMcpServers.map((entry) => entry.id)).toEqual([
      GITHUB_REST_MCP_APP_SERVER_ID,
    ]);
    expect(result.settings.mcpServers.at(-1)).toMatchObject({
      id: GITHUB_REST_MCP_APP_SERVER_ID,
      allowedTools: expect.any(Array),
    });
    expect(result.tools).toEqual([{ kind: "mcp", id: GITHUB_REST_MCP_APP_SERVER_ID }]);

    const read = result.connectorBindings.find(
      (binding) =>
        binding.modelName === prefixedMcpToolName(GITHUB_REST_MCP_APP_SERVER_ID, "repository_get"),
    );
    const write = result.connectorBindings.find(
      (binding) =>
        binding.modelName === prefixedMcpToolName(GITHUB_REST_MCP_APP_SERVER_ID, "issue_create"),
    );
    expect(read?.call("read-call", { repository: "Cloudgeni-ai/opengeni" })).toMatchObject({
      connectionId: "github-app:71",
      serverId: GITHUB_REST_MCP_APP_SERVER_ID,
      toolName: "repository_get",
    });
    expect(write?.call("write-call", { repository: "Cloudgeni-ai/opengeni" })).toMatchObject({
      connectionId: "github-app:71",
      serverId: GITHUB_REST_MCP_APP_SERVER_ID,
      toolName: "issue_create",
      approvalMode: "connector_write",
    });
    expect(
      result.connectorBindings.some(
        (binding) =>
          binding.modelName ===
          prefixedMcpToolName(GITHUB_REST_MCP_APP_SERVER_ID, "repositories_list"),
      ),
    ).toBe(false);
    expect(
      result.settings.mcpServers.some((server) => server.id === GITHUB_REST_MCP_PERSONAL_SERVER_ID),
    ).toBe(false);
  });

  test("reports an invalid repository URL separately from missing App authority", async () => {
    await expect(
      build({
        enabled: true,
        resource: { ...appResource, uri: "https://github.com/Cloudgeni-ai/opengeni?ref=main" },
      }),
    ).rejects.toThrow("GitHub App repository URL is invalid");
  });

  test("keeps the personal OAuth actor in a separate namespace", async () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const personalResource: ResourceRef = {
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/opengeni",
      ref: "main",
      provider: "github",
      connectionType: "github_personal",
      credentialBindingId: "22222222-2222-4222-8222-222222222222",
      repositoryId: "72",
      access: "write",
    };
    const result = await buildGitHubRestMcpForTurn({
      db: {} as Database,
      settings: testSettings({ githubRestMcpEnabled: true }),
      accountId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000003",
      attemptId: "00000000-0000-4000-8000-000000000004",
      turn: {
        personalConnectionDelegations: [
          {
            serverId: "github:personal",
            connectionId,
            originWorkspaceId: "00000000-0000-4000-8000-000000000005",
            ownerSubjectId: "user-1",
            providerDomain: "github.com",
            kind: "oauth2",
            connectionType: "github_personal",
            userDelegation: { grantId: "grant-1" },
            personalGitHubRepositorySelection: {
              credentialBindingId: "22222222-2222-4222-8222-222222222222",
              connectionAuthorityGeneration: 2,
              selectionGeneration: 4,
              repositories: [
                {
                  repositoryId: "72",
                  fullName: "Cloudgeni-ai/opengeni",
                  canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
                  ref: "main",
                  access: "write",
                  selectionGeneration: 4,
                },
              ],
            },
          },
        ],
      } as SessionTurn,
      resources: [personalResource],
      tools: [],
      resolveCredential: async () => ({
        status: "auth_needed",
        reason: "missing_connection",
        providerDomain: "github.com",
      }),
    });
    expect(result.localMcpServers.map((entry) => entry.id)).toEqual([
      GITHUB_REST_MCP_PERSONAL_SERVER_ID,
    ]);
    expect(result.tools).toEqual([{ kind: "mcp", id: GITHUB_REST_MCP_PERSONAL_SERVER_ID }]);
    const write = result.connectorBindings.find(
      (binding) =>
        binding.modelName ===
        prefixedMcpToolName(GITHUB_REST_MCP_PERSONAL_SERVER_ID, "pull_request_create"),
    );
    expect(write?.call("write-call", { repository: "Cloudgeni-ai/opengeni" })).toMatchObject({
      connectionId,
      serverId: GITHUB_REST_MCP_PERSONAL_SERVER_ID,
      toolName: "pull_request_create",
      approvalMode: "connector_write",
    });
  });

  test("All my repositories gives Your GitHub tools to a chat with no attached repository", async () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const result = await buildGitHubRestMcpForTurn({
      db: {} as Database,
      settings: testSettings({ githubRestMcpEnabled: true }),
      accountId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      sessionId: "00000000-0000-4000-8000-000000000003",
      attemptId: "00000000-0000-4000-8000-000000000004",
      turn: {
        personalConnectionDelegations: [
          {
            serverId: "github:personal",
            connectionId,
            originWorkspaceId: "00000000-0000-4000-8000-000000000005",
            ownerSubjectId: "user-1",
            providerDomain: "github.com",
            kind: "oauth2",
            connectionType: "github_personal",
            personalGitHubRepositorySelection: {
              credentialBindingId: "22222222-2222-4222-8222-222222222222",
              connectionAuthorityGeneration: 2,
              selectionGeneration: 4,
              allRepositoriesAccess: "write",
              repositories: [],
            },
          },
        ],
      } as unknown as SessionTurn,
      resources: [],
      tools: [],
      resolveCredential: async () => ({
        status: "auth_needed",
        reason: "missing_connection",
        providerDomain: "github.com",
      }),
    });
    expect(result.localMcpServers.map((entry) => entry.id)).toEqual([
      GITHUB_REST_MCP_PERSONAL_SERVER_ID,
    ]);
    const tools = await result.localMcpServers[0]!.server.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("organizations_list");
    expect(names).toContain("owner_repositories_list");
    expect(names).toContain("workflow_job_logs_get");
    // Any repository name binds to the person's connection; the bridge checks it.
    const runs = result.connectorBindings.find(
      (binding) =>
        binding.modelName ===
        prefixedMcpToolName(GITHUB_REST_MCP_PERSONAL_SERVER_ID, "workflow_runs_list"),
    );
    expect(runs?.call("read-call", { repository: "acme/anything" })).toMatchObject({
      connectionId,
      toolName: "workflow_runs_list",
    });
    expect(runs?.call("read-call", { repository: "acme/anything" })).not.toHaveProperty(
      "approvalMode",
    );
    expect(
      result.connectorBindings.some(
        (binding) =>
          binding.modelName ===
          prefixedMcpToolName(GITHUB_REST_MCP_PERSONAL_SERVER_ID, "organizations_list"),
      ),
    ).toBe(false);
  });

  // The idle compaction checkpoint of a chat with a personal repository runs
  // without the person's delegation. This threw "Personal GitHub delegation
  // is unavailable" and failed the whole turn.
  describe("a turn without the person's GitHub authority", () => {
    const personalResource: ResourceRef = {
      kind: "repository",
      uri: "https://github.com/Cloudgeni-ai/opengeni",
      ref: "main",
      provider: "github",
      connectionType: "github_personal",
      credentialBindingId: "22222222-2222-4222-8222-222222222222",
      repositoryId: "72",
      access: "write",
    };
    const appOps: ResourceRef = {
      ...appResource,
      uri: "https://github.com/Cloudgeni-ai/opengeni-ops.git",
      githubRepositoryId: 73,
    };
    const buildFor = (turn: Partial<SessionTurn> & { personalConnectionDelegations: unknown[] }) =>
      buildGitHubRestMcpForTurn({
        db: {} as Database,
        settings: testSettings({ githubRestMcpEnabled: true }),
        accountId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        sessionId: "00000000-0000-4000-8000-000000000003",
        attemptId: "00000000-0000-4000-8000-000000000004",
        turn: { id: "turn-1", ...turn } as unknown as SessionTurn,
        resources: [appOps, personalResource],
        tools: [],
        resolveCredential: async () => ({
          status: "auth_needed",
          reason: "missing_connection",
          providerDomain: "github.com",
        }),
      });
    const expectOnlyAppTools = (result: Awaited<ReturnType<typeof buildFor>>) => {
      // The workspace App repository keeps its tools.
      expect(result.localMcpServers.map((entry) => entry.id)).toEqual([
        GITHUB_REST_MCP_APP_SERVER_ID,
      ]);
      expect(result.tools).toEqual([{ kind: "mcp", id: GITHUB_REST_MCP_APP_SERVER_ID }]);
      expect(
        result.settings.mcpServers.some(
          (server) => server.id === GITHUB_REST_MCP_PERSONAL_SERVER_ID,
        ),
      ).toBe(false);
      expect(
        result.connectorBindings.some((binding) =>
          binding.modelName.startsWith(prefixedMcpToolName(GITHUB_REST_MCP_PERSONAL_SERVER_ID, "")),
        ),
      ).toBe(false);
    };

    test("a compaction checkpoint leaves the personal tools out quietly", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expectOnlyAppTools(
          await buildFor({ source: "compaction", personalConnectionDelegations: [] }),
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    test("any other turn leaves them out and logs a warning", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expectOnlyAppTools(await buildFor({ source: "goal", personalConnectionDelegations: [] }));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toMatchObject({ turnId: "turn-1", source: "goal" });
      } finally {
        warn.mockRestore();
      }
    });

    test("a malformed or ambiguous delegation still fails", async () => {
      const delegation = {
        serverId: "github:personal",
        connectionId: "11111111-1111-4111-8111-111111111111",
        originWorkspaceId: "00000000-0000-4000-8000-000000000005",
        ownerSubjectId: "user-1",
        providerDomain: "github.com",
        kind: "oauth2",
        connectionType: "github_personal",
        userDelegation: { grantId: "grant-1" },
        personalGitHubRepositorySelection: {
          credentialBindingId: "22222222-2222-4222-8222-222222222222",
          connectionAuthorityGeneration: 2,
          selectionGeneration: 4,
          repositories: [
            {
              repositoryId: "72",
              fullName: "Cloudgeni-ai/opengeni",
              canonicalUrl: "https://github.com/Cloudgeni-ai/opengeni",
              ref: "main",
              access: "write",
              selectionGeneration: 4,
            },
          ],
        },
      };
      // The complete delegation on its own builds the personal tools.
      const built = await buildFor({ source: "user", personalConnectionDelegations: [delegation] });
      expect(built.localMcpServers.map((entry) => entry.id)).toContain(
        GITHUB_REST_MCP_PERSONAL_SERVER_ID,
      );
      for (const delegations of [
        [{ ...delegation, connectionType: "mcp" }],
        [{ ...delegation, serverId: "github" }],
        [delegation, delegation],
        [delegation, { ...delegation, connectionId: "44444444-4444-4444-8444-444444444444" }],
      ]) {
        await expect(
          buildFor({ source: "user", personalConnectionDelegations: delegations }),
        ).rejects.toThrow(GitHubRestAuthorityError);
      }
    });
  });
});

async function build(input: { enabled: boolean; resource?: ResourceRef }) {
  return await buildGitHubRestMcpForTurn({
    db: {} as Database,
    settings: testSettings({ githubRestMcpEnabled: input.enabled }),
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    sessionId: "00000000-0000-4000-8000-000000000003",
    attemptId: "00000000-0000-4000-8000-000000000004",
    turn: { personalConnectionDelegations: [] } as SessionTurn,
    resources: [input.resource ?? appResource],
    tools: [],
    resolveCredential: async () => ({
      status: "auth_needed",
      reason: "missing_connection",
      providerDomain: "github.com",
    }),
  });
}

// GitHub refused Bendik's stored grant, and every personal GitHub tool said
// "Personal GitHub credential is unavailable". Agents now say what fixes it.
describe("personal GitHub tools when the grant needs reconnecting", () => {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const originWorkspaceId = "00000000-0000-4000-8000-000000000005";
  const connectionId = "11111111-1111-4111-8111-111111111111";
  const turn = {
    personalConnectionDelegations: [
      {
        serverId: "github:personal",
        connectionId,
        originWorkspaceId,
        ownerSubjectId: "user-1",
        providerDomain: "github.com",
        kind: "oauth2",
        connectionType: "github_personal",
        userDelegation: { grantId: "grant-1" },
        personalGitHubRepositorySelection: {
          credentialBindingId: "22222222-2222-4222-8222-222222222222",
          connectionAuthorityGeneration: 2,
          selectionGeneration: 4,
          repositories: [],
        },
      },
    ],
  } as unknown as SessionTurn;
  const storedConnection = (status: string, overrides: Record<string, unknown> = {}) =>
    (async () => ({
      id: connectionId,
      accountId,
      workspaceId: originWorkspaceId,
      subjectId: "user-1",
      providerDomain: "github.com",
      kind: "oauth2",
      status,
      metadata: {
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: "1234",
        githubUserId: "1234",
        githubLogin: "octocat",
        oauthEnvironment: "test",
        oauthClientMarker: "0123456789abcdef0123456789abcdef",
        credentialBindingId: "22222222-2222-4222-8222-222222222222",
        connectedAt: "2026-11-02T16:30:00.000Z",
        lastVerifiedAt: "2026-11-02T16:30:00.000Z",
      },
      ...overrides,
    })) as unknown as Parameters<typeof personalConnectionNeedsReconnect>[1];
  const input = { db: {} as Database, accountId, turn };

  test("a refused grant turns the generic failure into reconnect", async () => {
    const generic = new GitHubRestAuthorityError("Personal GitHub credential is unavailable");
    const needsReconnect = await personalConnectionNeedsReconnect(
      input,
      storedConnection("needs_reauth"),
    );
    expect(needsReconnect).toBe(true);
    const error = await personalReconnectOr(generic, async () => needsReconnect);
    expect(error.message).toBe(PERSONAL_GITHUB_RECONNECT_MESSAGE);
  });

  test("an active connection keeps the original failure", async () => {
    const generic = new GitHubRestAuthorityError("Personal GitHub credential is unavailable");
    expect(await personalConnectionNeedsReconnect(input, storedConnection("active"))).toBe(false);
    expect(await personalReconnectOr(generic, async () => false)).toBe(generic);
  });

  test("another account's row or a failed lookup never claims reconnect", async () => {
    expect(
      await personalConnectionNeedsReconnect(
        input,
        storedConnection("needs_reauth", { accountId: "00000000-0000-4000-8000-0000000000ff" }),
      ),
    ).toBe(false);
    const failing = (async () => {
      throw new Error("database unavailable");
    }) as unknown as Parameters<typeof personalConnectionNeedsReconnect>[1];
    expect(await personalConnectionNeedsReconnect(input, failing)).toBe(false);
    const generic = new GitHubRestAuthorityError("Personal GitHub credential is unavailable");
    expect(
      await personalReconnectOr(generic, async () => {
        throw new Error("database unavailable");
      }),
    ).toBe(generic);
  });
});
