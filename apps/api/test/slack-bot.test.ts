import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  claimSlackBotPostOperation,
  createConnection,
  createDb,
  createSession,
  getConnectionMetadata,
  getSlackBotPostOperation,
  loadConnectionCredentialForBroker,
  releaseSlackBotPostOperationClaim,
  updateConnection,
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

type SlackCall = {
  method: string;
  channel: string | null;
  clientMessageId: string | null;
  hasText: boolean;
  query: string;
};

function fakeSlack(
  options: {
    scopes?: string[];
    displayName?: string;
    botUserId?: string;
    botId?: string;
    loseFirstPostResponse?: boolean;
  } = {},
) {
  const calls: SlackCall[] = [];
  const committedPosts = new Map<string, { channel: string; timestamp: string }>();
  let postAttempts = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = url.pathname.replace(/^\/api\//, "");
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({
      method,
      channel: params.get("channel"),
      clientMessageId: params.get("client_msg_id"),
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
          user_id: options.botUserId ?? "U_OPEN_GENI",
          bot_id: options.botId ?? "B_OPEN_GENI",
        },
        { headers },
      );
    }
    if (method === "users.info") {
      return Response.json({
        ok: true,
        user: {
          id: options.botUserId ?? "U_OPEN_GENI",
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
      const clientMessageId = params.get("client_msg_id");
      const channel = params.get("channel");
      if (!clientMessageId || !channel) {
        return Response.json({ ok: false, error: "invalid_arguments" });
      }
      const committed = committedPosts.get(clientMessageId) ?? {
        channel,
        timestamp: `${committedPosts.size + 2}.000`,
      };
      committedPosts.set(clientMessageId, committed);
      postAttempts += 1;
      if (options.loseFirstPostResponse && postAttempts === 1) {
        throw new Error("fixture Slack response lost after commit");
      }
      return Response.json({ ok: true, channel: committed.channel, ts: committed.timestamp });
    }
    return Response.json({ ok: false, error: "unexpected_method" });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, committedPosts };
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
  connectionId?: string,
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
      body: JSON.stringify({ token: fixtureBotToken(), ...(connectionId ? { connectionId } : {}) }),
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
      verifiedInstallVersion: 1,
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES].sort(),
      metadata: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        slackTeamId: "T_OPEN_GENI",
        botDisplayName: "OpenGeni",
      },
    });
    expect(connection?.verifiedInstallAt).not.toBeNull();
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

  test("reinstalls only the immutable Slack workspace and bot principal", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const originalSlack = fakeSlack();
    const connected = await connectBot(workspace, originalSlack.fetch);
    expect(connected.response.status).toBe(201);

    const reinstalled = await connectBot(
      workspace,
      fakeSlack().fetch,
      connected.body.connection.id,
    );
    expect(reinstalled.response.status).toBe(200);
    const current = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    expect(current).toMatchObject({
      version: 2,
      verifiedInstallVersion: 2,
      metadata: { botId: "B_OPEN_GENI", botUserId: "U_OPEN_GENI" },
    });

    const substituted = await connectBot(
      workspace,
      fakeSlack({ botId: "B_DIFFERENT", botUserId: "U_DIFFERENT" }).fetch,
      connected.body.connection.id,
    );
    expect(substituted.response.status).toBe(409);
    expect(JSON.stringify(substituted.body)).not.toContain(fixtureBotToken());
    const unchanged = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    expect(unchanged).toMatchObject({
      version: 2,
      verifiedInstallVersion: 2,
      metadata: { botId: "B_OPEN_GENI", botUserId: "U_OPEN_GENI" },
    });
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

    // Simulate a publication-base pod that can still create the same caller-
    // writable row/JSON shape. The schema-owned marker remains null, so new
    // readers must not reinterpret it as a verified bot installation.
    const legacyFabricated = await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "legacy-caller-controlled-ciphertext",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      metadata: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        slackTeamId: "T_OPEN_GENI",
        slackTeamName: "OpenGeni Test Workspace",
        botUserId: "U_OPEN_GENI",
        botId: "B_OPEN_GENI",
        botDisplayName: "OpenGeni",
        verifiedAt: new Date().toISOString(),
      },
    });
    expect(legacyFabricated.verifiedInstallAt).toBeNull();
    await expect(
      resolveSlackBotConnectionForTool({
        db: client.db,
        grant: {
          ...workspace,
          subjectId: "subject-a",
          permissions: ["connections:read"],
          metadata: {},
        },
        sessionId: null,
        requestedConnectionId: legacyFabricated.id,
      }),
    ).rejects.toThrow("OpenGeni Slack bot connection");
  });

  test("invalidates verified eligibility when a rolling legacy writer replaces protected fields", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const connected = await connectBot(workspace, fakeSlack().fetch);
    const before = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    expect(before?.verifiedInstallVersion).toBe(1);
    const legacyUpdated = await updateConnection(client.db, {
      workspaceId: workspace.workspaceId,
      connectionId: connected.body.connection.id,
      visibleToSubjectId: null,
      credentialEncrypted: "rolling-old-writer-replacement",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      metadata: before!.metadata,
      updatedBySubjectId: "subject-a",
    });
    expect(legacyUpdated).toMatchObject({
      version: 2,
      verifiedInstallAt: null,
      verifiedInstallVersion: null,
    });
    await expect(
      resolveSlackBotConnectionForTool({
        db: client.db,
        grant: {
          ...workspace,
          subjectId: "subject-a",
          permissions: ["connections:read"],
          metadata: {},
        },
        sessionId: null,
        requestedConnectionId: connected.body.connection.id,
      }),
    ).rejects.toThrow("OpenGeni Slack bot connection");
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
    const operationId = crypto.randomUUID();
    const posted = await bot.postMessage({
      operationId,
      userId: "U_MEMBER",
      text: "private fixture text",
    });
    expect(posted).toMatchObject({ channelId: "D_MEMBER", timestamp: "2.000" });
    expect(slack.calls.find((call) => call.method === "chat.postMessage")).toMatchObject({
      hasText: true,
      clientMessageId: operationId,
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

  test("converges response-loss retries and completed replays through one client_msg_id", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack({ loseFirstPostResponse: true });
    const connected = await connectBot(workspace, slack.fetch);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    const resolved = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant: {
        ...workspace,
        subjectId: "subject-a",
        permissions: ["connections:read"],
        metadata: {},
      },
      sessionId: null,
      requestedConnectionId: connection!.id,
    });
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );
    const operationId = crypto.randomUUID();
    const post = { operationId, channelId: "C_MEMBER", text: "idempotent fixture text" };

    await expect(bot.postMessage(post)).rejects.toThrow("transport_error");
    expect(slack.committedPosts.size).toBe(1);
    expect(
      await getSlackBotPostOperation(client.db, workspace.workspaceId, connection!.id, operationId),
    ).toMatchObject({
      status: "provider_started",
      claimHolderId: null,
      clientMessageId: operationId,
      attemptCount: 1,
    });

    const retried = await bot.postMessage(post);
    expect(retried).toMatchObject({
      channelId: "C_MEMBER",
      timestamp: "2.000",
      receipt: { operationId, clientMessageId: operationId },
    });
    expect(slack.committedPosts.size).toBe(1);
    expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);

    const replayed = await bot.postMessage(post);
    expect(replayed).toEqual(retried);
    expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
    expect(
      await getSlackBotPostOperation(client.db, workspace.workspaceId, connection!.id, operationId),
    ).toMatchObject({ status: "completed", attemptCount: 2, slackMessageTimestamp: "2.000" });

    await expect(bot.postMessage({ ...post, text: "different message" })).rejects.toThrow(
      "already bound",
    );
    expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
    const operationAudits = await shared!.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'slack_bot.message.post'
        and metadata->>'operationId' = ${operationId}
      order by occurred_at, id`;
    expect(operationAudits.filter((audit) => audit.metadata.outcome === "succeeded")).toHaveLength(
      1,
    );
    expect(operationAudits.some((audit) => audit.metadata.outcome === "ambiguous")).toBe(true);
    expect(JSON.stringify(operationAudits)).not.toContain("idempotent fixture text");
  });

  test("reclaims a crashed post claim and keeps operation rows tenant-isolated", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const connected = await connectBot(workspace, fakeSlack().fetch);
    const operationId = crypto.randomUUID();
    const firstHolder = crypto.randomUUID();
    const first = await claimSlackBotPostOperation(client.db, {
      ...workspace,
      connectionId: connected.body.connection.id,
      operationId,
      targetKind: "channel",
      targetId: "C_MEMBER",
      requestDigest: "a".repeat(64),
      claimHolderId: firstHolder,
      claimLeaseMs: 30_000,
    });
    expect(first).toMatchObject({ kind: "claimed", operation: { attemptCount: 1 } });
    const otherWorkspace = await freshWorkspace();
    expect(
      await getSlackBotPostOperation(
        client.db,
        otherWorkspace.workspaceId,
        connected.body.connection.id,
        operationId,
      ),
    ).toBeNull();
    expect(
      await claimSlackBotPostOperation(client.db, {
        ...otherWorkspace,
        connectionId: connected.body.connection.id,
        operationId,
        targetKind: "channel",
        targetId: "C_MEMBER",
        requestDigest: "a".repeat(64),
        claimHolderId: crypto.randomUUID(),
        claimLeaseMs: 30_000,
      }),
    ).toEqual({ kind: "connection_not_found" });

    const secondHolder = crypto.randomUUID();
    expect(
      await claimSlackBotPostOperation(client.db, {
        ...workspace,
        connectionId: connected.body.connection.id,
        operationId,
        targetKind: "channel",
        targetId: "C_MEMBER",
        requestDigest: "a".repeat(64),
        claimHolderId: secondHolder,
        claimLeaseMs: 30_000,
      }),
    ).toMatchObject({ kind: "in_progress" });
    await shared!.admin`
      update slack_bot_post_operations
      set claim_expires_at = now() - interval '1 second'
      where workspace_id = ${workspace.workspaceId}
        and operation_id = ${operationId}`;
    const reclaimed = await claimSlackBotPostOperation(client.db, {
      ...workspace,
      connectionId: connected.body.connection.id,
      operationId,
      targetKind: "channel",
      targetId: "C_MEMBER",
      requestDigest: "a".repeat(64),
      claimHolderId: secondHolder,
      claimLeaseMs: 30_000,
    });
    expect(reclaimed).toMatchObject({
      kind: "claimed",
      operation: { attemptCount: 2, clientMessageId: operationId },
    });
    expect(
      await releaseSlackBotPostOperationClaim(client.db, {
        ...workspace,
        connectionId: connected.body.connection.id,
        operationId,
        claimHolderId: secondHolder,
        failureCode: "crash_fixture_reconciled",
      }),
    ).toBe(true);
  });

  test("rolls back completion when the success audit fails, then converges on retry", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const connected = await connectBot(workspace, slack.fetch);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    const resolved = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant: {
        ...workspace,
        subjectId: "subject-a",
        permissions: ["connections:read"],
        metadata: {},
      },
      sessionId: null,
      requestedConnectionId: connection!.id,
    });
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );
    const operationId = crypto.randomUUID();
    const suffix = operationId.replaceAll("-", "");
    const functionName = `opengeni_test_fail_slack_audit_${suffix}`;
    const triggerName = `opengeni_test_fail_slack_audit_${suffix}`;
    await shared!.admin.unsafe(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.action = 'slack_bot.message.post'
          and new.metadata->>'operationId' = '${operationId}'
          and new.metadata->>'outcome' = 'succeeded'
        then
          raise exception 'fixture success audit failure';
        end if;
        return new;
      end;
      $$;
      create trigger ${triggerName}
        before insert on audit_events
        for each row execute function ${functionName}();
    `);
    const post = { operationId, channelId: "C_MEMBER", text: "audit rollback fixture" };
    try {
      await expect(bot.postMessage(post)).rejects.toThrow();
    } finally {
      await shared!.admin.unsafe(`
        drop trigger if exists ${triggerName} on audit_events;
        drop function if exists ${functionName}();
      `);
    }
    expect(slack.committedPosts.size).toBe(1);
    expect(
      await getSlackBotPostOperation(client.db, workspace.workspaceId, connection!.id, operationId),
    ).toMatchObject({ status: "provider_started", claimHolderId: null });

    const retried = await bot.postMessage(post);
    expect(retried.receipt).toMatchObject({ operationId, clientMessageId: operationId });
    expect(slack.committedPosts.size).toBe(1);
    expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
    const [successCount] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::int as count from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'slack_bot.message.post'
        and metadata->>'operationId' = ${operationId}
        and metadata->>'outcome' = 'succeeded'`;
    expect(successCount?.count).toBe(1);
    expect(JSON.stringify(retried)).not.toContain("audit rollback fixture");
  });
});
