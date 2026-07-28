import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createSession,
  getConnectionMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  createOpenGeniSlackBotClient,
  resolveSlackBotConnectionForTool,
  verifyOpenGeniSlackBotCredential,
} from "../src/integrations/slack-bot";

const DELEGATION_SECRET = randomBytes(32).toString("hex");
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-slack-bot");
  if (!shared) {
    available = false;
    console.warn("[slack-bot] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: ENCRYPTION_KEY,
  }) as Settings;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('slack bot acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'slack bot ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function bearer(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function fixtureBotToken(): string {
  return ["xoxb", "fixture", "not-a-real-credential"].join("-");
}

type SlackCall = { method: string; channel: string | null; hasText: boolean; query: string };

function fakeSlack(options: { scopes?: string[]; displayName?: string } = {}) {
  const calls: SlackCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = url.pathname.replace(/^\/api\//, "");
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({
      method,
      channel: params.get("channel"),
      hasText: params.has("text"),
      query: url.search,
    });
    const headers =
      method === "auth.test"
        ? { "x-oauth-scopes": (options.scopes ?? OPENGENI_SLACK_BOT_REQUIRED_SCOPES).join(",") }
        : undefined;
    if (method === "auth.test") {
      return Response.json(
        {
          ok: true,
          team_id: "T_OPEN_GENI",
          team: "OpenGeni Test Workspace",
          user_id: "U_OPEN_GENI",
          bot_id: "B_OPEN_GENI",
        },
        { headers },
      );
    }
    if (method === "users.info") {
      return Response.json({
        ok: true,
        user: {
          id: "U_OPEN_GENI",
          is_bot: true,
          deleted: false,
          profile: { display_name: options.displayName ?? "OpenGeni", real_name: "OpenGeni" },
        },
      });
    }
    if (method === "conversations.list") {
      return Response.json({
        ok: true,
        channels: [
          { id: "C_MEMBER", name: "general", is_private: false, is_member: true },
          { id: "G_PRIVATE", name: "private", is_private: true, is_member: false },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.info") {
      const channel = params.get("channel") ?? "";
      return Response.json({
        ok: true,
        channel: {
          id: channel,
          name: channel === "C_MEMBER" ? "general" : "private",
          is_private: channel.startsWith("G"),
          is_member: channel === "C_MEMBER",
        },
      });
    }
    if (method === "conversations.history") {
      return Response.json({
        ok: true,
        messages: [{ ts: "1.000", user: "U_MEMBER", text: "bounded history" }],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "users.list") {
      return Response.json({
        ok: true,
        members: [
          {
            id: "U_MEMBER",
            name: "member",
            is_bot: false,
            deleted: false,
            profile: { display_name: "Member", real_name: "Test Member" },
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.open") {
      return Response.json({ ok: true, channel: { id: "D_MEMBER" } });
    }
    if (method === "chat.postMessage") {
      return Response.json({ ok: true, channel: params.get("channel"), ts: "2.000" });
    }
    return Response.json({ ok: false, error: "unexpected_method" });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("OpenGeni Slack bot credential verification", () => {
  test("accepts only the exact bot identity and scope set", async () => {
    const exact = fakeSlack();
    const verified = await verifyOpenGeniSlackBotCredential(
      fixtureBotToken(),
      exact.fetch,
      new Date("2026-01-02T03:04:05.000Z"),
    );
    expect(verified).toMatchObject({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES].sort(),
      metadata: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        slackTeamId: "T_OPEN_GENI",
        botDisplayName: "OpenGeni",
        verifiedAt: "2026-01-02T03:04:05.000Z",
      },
    });
    expect(exact.calls.map((call) => call.method)).toEqual(["auth.test", "users.info"]);
    expect(exact.calls.every((call) => call.query === "")).toBe(true);

    await expect(
      verifyOpenGeniSlackBotCredential(
        fixtureBotToken(),
        fakeSlack({
          scopes: OPENGENI_SLACK_BOT_REQUIRED_SCOPES.filter((scope) => scope !== "groups:history"),
        }).fetch,
      ),
    ).rejects.toThrow("exactly match");
    await expect(
      verifyOpenGeniSlackBotCredential(
        fixtureBotToken(),
        fakeSlack({
          scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "chat:write.public"],
        }).fetch,
      ),
    ).rejects.toThrow("exactly match");
    await expect(
      verifyOpenGeniSlackBotCredential(
        fixtureBotToken(),
        fakeSlack({ displayName: "Personal Slack user" }).fetch,
      ),
    ).rejects.toThrow('display name must be exactly "OpenGeni"');
  });
});

function app(slackFetch: typeof globalThis.fetch) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    slackFetch,
  } as never);
}

async function connectBot(
  workspace: { accountId: string; workspaceId: string },
  slackFetch: typeof globalThis.fetch,
) {
  const response = await app(slackFetch).request(
    `/v1/workspaces/${workspace.workspaceId}/connections/slack-bot`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", [
          "connections:read",
          "connections:write",
        ]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: fixtureBotToken() }),
    },
  );
  const body = (await response.json()) as { connection: { id: string } };
  return { response, body };
}

describe("OpenGeni Slack bot connection", () => {
  test("validates and binds a shared bot without exposing its credential", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const { response, body } = await connectBot(workspace, slack.fetch);
    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain(fixtureBotToken());

    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      body.connection.id,
      "subject-b",
    );
    expect(connection).toMatchObject({
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      status: "active",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES].sort(),
      metadata: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        slackTeamId: "T_OPEN_GENI",
        botDisplayName: "OpenGeni",
      },
    });
    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: body.connection.id,
      providerDomain: "slack.com",
    });
    if (!credential) throw new Error("expected stored Slack bot credential fixture");
    const credentialHeaders = (credential.credential as { headers?: Record<string, unknown> })
      .headers;
    expect(typeof credentialHeaders?.[["author", "ization"].join("")]).toBe("string");

    const [audit] = await shared!.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and target_id = ${body.connection.id}
        and action = 'slack_bot.connected'`;
    expect(audit?.metadata).toMatchObject({
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      connectionId: body.connection.id,
      slackTeamId: "T_OPEN_GENI",
      outcome: "succeeded",
    });
    expect(JSON.stringify(audit)).not.toContain(fixtureBotToken());

    const denied = await app(slack.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/slack-bot`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:read"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: fixtureBotToken() }),
      },
    );
    expect(denied.status).toBe(403);

    const other = await freshWorkspace();
    const crossTenant = await app(slack.fetch).request(
      `/v1/workspaces/${other.workspaceId}/connections/slack-bot`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(other, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: fixtureBotToken(), connectionId: body.connection.id }),
      },
    );
    expect(crossTenant.status).toBe(404);
  });

  test("rejects wrong identity, missing or forbidden scopes, and generic role fabrication", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const cases = [
      fakeSlack({ displayName: "Not OpenGeni" }),
      fakeSlack({
        scopes: OPENGENI_SLACK_BOT_REQUIRED_SCOPES.filter((scope) => scope !== "im:write"),
      }),
      fakeSlack({ scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "channels:join"] }),
    ];
    for (const slack of cases) {
      const result = await connectBot(workspace, slack.fetch);
      expect(result.response.status).toBe(422);
      expect(JSON.stringify(result.body)).not.toContain(fixtureBotToken());
    }

    const fabricated = await app(fakeSlack().fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerDomain: "slack.com",
          kind: "app_install",
          credential: { headers: { test: "value" } },
          metadata: { credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE },
        }),
      },
    );
    expect(fabricated.status).toBe(422);
  });

  test("enforces channel membership, routes DMs, and never substitutes personal OAuth", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const connected = await connectBot(workspace, slack.fetch);
    expect(connected.response.status).toBe(201);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    expect(connection).not.toBeNull();

    const personal = await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: "not-used-by-role-validation",
      metadata: { label: "personal hosted Slack MCP" },
    });
    const grant = {
      ...workspace,
      subjectId: "subject-a",
      permissions: ["connections:read"],
      metadata: {},
    } as AccessGrant;
    await expect(
      resolveSlackBotConnectionForTool({
        db: client.db,
        grant,
        sessionId: null,
        requestedConnectionId: personal.id,
      }),
    ).rejects.toThrow("OpenGeni Slack bot connection");
    await expect(
      resolveSlackBotConnectionForTool({ db: client.db, grant, sessionId: null }),
    ).rejects.toThrow("connectionId is required");

    const forgedSession = await createSession(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initialMessage: "forged routing metadata",
      resources: [],
      metadata: {
        scheduledTaskId: crypto.randomUUID(),
        scheduledTaskRunId: crypto.randomUUID(),
        [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: connection!.id,
      },
      createdBy: { kind: "subject", subjectId: "subject-a" },
      model: "test-model",
      sandboxBackend: "none",
    });
    await expect(
      resolveSlackBotConnectionForTool({
        db: client.db,
        grant,
        sessionId: forgedSession.id,
      }),
    ).rejects.toThrow("not scheduler-authorized");

    const resolved = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant,
      sessionId: null,
      requestedConnectionId: connection!.id,
    });
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );
    const channels = await bot.listChannels();
    expect(channels.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "C_MEMBER", isMember: true, isPrivate: false }),
        expect.objectContaining({ id: "G_PRIVATE", isMember: false, isPrivate: true }),
      ]),
    );
    await expect(bot.channelHistory({ channelId: "G_PRIVATE" })).rejects.toThrow("not_in_channel");
    expect(slack.calls.filter((call) => call.method === "conversations.history")).toHaveLength(0);
    const history = await bot.channelHistory({ channelId: "C_MEMBER" });
    expect(history.messages).toEqual([
      expect.objectContaining({ timestamp: "1.000", text: "bounded history" }),
    ]);
    const posted = await bot.postMessage({ userId: "U_MEMBER", text: "private fixture text" });
    expect(posted).toMatchObject({ channelId: "D_MEMBER", timestamp: "2.000" });
    expect(slack.calls.find((call) => call.method === "chat.postMessage")).toMatchObject({
      hasText: true,
      query: "",
    });

    const audits = await shared!.admin<
      Array<{ action: string; metadata: Record<string, unknown> }>
    >`
      select action, metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and target_id = ${connection!.id}
        and action like 'slack_bot.%'
      order by occurred_at, id`;
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "slack_bot.channels.list",
        "slack_bot.channel_history.read",
        "slack_bot.message.post",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain("private fixture text");
    expect(JSON.stringify(audits)).not.toContain(fixtureBotToken());
  });
});
