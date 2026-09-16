import { expect, test } from "bun:test";
import {
  McpConnectionAccountSelection,
  SessionUserMessagePayload,
  SteerSessionMessageRequest,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import {
  personalConnectionDelegationsFromParent,
  personalConnectionDelegationsFromVisibleConnections,
} from "../src/domain/personal-connection-delegations";

const server = {
  id: "mail",
  url: "https://mail.example.test/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
    subjectScope: "subject" as const,
  },
};

function connection(subjectId = "user:alice"): ConnectionMetadata {
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    authorityId: crypto.randomUUID(),
    subjectId,
    providerDomain: "mail.example.test",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: subjectId,
    updatedBySubjectId: subjectId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("the sender's active account is selected without a conversation grant", () => {
  const alice = connection();
  const bob = connection("user:bob");
  expect(
    personalConnectionDelegationsFromVisibleConnections({
      servers: [server],
      subjectId: "user:alice",
      connections: [bob, alice],
    }),
  ).toEqual([
    {
      serverId: server.id,
      connectionId: alice.id,
      originWorkspaceId: alice.workspaceId,
      ownerSubjectId: "user:alice",
      providerDomain: alice.providerDomain,
      kind: "oauth2",
    },
  ]);
});

test("an account choice cannot select another participant's connection", () => {
  const bob = connection("user:bob");
  expect(() =>
    personalConnectionDelegationsFromVisibleConnections({
      servers: [server],
      subjectId: "user:alice",
      connections: [bob],
      authoritySelections: [{ serverId: server.id, connectionId: bob.id }],
    }),
  ).toThrow("Selected account is unavailable for: mail");
});

test("multiple accounts require a choice and preserve the chosen older account", () => {
  const older = connection();
  const newer = { ...connection(), updatedAt: "2026-02-01T00:00:00.000Z" };
  const input = { servers: [server], subjectId: "user:alice", connections: [newer, older] };
  expect(() => personalConnectionDelegationsFromVisibleConnections(input)).toThrow(
    "Choose an account",
  );
  expect(
    personalConnectionDelegationsFromVisibleConnections({
      ...input,
      authoritySelections: [{ serverId: server.id, connectionId: older.id }],
    }),
  ).toMatchObject([{ connectionId: older.id }]);
});

test("child work retains the parent's account and owner", () => {
  const selected = personalConnectionDelegationsFromVisibleConnections({
    servers: [server],
    subjectId: "user:alice",
    connections: [connection()],
  });
  expect(
    personalConnectionDelegationsFromParent({
      servers: [server],
      parentDelegations: selected,
      targetSessionId: crypto.randomUUID(),
    }),
  ).toEqual(selected);
});

test("account-choice inputs accept neither ownership nor old consent grants", () => {
  const choice = { serverId: server.id, connectionId: crypto.randomUUID() };
  expect(McpConnectionAccountSelection.safeParse(choice).success).toBe(true);
  expect(
    McpConnectionAccountSelection.safeParse({ ...choice, ownerSubjectId: "user:bob" }).success,
  ).toBe(false);
  expect(McpConnectionAccountSelection.safeParse({ ...choice, userDelegation: {} }).success).toBe(
    false,
  );
});

test("messages and steering reject obsolete consent payloads instead of silently ignoring them", () => {
  for (const schema of [SessionUserMessagePayload, SteerSessionMessageRequest]) {
    expect(schema.safeParse({ text: "hello", connectionAuthorities: [] }).success).toBe(false);
    expect(schema.safeParse({ text: "hello", connectionAccounts: [] }).success).toBe(true);
  }
});

test("legacy rows without canonical ownership cannot become sender account selections", () => {
  expect(
    personalConnectionDelegationsFromVisibleConnections({
      servers: [server],
      subjectId: "user:alice",
      connections: [{ ...connection(), authorityId: null }],
    }),
  ).toEqual([]);
});
