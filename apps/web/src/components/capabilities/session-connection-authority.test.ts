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
  connectionRef: { subjectScope: "subject", connectionId: "connection" },
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
      { id: "connection", subjectId: "owner", status: "active", authorityId: "authority" },
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
test("only exact session, visibility, epoch and active grants enter messages", async () => {
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
