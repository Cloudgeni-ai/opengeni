import { describe, expect, test } from "bun:test";
import type { McpCredentialsRequest, SessionTurn } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { connectionTokenResolverForTurn } from "../src/activities/mcp-credentials";

describe("connectionTokenResolverForTurn", () => {
  test("prefers the host port and binds the model request to immutable turn authority", async () => {
    let received: McpCredentialsRequest | null = null;
    const turn = {
      id: "turn-1",
      executionGeneration: 8,
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
      connectionCredentials: {
        mcpCredentials: async (request) => {
          received = request;
          return {
            status: "ok",
            accountId: request.accountId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            headers: { Authorization: "Bearer host-owned" },
            connectionId: "connection-1",
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
      toolName: "merge_request_create",
      connectionRef: {
        provider: "gitlab",
        providerDomain: "gitlab.example",
        connectionId: "connection-1",
        kind: "oauth2",
        selectedResources: [{ kind: "repository", id: "44" }],
      },
    });

    expect(received).toEqual({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      turnId: "turn-1",
      attemptId: "attempt-1",
      executionGeneration: 8,
      initiator: { kind: "subject", subjectId: "host:user:9", label: "Grace" },
      initiatorContext: { source: "embedded-host" },
      callerSubjectId: "worker:first-party-mcp",
      surface: "model",
      serverId: "gitlab",
      toolName: "merge_request_create",
      connectionRef: {
        provider: "gitlab",
        providerDomain: "gitlab.example",
        connectionId: "connection-1",
        kind: "oauth2",
        selectedResources: [{ kind: "repository", id: "44" }],
      },
      forceRefresh: false,
    });
    expect(result).toEqual({
      status: "ok",
      headers: { Authorization: "Bearer host-owned" },
      connectionId: "connection-1",
    });
  });
});
