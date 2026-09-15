import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { newScheduledTaskFormState } from "@/lib/scheduled-tasks";
import { authorizeScheduledSlack } from "./schedule-slack-authority";

const item = {
  id: "slack",
  kind: "mcp",
  enabled: true,
  endpointUrl: "https://mcp.slack.com/mcp",
  connectionRef: { subjectScope: "subject", providerDomain: "slack.com", kind: "oauth2" },
  runtime: { mcpServerId: "personal-slack" },
  tools: [{ kind: "mcp", id: "personal-slack" }],
  metadata: {},
} as CapabilityCatalogItem;
const connection = {
  id: "own-connection",
  subjectId: "owner",
  status: "active",
  authorityId: "authority",
  providerDomain: "slack.com",
  kind: "oauth2",
};
const form = () => ({
  ...newScheduledTaskFormState(true, []),
  personalSlackCapabilityId: "slack",
  personalSlackAcknowledged: true,
});

test("generated schedule explicitly freezes the owner's standing grant", async () => {
  const issue = mock(async () => ({
    grant: { delegation: { grantId: "grant", authorityId: "authority" } },
  }));
  const client = {
    listConnections: async () => [connection],
    issueUserResourceGrant: issue,
  } as unknown as OpenGeniBrowserClient;
  const result = await authorizeScheduledSlack(client, "workspace", form(), [item], () => true);
  expect(issue).toHaveBeenCalledWith("workspace", "authority", {
    scope: "user",
    resourceKind: "connection",
    mode: "always",
    context: "workspace_shared",
    workspaceSharedAcknowledged: true,
  });
  expect(result?.connectionAuthorities[0]).toMatchObject({
    serverId: "personal-slack",
    connectionId: "own-connection",
    userDelegation: { grantId: "grant" },
  });
});

test("a scope change during connection lookup prevents durable consent", async () => {
  let current = true;
  const issue = mock(async () => {
    throw new Error("must not issue");
  });
  const client = {
    listConnections: async () => {
      current = false;
      return [connection];
    },
    issueUserResourceGrant: issue,
  } as unknown as OpenGeniBrowserClient;
  await expect(
    authorizeScheduledSlack(client, "workspace", form(), [item], () => current),
  ).rejects.toThrow("interrupted");
  expect(issue).not.toHaveBeenCalled();
});

test("personal scheduling requires acknowledgement and never chooses a workspace credential", async () => {
  const issue = mock(async () => {
    throw new Error("must not issue");
  });
  const client = {
    listConnections: async () => [{ ...connection, subjectId: null }],
    issueUserResourceGrant: issue,
  } as unknown as OpenGeniBrowserClient;
  await expect(
    authorizeScheduledSlack(
      client,
      "workspace",
      { ...form(), personalSlackAcknowledged: false },
      [item],
      () => true,
    ),
  ).rejects.toThrow("Review");
  await expect(
    authorizeScheduledSlack(client, "workspace", form(), [item], () => true),
  ).rejects.toThrow("Select one");
  expect(issue).not.toHaveBeenCalled();
});

for (const visibility of ["private", "workspace"] as const) {
  test(`existing-session schedule attaches missing Slack and uses fresh ${visibility} connection context without tenancy activation`, async () => {
    let tools: Array<{ kind: "mcp"; id: string }> = [];
    let issued = false;
    const update = mock(
      async (_workspace: string, _session: string, request: { tools: typeof tools }) => {
        tools = request.tools;
      },
    );
    const issue = mock(async () => {
      issued = true;
      return {};
    });
    const client = {
      getSession: async () => ({
        id: "chat",
        workspaceId: "workspace",
        tools,
        firstPartyMcpTools: ["sessions_list"],
        toolPolicy: { mode: "explicit" },
        toolPolicyVersion: 2,
        // Attaching the tool precedes the fresh authority read. No tenancy
        // projection is available when the private-session product is off.
        connectionContext: { visibility, authorityEpoch: tools.length ? 3 : 2 },
      }),
      updateSessionToolPolicy: update,
      listConnections: async () => [connection],
      issueUserResourceGrant: issue,
      listUserResourceAuthorities: async () => ({
        authorities: [
          {
            resourceId: connection.id,
            authorityId: "authority",
            status: "active",
            grants: issued
              ? [
                  {
                    mode: "session",
                    status: "active",
                    action: "connection.use",
                    targetSessionId: "chat",
                    targetWorkspaceId: "workspace",
                    authorityEpoch: 3,
                    context: visibility === "private" ? "user_private" : "workspace_shared",
                    delegation: { grantId: "session-grant" },
                  },
                ]
              : [],
          },
        ],
        nextCursor: null,
      }),
    } as unknown as OpenGeniBrowserClient;
    const result = await authorizeScheduledSlack(
      client,
      "workspace",
      { ...form(), runMode: "existing_session", targetSessionId: "chat" },
      [item],
      () => true,
    );
    expect(tools).toEqual([{ kind: "mcp", id: "personal-slack" }]);
    expect(update).toHaveBeenCalledWith("workspace", "chat", {
      mode: "explicit",
      tools,
      firstPartyMcpTools: ["sessions_list"],
      expectedVersion: 2,
    });
    expect(issue).toHaveBeenCalledWith("workspace", "authority", {
      scope: "user",
      resourceKind: "connection",
      mode: "session",
      sessionId: "chat",
      expectedAuthorityEpoch: 3,
      context: visibility === "private" ? "user_private" : "workspace_shared",
      workspaceSharedAcknowledged: visibility === "workspace",
    });
    expect(result?.connectionAuthorities[0]?.userDelegation.grantId).toBe("session-grant");
  });
}

test("adding personal access never replaces another frozen schedule authority", async () => {
  const list = mock(async () => [connection]);
  const client = { listConnections: list } as unknown as OpenGeniBrowserClient;
  await expect(
    authorizeScheduledSlack(
      client,
      "workspace",
      {
        ...form(),
        existingPersonalConnections: [{ serverId: "other", providerDomain: "example.com" }],
      },
      [item],
      () => true,
    ),
  ).rejects.toThrow("already has personal access");
  expect(list).not.toHaveBeenCalled();
});
