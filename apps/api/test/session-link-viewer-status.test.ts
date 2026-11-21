import { describe, expect, test } from "bun:test";
import {
  classifySessionLinkUrl,
  type AccessGrant,
  type SessionLink,
  type ToolGatewayCatalogEntry,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import type { SiteToolAccountInventory } from "../src/site-tool-routing";
import { withSessionLinkStatuses } from "../src/integrations/session-link-status";
import { sessionLinksWithStatus } from "../src/routes/session-links";
import {
  linearIssueArguments,
  linearIssueStatus,
  slackThreadArguments,
  slackThreadStatus,
  viewerAccountsFor,
  viewerSessionLinkReader,
  type ViewerLinkReaderIo,
} from "../src/integrations/session-link-viewer-status";

function sessionLink(url: string, title: string | null = null): SessionLink {
  const classified = classifySessionLinkUrl(url)!;
  return {
    id: crypto.randomUUID(),
    url: classified.url,
    title,
    kind: classified.kind,
    provider: classified.provider,
    ref: classified.ref,
    addedBy: "agent",
    addedAt: "2026-11-21T10:00:00.000Z",
  };
}

function grant(subjectId: string, principalKind: AccessGrant["principalKind"] = "human_session") {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    subjectId,
    permissions: ["sessions:read"],
    principalKind,
  } as AccessGrant;
}

function inventory(
  accounts: Array<{ serverId: string; canonical: string; shared?: boolean }>,
): SiteToolAccountInventory {
  return {
    canonical: new Map([
      ["linear", { capabilityId: "mcp:linear", name: "Linear", providerDomain: "linear.app" }],
      ["slack", { capabilityId: null, name: "Slack", providerDomain: "slack.com" }],
      ["gmail", { capabilityId: "mcp:gmail", name: "Gmail", providerDomain: "gmail.com" }],
    ]),
    plain: new Set(),
    accounts: accounts.map((account) => ({
      serverId: account.serverId,
      canonicalServerId: account.canonical,
      connector: account.canonical,
      account: "someone",
      connectionId: `c-${account.serverId}`,
      ...(account.shared ? { shared: true } : {}),
    })),
  };
}

const schema = (properties: string[]) =>
  ({
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(properties.map((name) => [name, {}])),
    },
  }) as unknown as ToolGatewayCatalogEntry;

function fakeIo(
  read: SiteToolAccountInventory,
  answer: (identity: ToolGatewayIdentity, args: Record<string, unknown>) => unknown,
  entries: Record<string, ToolGatewayCatalogEntry> = {},
) {
  const calls: Array<{ identity: ToolGatewayIdentity; args: Record<string, unknown> }> = [];
  const opened: ToolGatewayIdentity[][] = [];
  let closed = 0;
  const io: ViewerLinkReaderIo = {
    inventory: async () => read,
    open: async (_deps, _grant, identities) => {
      opened.push([...identities]);
      return {
        entry: (identity) =>
          identities.some((each) => each.serverId === identity.serverId)
            ? (entries[identity.toolName] ?? schema([]))
            : undefined,
        call: async (identity, args) => {
          calls.push({ identity, args });
          const value = answer(identity, args);
          return value === null
            ? null
            : ({ content: [{ type: "text", text: JSON.stringify(value) }] } as never);
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  };
  return { io, calls, opened, closed: () => closed };
}

const deps = {} as ApiRouteDeps;

describe("Linked status read as the viewer", () => {
  test("the viewer's own accounts come first, then ones the workspace shares", () => {
    const found = viewerAccountsFor(
      inventory([
        { serverId: "linear-shared", canonical: "linear", shared: true },
        { serverId: "linear-mine", canonical: "linear" },
        { serverId: "gmail-mine", canonical: "gmail" },
      ]),
      "linear",
    );
    expect(found.accounts.map((each) => each.serverId)).toEqual(["linear-mine", "linear-shared"]);
    expect(found.accounts[0]!.toolName).toBe("get_issue");
    expect(found.connect).toEqual({ name: "Linear", capabilityId: "mcp:linear" });
    expect(viewerAccountsFor(inventory([]), "slack")).toEqual({
      accounts: [],
      connect: { name: "Slack", capabilityId: null },
    });
    // No Connect where the workspace doesn't offer the connector.
    const none = inventory([]);
    none.canonical.delete("slack");
    expect(viewerAccountsFor(none, "slack").connect).toBeNull();
  });

  test("Linear: state, assignee and title from get_issue", () => {
    expect(linearIssueArguments(schema(["id", "fields"]), "ENG-1")).toEqual({
      id: "ENG-1",
      fields: ["title", "status", "statusType", "assignee"],
    });
    expect(linearIssueArguments(schema(["issueId"]), "ENG-1")).toEqual({ issueId: "ENG-1" });
    expect(
      linearIssueStatus({
        title: "Login fails",
        status: "In Progress",
        statusType: "started",
        assignee: "Ada",
      }),
    ).toEqual({
      state: "open",
      label: "In Progress",
      title: "Login fails",
      checks: null,
      review: null,
      assignee: "Ada",
    });
    expect(
      linearIssueStatus({
        issue: { title: "T", state: { name: "Done", type: "completed" }, assignee: null },
      }),
    ).toMatchObject({ state: "done", label: "Done", assignee: null });
    expect(linearIssueStatus({ status: "Canceled", statusType: "canceled" })?.state).toBe("closed");
    expect(linearIssueStatus({ status: "Custom" })?.state).toBe("unknown");
    // Without a state type, Linear's default state names.
    expect(linearIssueStatus({ status: "Done" })?.state).toBe("done");
    expect(linearIssueStatus({ status: "Canceled" })?.state).toBe("closed");
    expect(linearIssueStatus({ status: "In Progress" })?.state).toBe("open");
    expect(linearIssueStatus({})).toBeNull();
  });

  test("Slack: first message, reply count and last reply time from slack_read_thread", () => {
    expect(
      slackThreadArguments(schema(["channel", "ts", "limit"]), { channel: "C1", ts: "1.2" }),
    ).toEqual({ channel: "C1", ts: "1.2", limit: 1 });
    expect(
      slackThreadArguments(schema(["channel_id", "message_ts"]), { channel: "C1", ts: "1.2" }),
    ).toEqual({ channel_id: "C1", message_ts: "1.2" });
    expect(slackThreadArguments(schema(["query"]), { channel: "C1", ts: "1.2" })).toBeNull();
    const value = {
      messages: [
        { text: "Deploy is  stuck\\nagain", reply_count: 2, latest_reply: "1763719200.000100" },
      ],
    };
    expect(slackThreadStatus(value, { title: null })).toEqual({
      state: "unknown",
      label: null,
      title: "Deploy is stuck\\nagain",
      checks: null,
      review: null,
      replies: 2,
      lastReplyAt: "2025-11-21T10:00:00.000Z",
    });
    // A given title stays; no replies has no last reply.
    expect(
      slackThreadStatus({ messages: [{ text: "x", reply_count: 0 }] }, { title: "Incident" }),
    ).toMatchObject({ title: "Incident", replies: 0, lastReplyAt: null });
    // A count the server leaves out is unknown, not "No replies".
    expect(slackThreadStatus({ messages: [{ text: "x" }] }, { title: null })).toMatchObject({
      replies: null,
    });
    expect(slackThreadStatus({ messages: [] }, { title: null })).toBeNull();
  });

  test("reads through the viewer's account, tries the next on a miss, and offers Connect without one", async () => {
    const linear = sessionLink("https://linear.app/acme/issue/ENG-1/login-fails");
    const slack = sessionLink("https://acme.slack.com/archives/C123/p1763719200000100");
    const fake = fakeIo(
      inventory([
        { serverId: "linear-a", canonical: "linear" },
        { serverId: "linear-b", canonical: "linear" },
      ]),
      (identity) =>
        identity.serverId === "linear-b"
          ? { title: "Login fails", status: "Todo", statusType: "unstarted", assignee: "Ada" }
          : null,
      { get_issue: schema(["id"]) },
    );
    const reader = viewerSessionLinkReader(deps, grant("user:ada"), [linear, slack], fake.io);
    expect(await reader.read(linear)).toEqual({
      kind: "status",
      status: {
        state: "open",
        label: "Todo",
        title: "Login fails",
        checks: null,
        review: null,
        assignee: "Ada",
      },
    });
    expect(fake.calls.map((call) => call.identity.serverId)).toEqual(["linear-a", "linear-b"]);
    expect(fake.calls[0]!.args).toEqual({ id: "ENG-1" });
    expect(await reader.read(slack)).toEqual({
      kind: "connect",
      connect: { name: "Slack", capabilityId: null },
    });
    // The gateway opens once, for only the accounts these links need.
    expect(fake.opened).toEqual([
      [
        { serverId: "linear-a", toolName: "get_issue" },
        { serverId: "linear-b", toolName: "get_issue" },
      ],
    ]);
    await reader.close();
    expect(fake.closed()).toBe(1);
  });

  test("a read that doesn't answer stops in time and leaves the title", async () => {
    const linear = sessionLink("https://linear.app/acme/issue/ENG-2");
    const fake = fakeIo(inventory([{ serverId: "linear-a", canonical: "linear" }]), () => ({}), {
      get_issue: schema(["id"]),
    });
    const io = {
      ...fake.io,
      open: async (...args: Parameters<typeof fake.io.open>) => ({
        ...(await fake.io.open(...args)),
        call: () => new Promise<never>(() => undefined),
      }),
    };
    const reader = viewerSessionLinkReader(deps, grant("user:ada"), [linear], io, 20);
    expect(await reader.read(linear)).toEqual({ kind: "none" });
    await reader.close();
  });

  test("keys, services and other links read nothing", async () => {
    const linear = sessionLink("https://linear.app/acme/issue/ENG-1");
    const fake = fakeIo(inventory([{ serverId: "linear-a", canonical: "linear" }]), () => ({}));
    for (const kind of ["api_key", "service"] as const) {
      const reader = viewerSessionLinkReader(deps, grant("key", kind), [linear], fake.io);
      expect(await reader.read(linear)).toEqual({ kind: "none" });
    }
    const github = sessionLink("https://github.com/acme/api/pull/1");
    const reader = viewerSessionLinkReader(deps, grant("user:ada"), [github], fake.io);
    expect(await reader.read(github)).toEqual({ kind: "none" });
    expect(fake.opened).toEqual([]);
  });

  test("each viewer's status is cached for them alone", async () => {
    const linear = sessionLink("https://linear.app/acme/issue/ENG-9");
    const workspaceId = crypto.randomUUID();
    const githubReader = async () => null;
    const asViewer = (subjectId: string, label: string) => ({
      subjectId,
      read: async () => ({
        kind: "status" as const,
        status: { state: "open" as const, label, title: null, checks: null, review: null },
      }),
    });
    const [ada] = await withSessionLinkStatuses(workspaceId, [linear], githubReader, {
      viewer: asViewer("user:ada", "Ada's view"),
    });
    const [bob] = await withSessionLinkStatuses(workspaceId, [linear], githubReader, {
      viewer: asViewer("user:bob", "Bob's view"),
    });
    expect(ada!.status?.label).toBe("Ada's view");
    expect(bob!.status?.label).toBe("Bob's view");
    const [noViewer] = await withSessionLinkStatuses(workspaceId, [linear], githubReader);
    expect(noViewer!.status).toBeNull();
    const [connect] = await withSessionLinkStatuses(crypto.randomUUID(), [linear], githubReader, {
      viewer: {
        subjectId: "user:cy",
        read: async () => ({ kind: "connect", connect: { name: "Linear", capabilityId: null } }),
      },
    });
    expect(connect).toMatchObject({ status: null, connect: { name: "Linear" } });
  });

  test("the list reads as a person, titles only for others, and always releases the gateway", async () => {
    const linear = sessionLink("https://linear.app/acme/issue/ENG-11", "Login fails");
    const opened: string[] = [];
    let closed = 0;
    const viewerReader = (_deps: ApiRouteDeps, viewerGrant: AccessGrant) => {
      opened.push(viewerGrant.subjectId);
      return {
        read: async (): Promise<never> => {
          throw new Error("gateway down");
        },
        close: async () => {
          closed += 1;
        },
      };
    };
    const reader = async () => null;
    // Keys and services (no viewer grant) get titles; no gateway opens.
    const [keyed] = await sessionLinksWithStatus(deps, crypto.randomUUID(), [linear], {
      reader,
      viewerGrant: null,
      viewerReader,
      fresh: false,
    });
    expect(keyed).toMatchObject({ title: "Login fails", status: null });
    expect(opened).toEqual([]);
    // A person's read that fails still leaves the title and closes the gateway.
    const [person] = await sessionLinksWithStatus(deps, crypto.randomUUID(), [linear], {
      reader,
      viewerGrant: grant("user:ada"),
      viewerReader,
      fresh: false,
    });
    expect(person).toMatchObject({ title: "Login fails", status: null });
    expect(opened).toEqual(["user:ada"]);
    expect(closed).toBe(1);
  });
});
