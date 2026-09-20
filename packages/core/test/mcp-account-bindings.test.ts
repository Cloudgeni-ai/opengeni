import { expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import {
  mcpAccountBindingsFromVisibleConnections,
  mcpAccountRouteId,
  personalDelegationsForAccountBindings,
} from "../src/domain/mcp-account-bindings";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const server = {
  id: "slack",
  url: "https://slack.example.test/mcp",
  cacheToolsList: false,
  connectionRef: { providerDomain: "slack.example.test", kind: "oauth2" as const },
};
function connection(subjectId: string | null = "alice"): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId,
    workspaceId,
    subjectId,
    ...(subjectId ? { authorityId: crypto.randomUUID() } : {}),
    providerDomain: "slack.example.test",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { displayName: "Alice", slackTeamName: "Example" },
    createdBySubjectId: "alice",
    updatedBySubjectId: "alice",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}
const input = { accountId, workspaceId, subjectId: "alice", servers: [server] };

test("workspace and two personal accounts attach with distinct exact routes", () => {
  const connections = [connection(null), connection(), connection()];
  const bindings = mcpAccountBindingsFromVisibleConnections({ ...input, connections });
  expect(bindings).toHaveLength(3);
  expect(new Set(bindings.map((binding) => binding.serverId)).size).toBe(3);
  expect(bindings.every((binding) => binding.canonicalServerId === "slack")).toBe(true);
  expect(
    bindings.find((binding) => binding.subjectScope === "workspace")?.ownerSubjectId,
  ).toBeNull();
  expect(personalDelegationsForAccountBindings(bindings)).toHaveLength(2);
  expect(bindings.map((binding) => binding.accountLabel)).toContain("Alice · Example · Only me");
});

test("explicit workspace-only selection excludes personal accounts", () => {
  const shared = connection(null);
  const bindings = mcpAccountBindingsFromVisibleConnections({
    ...input,
    connections: [shared, connection()],
    selections: [{ serverId: server.id, connectionId: shared.id }],
  });
  expect(bindings).toHaveLength(1);
  expect(bindings[0]?.subjectScope).toBe("workspace");
  expect(personalDelegationsForAccountBindings(bindings)).toEqual([]);
});

test("other users, organizations and workspaces cannot enter the binding set", () => {
  const connections = [
    connection("bob"),
    { ...connection(), accountId: crypto.randomUUID() },
    { ...connection(null), workspaceId: crypto.randomUUID() },
  ];
  expect(mcpAccountBindingsFromVisibleConnections({ ...input, connections })).toEqual([]);
  for (const candidate of connections) {
    expect(() =>
      mcpAccountBindingsFromVisibleConnections({
        ...input,
        connections,
        selections: [{ serverId: server.id, connectionId: candidate.id }],
      }),
    ).toThrow("unavailable");
  }
});

test("personal cross-workspace inventory requires the same authenticated owner", () => {
  const personal = { ...connection(), workspaceId: crypto.randomUUID() };
  expect(
    mcpAccountBindingsFromVisibleConnections({ ...input, connections: [personal] }),
  ).toHaveLength(1);
  expect(
    mcpAccountBindingsFromVisibleConnections({
      ...input,
      subjectId: null,
      connections: [personal],
    }),
  ).toEqual([]);
});

test("missing selected account never falls back to another eligible account", () => {
  expect(() =>
    mcpAccountBindingsFromVisibleConnections({
      ...input,
      connections: [connection()],
      selections: [{ serverId: server.id, connectionId: crypto.randomUUID() }],
    }),
  ).toThrow("unavailable");
});

test("resource constraints are enforced before attaching accounts", () => {
  const resource = "https://slack.example.test/team/one";
  const matching = { ...connection(), metadata: { resource: `${resource}/` } };
  const other = { ...connection(), metadata: { resource: "https://slack.example.test/team/two" } };
  const bindings = mcpAccountBindingsFromVisibleConnections({
    ...input,
    servers: [{ ...server, connectionRef: { ...server.connectionRef, resource } }],
    connections: [matching, other, connection()],
  });
  expect(bindings).toHaveLength(1);
  expect(bindings[0]?.connectionId).toBe(matching.id);
});

test("route identity is stable, bounded and distinguishes connector surfaces", () => {
  const id = crypto.randomUUID();
  expect(mcpAccountRouteId("slack", id)).toBe(mcpAccountRouteId("slack", id));
  expect(mcpAccountRouteId("slack", id)).not.toBe(mcpAccountRouteId("mail", id));
  expect(mcpAccountRouteId("x".repeat(256), id).length).toBeLessThan(256);
});
