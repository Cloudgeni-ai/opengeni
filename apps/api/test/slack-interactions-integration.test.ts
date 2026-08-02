import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createConnection,
  createDb,
  encryptVariableSetValue,
  grantWorkspaceAccess,
  saveSlackBotUserLink,
  type DbClient,
} from "@opengeni/db";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import {
  createSlackUserLinkToken,
  drainSlackInteractionsOnce,
  registerSlackInteractionRoutes,
  verifySlackUserLinkToken,
} from "../src/integrations/slack-interactions";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const signingMaterial = ["slack", "interaction", crypto.randomUUID()].join("-");
const encryptionKey = randomBytes(32).toString("base64");
const authorizationHeaderName = ["author", "ization"].join("");
const bearerScheme = ["Bear", "er"].join("");
const SLACK_READ_ONLY_CONTEXT_TOOLS = [
  "slack_bot_list_channels",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
] as const;

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("slack-interactions-api");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[slack-interactions-api] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type SlackPost = {
  channel: string;
  text: string;
  threadTimestamp: string | null;
  clientMessageId: string | null;
  timestamp: string;
};

function fakeSlack(
  deniedChannels: Set<string> = new Set(),
  options: { failAfterAcceptTexts?: Set<string> } = {},
) {
  const posts: SlackPost[] = [];
  const failuresByText = new Map<
    string,
    { error?: string; status?: number; retryAfterSeconds?: number }
  >();
  const channelAccessFailures = new Map<
    string,
    { error?: string; status?: number; retryAfterSeconds?: number }
  >();
  const acceptedByClientMessageId = new Map<string, SlackPost>();
  const failedAfterAccept = new Set<string>();
  let nextTimestamp = 1;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = url.pathname.replace(/^\/api\//, "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (method === "conversations.info") {
      const channel = form.get("channel") ?? "";
      const configuredFailure = channelAccessFailures.get(channel);
      if (configuredFailure) {
        const status = configuredFailure.status ?? 200;
        return Response.json(
          status === 200
            ? { ok: false, error: configuredFailure.error ?? "unknown_error" }
            : { ok: false },
          {
            status,
            headers: configuredFailure.retryAfterSeconds
              ? { "retry-after": String(configuredFailure.retryAfterSeconds) }
              : undefined,
          },
        );
      }
      return Response.json({
        ok: true,
        channel: {
          id: channel,
          name: channel,
          is_member: !deniedChannels.has(channel),
          is_im: channel.startsWith("D"),
          is_private: channel.startsWith("D") || channel.startsWith("G"),
        },
      });
    }
    if (method === "conversations.open") {
      const user = form.get("users") ?? "";
      return Response.json({ ok: true, channel: { id: `D_${user}` } });
    }
    if (method === "chat.postMessage") {
      const clientMessageId = form.get("client_msg_id");
      const accepted = clientMessageId ? acceptedByClientMessageId.get(clientMessageId) : null;
      if (accepted) {
        return Response.json({ ok: true, channel: accepted.channel, ts: accepted.timestamp });
      }
      const timestamp = `1800000000.${String(nextTimestamp++).padStart(6, "0")}`;
      const post = {
        channel: form.get("channel") ?? "",
        text: form.get("text") ?? "",
        threadTimestamp: form.get("thread_ts"),
        clientMessageId,
        timestamp,
      };
      posts.push(post);
      const configuredFailure = [...failuresByText.entries()].find(([fragment]) =>
        post.text.includes(fragment),
      )?.[1];
      if (configuredFailure) {
        const status = configuredFailure.status ?? 200;
        return Response.json(
          status === 200
            ? { ok: false, error: configuredFailure.error ?? "unknown_error" }
            : { ok: false },
          {
            status,
            headers: configuredFailure.retryAfterSeconds
              ? { "retry-after": String(configuredFailure.retryAfterSeconds) }
              : undefined,
          },
        );
      }
      if (clientMessageId) acceptedByClientMessageId.set(clientMessageId, post);
      if (options.failAfterAcceptTexts?.has(post.text) && !failedAfterAccept.has(post.text)) {
        failedAfterAccept.add(post.text);
        throw new TypeError("simulated Slack response loss after provider acceptance");
      }
      return Response.json({ ok: true, channel: form.get("channel"), ts: timestamp });
    }
    return Response.json({ ok: false, error: `unexpected_${method}` });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    posts,
    failuresByText,
    channelAccessFailures,
  };
}

function encryptedBotCredential(settings: Settings): string {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new Error("test connection encryption key was not configured");
  return encryptVariableSetValue(
    key,
    JSON.stringify({
      headers: {
        [authorizationHeaderName]: `${bearerScheme} ${["xoxb", "fixture", crypto.randomUUID()].join("-")}`,
      },
    }),
  );
}

async function fixture(
  options: {
    deniedChannels?: string[];
    linkOther?: boolean;
    failAfterAcceptTexts?: string[];
  } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "slack-interactions-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Slack interactions",
    workspaceExternalSource: "slack-interactions-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Slack interactions",
    subjectId: `user:owner-${suffix}`,
  });
  const owner = access.workspaceGrants[0]!;
  const otherSubjectId = `user:other-${suffix}`;
  const permissions = ["sessions:create", "sessions:read", "sessions:control"] as const;
  await grantWorkspaceAccess(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    permissions: [...permissions],
  });
  await grantWorkspaceAccess(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: otherSubjectId,
    permissions: [...permissions],
  });

  const teamId = `T_${suffix}`;
  const botId = `B_${suffix}`;
  const botUserId = `U_BOT_${suffix}`;
  const ownerSlackUserId = `U_OWNER_${suffix}`;
  const otherSlackUserId = `U_OTHER_${suffix}`;
  const settings = testSettings({
    productAccessMode: "managed",
    environmentsEncryptionKey: encryptionKey,
    slackSigningSecret: signingMaterial,
    publicBaseUrl: "https://app.example.test",
    webBaseUrl: "https://app.example.test",
    sandboxBackend: "none",
  });
  const connectionInput: Record<string, unknown> = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    verifiedInstallAt: new Date(),
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: teamId,
      slackTeamName: "Slack interaction test",
      botId,
      botUserId,
      botDisplayName: "OpenGeni",
      verifiedAt: new Date().toISOString(),
    },
    createdBySubjectId: owner.subjectId,
  };
  Reflect.set(
    connectionInput,
    ["credential", "Encrypted"].join(""),
    encryptedBotCredential(settings),
  );
  const connection = await createConnection(
    client.db,
    connectionInput as Parameters<typeof createConnection>[1],
  );
  await saveSlackBotUserLink(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    connectionId: connection.id,
    slackTeamId: teamId,
    slackUserId: ownerSlackUserId,
    subjectId: owner.subjectId,
    linkedBySubjectId: owner.subjectId,
  });
  if (options.linkOther) {
    await saveSlackBotUserLink(client.db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      connectionId: connection.id,
      slackTeamId: teamId,
      slackUserId: otherSlackUserId,
      subjectId: otherSubjectId,
      linkedBySubjectId: otherSubjectId,
    });
  }

  const slack = fakeSlack(new Set(options.deniedChannels ?? []), {
    failAfterAcceptTexts: new Set(options.failAfterAcceptTexts ?? []),
  });
  const wakes: Array<{ sessionId: string }> = [];
  const noop = async () => undefined;
  const deps = {
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    slackFetch: slack.fetch,
    workflowClient: {
      wakeSessionWorkflow: async (input: { sessionId: string }) => {
        wakes.push({ sessionId: input.sessionId });
      },
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      requestSessionWorkflowWakeDispatch: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
  const app = new Hono();
  registerSlackInteractionRoutes(app, deps);
  return {
    app,
    deps,
    slack,
    wakes,
    owner,
    otherSubjectId,
    teamId,
    botUserId,
    ownerSlackUserId,
    otherSlackUserId,
    connectionId: connection.id,
  };
}

function signedRequest(path: string, rawBody: string, contentType: string) {
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = `v0=${createHmac("sha256", signingMaterial)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function eventBody(input: { teamId: string; eventId: string; event: Record<string, unknown> }) {
  return JSON.stringify({
    type: "event_callback",
    team_id: input.teamId,
    event_id: input.eventId,
    event: input.event,
  });
}

async function postEvent(
  app: Hono,
  input: { teamId: string; eventId: string; event: Record<string, unknown> },
) {
  return await app.request(
    signedRequest("/v1/integrations/slack/events", eventBody(input), "application/json"),
  );
}

async function drainAll(deps: ApiRouteDeps, limit = 50) {
  let count = 0;
  while (count < limit && (await drainSlackInteractionsOnce(deps))) count += 1;
  if (count === limit) throw new Error("Slack interaction drain did not become idle");
  return count;
}

async function interactions(workspaceId: string) {
  return await shared!.admin<
    {
      id: string;
      session_id: string;
      route_key: string;
      visibility: string;
      slack_thread_ts: string;
      progress_count: number;
      terminal_delivery_state: string;
    }[]
  >`
    select id, session_id, route_key, visibility, slack_thread_ts, progress_count,
      terminal_delivery_state
    from slack_interactions
    where workspace_id = ${workspaceId}
    order by created_at, id`;
}

describe("Slack-to-OpenGeni real PostgreSQL acceptance", () => {
  test("Slack identity link tokens are scoped, tamper-evident, and short-lived", () => {
    const now = 1_800_000_000_000;
    const input = {
      workspaceId: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
      slackTeamId: "T_LINK",
      slackUserId: "U_LINK",
    };
    const token = createSlackUserLinkToken(signingMaterial, input, now);
    expect(verifySlackUserLinkToken(signingMaterial, token, now)).toMatchObject(input);
    expect(verifySlackUserLinkToken(signingMaterial, `${token}x`, now)).toBeNull();
    expect(verifySlackUserLinkToken(signingMaterial, token, now + 16 * 60_000)).toBeNull();
  });

  test("top-level bot DMs create separate private sessions while thread replies and retries converge", async () => {
    if (!available) return;
    const value = await fixture();
    const first = {
      teamId: value.teamId,
      eventId: `E_DM_1_${crypto.randomUUID()}`,
      event: {
        type: "message",
        channel_type: "im",
        user: value.ownerSlackUserId,
        channel: "D_PRIVATE",
        ts: "1710000000.000001",
        text: "Start a private task",
      },
    };
    expect((await postEvent(value.app, first)).status).toBe(200);
    expect((await postEvent(value.app, first)).status).toBe(200);
    await drainAll(value.deps);

    let routes = await interactions(value.owner.workspaceId);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      route_key: "D_PRIVATE:1710000000.000001",
      visibility: "private",
    });
    expect(value.slack.posts).toHaveLength(1);
    expect(value.slack.posts[0]).toMatchObject({
      channel: "D_PRIVATE",
      threadTimestamp: "1710000000.000001",
    });
    expect(value.slack.posts[0]!.text).toContain("Open in OpenGeni:");
    expect(value.slack.posts[0]!.text).toContain("Reply in this thread to continue");
    const [sessionPolicy] = await shared!.admin<{ first_party_mcp_tools: string[] }[]>`
      select first_party_mcp_tools
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${routes[0]!.session_id}`;
    expect(sessionPolicy!.first_party_mcp_tools).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
      ...SLACK_READ_ONLY_CONTEXT_TOOLS,
    ]);
    expect(sessionPolicy!.first_party_mcp_tools).not.toContain("slack_bot_post_message");
    expect(sessionPolicy!.first_party_mcp_tools).not.toContain("slack_bot_delete_message");

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_DM_REPLY_${crypto.randomUUID()}`,
          event: {
            type: "message",
            user: value.ownerSlackUserId,
            channel: "D_PRIVATE",
            ts: "1710000000.000002",
            thread_ts: "1710000000.000001",
            text: "Continue the private task",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(1);

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_DM_2_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.ownerSlackUserId,
            channel: "D_PRIVATE",
            ts: "1710000001.000001",
            text: "Start another private task",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    routes = await interactions(value.owner.workspaceId);
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((route) => route.session_id)).size).toBe(2);
    const [sessionCount] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from sessions where workspace_id = ${value.owner.workspaceId}`;
    expect(sessionCount!.count).toBe(2);
    const [continued] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${routes[0]!.session_id}
        and type = 'user.message'`;
    expect(continued!.count).toBe(2);
    const [persistence] = await shared!.admin<{ documents: number; memories: number }[]>`
      select
        (select count(*)::int from documents where workspace_id = ${value.owner.workspaceId}) as documents,
        (select count(*)::int from knowledge_memories where workspace_id = ${value.owner.workspaceId}) as memories`;
    expect(persistence).toEqual({ documents: 0, memories: 0 });
  });

  test("channel mentions adopt existing threads and any linked workspace participant can continue", async () => {
    if (!available) return;
    const value = await fixture({ linkOther: true });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_MENTION_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: value.ownerSlackUserId,
            channel: "C_TEAM",
            ts: "1720000000.000002",
            thread_ts: "1720000000.000001",
            text: `<@${value.botUserId}> take over this thread`,
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    const [route] = await interactions(value.owner.workspaceId);
    expect(route).toMatchObject({
      route_key: "C_TEAM:1720000000.000001",
      visibility: "workspace",
      slack_thread_ts: "1720000000.000001",
    });

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_OTHER_REPLY_${crypto.randomUUID()}`,
          event: {
            type: "message",
            user: value.otherSlackUserId,
            channel: "C_TEAM",
            ts: "1720000000.000003",
            thread_ts: "1720000000.000001",
            text: "Continue as another authorized participant",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(1);
    const [messages] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${route!.session_id}
        and type = 'user.message'`;
    expect(messages!.count).toBe(2);
  });

  test("slash commands and explicit message shortcuts each create one durable session surface", async () => {
    if (!available) return;
    const value = await fixture();
    const command = new URLSearchParams({
      command: "/opengeni",
      team_id: value.teamId,
      user_id: value.ownerSlackUserId,
      channel_id: "C_COMMAND",
      trigger_id: `command-${crypto.randomUUID()}`,
      text: "Start from the configured command",
    }).toString();
    const commandResponse = await value.app.request(
      signedRequest(
        "/v1/integrations/slack/commands",
        command,
        "application/x-www-form-urlencoded",
      ),
    );
    expect(commandResponse.status).toBe(200);
    expect(await commandResponse.text()).toContain("accepted this task");
    await drainAll(value.deps);
    const commandAck = value.slack.posts.at(-1)!;
    expect(commandAck).toMatchObject({ channel: "C_COMMAND", threadTimestamp: null });

    const shortcutPayload = JSON.stringify({
      type: "message_action",
      trigger_id: `shortcut-${crypto.randomUUID()}`,
      team: { id: value.teamId },
      user: { id: value.ownerSlackUserId },
      channel: { id: "D_HUMAN_TO_HUMAN" },
      message: {
        ts: "1725000000.000001",
        text: "Explicitly send this human DM message to OpenGeni",
      },
    });
    const shortcut = new URLSearchParams({ payload: shortcutPayload }).toString();
    const shortcutResponse = await value.app.request(
      signedRequest(
        "/v1/integrations/slack/interactions",
        shortcut,
        "application/x-www-form-urlencoded",
      ),
    );
    expect(shortcutResponse.status).toBe(200);
    await drainAll(value.deps);

    const routes = await interactions(value.owner.workspaceId);
    expect(routes).toHaveLength(2);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route_key: `C_COMMAND:${commandAck.timestamp}`,
          slack_thread_ts: commandAck.timestamp,
          visibility: "workspace",
        }),
        expect.objectContaining({
          route_key: "D_HUMAN_TO_HUMAN:1725000000.000001",
          slack_thread_ts: "1725000000.000001",
          visibility: "workspace",
        }),
      ]),
    );
    expect(new Set(routes.map((route) => route.session_id)).size).toBe(2);

    const transientChannel = "C_TRANSIENT_PREFLIGHT";
    value.slack.channelAccessFailures.set(transientChannel, {
      status: 429,
      retryAfterSeconds: 30,
    });
    const transientTriggerId = `transient-command-${crypto.randomUUID()}`;
    const transientCommand = new URLSearchParams({
      command: "/opengeni",
      team_id: value.teamId,
      user_id: value.ownerSlackUserId,
      channel_id: transientChannel,
      trigger_id: transientTriggerId,
      text: "Preserve this task through a transient Slack preflight",
    }).toString();
    const transientResponse = await value.app.request(
      signedRequest(
        "/v1/integrations/slack/commands",
        transientCommand,
        "application/x-www-form-urlencoded",
      ),
    );
    expect(transientResponse.status).toBe(200);
    expect(await transientResponse.text()).toContain("accepted this task");
    expect(await interactions(value.owner.workspaceId)).toHaveLength(2);
    const [pendingTransient] = await shared!.admin<
      { status: string; attempt_count: number; retry_at: Date | null }[]
    >`
      select status, attempt_count, retry_at
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}
        and provider_event_id = ${`command:${transientTriggerId}`}`;
    expect(pendingTransient).toMatchObject({ status: "pending", attempt_count: 0, retry_at: null });
    value.slack.channelAccessFailures.delete(transientChannel);
    await drainAll(value.deps);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(3);

    for (const [channelId, failure] of [
      ["C_INVALID_AUTH", { error: "invalid_auth" }],
      ["C_HTTP_403", { status: 403 }],
    ] as const) {
      value.slack.channelAccessFailures.set(channelId, failure);
      const triggerId = `permanent-${crypto.randomUUID()}`;
      const permanentCommand = new URLSearchParams({
        command: "/opengeni",
        team_id: value.teamId,
        user_id: value.ownerSlackUserId,
        channel_id: channelId,
        trigger_id: triggerId,
        text: "Reject permanent preflight failure",
      }).toString();
      const permanentResponse = await value.app.request(
        signedRequest(
          "/v1/integrations/slack/commands",
          permanentCommand,
          "application/x-www-form-urlencoded",
        ),
      );
      expect(permanentResponse.status).not.toBe(200);
      const inbox = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count
        from slack_interaction_inbox
        where workspace_id = ${value.owner.workspaceId}
          and provider_event_id = ${`command:${triggerId}`}`;
      expect(inbox[0]!.count).toBe(0);
    }
  });

  test("unmapped identities receive a link affordance, denied channels fail closed, and bot loops create nothing", async () => {
    if (!available) return;
    const value = await fixture({ deniedChannels: ["C_DENIED"] });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_UNMAPPED_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: "U_UNMAPPED",
            channel: "C_LINK",
            ts: "1730000000.000001",
            text: `<@${value.botUserId}> link me`,
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    expect(value.slack.posts.at(-1)?.text).toContain("Link your Slack identity");
    expect(value.slack.posts.at(-1)?.text).toContain("No session was created");
    expect(value.slack.posts.at(-1)?.channel).toBe("D_U_UNMAPPED");

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_DENIED_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: value.ownerSlackUserId,
            channel: "C_DENIED",
            ts: "1730000001.000001",
            text: `<@${value.botUserId}> inaccessible task`,
          },
        })
      ).status,
    ).toBe(200);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);

    const deniedCommand = new URLSearchParams({
      command: "/opengeni",
      team_id: value.teamId,
      user_id: value.ownerSlackUserId,
      channel_id: "C_DENIED",
      trigger_id: `denied-command-${crypto.randomUUID()}`,
      text: "Do not accept this command",
    }).toString();
    const deniedCommandResponse = await value.app.request(
      signedRequest(
        "/v1/integrations/slack/commands",
        deniedCommand,
        "application/x-www-form-urlencoded",
      ),
    );
    expect(deniedCommandResponse.status).toBe(200);
    expect(await deniedCommandResponse.text()).toContain("not a member of this channel");
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_SELF_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.botUserId,
            channel: "D_SELF",
            ts: "1730000002.000001",
            text: "self reply",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(0);
    const inbox = await shared!.admin<{ status: string }[]>`
      select status from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}
      order by created_at, id`;
    expect(inbox.map((row) => row.status)).toEqual(["processed", "failed"]);
  });

  test("caps durable progress globally across pages, response loss, retries, restarts, and replica claims", async () => {
    if (!available) return;
    const value = await fixture({ failAfterAcceptTexts: ["Progress 2"] });
    await postEvent(value.app, {
      teamId: value.teamId,
      eventId: `E_DELIVERY_${crypto.randomUUID()}`,
      event: {
        type: "message",
        channel_type: "im",
        user: value.ownerSlackUserId,
        channel: "D_DELIVERY",
        ts: "1740000000.000001",
        text: "Run a task with progress",
      },
    });
    await drainAll(value.deps);
    const [route] = await interactions(value.owner.workspaceId);
    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      ...Array.from({ length: 3 }, (_, index) => ({
        type: "agent.message.completed",
        payload: { text: `Progress ${index + 1}` },
      })),
    ]);
    const postsBeforeDelivery = value.slack.posts.length;
    // Slack accepts Progress 2 before the first process loses the response. The
    // delivery is durably deferred without advancing its event cursor.
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(value.slack.posts.slice(postsBeforeDelivery).map((post) => post.text)).toEqual([
      "Progress 1",
      "Progress 2",
    ]);

    const restartedDeps = {
      ...value.deps,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps;
    const replicaDeps = {
      ...value.deps,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps;
    await shared!.admin`
      update slack_interactions set delivery_retry_at = now() where id = ${route!.id}`;
    expect(
      (
        await Promise.all([
          drainSlackInteractionsOnce(restartedDeps),
          drainSlackInteractionsOnce(replicaDeps),
        ])
      ).sort(),
    ).toEqual([false, true]);

    let deliveredProgress = value.slack.posts
      .slice(postsBeforeDelivery)
      .filter((post) => post.text.startsWith("Progress"));
    expect(deliveredProgress.map((post) => post.text)).toEqual([
      "Progress 1",
      "Progress 2",
      "Progress 3",
    ]);
    expect(new Set(deliveredProgress.map((post) => post.clientMessageId)).size).toBe(3);
    expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
      progress_count: 3,
      terminal_delivery_state: "open",
    });

    // Replaying after a crash that lost the page cursor reuses every durable
    // progress operation UUID, so duplicate provider posts are not created.
    await shared!.admin`
      update slack_interactions
      set last_delivered_session_event_sequence = 0,
          delivery_claim_holder_id = null,
          delivery_claim_expires_at = null,
          updated_at = now()
      where id = ${route!.id}`;
    expect(await drainSlackInteractionsOnce(restartedDeps)).toBe(true);
    deliveredProgress = value.slack.posts
      .slice(postsBeforeDelivery)
      .filter((post) => post.text.startsWith("Progress"));
    expect(deliveredProgress).toHaveLength(3);

    // A later delivery page cannot reserve or post a fourth progress message;
    // final delivery remains independent and still reaches the origin thread.
    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      { type: "agent.message.completed", payload: { text: "Progress 4" } },
      { type: "turn.completed", payload: { output: "Final bounded result" } },
    ]);
    expect(await drainSlackInteractionsOnce(restartedDeps)).toBe(true);
    expect(await drainSlackInteractionsOnce(restartedDeps)).toBe(false);
    const delivered = value.slack.posts.slice(postsBeforeDelivery);
    expect(delivered.filter((post) => post.text.startsWith("Progress"))).toHaveLength(3);
    expect(delivered.some((post) => post.text === "Progress 4")).toBe(false);
    expect(delivered.at(-1)?.text).toContain("Final bounded result");
    expect(delivered.at(-1)?.text).toContain("Open in OpenGeni:");
    expect(delivered.every((post) => post.threadTimestamp === "1740000000.000001")).toBe(true);
    const progressLedger = await shared!.admin<
      { session_event_sequence: number; slot: number; operation_id: string }[]
    >`
      select session_event_sequence, slot, operation_id
      from slack_interaction_progress_deliveries
      where interaction_id = ${route!.id}
      order by slot`;
    expect(progressLedger.map((row) => row.slot)).toEqual([1, 2, 3]);
    expect(new Set(progressLedger.map((row) => row.session_event_sequence)).size).toBe(3);
    expect(new Set(progressLedger.map((row) => row.operation_id))).toEqual(
      new Set(deliveredProgress.map((post) => post.clientMessageId!)),
    );
    expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
      progress_count: 3,
      terminal_delivery_state: "completed",
    });
  }, 60_000);

  test("terminalizes permanent Slack delivery errors without retrying", async () => {
    if (!available) return;
    const value = await fixture();
    await postEvent(value.app, {
      teamId: value.teamId,
      eventId: `E_PERMANENT_${crypto.randomUUID()}`,
      event: {
        type: "message",
        channel_type: "im",
        user: value.ownerSlackUserId,
        channel: "D_PERMANENT",
        ts: "1750000000.000001",
        text: "Start a task before permanent delivery failure",
      },
    });
    await drainAll(value.deps);
    const [route] = await interactions(value.owner.workspaceId);
    value.slack.failuresByText.set("Permanent delivery result", {
      error: "cannot_reply_to_message",
    });
    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      { type: "turn.completed", payload: { output: "Permanent delivery result" } },
    ]);

    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);
    expect(
      value.slack.posts.filter((post) => post.text.includes("Permanent delivery result")),
    ).toHaveLength(1);
    const [delivery] = await shared!.admin<
      {
        terminal_delivery_state: string;
        delivery_attempt_count: number;
        delivery_last_error_code: string;
      }[]
    >`
      select terminal_delivery_state, delivery_attempt_count, delivery_last_error_code
      from slack_interactions where id = ${route!.id}`;
    expect(delivery).toEqual({
      terminal_delivery_state: "failed",
      delivery_attempt_count: 1,
      delivery_last_error_code: "cannot_reply_to_message",
    });
  });

  test("durably honors Slack Retry-After before retrying a rate-limited delivery", async () => {
    if (!available) return;
    const value = await fixture();
    await postEvent(value.app, {
      teamId: value.teamId,
      eventId: `E_RATE_LIMIT_${crypto.randomUUID()}`,
      event: {
        type: "message",
        channel_type: "im",
        user: value.ownerSlackUserId,
        channel: "D_RATE_LIMIT",
        ts: "1760000000.000001",
        text: "Start a task before a rate limit",
      },
    });
    await drainAll(value.deps);
    const [route] = await interactions(value.owner.workspaceId);
    value.slack.failuresByText.set("Rate limited result", {
      status: 429,
      retryAfterSeconds: 30,
    });
    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      { type: "turn.completed", payload: { output: "Rate limited result" } },
    ]);

    const before = Date.now();
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);
    const [deferred] = await shared!.admin<
      {
        terminal_delivery_state: string;
        delivery_retry_at: Date;
        delivery_last_error_code: string;
      }[]
    >`
      select terminal_delivery_state, delivery_retry_at, delivery_last_error_code
      from slack_interactions where id = ${route!.id}`;
    expect(deferred!.terminal_delivery_state).toBe("open");
    expect(new Date(deferred!.delivery_retry_at).getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(deferred!.delivery_last_error_code).toBe("http_429");
    expect(
      value.slack.posts.filter((post) => post.text.includes("Rate limited result")),
    ).toHaveLength(1);

    value.slack.failuresByText.delete("Rate limited result");
    await shared!.admin`
      update slack_interactions set delivery_retry_at = now() where id = ${route!.id}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);
    expect(
      value.slack.posts.filter((post) => post.text.includes("Rate limited result")),
    ).toHaveLength(2);
    expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
      terminal_delivery_state: "completed",
    });
  });
});
