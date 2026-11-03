import { describe, expect, test } from "bun:test";
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
