import { expect, test } from "bun:test";
import type { Database, SessionTurnForExecution } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { connectionTokenResolverForTurn } from "../src/activities/mcp-credentials";

test.each([
  "missing",
  "different_turn",
  "different_generation",
  "outage",
  "after_resolution",
  "physical",
] as const)("host execution checks canonical attempt liveness: %s", async (mode) => {
  let checks = 0;
  let hostCalls = 0;
  let active = true;
  const accepted = {
    id: "turn-1",
    executionGeneration: 3,
    personalConnectionDelegations: [],
    initiator: { kind: "service", subjectId: "scheduler" },
    initiatorContext: {},
  } as SessionTurnForExecution;
  const resolver = connectionTokenResolverForTurn({
    db: {} as Database,
    settings: testSettings(),
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    rootSessionId: "root-1",
    attemptId: "attempt-1",
    turn: accepted,
    getHostTurnForAttempt: async (_db, workspaceId, sessionId, attemptId) => {
      checks++;
      expect([workspaceId, sessionId, attemptId]).toEqual([
        "workspace-1",
        "session-1",
        "attempt-1",
      ]);
      if (mode === "outage") throw new Error("synthetic database outage");
      if (mode === "missing" || !active) return null;
      return {
        ...accepted,
        id: mode === "different_turn" ? "other-turn" : "turn-1",
        executionGeneration: mode === "different_generation" ? 4 : 3,
      };
    },
    connectionCredentials: {
      mcpAuthoritySource: "host",
      mcpCredentials: async (request) => {
        hostCalls++;
        if (mode === "after_resolution") active = false;
        return {
          status: "ok",
          accountId: request.accountId,
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          connectionId: request.connectionRef.connectionId,
          providerDomain: request.connectionRef.providerDomain,
          headers: { Authorization: "Bearer synthetic" },
        };
      },
    },
  });
  const result = await resolver({
    workspaceId: "workspace-1",
    serverId: "host-tools",
    destinationUrl: "https://host.example/mcp",
    connectionRef: {
      authoritySource: "host",
      connectionId: "opaque",
      providerDomain: "host.example",
    },
  });
  if (mode === "physical") {
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected host credentials");
    expect(checks).toBe(2);
    expect(await result.authorizeProviderRequest?.()).toBe(true);
    active = false;
    expect(await result.authorizeProviderRequest?.()).toBe(false);
    expect(hostCalls).toBe(1);
  } else {
    expect(result).toMatchObject({
      status: "auth_needed",
      authoritySource: "host",
      reason: mode === "outage" ? "refresh_failed" : "resource_scope_unavailable",
    });
    expect(result).not.toHaveProperty("headers");
    expect(hostCalls).toBe(mode === "after_resolution" ? 1 : 0);
  }
});
