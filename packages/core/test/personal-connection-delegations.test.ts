import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata, McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  personalConnectionDelegationSourceForGrant,
  personalConnectionDelegationsFromParent,
  personalConnectionDelegationsFromVisibleConnections,
} from "../src/domain/personal-connection-delegations";

const personalServer = {
  id: "linear",
  url: "https://mcp.linear.app/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "linear.app",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};

describe("personal MCP connection delegation", () => {
  test("uses human/API subjects but copies authority for agent attempts", () => {
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "user:owner",
        principalKind: "human_session",
        permissions: [],
      }),
    ).toEqual({ kind: "subject", subjectId: "user:owner" });
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        principalKind: "agent_attempt",
        permissions: [],
        metadata: { sessionId: "parent-session", turnId: "parent-turn" },
      }),
    ).toEqual({ kind: "turn", sessionId: "parent-session", turnId: "parent-turn" });
    expect(
      personalConnectionDelegationSourceForGrant({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        principalKind: "agent_attempt",
        permissions: [],
        metadata: { sessionId: "parent-session" },
      }),
    ).toEqual({ kind: "none" });
  });

  test("freezes only an active exact subject connection", () => {
    const active: ConnectionMetadata = {
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:owner",
      providerDomain: "linear.app",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "user:owner",
      updatedBySubjectId: "user:owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = personalConnectionDelegationsFromVisibleConnections({
      servers: [personalServer],
      subjectId: "user:owner",
      connections: [
        { ...active, id: crypto.randomUUID(), status: "revoked" },
        { ...active, id: crypto.randomUUID(), subjectId: "someone-else" },
        active,
      ],
    });
    expect(result).toEqual([
      {
        serverId: "linear",
        connectionId: active.id,
        ownerSubjectId: "user:owner",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    ]);
  });

  test("uses the same deterministic active-row order as runtime resolution", () => {
    const base: ConnectionMetadata = {
      id: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:owner",
      providerDomain: "LINEAR.APP",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "user:owner",
      updatedBySubjectId: "user:owner",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const newest = {
      ...base,
      id: crypto.randomUUID(),
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(
      personalConnectionDelegationsFromVisibleConnections({
        servers: [personalServer],
        subjectId: "user:owner",
        connections: [base, newest],
      }),
    ).toMatchObject([{ connectionId: newest.id, providerDomain: "LINEAR.APP" }]);
  });

  test("children copy only selected server-bound grants", () => {
    const parent: McpPersonalConnectionDelegation[] = [
      {
        serverId: "linear",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: "user:owner",
        providerDomain: "linear.app",
        kind: "oauth2",
      },
      {
        serverId: "other",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: "user:owner",
        providerDomain: "other.example",
        kind: "oauth2",
      },
    ];
    expect(
      personalConnectionDelegationsFromParent({
        servers: [personalServer],
        parentDelegations: parent,
      }),
    ).toEqual([parent[0]]);
  });
});
