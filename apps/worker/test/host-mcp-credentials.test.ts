import { describe, expect, test } from "bun:test";
import type { McpCredentialsRequest, SessionTurn } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { connectionTokenResolverForTurn } from "../src/activities/mcp-credentials";

const SUBJECT_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

describe("connectionTokenResolverForTurn", () => {
  test("admits only the reserved personal GitHub API lane for a frozen GitHub delegation", async () => {
    let hostCalls = 0;
    const turn = {
      id: "turn-github",
      executionGeneration: 3,
      personalConnectionDelegations: [
        {
          serverId: "github:personal",
          connectionType: "github_personal",
          connectionId: "11111111-1111-4111-8111-111111111111",
          ownerSubjectId: "host:user:9",
          originWorkspaceId: "origin-workspace",
          providerDomain: "github.com",
          kind: "oauth2",
          userDelegation: { grantId: "grant-1" },
          personalGitHubRepositorySelection: {},
        },
      ],
      initiator: { kind: "subject", subjectId: "host:user:9" },
      initiatorContext: {},
    } as SessionTurn;
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-1",
      turn,
      authorizeAcceptedUse: async (_db, authority) => ({
        status: "authorized" as const,
        originWorkspaceId: "origin-workspace",
        connectionKind: "oauth2" as const,
        attribution: {
          organizationId: authority.accountId,
          workspaceId: authority.workspaceId,
          sessionId: authority.sessionId,
          connectionId: "11111111-1111-4111-8111-111111111111",
          connectionGeneration: 2,
          scope: "user" as const,
          ownerSubjectId: "host:user:9",
          authorityId: "authority-1",
          grantId: "grant-1",
        },
      }),
      connectionCredentials: {
        mcpCredentials: async (request) => {
          hostCalls += 1;
          return {
            status: "ok",
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: "Bearer host-owned" },
            connectionId: "11111111-1111-4111-8111-111111111111",
            providerDomain: "github.com",
            provider: "github",
          };
        },
      },
    });
    const exact = {
      workspaceId: "workspace-1",
      subjectId: "host:user:9",
      serverId: "github:personal",
      destinationUrl: "https://api.github.com/repos/Cloudgeni-ai/opengeni",
      credentialTarget: "http_api" as const,
      connectionRef: {
        provider: "github",
        providerDomain: "github.com",
        connectionId: "11111111-1111-4111-8111-111111111111",
        kind: "oauth2" as const,
        subjectScope: "subject" as const,
      },
    };
    expect(await resolver(exact)).toMatchObject({ status: "ok" });
    await expect(
      resolver({ ...exact, serverId: "attacker", connectionRef: exact.connectionRef }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "personal_authority_unavailable" });
    await expect(
      resolver({ ...exact, destinationUrl: "https://github.com.attacker.invalid/token" }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "personal_authority_unavailable" });
    await expect(resolver({ ...exact, credentialTarget: "mcp" })).resolves.toMatchObject({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
    });
    expect(hostCalls).toBe(1);
  });

  test("prefers the host port and binds the model request to immutable turn authority", async () => {
    let received: McpCredentialsRequest | null = null;
    let authorizationCalls = 0;
    const authorizationUses: Array<{ phase: string; requestId: string }> = [];
    const turn = {
      id: "turn-1",
      executionGeneration: 8,
      personalConnectionDelegations: [
        {
          serverId: "gitlab",
          connectionId: SUBJECT_CONNECTION_ID,
          ownerSubjectId: "host:user:9",
          providerDomain: "gitlab.example",
          kind: "oauth2",
          userDelegation: { grantId: "grant-1" },
        },
      ],
      initiator: { kind: "subject", subjectId: "host:user:9", label: "Grace" },
      initiatorContext: { source: "embedded-host" },
    } as SessionTurn;
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-1",
      turn,
      authorizeAcceptedUse: async (_db, authority) => {
        authorizationCalls += 1;
        authorizationUses.push({
          phase: authority.usePhase,
          requestId: authority.physicalRequestId,
        });
        return {
          status: "authorized" as const,
          originWorkspaceId: authority.workspaceId,
          connectionKind: "oauth2" as const,
          attribution: {
            organizationId: authority.accountId,
            workspaceId: authority.workspaceId,
            sessionId: authority.sessionId,
            connectionId: SUBJECT_CONNECTION_ID,
            connectionGeneration: 3,
            scope: "user" as const,
            ownerSubjectId: "host:user:9",
            authorityId: "authority-1",
            grantId: "grant-1",
          },
        };
      },
      connectionCredentials: {
        mcpCredentials: async (request) => {
          received = request;
          return {
            status: "ok",
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: "Bearer host-owned" },
            connectionId: SUBJECT_CONNECTION_ID,
            providerDomain: request.connectionRef.providerDomain,
            ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
            ...(request.connectionRef.selectedResources
              ? { selectedResources: request.connectionRef.selectedResources }
              : {}),
          };
        },
      },
    });

    const result = await resolver({
      workspaceId: "workspace-1",
      subjectId: "worker:first-party-mcp",
      serverId: "gitlab",
      destinationUrl: "https://gitlab.example/mcp",
      toolName: "merge_request_create",
      connectionRef: {
        provider: "gitlab",
        providerDomain: "gitlab.example",
        connectionId: SUBJECT_CONNECTION_ID,
        kind: "oauth2",
        subjectScope: "subject",
        selectedResources: [{ kind: "repository", id: "44" }],
      },
    });

    expect(received).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      turnId: "turn-1",
      attemptId: "attempt-1",
      executionGeneration: 8,
      initiator: { kind: "subject", subjectId: "host:user:9", label: "Grace" },
      initiatorContext: { source: "embedded-host" },
      callerSubjectId: "host:user:9",
      surface: "model",
      serverId: "gitlab",
      toolName: "merge_request_create",
      destinationUrl: "https://gitlab.example/mcp",
      credentialTarget: "mcp",
      connectionRef: {
        provider: "gitlab",
        providerDomain: "gitlab.example",
        connectionId: SUBJECT_CONNECTION_ID,
        kind: "oauth2",
        selectedResources: [{ kind: "repository", id: "44" }],
      },
      forceRefresh: false,
      connectionUseAuthority: {
        connectionId: SUBJECT_CONNECTION_ID,
        connectionGeneration: 3,
        scope: "user",
      },
    });
    expect(received?.connectionUseRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result).toEqual({
      status: "ok",
      headers: { Authorization: "Bearer host-owned" },
      authoritySource: "host",
      connectionId: SUBJECT_CONNECTION_ID,
      authorizeProviderRequest: expect.any(Function),
    });
    if (result.status !== "ok" || !result.authorizeProviderRequest) {
      throw new Error("provider authorization hook was not returned");
    }
    expect(await result.authorizeProviderRequest()).toBe(true);
    expect(authorizationCalls).toBe(2);
    expect(authorizationUses.map((use) => use.phase)).toEqual([
      "credential_resolution",
      "provider_request",
    ]);
    expect(authorizationUses[0]?.requestId).not.toBe(authorizationUses[1]?.requestId);
  });

  test("reads already-stored explicit host authority independently of admission posture", async () => {
    let hostCalls = 0;
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-1",
      turn: {
        id: "turn-1",
        executionGeneration: 1,
        personalConnectionDelegations: [],
        initiator: { kind: "service", subjectId: "embedding-service" },
        initiatorContext: {},
      } as SessionTurn,
      connectionCredentials: {
        mcpCredentials: async (request) => {
          hostCalls += 1;
          return {
            status: "ok",
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: "Bearer already-stored" },
            connectionId: "opaque-host-binding",
            providerDomain: "host.example.test",
          };
        },
      },
    });

    await expect(
      resolver({
        workspaceId: "workspace-1",
        serverId: "host-tools",
        destinationUrl: "https://host.example.test/mcp",
        connectionRef: {
          authoritySource: "host",
          connectionId: "opaque-host-binding",
          providerDomain: "host.example.test",
        },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      authoritySource: "host",
      connectionId: "opaque-host-binding",
    });
    expect(hostCalls).toBe(1);
  });

  test("denies a stale accepted attempt before invoking the host", async () => {
    let hostCalls = 0;
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-stale",
      turn: {
        id: "turn-1",
        executionGeneration: 8,
        personalConnectionDelegations: [
          {
            serverId: "gitlab",
            connectionId: SUBJECT_CONNECTION_ID,
            ownerSubjectId: "host:user:9",
            providerDomain: "gitlab.example",
            kind: "oauth2",
            userDelegation: { grantId: "grant-1" },
          },
        ],
        initiator: { kind: "subject", subjectId: "host:user:9" },
        initiatorContext: {},
      } as SessionTurn,
      authorizeAcceptedUse: async () => ({
        status: "denied",
        reason: "session_identity_changed",
      }),
      connectionCredentials: {
        mcpCredentials: async () => {
          hostCalls += 1;
          throw new Error("host must not be invoked after authority denial");
        },
      },
    });

    await expect(
      resolver({
        workspaceId: "workspace-1",
        serverId: "gitlab",
        destinationUrl: "https://gitlab.example/mcp",
        connectionRef: {
          providerDomain: "gitlab.example",
          connectionId: SUBJECT_CONNECTION_ID,
          kind: "oauth2",
          subjectScope: "subject",
        },
      }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "personal_authority_unavailable" });
    expect(hostCalls).toBe(0);
  });

  test("denies the target request after delayed host credentials are revoked", async () => {
    let authorizationCalls = 0;
    let hostCalls = 0;
    const authorizationUses: Array<{ phase: string; requestId: string }> = [];
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-1",
      turn: {
        id: "turn-1",
        executionGeneration: 2,
        personalConnectionDelegations: [
          {
            serverId: "gitlab",
            connectionId: SUBJECT_CONNECTION_ID,
            ownerSubjectId: "host:user:9",
            providerDomain: "gitlab.example",
            kind: "oauth2",
            userDelegation: { grantId: "grant-1" },
          },
        ],
        initiator: { kind: "subject", subjectId: "host:user:9" },
        initiatorContext: {},
      } as SessionTurn,
      authorizeAcceptedUse: async (_db, authority) => {
        authorizationCalls += 1;
        authorizationUses.push({
          phase: authority.usePhase,
          requestId: authority.physicalRequestId,
        });
        if (authorizationCalls === 2) {
          return { status: "denied" as const, reason: "grant_status_inactive" as const };
        }
        return {
          status: "authorized" as const,
          originWorkspaceId: authority.workspaceId,
          connectionKind: "oauth2" as const,
          attribution: {
            organizationId: authority.accountId,
            workspaceId: authority.workspaceId,
            sessionId: authority.sessionId,
            connectionId: SUBJECT_CONNECTION_ID,
            connectionGeneration: 3,
            scope: "user" as const,
            ownerSubjectId: "host:user:9",
            authorityId: "authority-1",
            grantId: "grant-1",
          },
        };
      },
      connectionCredentials: {
        mcpCredentials: async (request) => {
          hostCalls += 1;
          return {
            status: "ok",
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: "Bearer must-be-discarded" },
            connectionId: SUBJECT_CONNECTION_ID,
            providerDomain: request.connectionRef.providerDomain,
          };
        },
      },
    });

    const result = await resolver({
      workspaceId: "workspace-1",
      subjectId: "host:user:9",
      serverId: "gitlab",
      destinationUrl: "https://gitlab.example/mcp",
      connectionRef: {
        providerDomain: "gitlab.example",
        connectionId: SUBJECT_CONNECTION_ID,
        kind: "oauth2",
        subjectScope: "subject",
      },
    });
    expect(result).toMatchObject({ status: "ok", connectionId: SUBJECT_CONNECTION_ID });
    if (result.status !== "ok" || !result.authorizeProviderRequest) {
      throw new Error("provider authorization hook was not returned");
    }
    expect(await result.authorizeProviderRequest()).toBe(false);
    expect(hostCalls).toBe(1);
    expect(authorizationCalls).toBe(2);
    expect(authorizationUses.map((use) => use.phase)).toEqual([
      "credential_resolution",
      "provider_request",
    ]);
    expect(authorizationUses[0]?.requestId).not.toBe(authorizationUses[1]?.requestId);
  });

  test("pre-cutover common-user work without a snapshot never reaches the host", async () => {
    let hostCalls = 0;
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-1",
      turn: {
        id: "turn-pre-cutover",
        executionGeneration: 1,
        personalConnectionDelegations: [
          {
            serverId: "gitlab",
            connectionId: SUBJECT_CONNECTION_ID,
            ownerSubjectId: "host:user:9",
            providerDomain: "gitlab.example",
            kind: "oauth2",
          },
        ],
        initiator: { kind: "subject", subjectId: "host:user:9" },
        initiatorContext: {},
      } as SessionTurn,
      authorizeAcceptedUse: async () => ({
        status: "denied",
        reason: "connection_missing",
      }),
      connectionCredentials: {
        mcpCredentials: async () => {
          hostCalls += 1;
          throw new Error("host must not receive a pre-cutover common-user request");
        },
      },
    });

    await expect(
      resolver({
        workspaceId: "workspace-1",
        subjectId: "host:user:9",
        serverId: "gitlab",
        destinationUrl: "https://gitlab.example/mcp",
        connectionRef: {
          providerDomain: "gitlab.example",
          connectionId: SUBJECT_CONNECTION_ID,
          kind: "oauth2",
          subjectScope: "subject",
        },
      }),
    ).resolves.toMatchObject({ status: "auth_needed", reason: "personal_authority_unavailable" });
    expect(hostCalls).toBe(0);
  });
});
