import { expect, test } from "bun:test";
import type { ConnectionMetadata, UserResourceAuthoritySummary } from "@opengeni/contracts";
import { defaultPersonalConnectionSelections } from "../src/domain/personal-connection-delegations";

const connection = {
  id: "connection",
  workspaceId: "workspace",
  subjectId: "owner",
  status: "active",
  authorityId: "authority",
  providerDomain: "example.com",
  kind: "oauth2",
} as ConnectionMetadata;
const authority = {
  authorityId: "authority",
  resourceKind: "connection",
  resourceId: "connection",
  originWorkspaceId: "workspace",
  generation: 1,
  status: "active",
  grants: [
    {
      grantId: "grant",
      mode: "always",
      status: "active",
      action: "connection.use",
      targetWorkspaceId: "workspace",
      targetSessionId: null,
      authorityEpoch: null,
      context: "user_private",
      generation: 1,
      expiresAt: null,
      delegation: {
        authorityId: "authority",
        grantId: "grant",
        organizationId: "organization",
        workspaceId: "workspace",
        sessionId: null,
        action: "connection.use",
        mode: "always",
        context: "user_private",
        authorityEpoch: null,
        authorityGeneration: 1,
        grantGeneration: 1,
      },
    },
  ],
} satisfies UserResourceAuthoritySummary;
const input = {
  servers: [
    {
      id: "example",
      url: "https://example.com/mcp",
      cacheToolsList: false,
      connectionRef: {
        subjectScope: "subject" as const,
        providerDomain: "example.com",
        kind: "oauth2" as const,
      },
    },
  ],
  connections: [connection],
  authorities: [authority],
  subjectId: "owner",
  workspaceId: "workspace",
  visibility: "user_private" as const,
};

test("restores an existing exact owner grant without minting authority", () => {
  expect(defaultPersonalConnectionSelections(input)).toEqual([
    {
      serverId: "example",
      connectionId: "connection",
      userDelegation: authority.grants[0].delegation,
    },
  ]);
});

test("does not cross actor, workspace, visibility or inactive connection boundaries", () => {
  for (const override of [
    { subjectId: "other" },
    { workspaceId: "other" },
    { status: "revoked" as const },
    { authorityId: "other" },
    { providerDomain: "other.example.com" },
  ]) {
    expect(
      defaultPersonalConnectionSelections({
        ...input,
        connections: [{ ...connection, ...override }],
      }),
    ).toEqual([]);
  }
  expect(defaultPersonalConnectionSelections({ ...input, visibility: "workspace_shared" })).toEqual(
    [],
  );
});

test("rejects revoked, expired and non-durable grants", () => {
  for (const override of [
    { status: "revoked" as const },
    { expiresAt: "2020-01-01T00:00:00Z" },
    { targetWorkspaceId: "other" },
    { targetSessionId: "session" },
    { authorityEpoch: 1 },
    { mode: "session" as const },
  ]) {
    expect(
      defaultPersonalConnectionSelections({
        ...input,
        authorities: [
          {
            ...authority,
            grants: [{ ...authority.grants[0], ...override }],
          },
        ],
      }),
    ).toEqual([]);
  }
});

test("ambiguous accounts require selection; an exact server binding disambiguates", () => {
  const second = { ...connection, id: "second", authorityId: "second-authority" };
  const two = {
    ...input,
    connections: [connection, second],
    authorities: [
      authority,
      {
        ...authority,
        authorityId: "second-authority",
        resourceId: "second",
      },
    ],
  };
  expect(() => defaultPersonalConnectionSelections(two)).toThrow("select one explicitly");
  expect(
    defaultPersonalConnectionSelections({
      ...two,
      servers: [
        {
          ...input.servers[0],
          connectionRef: { ...input.servers[0].connectionRef, connectionId: "connection" },
        },
      ],
    }),
  ).toHaveLength(1);
});

test("restores only the current conversation's existing session grant", () => {
  const sessionGrant = {
    ...authority.grants[0],
    grantId: "session-grant",
    mode: "session" as const,
    targetSessionId: "session",
    authorityEpoch: 3,
    delegation: {
      ...authority.grants[0].delegation,
      grantId: "session-grant",
      mode: "session" as const,
      sessionId: "session",
      authorityEpoch: 3,
    },
  };
  const scoped = {
    ...input,
    session: { id: "session", authorityEpoch: 3 },
    authorities: [{ ...authority, grants: [sessionGrant] }],
  };
  expect(defaultPersonalConnectionSelections(scoped)).toEqual([
    { serverId: "example", connectionId: "connection", userDelegation: sessionGrant.delegation },
  ]);
  for (const session of [
    undefined,
    { id: "other", authorityEpoch: 3 },
    { id: "session", authorityEpoch: 4 },
  ]) {
    expect(defaultPersonalConnectionSelections({ ...scoped, session })).toEqual([]);
  }
  expect(defaultPersonalConnectionSelections({ ...scoped, subjectId: "other" })).toEqual([]);
  expect(
    defaultPersonalConnectionSelections({ ...scoped, visibility: "workspace_shared" }),
  ).toEqual([]);
  expect(
    defaultPersonalConnectionSelections({
      ...scoped,
      authorities: [{ ...authority, grants: [{ ...sessionGrant, status: "revoked" }] }],
    }),
  ).toEqual([]);
});

test("keeps the narrower session grant when the same account also has an always grant", () => {
  const sessionGrant = {
    ...authority.grants[0],
    mode: "session" as const,
    targetSessionId: "session",
    authorityEpoch: 1,
    delegation: {
      ...authority.grants[0].delegation,
      mode: "session" as const,
      sessionId: "session",
      authorityEpoch: 1,
    },
  };
  for (const grants of [
    [authority.grants[0], sessionGrant],
    [sessionGrant, authority.grants[0]],
  ]) {
    expect(
      defaultPersonalConnectionSelections({
        ...input,
        session: { id: "session", authorityEpoch: 1 },
        authorities: [{ ...authority, grants }],
      })[0]?.userDelegation.mode,
    ).toBe("session");
  }
});
