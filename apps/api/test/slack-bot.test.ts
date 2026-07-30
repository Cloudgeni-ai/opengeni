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
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  recordSlackBotInstallCallbackFailure,
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
  exchangeOpenGeniSlackAuthorizationCode,
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
    publicBaseUrl: "https://app.example.test",
    integrationsStateSecret: "slack-state-secret-for-tests",
    slackClientId: "slack-client-id",
    slackClientSecret: "slack-client-secret",
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
  for (const subjectId of ["subject-a", "subject-b"]) {
    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, ${subjectId}, ${subjectId}, 'member',
        ${shared!.admin.json(["connections:read", "connections:write"])}
      )`;
  }
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
  fileId: string | null;
  clientMessageId: string | null;
  parentTimestamp: string | null;
  threadTimestamp: string | null;
  hasText: boolean;
  query: string;
};

function fakeSlack(
  options: {
    scopes?: string[];
    displayName?: string;
    teamId?: string;
    botUserId?: string;
    botId?: string;
    loseFirstPostResponse?: boolean;
    transcriptRequiresUserSession?: boolean;
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
      fileId: params.get("file"),
      clientMessageId: params.get("client_msg_id"),
      parentTimestamp: params.get("ts"),
      threadTimestamp: params.get("thread_ts"),
      hasText: params.has("text"),
      query: url.search,
    });
    const headers =
      method === "auth.test"
        ? { "x-oauth-scopes": (options.scopes ?? OPENGENI_SLACK_BOT_REQUIRED_SCOPES).join(",") }
        : undefined;
    if (url.hostname === "files.slack.com") {
      if (url.pathname.includes("huddle-transcript") && options.transcriptRequiresUserSession) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://fixture.slack.com/?redir=%2Ffiles-pri%2FT_OPEN_GENI-FTRANSCRIPT%2Fdownload%2Fhuddle-transcript",
          },
        });
      }
      return url.pathname.includes("huddle-transcript")
        ? new Response("00:00 Test Member: A bounded transcript fixture.", {
            headers: {
              "content-type": "application/vnd.slack-huddle-transcript; charset=utf-8",
            },
          })
        : new Response(
            '<div class="quip-canvas-content"><h1>Meeting notes</h1><p class="embedded-file">File ID: sf:FTRANSCRIPT</p></div>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
    }
    if (method === "oauth.v2.access") {
      return Response.json({ ok: true, access_token: fixtureBotToken() });
    }
    if (method === "auth.test") {
      return Response.json(
        {
          ok: true,
          team_id: options.teamId ?? "T_OPEN_GENI",
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
        messages: [
          {
            ts: "1.000",
            user: "U_MEMBER",
            text: "bounded history",
            thread_ts: "1.000",
            reply_count: 1,
            files: [
              {
                id: "F_CANVAS",
                name: "meeting-notes",
                title: "Meeting notes",
                mode: "canvas",
                filetype: "quip",
                mimetype: "application/vnd.slack-docs",
                size: 1234,
                channels: ["C_MEMBER"],
                canvas_metadata: { originating_huddle_id: "H_FIXTURE" },
                huddle_transcript_file_id: "FTRANSCRIPT",
              },
            ],
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.replies") {
      return Response.json({
        ok: true,
        messages: [
          { ts: "1.000", user: "U_MEMBER", text: "bounded history", thread_ts: "1.000" },
          {
            ts: "1.001",
            user: "U_REPLY",
            text: "bounded thread reply",
            thread_ts: "1.000",
          },
        ],
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
    if (method === "files.list") {
      return Response.json({
        ok: true,
        files: [
          {
            id: "F_CANVAS",
            name: "meeting-notes",
            title: "Meeting notes",
            mode: "canvas",
            filetype: "quip",
            mimetype: "application/vnd.slack-docs",
            size: 1234,
            channels: ["C_MEMBER"],
            canvas_metadata: { originating_huddle_id: "H_FIXTURE" },
            huddle_transcript_file_id: "FTRANSCRIPT",
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "files.info") {
      const fileId = params.get("file") ?? "F_CANVAS";
      const transcript = fileId === "FTRANSCRIPT";
      return Response.json({
        ok: true,
        file: {
          id: fileId,
          name: transcript ? "huddle-transcript" : "meeting-notes",
          title: transcript ? "Huddle transcript" : "Meeting notes",
          mode: transcript ? "huddle_transcript" : "canvas",
          filetype: transcript ? "huddle_transcript" : "quip",
          mimetype: transcript
            ? "application/vnd.slack-huddle-transcript"
            : "application/vnd.slack-docs",
          size: transcript ? 4567 : 1234,
          channels: transcript ? [] : [fileId === "F_OTHER" ? "G_PRIVATE" : "C_MEMBER"],
          groups: transcript ? ["C_CANVAS"] : [],
          canvas_metadata: transcript ? undefined : { originating_huddle_id: "H_FIXTURE" },
          huddle_transcript_file_id: transcript ? undefined : "FTRANSCRIPT",
          url_private_download: transcript
            ? "https://files.slack.com/files-pri/T_OPEN_GENI-FTRANSCRIPT/download/huddle-transcript"
            : "https://files.slack.com/files-pri/T_OPEN_GENI-F_CANVAS/download/meeting-notes.html",
        },
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
  test("exchanges the authorization code server-side with the configured callback", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const token = await exchangeOpenGeniSlackAuthorizationCode(
      {
        code: "authorization-code",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app.example.test/v1/integrations/slack/callback",
      },
      (async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({ ok: true, access_token: fixtureBotToken() });
      }) as typeof globalThis.fetch,
    );

    expect(token).toBe(fixtureBotToken());
    expect(requestUrl).toBe("https://slack.com/api/oauth.v2.access");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.redirect).toBe("error");
    expect(new URLSearchParams(String(requestInit?.body))).toEqual(
      new URLSearchParams({
        code: "authorization-code",
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uri: "https://app.example.test/v1/integrations/slack/callback",
      }),
    );
  });

  test("rejects non-bot and oversized OAuth exchange responses", async () => {
    const input = {
      code: "authorization-code",
      clientId: "client-id",
      clientSecret: "fixture-client-secret",
      redirectUri: "https://app.example.test/v1/integrations/slack/callback",
    };
    await expect(
      exchangeOpenGeniSlackAuthorizationCode(input, (async () =>
        Response.json({
          ok: true,
          access_token: ["xoxp", "fixture", "not-a-real-credential"].join("-"),
        })) as typeof globalThis.fetch),
    ).rejects.toThrow("did not return a bot token");
    await expect(
      exchangeOpenGeniSlackAuthorizationCode(
        input,
        (async () =>
          new Response("{}", {
            headers: { "content-length": String(3 * 1024 * 1024) },
          })) as typeof globalThis.fetch,
      ),
    ).rejects.toThrow();
  });

  test("accepts only the exact bot identity and scope set", async () => {
    expect(OPENGENI_SLACK_BOT_REQUIRED_SCOPES).toEqual([
      "app_mentions:read",
      "bookmarks:read",
      "canvases:read",
      "canvases:write",
      "channels:history",
      "channels:read",
      "chat:write",
      "commands",
      "emoji:read",
      "files:read",
      "files:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "im:write",
      "lists:read",
      "mpim:history",
      "mpim:read",
      "pins:read",
      "reactions:read",
      "reactions:write",
      "team:read",
      "usergroups:read",
      "users:read",
    ]);
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

async function startBotInstall(
  workspace: { accountId: string; workspaceId: string },
  slackFetch: typeof globalThis.fetch,
  connectionId?: string,
  subjectId = "subject-a",
): Promise<{ response: Response; state: string | null }> {
  const response = await app(slackFetch).request(
    `/v1/workspaces/${workspace.workspaceId}/connections/slack-bot/install`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, subjectId, [
          "connections:read",
          "connections:write",
        ]),
        "content-type": "application/json",
      },
      body: JSON.stringify(connectionId ? { connectionId } : {}),
    },
  );
  if (response.status !== 200) return { response, state: null };
  const installation = (await response.json()) as { authorizationUrl: string };
  return {
    response,
    state: new URL(installation.authorizationUrl).searchParams.get("state"),
  };
}

async function completeBotInstall(
  slackFetch: typeof globalThis.fetch,
  state: string,
  callbackQuery = "code=fixture-code",
): Promise<Response> {
  return await app(slackFetch).request(
    `/v1/integrations/slack/callback?${callbackQuery}&state=${encodeURIComponent(state)}`,
  );
}

async function connectBot(
  workspace: { accountId: string; workspaceId: string },
  slackFetch: typeof globalThis.fetch,
  connectionId?: string,
) {
  const start = await startBotInstall(workspace, slackFetch, connectionId);
  if (start.response.status !== 200 || !start.state) {
    return { response: start.response, body: { connection: { id: "" } } };
  }
  const response = await completeBotInstall(slackFetch, start.state);
  const connections = await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a");
  const connection = connections.find(
    (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  );
  const body = { connection: { id: connection?.id ?? "" } };
  return { response, body };
}

type CallbackFailureAudit = {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
};

async function callbackFailureAudits(workspaceId: string): Promise<CallbackFailureAudit[]> {
  return await shared!.admin<CallbackFailureAudit[]>`
    select
      account_id as "accountId",
      workspace_id as "workspaceId",
      subject_id as "subjectId",
      target_id as "targetId",
      metadata
    from audit_events
    where workspace_id = ${workspaceId}
      and action = 'slack_bot.install.callback.failed'
    order by occurred_at, id`;
}

async function withFailingLifecycleAudit<T>(
  workspaceId: string,
  action: "slack_bot.connected" | "slack_bot.reinstalled" | "slack_bot.disconnected",
  fn: () => Promise<T>,
): Promise<T> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const functionName = `og_test_slack_lifecycle_${suffix}`;
  const triggerName = `og_test_slack_lifecycle_${suffix}`;
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error("invalid fixture workspace id");
  await shared!.admin.unsafe(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if new.workspace_id = '${workspaceId}'::uuid and new.action = '${action}' then
        raise exception 'fixture lifecycle audit failure';
      end if;
      return new;
    end;
    $$;
    create trigger ${triggerName}
      before insert on audit_events
      for each row execute function ${functionName}();
  `);
  try {
    return await fn();
  } finally {
    await shared!.admin.unsafe(`
      drop trigger if exists ${triggerName} on audit_events;
      drop function if exists ${functionName}();
    `);
  }
}

async function withFailingConnectionInsert<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const functionName = `og_test_slack_connection_${suffix}`;
  const triggerName = `og_test_slack_connection_${suffix}`;
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error("invalid fixture workspace id");
  await shared!.admin.unsafe(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if new.workspace_id = '${workspaceId}'::uuid then
        raise exception 'fixture connection persistence failure';
      end if;
      return new;
    end;
    $$;
    create trigger ${triggerName}
      before insert on connections
      for each row execute function ${functionName}();
  `);
  try {
    return await fn();
  } finally {
    await shared!.admin.unsafe(`
      drop trigger if exists ${triggerName} on connections;
      drop function if exists ${functionName}();
    `);
  }
}

describe("OpenGeni Slack bot connection", () => {
  test("validates and binds a shared bot without exposing its credential", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const { response, body } = await connectBot(workspace, slack.fetch);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("slack=connected");
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
      `/v1/workspaces/${workspace.workspaceId}/connections/slack-bot/install`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:read"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(denied.status).toBe(403);

    const other = await freshWorkspace();
    const crossTenant = await app(slack.fetch).request(
      `/v1/workspaces/${other.workspaceId}/connections/slack-bot/install`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(other, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ connectionId: body.connection.id }),
      },
    );
    expect(crossTenant.status).toBe(404);
  });

  test("reinstalls only the immutable Slack workspace and bot principal", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const originalSlack = fakeSlack();
    const connected = await connectBot(workspace, originalSlack.fetch);
    expect(connected.response.status).toBe(302);
    expect(connected.response.headers.get("location")).toContain("slack=connected");

    const reinstalled = await connectBot(
      workspace,
      fakeSlack().fetch,
      connected.body.connection.id,
    );
    expect(reinstalled.response.status).toBe(302);
    expect(reinstalled.response.headers.get("location")).toContain("slack=connected");
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
    expect(substituted.response.status).toBe(302);
    expect(substituted.response.headers.get("location")).toContain("slack=error");
    expect(substituted.response.headers.get("location")).toContain("reason=http_409");
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

    const wrongTeam = await connectBot(
      workspace,
      fakeSlack({ teamId: "T_DIFFERENT" }).fetch,
      connected.body.connection.id,
    );
    expect(wrongTeam.response.headers.get("location")).toContain("reason=http_409");
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        null,
      ),
    ).toMatchObject({ version: 2, metadata: { slackTeamId: "T_OPEN_GENI" } });
    const principalFailures = await callbackFailureAudits(workspace.workspaceId);
    expect(principalFailures).toHaveLength(2);
    expect(principalFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectId: "subject-a",
          metadata: {
            outcome: "failed",
            installMode: "reinstall",
            stage: "principal_validation",
            reason: "principal_mismatch",
          },
        }),
      ]),
    );

    const separate = await connectBot(
      workspace,
      fakeSlack({ botId: "B_DIFFERENT", botUserId: "U_DIFFERENT" }).fetch,
    );
    expect(separate.response.status).toBe(302);
    expect(separate.response.headers.get("location")).toContain("slack=connected");
    expect(separate.body.connection.id).not.toBe(connected.body.connection.id);
    const botConnections = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a")
    ).filter(
      (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
    );
    expect(botConnections).toHaveLength(2);
  });

  test("rejects wrong identity, missing or forbidden scopes, and generic role fabrication", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const cases = [
      { slack: fakeSlack({ displayName: "Not OpenGeni" }), reason: "identity_mismatch" },
      {
        slack: fakeSlack({
          scopes: OPENGENI_SLACK_BOT_REQUIRED_SCOPES.filter((scope) => scope !== "im:write"),
        }),
        reason: "scope_mismatch",
      },
      {
        slack: fakeSlack({
          scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "channels:join"],
        }),
        reason: "scope_mismatch",
      },
    ] as const;
    for (const fixture of cases) {
      const result = await connectBot(workspace, fixture.slack.fetch);
      expect(result.response.status).toBe(302);
      expect(result.response.headers.get("location")).toContain("slack=error");
      expect(JSON.stringify(result.body)).not.toContain(fixtureBotToken());
    }
    const verificationFailures = await callbackFailureAudits(workspace.workspaceId);
    expect(verificationFailures).toHaveLength(cases.length);
    expect(
      verificationFailures.every(
        (audit) =>
          audit.subjectId === "subject-a" &&
          audit.metadata.outcome === "failed" &&
          audit.metadata.installMode === "connect" &&
          audit.metadata.stage === "credential_verification",
      ),
    ).toBe(true);
    expect(verificationFailures.map((audit) => audit.metadata.reason).sort()).toEqual(
      cases.map((fixture) => fixture.reason).sort(),
    );

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

  test("revalidates callback membership before consuming state and rejects replay", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const start = await app(slack.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/slack-bot/install`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(start.status).toBe(200);
    const authorizationUrl = new URL(
      ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("expected Slack installation state fixture");

    await shared!.admin`
      delete from workspace_memberships
      where workspace_id = ${workspace.workspaceId} and subject_id = 'subject-a'`;
    const denied = await app(slack.fetch).request(
      `/v1/integrations/slack/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("slack=error");
    expect(denied.headers.get("location")).toContain("reason=http_403");
    expect(
      (await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-b")).filter(
        (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      ),
    ).toHaveLength(0);
    expect(await callbackFailureAudits(workspace.workspaceId)).toEqual([
      expect.objectContaining({
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-a",
        metadata: {
          outcome: "failed",
          installMode: "connect",
          stage: "permission_check",
          reason: "permission_lost",
        },
      }),
    ]);

    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, 'subject-a', 'subject-a', 'member',
        ${shared!.admin.json(["connections:read", "connections:write"])}
      )`;
    const connected = await app(slack.fetch).request(
      `/v1/integrations/slack/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
    );
    expect(connected.status).toBe(302);
    expect(connected.headers.get("location")).toContain("slack=connected");

    const replay = await app(slack.fetch).request(
      `/v1/integrations/slack/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("slack=error");
    expect(replay.headers.get("location")).toContain("reason=http_400");
    expect(await callbackFailureAudits(workspace.workspaceId)).toHaveLength(1);
  });

  test("records sanitized provider, exchange, and verification callback failures", async () => {
    if (!available) return;

    const deniedWorkspace = await freshWorkspace();
    const deniedSlack = fakeSlack();
    const deniedStart = await startBotInstall(deniedWorkspace, deniedSlack.fetch);
    if (!deniedStart.state) throw new Error("expected denied callback state");
    const denied = await completeBotInstall(
      deniedSlack.fetch,
      deniedStart.state,
      "error=access_denied",
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toContain("reason=provider_denied");
    expect(denied.headers.get("location")).not.toContain("access_denied");
    expect(await callbackFailureAudits(deniedWorkspace.workspaceId)).toEqual([
      expect.objectContaining({
        accountId: deniedWorkspace.accountId,
        workspaceId: deniedWorkspace.workspaceId,
        subjectId: "subject-a",
        targetId: expect.stringMatching(/^[a-f0-9]{64}$/),
        metadata: {
          outcome: "failed",
          installMode: "connect",
          stage: "provider_denial",
          reason: "provider_denied",
        },
      }),
    ]);

    const exchangeWorkspace = await freshWorkspace();
    const exchangeSlack = fakeSlack();
    const exchangeFailure = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/oauth.v2.access")) {
        return Response.json({ ok: false, error: "fixture_provider_exchange_payload" });
      }
      return await exchangeSlack.fetch(input, init);
    }) as typeof globalThis.fetch;
    const exchangeStart = await startBotInstall(exchangeWorkspace, exchangeFailure);
    if (!exchangeStart.state) throw new Error("expected exchange callback state");
    const exchange = await completeBotInstall(exchangeFailure, exchangeStart.state);
    expect(exchange.headers.get("location")).toContain("slack=error");
    const exchangeAudits = await callbackFailureAudits(exchangeWorkspace.workspaceId);
    expect(exchangeAudits).toEqual([
      expect.objectContaining({
        subjectId: "subject-a",
        metadata: {
          outcome: "failed",
          installMode: "connect",
          stage: "code_exchange",
          reason: "exchange_failed",
        },
      }),
    ]);
    expect(JSON.stringify(exchangeAudits)).not.toContain("fixture_provider_exchange_payload");

    const verificationWorkspace = await freshWorkspace();
    const verificationSlack = fakeSlack();
    const verificationFailure = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/auth.test")) throw new Error("fixture verification transport");
      return await verificationSlack.fetch(input, init);
    }) as typeof globalThis.fetch;
    const verificationStart = await startBotInstall(verificationWorkspace, verificationFailure);
    if (!verificationStart.state) throw new Error("expected verification callback state");
    const verification = await completeBotInstall(verificationFailure, verificationStart.state);
    expect(verification.headers.get("location")).toContain("slack=error");
    const verificationAudits = await callbackFailureAudits(verificationWorkspace.workspaceId);
    expect(verificationAudits).toEqual([
      expect.objectContaining({
        subjectId: "subject-a",
        metadata: {
          outcome: "failed",
          installMode: "connect",
          stage: "credential_verification",
          reason: "credential_verification_failed",
        },
      }),
    ]);
    expect(JSON.stringify(verificationAudits)).not.toContain("fixture verification transport");

    const persistenceWorkspace = await freshWorkspace();
    const persistenceSlack = fakeSlack();
    const persistenceStart = await startBotInstall(persistenceWorkspace, persistenceSlack.fetch);
    if (!persistenceStart.state) throw new Error("expected persistence callback state");
    const persistence = await withFailingConnectionInsert(
      persistenceWorkspace.workspaceId,
      async () => await completeBotInstall(persistenceSlack.fetch, persistenceStart.state!),
    );
    expect(persistence.headers.get("location")).toContain("reason=installation_failed");
    expect(await callbackFailureAudits(persistenceWorkspace.workspaceId)).toEqual([
      expect.objectContaining({
        subjectId: "subject-a",
        metadata: {
          outcome: "failed",
          installMode: "connect",
          stage: "persistence",
          reason: "persistence_failed",
        },
      }),
    ]);
    expect(
      (
        await listConnectionsMetadata(client.db, persistenceWorkspace.workspaceId, "subject-a")
      ).filter(
        (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      ),
    ).toHaveLength(0);
  });

  test("rolls back a new connection when its success audit fails and records one failure", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const start = await startBotInstall(workspace, slack.fetch);
    if (!start.state) throw new Error("expected connect callback state");

    const failed = await withFailingLifecycleAudit(
      workspace.workspaceId,
      "slack_bot.connected",
      async () => await completeBotInstall(slack.fetch, start.state!),
    );
    expect(failed.status).toBe(302);
    expect(failed.headers.get("location")).toContain("reason=installation_failed");
    expect(
      (await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a")).filter(
        (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      ),
    ).toHaveLength(0);
    const failures = await callbackFailureAudits(workspace.workspaceId);
    expect(failures).toEqual([
      expect.objectContaining({
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-a",
        targetId: expect.stringMatching(/^[a-f0-9]{64}$/),
        metadata: {
          outcome: "failed",
          installMode: "connect",
          stage: "persistence",
          reason: "success_audit_failed",
        },
      }),
    ]);
    const serialized = JSON.stringify(failures);
    expect(serialized).not.toContain(start.state);
    expect(serialized).not.toContain("fixture-code");
    expect(serialized).not.toContain(fixtureBotToken());

    const replay = await completeBotInstall(slack.fetch, start.state);
    expect(replay.headers.get("location")).toContain("reason=http_400");
    expect(await callbackFailureAudits(workspace.workspaceId)).toHaveLength(1);
  });

  test("rolls back reinstall when its success audit fails and recovers with fresh state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const connected = await connectBot(workspace, slack.fetch);
    const before = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      "subject-a",
    );
    expect(before).toMatchObject({ version: 1, status: "active" });
    const start = await startBotInstall(workspace, slack.fetch, connected.body.connection.id);
    if (!start.state) throw new Error("expected reinstall callback state");

    const failed = await withFailingLifecycleAudit(
      workspace.workspaceId,
      "slack_bot.reinstalled",
      async () => await completeBotInstall(slack.fetch, start.state!),
    );
    expect(failed.headers.get("location")).toContain("reason=installation_failed");
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        "subject-a",
      ),
    ).toMatchObject({
      version: before!.version,
      verifiedInstallVersion: before!.verifiedInstallVersion,
      status: "active",
      metadata: {
        slackTeamId: before!.metadata.slackTeamId,
        botId: before!.metadata.botId,
        botUserId: before!.metadata.botUserId,
      },
    });
    expect(await callbackFailureAudits(workspace.workspaceId)).toEqual([
      expect.objectContaining({
        subjectId: "subject-a",
        metadata: {
          outcome: "failed",
          installMode: "reinstall",
          stage: "persistence",
          reason: "success_audit_failed",
        },
      }),
    ]);

    const recovered = await connectBot(workspace, slack.fetch, connected.body.connection.id);
    expect(recovered.response.headers.get("location")).toContain("slack=connected");
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        "subject-a",
      ),
    ).toMatchObject({ version: before!.version + 1, verifiedInstallVersion: before!.version + 1 });
  });

  test("rolls back disconnect when its success audit fails and remains usable", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const connected = await connectBot(workspace, slack.fetch);
    const before = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      "subject-a",
    );
    const disconnect = async () =>
      await app(slack.fetch).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/${connected.body.connection.id}`,
        {
          method: "DELETE",
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          },
        },
      );

    const failed = await withFailingLifecycleAudit(
      workspace.workspaceId,
      "slack_bot.disconnected",
      disconnect,
    );
    expect(failed.status).toBe(500);
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        "subject-a",
      ),
    ).toMatchObject({
      status: "active",
      version: before!.version,
      verifiedInstallVersion: before!.verifiedInstallVersion,
    });
    const [falseSuccess] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::int as count from audit_events
      where workspace_id = ${workspace.workspaceId}
        and target_id = ${connected.body.connection.id}
        and action = 'slack_bot.disconnected'`;
    expect(falseSuccess?.count).toBe(0);
    const resolved = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant: {
        ...workspace,
        subjectId: "subject-a",
        permissions: ["connections:read"],
        metadata: {},
      },
      sessionId: null,
      requestedConnectionId: connected.body.connection.id,
    });
    expect(
      await createOpenGeniSlackBotClient(
        { db: client.db, settings, slackFetch: slack.fetch },
        resolved,
      ).listChannels(),
    ).toMatchObject({ channels: expect.any(Array) });

    const recovered = await disconnect();
    expect(recovered.status).toBe(200);
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        "subject-a",
      ),
    ).toMatchObject({ status: "revoked", version: before!.version + 1 });
  });

  test("keeps callback failure idempotency scoped to its tenant and first subject", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const other = await freshWorkspace();
    const callbackDigest = "a".repeat(64);
    const failure = {
      callbackDigest,
      installMode: "connect" as const,
      stage: "provider_denial" as const,
      reason: "provider_denied" as const,
    };
    expect(
      await recordSlackBotInstallCallbackFailure(client.db, {
        ...workspace,
        subjectId: "subject-a",
        ...failure,
      }),
    ).toBe(true);
    expect(
      await recordSlackBotInstallCallbackFailure(client.db, {
        ...workspace,
        subjectId: "subject-b",
        ...failure,
      }),
    ).toBe(false);
    expect(await callbackFailureAudits(workspace.workspaceId)).toEqual([
      expect.objectContaining({
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-a",
        targetId: callbackDigest,
      }),
    ]);
    expect(
      await recordSlackBotInstallCallbackFailure(client.db, {
        ...other,
        subjectId: "subject-b",
        ...failure,
      }),
    ).toBe(true);
    expect(await callbackFailureAudits(other.workspaceId)).toEqual([
      expect.objectContaining({
        accountId: other.accountId,
        workspaceId: other.workspaceId,
        subjectId: "subject-b",
        targetId: callbackDigest,
      }),
    ]);
    await expect(
      recordSlackBotInstallCallbackFailure(client.db, {
        accountId: other.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-a",
        ...failure,
      }),
    ).rejects.toThrow();
    expect(await callbackFailureAudits(workspace.workspaceId)).toHaveLength(1);
  });

  test("marks only exact Slack credential rejection codes as needing reauth", async () => {
    if (!available) return;
    const rejectedCodes = [
      "account_inactive",
      "invalid_auth",
      "not_authed",
      "token_expired",
      "token_revoked",
    ];
    for (const code of rejectedCodes) {
      const workspace = await freshWorkspace();
      const slack = fakeSlack();
      const connected = await connectBot(workspace, slack.fetch);
      const resolved = await resolveSlackBotConnectionForTool({
        db: client.db,
        grant: {
          ...workspace,
          subjectId: "subject-a",
          permissions: ["connections:read"],
          metadata: {},
        },
        sessionId: null,
        requestedConnectionId: connected.body.connection.id,
      });
      const failingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/conversations.list")) {
          return Response.json({ ok: false, error: code });
        }
        return await slack.fetch(input, init);
      }) as typeof globalThis.fetch;
      const bot = createOpenGeniSlackBotClient(
        { db: client.db, settings, slackFetch: failingFetch },
        resolved,
      );
      await expect(bot.listChannels()).rejects.toThrow(code);
      expect(
        await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          "subject-a",
        ),
      ).toMatchObject({ status: "needs_reauth", lastError: code });
    }
  });

  test("does not poison credentials for transport, HTTP, channel, or permission failures", async () => {
    if (!available) return;
    const cases: Array<
      { kind: "provider"; code: string } | { kind: "http"; status: number } | { kind: "transport" }
    > = [
      { kind: "provider", code: "not_in_channel" },
      { kind: "provider", code: "missing_scope" },
      { kind: "provider", code: "channel_not_found" },
      { kind: "http", status: 500 },
      { kind: "transport" },
    ];
    for (const failure of cases) {
      const workspace = await freshWorkspace();
      const slack = fakeSlack();
      const connected = await connectBot(workspace, slack.fetch);
      const resolved = await resolveSlackBotConnectionForTool({
        db: client.db,
        grant: {
          ...workspace,
          subjectId: "subject-a",
          permissions: ["connections:read"],
          metadata: {},
        },
        sessionId: null,
        requestedConnectionId: connected.body.connection.id,
      });
      const failingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (!url.pathname.endsWith("/conversations.list")) return await slack.fetch(input, init);
        if (failure.kind === "transport") throw new Error("fixture transport failure");
        if (failure.kind === "http") {
          return Response.json({ ok: false }, { status: failure.status });
        }
        return Response.json({ ok: false, error: failure.code });
      }) as typeof globalThis.fetch;
      const bot = createOpenGeniSlackBotClient(
        { db: client.db, settings, slackFetch: failingFetch },
        resolved,
      );
      await expect(bot.listChannels()).rejects.toThrow();
      expect(
        await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          "subject-a",
        ),
      ).toMatchObject({ status: "active", lastError: null });
    }
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
    expect(connected.response.status).toBe(302);
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
    const automaticallyResolved = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant,
      sessionId: null,
    });
    expect(automaticallyResolved.connection.id).toBe(connection!.id);

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
      expect.objectContaining({
        timestamp: "1.000",
        threadTimestamp: "1.000",
        text: "bounded history",
        files: [
          {
            id: "F_CANVAS",
            name: "meeting-notes",
            title: "Meeting notes",
            mode: "canvas",
            filetype: "quip",
            mimetype: "application/vnd.slack-docs",
            size: 1234,
            originatingHuddleId: "H_FIXTURE",
            huddleTranscriptFileId: "FTRANSCRIPT",
          },
        ],
      }),
    ]);
    await expect(
      bot.threadReplies({ channelId: "G_PRIVATE", threadTimestamp: "1.000" }),
    ).rejects.toThrow("not_in_channel");
    expect(slack.calls.filter((call) => call.method === "conversations.replies")).toHaveLength(0);
    const thread = await bot.threadReplies({
      channelId: "C_MEMBER",
      threadTimestamp: "1.000",
    });
    expect(thread).toMatchObject({
      threadTimestamp: "1.000",
      messages: [
        { timestamp: "1.000", threadTimestamp: "1.000", text: "bounded history" },
        { timestamp: "1.001", threadTimestamp: "1.000", text: "bounded thread reply" },
      ],
      nextCursor: null,
    });
    expect(slack.calls.find((call) => call.method === "conversations.replies")).toMatchObject({
      channel: "C_MEMBER",
      parentTimestamp: "1.000",
    });
    await expect(bot.listFiles({ channelId: "G_PRIVATE" })).rejects.toThrow("not_in_channel");
    expect(slack.calls.filter((call) => call.method === "files.list")).toHaveLength(0);
    const files = await bot.listFiles({ channelId: "C_MEMBER" });
    expect(files).toMatchObject({
      files: [
        {
          id: "F_CANVAS",
          title: "Meeting notes",
          mode: "canvas",
          originatingHuddleId: "H_FIXTURE",
          huddleTranscriptFileId: "FTRANSCRIPT",
        },
      ],
      nextCursor: null,
    });
    await expect(bot.fileInfo({ channelId: "C_MEMBER", fileId: "F_OTHER" })).rejects.toThrow(
      "file_not_found",
    );
    const file = await bot.fileInfo({ channelId: "C_MEMBER", fileId: "F_CANVAS" });
    expect(file).toMatchObject({
      channel: { id: "C_MEMBER", isMember: true },
      file: {
        id: "F_CANVAS",
        title: "Meeting notes",
        mode: "canvas",
        originatingHuddleId: "H_FIXTURE",
        huddleTranscriptFileId: "FTRANSCRIPT",
      },
    });
    expect(
      slack.calls.find((call) => call.method === "files.info" && call.fileId === "F_CANVAS"),
    ).toBeDefined();
    const content = await bot.fileContent({ channelId: "C_MEMBER", fileId: "F_CANVAS" });
    expect(content).toMatchObject({
      file: { id: "F_CANVAS", title: "Meeting notes", mode: "canvas" },
      contentType: "text/html",
      offset: 0,
      content:
        '<div class="quip-canvas-content"><h1>Meeting notes</h1><p class="embedded-file">File ID: sf:FTRANSCRIPT</p></div>',
      nextOffset: null,
      truncated: false,
    });
    expect(JSON.stringify(content)).not.toContain("files.slack.com");
    await expect(bot.fileContent({ channelId: "C_MEMBER", fileId: "FTRANSCRIPT" })).rejects.toThrow(
      "file_not_found",
    );
    const transcript = await bot.fileContent({
      channelId: "C_MEMBER",
      fileId: "FTRANSCRIPT",
      parentFileId: "F_CANVAS",
    });
    expect(transcript).toMatchObject({
      file: {
        id: "FTRANSCRIPT",
        title: "Huddle transcript",
        mode: "huddle_transcript",
      },
      contentType: "application/vnd.slack-huddle-transcript",
      content: "00:00 Test Member: A bounded transcript fixture.",
      nextOffset: null,
      truncated: false,
    });
    const participantOnlySlack = fakeSlack({ transcriptRequiresUserSession: true });
    const participantOnlyBot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: participantOnlySlack.fetch },
      resolved,
    );
    await expect(
      participantOnlyBot.fileContent({
        channelId: "C_MEMBER",
        fileId: "FTRANSCRIPT",
        parentFileId: "F_CANVAS",
      }),
    ).rejects.toThrow("huddle_transcript_requires_participant_access");
    expect(participantOnlySlack.calls.some((call) => call.query.includes("redir="))).toBe(false);
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
    const threadedOperationId = crypto.randomUUID();
    const threadedPost = await bot.postMessage({
      operationId: threadedOperationId,
      channelId: "C_MEMBER",
      threadTimestamp: "1.000",
      text: "private threaded fixture text",
    });
    expect(threadedPost).toMatchObject({ channelId: "C_MEMBER", timestamp: "3.000" });
    expect(slack.calls.find((call) => call.clientMessageId === threadedOperationId)).toMatchObject({
      channel: "C_MEMBER",
      threadTimestamp: "1.000",
    });
    await expect(
      bot.postMessage({
        operationId: threadedOperationId,
        channelId: "C_MEMBER",
        threadTimestamp: "9.000",
        text: "private threaded fixture text",
      }),
    ).rejects.toThrow("different Slack post request");
    expect(
      slack.calls.filter(
        (call) =>
          call.method === "chat.postMessage" && call.clientMessageId === threadedOperationId,
      ),
    ).toHaveLength(1);

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
        "slack_bot.thread_replies.read",
        "slack_bot.files.list",
        "slack_bot.file.info",
        "slack_bot.file.content.read",
        "slack_bot.message.post",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain("private fixture text");
    expect(JSON.stringify(audits)).not.toContain("private threaded fixture text");
    expect(JSON.stringify(audits)).not.toContain(fixtureBotToken());

    const second = await connectBot(workspace, fakeSlack().fetch);
    expect(second.response.status).toBe(302);
    await expect(
      resolveSlackBotConnectionForTool({ db: client.db, grant, sessionId: null }),
    ).rejects.toThrow("multiple active OpenGeni Slack bot connections");
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
