import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  signDelegatedAccessToken,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  claimSlackBotDeleteOperation,
  claimSlackBotPostOperation,
  createConnection,
  createDb,
  createSession,
  getConnectionMetadata,
  getSlackBotDeleteOperation,
  getSlackBotPostOperation,
  markSlackBotDeleteOperationProviderStarted,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  recordSlackBotInstallCallbackFailure,
  releaseSlackBotDeleteOperationClaim,
  releaseSlackBotPostOperationClaim,
  setConnectionStatus,
  updateConnection,
  updateSlackBotDocumentDestination,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  createSlackFilesListCursor,
  createOpenGeniSlackBotClient,
  exchangeOpenGeniSlackAuthorizationCode,
  nextSlackFilesListPage,
  resolveSlackFilesListPage,
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

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
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
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function fixtureBotToken(): string {
  return ["xoxb", "fixture", "not-a-real-credential"].join("-");
}

type SlackCall = {
  method: string;
  channel: string | null;
  count: string | null;
  page: string | null;
  cursor: string | null;
  limit: string | null;
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
    loseFirstDeleteResponse?: boolean;
    loseFirstDeleteBeforeCommit?: boolean;
    deleteErrorCode?: string;
    transcriptRequiresUserSession?: boolean;
    transcriptInFileInfo?: boolean;
    fileListResponse?: (input: { count: number; page: number }) => Record<string, unknown>;
  } = {},
) {
  const calls: SlackCall[] = [];
  const committedPosts = new Map<string, { channel: string; timestamp: string }>();
  const committedDeletes = new Set<string>();
  let postAttempts = 0;
  let deleteAttempts = 0;
  let failNextMemberChannelCheck = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = url.pathname.replace(/^\/api\//, "");
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push({
      method,
      channel: params.get("channel"),
      count: params.get("count"),
      page: params.get("page"),
      cursor: params.get("cursor"),
      limit: params.get("limit"),
      fileId: params.get("file"),
      clientMessageId: params.get("client_msg_id"),
      parentTimestamp: params.get("ts"),
      threadTimestamp: params.get("thread_ts"),
      hasText: params.has("text"),
      query: url.search,
    });
    const headers =
      method === "auth.test"
        ? {
            "x-oauth-scopes": (options.scopes ?? OPENGENI_SLACK_BOT_REQUESTED_SCOPES).join(","),
          }
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
          profile: {
            display_name: options.displayName ?? "OpenGeni",
            real_name: "OpenGeni",
          },
        },
      });
    }
    if (method === "conversations.list") {
      return Response.json({
        ok: true,
        channels: [
          {
            id: "C_MEMBER",
            name: "general",
            is_private: false,
            is_member: true,
          },
          {
            id: "G_PRIVATE",
            name: "private",
            is_private: true,
            is_member: false,
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (method === "conversations.info") {
      if (failNextMemberChannelCheck) {
        failNextMemberChannelCheck = false;
        return Response.json({ ok: false, error: "not_in_channel" });
      }
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
          {
            ts: "1.000",
            user: "U_MEMBER",
            text: "bounded history",
            thread_ts: "1.000",
          },
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
      const count = Number(params.get("count"));
      const page = Number(params.get("page"));
      if (options.fileListResponse) {
        return Response.json({
          ok: true,
          ...options.fileListResponse({ count, page }),
        });
      }
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
        paging: { count, total: 1, page, pages: 1 },
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
          huddle_transcription:
            options.transcriptInFileInfo &&
            transcript &&
            params.get("include_transcription") === "true"
              ? {
                  channel_id: "C_MEMBER",
                  date_start: 1_785_141_690,
                  date_end: 1_785_141_750,
                  lines: [
                    {
                      user_id: "U_MEMBER",
                      start_time_ms: 0,
                      contents: "A transcript returned directly by files.info.",
                    },
                  ],
                  blocks: [],
                  transcription_time_ranges: [],
                }
              : undefined,
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
      return Response.json({
        ok: true,
        channel: committed.channel,
        ts: committed.timestamp,
      });
    }
    if (method === "chat.delete") {
      const channel = params.get("channel");
      const timestamp = params.get("ts");
      if (!channel || !timestamp) {
        return Response.json({ ok: false, error: "invalid_arguments" });
      }
      deleteAttempts += 1;
      if (options.deleteErrorCode) {
        return Response.json({ ok: false, error: options.deleteErrorCode });
      }
      if (options.loseFirstDeleteBeforeCommit && deleteAttempts === 1) {
        throw new Error("fixture Slack delete response lost before commit");
      }
      committedDeletes.add(`${channel}:${timestamp}`);
      if (options.loseFirstDeleteResponse && deleteAttempts === 1) {
        throw new Error("fixture Slack delete response lost after commit");
      }
      return Response.json({ ok: true, channel, ts: timestamp });
    }
    if (method === "chat.getPermalink") {
      const channel = params.get("channel");
      const timestamp = params.get("message_ts");
      if (!channel || !timestamp) {
        return Response.json({ ok: false, error: "invalid_arguments" });
      }
      return committedDeletes.has(`${channel}:${timestamp}`)
        ? Response.json({ ok: false, error: "message_not_found" })
        : Response.json({
            ok: true,
            channel,
            permalink: "https://fixture.slack.com/message",
          });
    }
    return Response.json({ ok: false, error: "unexpected_method" });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    calls,
    committedPosts,
    committedDeletes,
    failNextMemberChannelCheck: () => {
      failNextMemberChannelCheck = true;
    },
  };
}

describe("Slack files.list pagination adapter", () => {
  const context = {
    connectionId: "11111111-1111-4111-8111-111111111111",
    key: randomBytes(32),
  };

  test("bounds count and advances exactly once across realistic pages", () => {
    expect(resolveSlackFilesListPage({ channelId: "C_MEMBER", limit: 999 }, context)).toEqual({
      count: 200,
      page: 1,
    });

    const firstPage = resolveSlackFilesListPage({ channelId: "C_MEMBER", limit: 1 }, context);
    expect(firstPage).toEqual({ count: 1, page: 1 });
    const nextPage = nextSlackFilesListPage(
      {
        files: [{ id: "F_PAGE_1" }],
        paging: { count: 1, total: 2, page: 1, pages: 2 },
      },
      firstPage,
      1,
    );
    expect(nextPage).toBe(2);
    const cursor = createSlackFilesListCursor(
      { channelId: "C_MEMBER", count: firstPage.count, page: nextPage! },
      context,
    );
    expect(cursor).toMatch(/^files-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const secondPage = resolveSlackFilesListPage({ channelId: "C_MEMBER", cursor }, context);
    expect(secondPage).toEqual({ count: 1, page: 2 });
    expect(
      nextSlackFilesListPage(
        {
          files: [{ id: "F_PAGE_2" }],
          paging: { count: 1, total: 2, page: 2, pages: 2 },
        },
        secondPage,
        1,
      ),
    ).toBeNull();
  });

  test("rejects malformed, mixed, oversized, and non-advancing provider paging", () => {
    const requested = { count: 1, page: 1 };
    const invalidPayloads = [
      { files: [] },
      {
        files: [],
        paging: { count: 1, total: 0, page: 1, pages: 0 },
        response_metadata: { next_cursor: "legacy-cursor" },
      },
      {
        files: [{ id: "F_ONE" }, { id: "F_TWO" }],
        paging: { count: 1, total: 1, page: 1, pages: 1 },
      },
      {
        files: [{ id: "F_PAGE_1" }],
        paging: { count: 1, total: 2, page: 2, pages: 2 },
      },
      {
        files: [{ id: "F_PAGE_1" }],
        paging: { count: 1, total: 2, page: 1, pages: 1 },
      },
    ];
    for (const payload of invalidPayloads) {
      expect(() =>
        nextSlackFilesListPage(
          payload,
          requested,
          Array.isArray(payload.files) ? payload.files.length : 0,
        ),
      ).toThrow("invalid_files_paging");
    }

    expect(() =>
      nextSlackFilesListPage(
        {
          files: [{ id: "F_PAGE_1" }],
          paging: { count: 1, total: 2, page: 1, pages: 2 },
        },
        { count: 1, page: 2 },
        1,
      ),
    ).toThrow("invalid_files_paging");
  });

  test("binds opaque continuations to connection, channel, and page size", () => {
    const cursor = createSlackFilesListCursor(
      { channelId: "C_MEMBER", count: 1, page: 2 },
      context,
    );
    expect(() => resolveSlackFilesListPage({ channelId: "C_OTHER", cursor }, context)).toThrow(
      "invalid_files_cursor",
    );
    expect(() =>
      resolveSlackFilesListPage({ channelId: "C_MEMBER", cursor, limit: 2 }, context),
    ).toThrow("invalid_files_cursor");
    expect(() =>
      resolveSlackFilesListPage(
        { channelId: "C_MEMBER", cursor },
        { ...context, connectionId: crypto.randomUUID() },
      ),
    ).toThrow("invalid_files_cursor");
    const replacement = cursor.endsWith("A") ? "B" : "A";
    expect(() =>
      resolveSlackFilesListPage(
        {
          channelId: "C_MEMBER",
          cursor: `${cursor.slice(0, -1)}${replacement}`,
        },
        context,
      ),
    ).toThrow("invalid_files_cursor");
  });
});

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

  test("accepts only required plus canonical safe optional scopes", async () => {
    expect(OPENGENI_SLACK_BOT_REQUIRED_SCOPES).toEqual([
      "app_mentions:read",
      "canvases:read",
      "channels:history",
      "channels:read",
      "chat:write",
      "commands",
      "files:read",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
      "users:read",
    ]);
    const exact = fakeSlack({ scopes: OPENGENI_SLACK_BOT_REQUIRED_SCOPES });
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
    ).rejects.toThrow("do not satisfy");
    for (const unsafe of [
      "files:write",
      "reactions:write",
      "chat:write.customize",
      "users:read.email",
      "admin",
      "admin.users:read",
      "search:read.enterprise",
      "future:unknown",
    ]) {
      await expect(
        verifyOpenGeniSlackBotCredential(
          fixtureBotToken(),
          fakeSlack({ scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, unsafe] }).fetch,
        ),
      ).rejects.toThrow("do not satisfy");
    }
    await expect(
      verifyOpenGeniSlackBotCredential(
        fixtureBotToken(),
        fakeSlack({
          scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "chat:write.public"],
        }).fetch,
      ),
    ).rejects.toThrow("do not satisfy");
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
): Promise<{
  response: Response;
  state: string | null;
  authorizationUrl: string | null;
}> {
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
  if (response.status !== 200) return { response, state: null, authorizationUrl: null };
  const installation = (await response.json()) as { authorizationUrl: string };
  return {
    response,
    state: new URL(installation.authorizationUrl).searchParams.get("state"),
    authorizationUrl: installation.authorizationUrl,
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
    return {
      response: start.response,
      body: { connection: { id: "", grantedScopes: [] } },
    };
  }
  const response = await completeBotInstall(slackFetch, start.state);
  const connections = await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a");
  const connection = connections.find(
    (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  );
  const body = {
    connection: {
      id: connection?.id ?? "",
      grantedScopes: connection?.grantedScopes ?? [],
    },
  };
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
  test("requests the reaction-capable bot manifest and completes the callback", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const start = await startBotInstall(workspace, slack.fetch);
    expect(start.response.status).toBe(200);
    if (!start.state || !start.authorizationUrl) {
      throw new Error("expected Slack installation authorization URL fixture");
    }
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://slack.com");
    expect(authorizationUrl.pathname).toBe("/oauth/v2/authorize");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      OPENGENI_SLACK_BOT_REQUESTED_SCOPES.join(","),
    );
    expect(authorizationUrl.searchParams.has("user_scope")).toBe(false);

    const callback = await completeBotInstall(slack.fetch, start.state);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("slack=connected");
    const [connection] = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, null)
    ).filter(
      (candidate) => candidate.metadata.credentialRole === OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
    );
    expect(connection).toMatchObject({
      status: "active",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES].sort(),
      verifiedInstallVersion: 1,
    });
    expect(connection?.verifiedInstallAt).not.toBeNull();
  });

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
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES].sort(),
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
      {
        slack: fakeSlack({ displayName: "Not OpenGeni" }),
        reason: "identity_mismatch",
      },
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

  test("accepts only explicitly safe additional Slack scopes", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const result = await connectBot(
      workspace,
      fakeSlack({
        scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, ...OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES],
      }).fetch,
    );
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("location")).toContain("slack=connected");
    expect(result.body.connection.grantedScopes).toEqual(
      expect.arrayContaining([...OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES]),
    );
  });

  test("deterministically collapses equal-timestamp legacy duplicates only for one bot principal", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const connected = await connectBot(workspace, fakeSlack().fetch);
    const original = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.body.connection.id,
      null,
    );
    if (!original) throw new Error("expected connected Slack bot fixture");
    const duplicate = await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "legacy-duplicate-fixture",
      grantedScopes: [...original.grantedScopes],
      verifiedInstallAt: new Date(original.verifiedInstallAt!),
      verifiedInstallVersion: 1,
      metadata: { ...original.metadata },
      createdBySubjectId: "subject-a",
    });
    const equalCreatedAt = new Date("2026-07-31T12:00:00.000Z");
    await shared!.admin`
      update connections
      set created_at = ${equalCreatedAt}
      where workspace_id = ${workspace.workspaceId}
        and id in (${original.id}, ${duplicate.id})`;

    const ordered = (await listConnectionsMetadata(client.db, workspace.workspaceId, null)).filter(
      (connection) => connection.id === original.id || connection.id === duplicate.id,
    );
    const expectedId = [original.id, duplicate.id].sort().reverse()[0]!;
    expect(ordered.map((connection) => connection.id)).toEqual(
      [original.id, duplicate.id].sort().reverse(),
    );
    expect(
      await resolveSlackBotConnectionForTool({
        db: client.db,
        grant: {
          ...workspace,
          subjectId: "subject-a",
          permissions: ["connections:read"],
          metadata: {},
        },
        sessionId: null,
      }),
    ).toMatchObject({ connection: { id: expectedId } });

    const otherWorkspace = await freshWorkspace();
    const crossTenant = await createConnection(client.db, {
      accountId: otherWorkspace.accountId,
      workspaceId: otherWorkspace.workspaceId,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "cross-tenant-duplicate-fixture",
      grantedScopes: [...original.grantedScopes],
      verifiedInstallAt: new Date(original.verifiedInstallAt!),
      verifiedInstallVersion: 1,
      metadata: { ...original.metadata },
      createdBySubjectId: "subject-a",
    });
    expect(
      (await listConnectionsMetadata(client.db, workspace.workspaceId, null)).some(
        (connection) => connection.id === crossTenant.id,
      ),
    ).toBe(false);

    await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "different-principal-fixture",
      grantedScopes: [...original.grantedScopes],
      verifiedInstallAt: new Date(original.verifiedInstallAt!),
      verifiedInstallVersion: 1,
      metadata: {
        ...original.metadata,
        botId: "B_OTHER",
        botUserId: "U_OTHER",
      },
      createdBySubjectId: "subject-a",
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
      }),
    ).rejects.toThrow("multiple active OpenGeni Slack bot connections");
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
        return Response.json({
          ok: false,
          error: "fixture_provider_exchange_payload",
        });
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
    ).toMatchObject({
      version: before!.version + 1,
      verifiedInstallVersion: before!.version + 1,
    });
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

  test("adapts files.list to bounded count/page pagination with opaque continuation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack({
      fileListResponse: ({ count, page }) => {
        if (count === 200) {
          return {
            files: [{ id: "F_BOUNDED", title: "Bounded page" }],
            paging: { count, total: 1, page, pages: 1 },
          };
        }
        return {
          files: [{ id: page === 1 ? "F_PAGE_1" : "F_PAGE_2", title: `Page ${page}` }],
          paging: { count, total: 2, page, pages: 2 },
        };
      },
    });
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
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );

    const bounded = await bot.listFiles({ channelId: "C_MEMBER", limit: 999 });
    expect(bounded).toMatchObject({
      files: [{ id: "F_BOUNDED", title: "Bounded page" }],
      nextCursor: null,
    });

    const first = await bot.listFiles({ channelId: "C_MEMBER", limit: 1 });
    expect(first).toMatchObject({
      files: [{ id: "F_PAGE_1", title: "Page 1" }],
    });
    expect(first.nextCursor).toMatch(/^files-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const second = await bot.listFiles({
      channelId: "C_MEMBER",
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({
      files: [{ id: "F_PAGE_2", title: "Page 2" }],
      nextCursor: null,
    });
    expect(new Set([...first.files, ...second.files].map((file) => file.id)).size).toBe(2);

    const fileCalls = slack.calls.filter((call) => call.method === "files.list");
    expect(fileCalls).toMatchObject([
      {
        channel: "C_MEMBER",
        count: "200",
        page: "1",
        cursor: null,
        limit: null,
      },
      { channel: "C_MEMBER", count: "1", page: "1", cursor: null, limit: null },
      { channel: "C_MEMBER", count: "1", page: "2", cursor: null, limit: null },
    ]);

    await expect(
      bot.listFiles({
        channelId: "C_MEMBER",
        cursor: first.nextCursor!,
        limit: 2,
      }),
    ).rejects.toThrow("invalid_files_cursor");
    await expect(
      bot.listFiles({ channelId: "C_OTHER", cursor: first.nextCursor! }),
    ).rejects.toThrow("invalid_files_cursor");
    const replacement = first.nextCursor!.endsWith("A") ? "B" : "A";
    await expect(
      bot.listFiles({
        channelId: "C_MEMBER",
        cursor: `${first.nextCursor!.slice(0, -1)}${replacement}`,
      }),
    ).rejects.toThrow("invalid_files_cursor");
    expect(slack.calls.filter((call) => call.method === "files.list")).toHaveLength(3);
  });

  test("rejects malformed, mixed, and non-advancing files.list paging", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installSlack = fakeSlack();
    const connected = await connectBot(workspace, installSlack.fetch);
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

    const malformedResponses = [
      () => ({ files: [] }),
      ({ count, page }: { count: number; page: number }) => ({
        files: [],
        paging: { count, total: 0, page, pages: 0 },
        response_metadata: { next_cursor: "legacy-cursor" },
      }),
      ({ count, page }: { count: number; page: number }) => ({
        files: [{ id: "F_ONE" }, { id: "F_TWO" }],
        paging: { count, total: 1, page, pages: 1 },
      }),
    ];
    for (const fileListResponse of malformedResponses) {
      const slack = fakeSlack({ fileListResponse });
      const bot = createOpenGeniSlackBotClient(
        { db: client.db, settings, slackFetch: slack.fetch },
        resolved,
      );
      await expect(bot.listFiles({ channelId: "C_MEMBER", limit: 1 })).rejects.toThrow(
        "invalid_files_paging",
      );
      expect(slack.calls.filter((call) => call.method === "files.list")).toMatchObject([
        { count: "1", page: "1", cursor: null, limit: null },
      ]);
    }

    const firstPageSlack = fakeSlack({
      fileListResponse: ({ count, page }) => ({
        files: [{ id: "F_PAGE_1" }],
        paging: { count, total: 2, page, pages: 2 },
      }),
    });
    const firstPageBot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: firstPageSlack.fetch },
      resolved,
    );
    const first = await firstPageBot.listFiles({
      channelId: "C_MEMBER",
      limit: 1,
    });
    expect(first.nextCursor).toBeString();

    const repeatedPageSlack = fakeSlack({
      fileListResponse: ({ count }) => ({
        files: [{ id: "F_PAGE_1" }],
        paging: { count, total: 2, page: 1, pages: 2 },
      }),
    });
    const repeatedPageBot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: repeatedPageSlack.fetch },
      resolved,
    );
    await expect(
      repeatedPageBot.listFiles({
        channelId: "C_MEMBER",
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow("invalid_files_paging");
    expect(repeatedPageSlack.calls.filter((call) => call.method === "files.list")).toMatchObject([
      { count: "1", page: "2", cursor: null, limit: null },
    ]);
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
        expect.objectContaining({
          id: "C_MEMBER",
          isMember: true,
          isPrivate: false,
        }),
        expect.objectContaining({
          id: "G_PRIVATE",
          isMember: false,
          isPrivate: true,
        }),
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
        {
          timestamp: "1.000",
          threadTimestamp: "1.000",
          text: "bounded history",
        },
        {
          timestamp: "1.001",
          threadTimestamp: "1.000",
          text: "bounded thread reply",
        },
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
    const file = await bot.fileInfo({
      channelId: "C_MEMBER",
      fileId: "F_CANVAS",
    });
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
    const content = await bot.fileContent({
      channelId: "C_MEMBER",
      fileId: "F_CANVAS",
    });
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
    const participantOnlySlack = fakeSlack({
      transcriptRequiresUserSession: true,
    });
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
    const inlineTranscriptSlack = fakeSlack({
      transcriptRequiresUserSession: true,
      transcriptInFileInfo: true,
    });
    const inlineTranscriptBot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: inlineTranscriptSlack.fetch },
      resolved,
    );
    const inlineTranscript = await inlineTranscriptBot.fileContent({
      channelId: "C_MEMBER",
      fileId: "FTRANSCRIPT",
      parentFileId: "F_CANVAS",
    });
    expect(inlineTranscript).toMatchObject({
      contentType: "application/json",
      content: expect.stringContaining("A transcript returned directly by files.info."),
      nextOffset: null,
      truncated: false,
    });
    expect(inlineTranscriptSlack.calls.some((call) => call.query.includes("redir="))).toBe(false);
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
    expect(threadedPost).toMatchObject({
      channelId: "C_MEMBER",
      timestamp: "3.000",
      threadTimestamp: "1.000",
    });
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
    const deleted = await bot.deleteMessage({
      operationId: crypto.randomUUID(),
      channelId: "C_MEMBER",
      timestamp: threadedPost.timestamp,
    });
    expect(deleted).toMatchObject({
      channelId: "C_MEMBER",
      timestamp: "3.000",
      deleted: true,
      receipt: { operation: "message.delete", operationId: expect.any(String) },
    });
    expect(slack.calls.find((call) => call.method === "chat.delete")).toMatchObject({
      channel: "C_MEMBER",
      parentTimestamp: "3.000",
      hasText: false,
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
        "slack_bot.thread_replies.read",
        "slack_bot.files.list",
        "slack_bot.file.info",
        "slack_bot.file.content.read",
        "slack_bot.message.post",
        "slack_bot.message.delete",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain("private fixture text");
    expect(JSON.stringify(audits)).not.toContain("private threaded fixture text");
    expect(JSON.stringify(audits)).not.toContain(fixtureBotToken());

    const second = await connectBot(workspace, fakeSlack().fetch);
    expect(second.response.status).toBe(302);
    expect(second.body.connection.id).toBe(connected.body.connection.id);
    expect(
      await resolveSlackBotConnectionForTool({
        db: client.db,
        grant,
        sessionId: null,
      }),
    ).toMatchObject({ connection: { id: connected.body.connection.id } });
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
    const post = {
      operationId,
      channelId: "C_MEMBER",
      text: "idempotent fixture text",
    };

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
    ).toMatchObject({
      status: "completed",
      attemptCount: 2,
      slackMessageTimestamp: "2.000",
    });

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

  test("reconciles ambiguous delete outcomes without blindly issuing chat.delete twice", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack({ loseFirstDeleteResponse: true });
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
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );
    const operationId = crypto.randomUUID();
    const request = { operationId, channelId: "C_MEMBER", timestamp: "3.000" };

    await expect(bot.deleteMessage(request)).rejects.toThrow("transport_error");
    expect(slack.committedDeletes).toContain("C_MEMBER:3.000");
    expect(
      await getSlackBotDeleteOperation(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        operationId,
      ),
    ).toMatchObject({
      status: "outcome_unknown",
      claimHolderId: null,
      attemptCount: 1,
      principalType: "subject",
      principalId: "subject-a",
      toolName: "slack_bot_delete_message",
    });

    const retried = await bot.deleteMessage(request);
    expect(retried).toMatchObject({
      channelId: "C_MEMBER",
      timestamp: "3.000",
      deleted: true,
      receipt: { operationId, operation: "message.delete" },
    });
    expect(slack.calls.filter((call) => call.method === "chat.delete")).toHaveLength(1);
    expect(slack.calls.filter((call) => call.method === "chat.getPermalink")).toHaveLength(1);

    const replay = await bot.deleteMessage(request);
    expect(replay).toEqual(retried);
    expect(slack.calls.filter((call) => call.method === "chat.delete")).toHaveLength(1);
    expect(slack.calls.filter((call) => call.method === "chat.getPermalink")).toHaveLength(1);
    expect(
      await getSlackBotDeleteOperation(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        operationId,
      ),
    ).toMatchObject({ status: "completed", attemptCount: 2 });

    await expect(bot.deleteMessage({ ...request, timestamp: "4.000" })).rejects.toThrow(
      "already bound",
    );
    const resolvedForOtherSubject = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant: {
        ...workspace,
        subjectId: "subject-b",
        permissions: ["connections:read"],
        metadata: {},
      },
      sessionId: null,
      requestedConnectionId: connected.body.connection.id,
    });
    const otherSubjectBot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolvedForOtherSubject,
    );
    await expect(otherSubjectBot.deleteMessage(request)).rejects.toThrow("already bound");

    const audits = await shared!.admin<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where workspace_id = ${workspace.workspaceId}
        and action = 'slack_bot.message.delete'
        and metadata->>'operationId' = ${operationId}
      order by occurred_at, id`;
    expect(audits.filter((audit) => audit.metadata.outcome === "succeeded")).toHaveLength(1);
    expect(audits.filter((audit) => audit.metadata.outcome === "ambiguous")).toHaveLength(1);
  });

  test("preserves reconcile state across pre-reconciliation failures", async () => {
    if (!available) return;
    for (const failure of ["headers", "member"] as const) {
      const workspace = await freshWorkspace();
      const slack = fakeSlack({ loseFirstDeleteResponse: true });
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
      const bot = createOpenGeniSlackBotClient(
        { db: client.db, settings, slackFetch: slack.fetch },
        resolved,
      );
      const operationId = crypto.randomUUID();
      const request = {
        operationId,
        channelId: "C_MEMBER",
        timestamp: "3.500",
      };

      await expect(bot.deleteMessage(request)).rejects.toThrow("transport_error");
      expect(
        await getSlackBotDeleteOperation(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          operationId,
        ),
      ).toMatchObject({
        status: "outcome_unknown",
        claimHolderId: null,
        attemptCount: 1,
      });
      expect(slack.committedDeletes).toContain("C_MEMBER:3.500");

      if (failure === "headers") {
        const connection = await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          null,
        );
        if (!connection) throw new Error("expected connected Slack bot fixture");
        expect(
          await setConnectionStatus(
            client.db,
            workspace.workspaceId,
            "needs_reauth",
            "reconcile_headers_fixture",
            { id: connection.id, version: connection.version, subjectId: null },
          ),
        ).toBe(true);
      } else {
        slack.failNextMemberChannelCheck();
      }

      await expect(bot.deleteMessage(request)).rejects.toThrow();
      expect(
        await getSlackBotDeleteOperation(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          operationId,
        ),
      ).toMatchObject({
        status: "outcome_unknown",
        claimHolderId: null,
        attemptCount: 2,
      });

      if (failure === "headers") {
        const connection = await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          null,
        );
        if (!connection) throw new Error("expected connected Slack bot fixture");
        expect(
          await setConnectionStatus(client.db, workspace.workspaceId, "active", null, {
            id: connection.id,
            version: connection.version,
            subjectId: null,
          }),
        ).toBe(true);
      }

      await expect(bot.deleteMessage(request)).resolves.toMatchObject({
        deleted: true,
      });
      expect(slack.calls.filter((call) => call.method === "chat.getPermalink")).toHaveLength(1);
      expect(slack.calls.filter((call) => call.method === "chat.delete")).toHaveLength(1);
      expect(
        await getSlackBotDeleteOperation(
          client.db,
          workspace.workspaceId,
          connected.body.connection.id,
          operationId,
        ),
      ).toMatchObject({ status: "completed", attemptCount: 3 });
    }
  });

  test("rechecks an unknown but uncommitted delete before one safe retry", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack({ loseFirstDeleteBeforeCommit: true });
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
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );
    const request = {
      operationId: crypto.randomUUID(),
      channelId: "C_MEMBER",
      timestamp: "5.000",
    };
    await expect(bot.deleteMessage(request)).rejects.toThrow("transport_error");
    expect(slack.committedDeletes).not.toContain("C_MEMBER:5.000");
    await expect(bot.deleteMessage(request)).resolves.toMatchObject({
      deleted: true,
    });
    expect(slack.calls.filter((call) => call.method === "chat.getPermalink")).toHaveLength(1);
    expect(slack.calls.filter((call) => call.method === "chat.delete")).toHaveLength(2);
    expect(slack.committedDeletes).toContain("C_MEMBER:5.000");
  });

  test("keeps bot-owned-only deletion failures non-completed and retryable", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack({ deleteErrorCode: "cant_delete_message" });
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
    const bot = createOpenGeniSlackBotClient(
      { db: client.db, settings, slackFetch: slack.fetch },
      resolved,
    );
    const operationId = crypto.randomUUID();
    await expect(
      bot.deleteMessage({
        operationId,
        channelId: "C_MEMBER",
        timestamp: "6.000",
      }),
    ).rejects.toThrow("cant_delete_message");
    expect(
      await getSlackBotDeleteOperation(
        client.db,
        workspace.workspaceId,
        connected.body.connection.id,
        operationId,
      ),
    ).toMatchObject({
      status: "pending",
      lastFailureCode: "cant_delete_message",
    });
  });

  test("fences in-flight delete claims by tenant, principal, connection, tool, and request", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const connected = await connectBot(workspace, fakeSlack().fetch);
    const otherConnection = await connectBot(
      workspace,
      fakeSlack({ botId: "B_OTHER", botUserId: "U_OTHER" }).fetch,
    );
    const operationId = crypto.randomUUID();
    const firstHolder = crypto.randomUUID();
    const baseClaim = {
      ...workspace,
      connectionId: connected.body.connection.id,
      operationId,
      principalType: "subject" as const,
      principalId: "subject-a",
      toolName: "slack_bot_delete_message" as const,
      channelId: "C_MEMBER",
      messageTimestamp: "7.000",
      requestDigest: "b".repeat(64),
      claimLeaseMs: 30_000,
    };
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        claimHolderId: firstHolder,
      }),
    ).toMatchObject({ kind: "claimed", operation: { attemptCount: 1 } });
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        claimHolderId: crypto.randomUUID(),
      }),
    ).toMatchObject({ kind: "in_progress" });
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        principalId: "subject-b",
        claimHolderId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "conflict" });
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        toolName: "different_tool" as never,
        claimHolderId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "conflict" });
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        connectionId: otherConnection.body.connection.id,
        claimHolderId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "conflict" });

    const otherWorkspace = await freshWorkspace();
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        ...otherWorkspace,
        claimHolderId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "connection_not_found" });
    expect(
      await getSlackBotDeleteOperation(
        client.db,
        otherWorkspace.workspaceId,
        connected.body.connection.id,
        operationId,
      ),
    ).toBeNull();

    expect(
      await markSlackBotDeleteOperationProviderStarted(client.db, {
        ...workspace,
        connectionId: connected.body.connection.id,
        operationId,
        claimHolderId: firstHolder,
      }),
    ).toBe(true);
    await shared!.admin`
      update slack_bot_delete_operations
      set claim_expires_at = now() - interval '1 second'
      where workspace_id = ${workspace.workspaceId}
        and operation_id = ${operationId}`;
    const reclaimHolder = crypto.randomUUID();
    expect(
      await claimSlackBotDeleteOperation(client.db, {
        ...baseClaim,
        claimHolderId: reclaimHolder,
      }),
    ).toMatchObject({ kind: "reconcile", operation: { attemptCount: 2 } });
    expect(
      await releaseSlackBotDeleteOperationClaim(client.db, {
        ...workspace,
        connectionId: connected.body.connection.id,
        operationId,
        claimHolderId: reclaimHolder,
        outcomeUnknown: true,
        failureCode: "reconcile_fixture",
      }),
    ).toBe(true);
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
    expect(first).toMatchObject({
      kind: "claimed",
      operation: { attemptCount: 1 },
    });
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
    const post = {
      operationId,
      channelId: "C_MEMBER",
      text: "audit rollback fixture",
    };
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
    expect(retried.receipt).toMatchObject({
      operationId,
      clientMessageId: operationId,
    });
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

  test("preserves verified Slack bot proof across fenced destination transitions", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const slack = fakeSlack();
    const connected = await connectBot(workspace, slack.fetch);
    const connectionId = connected.body.connection.id;
    const endpoint = `/v1/workspaces/${workspace.workspaceId}/connections/${connectionId}`;
    const writeAuthorization = await bearer(workspace, "subject-a", ["connections:write"]);
    const before = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connectionId,
      null,
    );
    expect(before).toMatchObject({ version: 1, verifiedInstallVersion: 1 });
    expect(before?.verifiedInstallAt).not.toBeNull();
    if (!before?.verifiedInstallAt) throw new Error("expected verified Slack bot fixture");

    const personal = await app(slack.fetch).request(endpoint, {
      method: "PATCH",
      headers: {
        authorization: writeAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          documentDestination: { authorityKind: "personal", collectionId: null },
        },
      }),
    });
    expect(personal.status).toBe(200);
    const afterPersonal = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connectionId,
      null,
    );
    expect(afterPersonal).toMatchObject({ version: 2, verifiedInstallVersion: 2 });
    expect(afterPersonal?.verifiedInstallAt).toBe(before.verifiedInstallAt);
    expect(afterPersonal?.metadata.documentDestination).toEqual({
      authorityKind: "personal",
      authorityAccountId: workspace.accountId,
      authorityWorkspaceId: workspace.workspaceId,
      authoritySubjectId: "subject-a",
      collectionId: null,
    });

    const resolvedAfterPersonal = await resolveSlackBotConnectionForTool({
      db: client.db,
      grant: {
        ...workspace,
        subjectId: "subject-a",
        permissions: ["connections:read"],
        metadata: {},
      },
      sessionId: null,
      requestedConnectionId: connectionId,
    });
    expect(resolvedAfterPersonal.connection).toMatchObject({ id: connectionId, version: 2 });

    const reinstallSelection = await startBotInstall(workspace, slack.fetch, connectionId);
    expect(reinstallSelection.response.status).toBe(200);
    expect(reinstallSelection.state).not.toBeNull();

    const rejectedGenericMutation = await app(slack.fetch).request(endpoint, {
      method: "PATCH",
      headers: {
        authorization: writeAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ metadata: { label: "must not bypass the reserved bot guard" } }),
    });
    expect(rejectedGenericMutation.status).toBe(422);
    expect(
      await getConnectionMetadata(client.db, workspace.workspaceId, connectionId, null),
    ).toMatchObject({ version: 2, verifiedInstallVersion: 2 });

    const deniedWorkspace = await app(slack.fetch).request(endpoint, {
      method: "PATCH",
      headers: {
        authorization: writeAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          documentDestination: { authorityKind: "workspace", collectionId: null },
        },
      }),
    });
    expect(deniedWorkspace.status).toBe(403);

    await shared!.admin`
      update workspace_memberships
      set permissions = ${shared!.admin.json([
        "connections:read",
        "connections:write",
        "workspace:admin",
      ])}
      where workspace_id = ${workspace.workspaceId}
        and subject_id = 'subject-a'`;
    const adminAuthorization = await bearer(workspace, "subject-a", [
      "connections:write",
      "workspace:admin",
    ]);
    const allowedWorkspace = await app(slack.fetch).request(endpoint, {
      method: "PATCH",
      headers: {
        authorization: adminAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          documentDestination: { authorityKind: "workspace", collectionId: null },
        },
      }),
    });
    expect(allowedWorkspace.status).toBe(200);
    const persisted = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connectionId,
      null,
    );
    expect(persisted).toMatchObject({ version: 3, verifiedInstallVersion: 3 });
    expect(persisted?.verifiedInstallAt).toBe(before.verifiedInstallAt);
    expect(persisted?.metadata.documentDestination).toEqual({
      authorityKind: "workspace",
      authorityAccountId: workspace.accountId,
      authorityWorkspaceId: workspace.workspaceId,
      authoritySubjectId: null,
      collectionId: null,
    });
    if (!persisted) throw new Error("expected persisted Slack bot destination");

    const personalRaceMetadata = {
      ...persisted.metadata,
      documentDestination: {
        authorityKind: "personal",
        authorityAccountId: workspace.accountId,
        authorityWorkspaceId: workspace.workspaceId,
        authoritySubjectId: "subject-a",
        collectionId: null,
      },
    };
    const workspaceRaceMetadata = {
      ...persisted.metadata,
      documentDestination: {
        authorityKind: "workspace",
        authorityAccountId: workspace.accountId,
        authorityWorkspaceId: workspace.workspaceId,
        authoritySubjectId: null,
        collectionId: null,
      },
    };
    const [firstRace, secondRace] = await Promise.all([
      updateSlackBotDocumentDestination(client.db, {
        ...workspace,
        connectionId,
        visibleToSubjectId: "subject-a",
        expectedVersion: persisted.version,
        metadata: personalRaceMetadata,
        updatedBySubjectId: "subject-a",
      }),
      updateSlackBotDocumentDestination(client.db, {
        ...workspace,
        connectionId,
        visibleToSubjectId: "subject-a",
        expectedVersion: persisted.version,
        metadata: workspaceRaceMetadata,
        updatedBySubjectId: "subject-a",
      }),
    ]);
    expect([firstRace, secondRace].filter((result) => result !== null)).toHaveLength(1);
    expect([firstRace, secondRace].filter((result) => result === null)).toHaveLength(1);
    const afterRace = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connectionId,
      null,
    );
    expect(afterRace).toMatchObject({ version: 4, verifiedInstallVersion: 4 });
    expect(afterRace?.verifiedInstallAt).toBe(before.verifiedInstallAt);
    expect(afterRace?.metadata.documentDestination).toEqual(
      firstRace !== null
        ? personalRaceMetadata.documentDestination
        : workspaceRaceMetadata.documentDestination,
    );

    const stale = await updateSlackBotDocumentDestination(client.db, {
      ...workspace,
      connectionId,
      visibleToSubjectId: "subject-a",
      expectedVersion: persisted.version,
      metadata: persisted.metadata,
      updatedBySubjectId: "subject-a",
    });
    expect(stale).toBeNull();
    expect(
      await getConnectionMetadata(client.db, workspace.workspaceId, connectionId, null),
    ).toMatchObject({
      version: 4,
      verifiedInstallVersion: 4,
      metadata: { documentDestination: afterRace?.metadata.documentDestination },
    });

    expect(
      (
        await resolveSlackBotConnectionForTool({
          db: client.db,
          grant: {
            ...workspace,
            subjectId: "subject-a",
            permissions: ["connections:read"],
            metadata: {},
          },
          sessionId: null,
          requestedConnectionId: connectionId,
        })
      ).connection,
    ).toMatchObject({ id: connectionId, version: 4 });

    const capabilitiesSource = await Bun.file(
      new URL("../../web/src/routes/capabilities.tsx", import.meta.url),
    ).text();
    expect(capabilitiesSource).toContain("Slack knowledge destination");
    expect(capabilitiesSource).toContain("slackBotDestinationLabel");
    expect(capabilitiesSource).toContain("collectionId: null");
    expect(capabilitiesSource).toContain("No user-created collection is required");
  });
});
