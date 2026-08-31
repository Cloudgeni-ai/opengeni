// Workspace-owned MCP connections no longer bypass the accepted connection-use
// authority (migration 0279): the worker authorizes the exact workspace row
// through the same fences and audit facts as personal delegations, keeping
// only the bounded pre-snapshot legacy path (a ref with no connection id).
import { describe, expect, test } from "bun:test";
import type { SessionTurn } from "@opengeni/contracts";
import type { Database, resolveAcceptedConnectionUse } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { connectionTokenResolverForTurn } from "../src/activities/mcp-credentials";

type AuthorizeInput = Parameters<typeof resolveAcceptedConnectionUse>[1];

const WORKSPACE_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

const turn = {
  id: "turn-1",
  executionGeneration: 4,
  personalConnectionDelegations: [],
  initiator: { kind: "subject", subjectId: "user:someone", label: "Someone" },
  initiatorContext: { source: "test" },
} as unknown as SessionTurn;

function workspaceResolver(input: {
  authorize: (
    authority: AuthorizeInput,
  ) => Awaited<ReturnType<typeof resolveAcceptedConnectionUse>>;
  onHostRequest?: (request: unknown) => void;
  activated?: boolean;
}) {
  return connectionTokenResolverForTurn({
    db: {} as Database,
    settings: testSettings(),
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    rootSessionId: "session-root",
    attemptId: "attempt-1",
    turn,
    authorizeAcceptedUse: async (_db, authority) => input.authorize(authority),
    isSessionTenancyProductActivated: async () => input.activated ?? false,
    connectionCredentials: {
      mcpCredentials: async (request) => {
        input.onHostRequest?.(request);
        return {
          status: "ok",
          accountId: request.accountId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          headers: { Authorization: "Bearer workspace-owned" },
          connectionId: request.connectionRef.connectionId ?? WORKSPACE_CONNECTION_ID,
          providerDomain: request.connectionRef.providerDomain,
          ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
        };
      },
    },
  });
}

const workspaceRequest = {
  workspaceId: "workspace-1",
  serverId: "linear",
  destinationUrl: "https://mcp.linear.app/mcp",
  toolName: "create_issue",
  connectionRef: {
    provider: "linear",
    providerDomain: "linear.app",
    connectionId: WORKSPACE_CONNECTION_ID,
    kind: "oauth2" as const,
    subjectScope: "workspace" as const,
  },
};

describe("workspace connection lane", () => {
  test("authorizes the exact workspace connection and wraps provider requests", async () => {
    const authorized: AuthorizeInput[] = [];
    let hostCalls = 0;
    const resolver = workspaceResolver({
      authorize: (authority) => {
        authorized.push(authority);
        return {
          status: "authorized" as const,
          originWorkspaceId: "workspace-1",
          connectionKind: "oauth2" as const,
          attribution: {
            organizationId: "account-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            connectionId: WORKSPACE_CONNECTION_ID,
            connectionGeneration: 2,
            scope: "workspace" as const,
            ownerSubjectId: null,
            authorityId: null,
            grantId: null,
          },
        };
      },
      onHostRequest: () => {
        hostCalls += 1;
      },
    });
    const result = await resolver(workspaceRequest);
    expect(result.status).toBe("ok");
    expect(hostCalls).toBe(1);
    expect(authorized).toHaveLength(1);
    expect(authorized[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      executionGeneration: 4,
      usePhase: "credential_resolution",
      serverId: "linear",
      connectionId: WORKSPACE_CONNECTION_ID,
      providerDomain: "linear.app",
      connectionKind: "oauth2",
      subjectScope: "workspace",
    });
    // The workspace lane never carries a personal owner binding.
    expect("ownerSubjectId" in authorized[0]!).toBe(false);
    if (result.status !== "ok" || !result.authorizeProviderRequest) {
      throw new Error("provider authorization hook was not returned");
    }
    expect(await result.authorizeProviderRequest()).toBe(true);
    expect(authorized).toHaveLength(2);
    expect(authorized[1]).toMatchObject({ usePhase: "provider_request" });
    expect(authorized[0]!.physicalRequestId).not.toBe(authorized[1]!.physicalRequestId);
  });

  test("a denied workspace connection never reaches the host port", async () => {
    let hostCalls = 0;
    const resolver = workspaceResolver({
      authorize: () => ({ status: "denied" as const, reason: "connection_status_inactive" }),
      onHostRequest: () => {
        hostCalls += 1;
      },
    });
    const result = await resolver(workspaceRequest);
    expect(result).toMatchObject({ status: "auth_needed", reason: "missing_connection" });
    expect(hostCalls).toBe(0);
  });

  test("opaque host bindings bypass native UUID authority and reach the host", async () => {
    let authorizeCalls = 0;
    let hostCalls = 0;
    const resolver = workspaceResolver({
      activated: true,
      authorize: () => {
        authorizeCalls += 1;
        throw new Error("opaque host bindings must not enter native connection authority");
      },
      onHostRequest: () => {
        hostCalls += 1;
      },
    });

    const result = await resolver({
      ...workspaceRequest,
      serverId: "cloudgeni-capability",
      destinationUrl: "https://api.example.test/embedded/capability-mcp/mcp",
      connectionRef: {
        providerDomain: "api.example.test",
        connectionId: "cloudgeni-capability",
        kind: "delegated" as const,
        subjectScope: "workspace" as const,
      },
    });

    expect(result).toMatchObject({ status: "ok", connectionId: "cloudgeni-capability" });
    expect(result).not.toHaveProperty("authorizeProviderRequest");

    const invalidUuidShapedId = "aaaaaaaa-aaaa-0aaa-0aaa-aaaaaaaaaaaa";
    const invalidUuidShapedResult = await resolver({
      ...workspaceRequest,
      serverId: "host-invalid-uuid-shape",
      destinationUrl: "https://api.example.test/embedded/host-mcp/mcp",
      connectionRef: {
        providerDomain: "api.example.test",
        connectionId: invalidUuidShapedId,
        kind: "delegated" as const,
        subjectScope: "workspace" as const,
      },
    });

    expect(invalidUuidShapedResult).toMatchObject({
      status: "ok",
      connectionId: invalidUuidShapedId,
    });
    expect(invalidUuidShapedResult).not.toHaveProperty("authorizeProviderRequest");
    expect(authorizeCalls).toBe(0);
    expect(hostCalls).toBe(2);
  });

  test("a ref with no connection id keeps the bounded pre-snapshot legacy path", async () => {
    let authorizeCalls = 0;
    let hostCalls = 0;
    const resolver = workspaceResolver({
      authorize: () => {
        authorizeCalls += 1;
        return { status: "denied" as const, reason: "connection_missing" };
      },
      onHostRequest: () => {
        hostCalls += 1;
      },
    });
    const result = await resolver({
      ...workspaceRequest,
      connectionRef: {
        provider: "linear",
        providerDomain: "linear.app",
        kind: "oauth2" as const,
        subjectScope: "workspace" as const,
      },
    });
    expect(result.status).toBe("ok");
    expect(authorizeCalls).toBe(0);
    expect(hostCalls).toBe(1);
  });

  test("an activated organization rejects a ref with no connection id before host resolution", async () => {
    let authorizeCalls = 0;
    let hostCalls = 0;
    const resolver = workspaceResolver({
      activated: true,
      authorize: () => {
        authorizeCalls += 1;
        return { status: "denied" as const, reason: "connection_missing" };
      },
      onHostRequest: () => {
        hostCalls += 1;
      },
    });

    const result = await resolver({
      ...workspaceRequest,
      connectionRef: {
        provider: "linear",
        providerDomain: "linear.app",
        kind: "oauth2" as const,
        subjectScope: "workspace" as const,
      },
    });

    expect(result).toMatchObject({ status: "auth_needed", reason: "missing_connection" });
    expect(authorizeCalls).toBe(0);
    expect(hostCalls).toBe(0);
  });
});
