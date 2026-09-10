import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  CapabilityCatalogItem,
  Session,
  McpConnectionAuthoritySelection,
} from "@opengeni/sdk";
import {
  authorizeSessionPersonalConnection,
  sessionConnectionAuthorities,
} from "./session-connection-authority";

const item = {
  enabled: true,
  connectionRef: { subjectScope: "subject", providerDomain: "example.com", kind: "api_key" },
  runtime: { mcpServerId: "example" },
} as CapabilityCatalogItem;
const session = {
  id: "session",
  workspaceId: "workspace",
  tenancy: { visibility: "workspace", authorityEpoch: 4 },
} as Session;
const grant = {
  mode: "session",
  status: "active",
  action: "connection.use",
  targetSessionId: "session",
  targetWorkspaceId: "workspace",
  authorityEpoch: 4,
  context: "workspace_shared",
  delegation: {
    authorityId: "authority",
    grantId: "grant",
  } as McpConnectionAuthoritySelection["userDelegation"],
};
function harness(grants: unknown[] = []) {
  const issueUserResourceGrant = mock(
    async (..._args: Parameters<OpenGeniBrowserClient["issueUserResourceGrant"]>) => ({}),
  );
  const client = {
    getSession: async () => session,
    listConnections: async () => [
      {
        id: "connection",
        subjectId: "owner",
        status: "active",
        authorityId: "authority",
        providerDomain: "example.com",
        kind: "api_key",
      },
    ],
    listUserResourceAuthorities: async () => ({
      authorities: [
        { resourceId: "connection", authorityId: "authority", status: "active", grants },
      ],
    }),
    issueUserResourceGrant,
  } as unknown as OpenGeniBrowserClient;
  return { client, issueUserResourceGrant };
}
test("private IDs resolve from owner metadata and only exact active session grants enter messages", async () => {
  const h = harness([
    { ...grant, mode: "always" },
    { ...grant, targetSessionId: "other" },
    { ...grant, authorityEpoch: 3 },
    { ...grant, context: "user_private" },
    { ...grant, status: "revoked" },
    { ...grant, expiresAt: "2020-01-01T00:00:00Z" },
  ]);
  expect(await sessionConnectionAuthorities(h.client, session, [item])).toEqual([]);
  const valid = harness([grant]);
  expect(await sessionConnectionAuthorities(valid.client, session, [item])).toEqual([
    { serverId: "example", connectionId: "connection", userDelegation: grant.delegation },
  ]);
});
test("personal use requires explicit shared-results acknowledgement", async () => {
  const h = harness();
  await expect(
    authorizeSessionPersonalConnection(
      h.client,
      "workspace",
      "session",
      item,
      "workspace",
      false,
      () => true,
    ),
  ).rejects.toThrow("Acknowledge");
  expect(h.issueUserResourceGrant).not.toHaveBeenCalled();
});
test("visibility changes and navigation prevent granting", async () => {
  const h = harness();
  await expect(
    authorizeSessionPersonalConnection(
      h.client,
      "workspace",
      "session",
      item,
      "private",
      true,
      () => true,
    ),
  ).rejects.toThrow("visibility changed");
  await expect(
    authorizeSessionPersonalConnection(
      h.client,
      "workspace",
      "session",
      item,
      "workspace",
      true,
      () => false,
    ),
  ).rejects.toThrow("interrupted");
  expect(h.issueUserResourceGrant).not.toHaveBeenCalled();
});
test("the explicit action issues an epoch-fenced session grant and reuses it on retry", async () => {
  const h = harness();
  await authorizeSessionPersonalConnection(
    h.client,
    "workspace",
    "session",
    item,
    "workspace",
    true,
    () => true,
  );
  expect(h.issueUserResourceGrant.mock.calls[0]).toEqual([
    "workspace",
    "authority",
    {
      scope: "user",
      resourceKind: "connection",
      mode: "session",
      sessionId: "session",
      expectedAuthorityEpoch: 4,
      context: "workspace_shared",
      workspaceSharedAcknowledged: true,
    },
  ]);
  const existing = harness([grant]);
  await authorizeSessionPersonalConnection(
    existing.client,
    "workspace",
    "session",
    item,
    "workspace",
    true,
    () => true,
  );
  expect(existing.issueUserResourceGrant).not.toHaveBeenCalled();
});

test("ambiguous personal accounts never issue an arbitrary account grant", async () => {
  const h = harness();
  h.client.listConnections = async () =>
    ["first", "second"].map((id) => ({
      id,
      subjectId: "owner",
      status: "active",
      authorityId: id,
      providerDomain: "example.com",
      kind: "api_key",
    })) as Awaited<ReturnType<OpenGeniBrowserClient["listConnections"]>>;
  await expect(
    authorizeSessionPersonalConnection(
      h.client,
      "workspace",
      "session",
      item,
      "workspace",
      true,
      () => true,
    ),
  ).rejects.toThrow("More than one personal account");
  expect(h.issueUserResourceGrant).not.toHaveBeenCalled();
});

test("unselected duplicate accounts do not block messages; an exact grant restores its account", async () => {
  const h = harness();
  const connections = await h.client.listConnections("workspace");
  h.client.listConnections = async () => [
    ...connections,
    { ...connections[0]!, id: "second", authorityId: "second-authority" },
  ];
  expect(await sessionConnectionAuthorities(h.client, session, [item])).toEqual([]);
  const granted = harness([grant]);
  granted.client.listConnections = h.client.listConnections;
  const selections = await sessionConnectionAuthorities(granted.client, session, [item]);
  expect(selections).toHaveLength(1);
  expect(selections[0]?.connectionId).toBe("connection");
});
