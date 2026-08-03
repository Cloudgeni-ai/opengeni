import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  type Permission,
  type WorkspaceSlackReactionSummonSettings,
} from "@opengeni/contracts";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createConnection,
  createDb,
  encryptVariableSetValue,
  getLatestSessionModelForSubject,
  getOrCreateSlackInteraction,
  getWorkspaceGrant,
  grantWorkspaceAccess,
  saveSlackBotUserLink,
  updateWorkspaceSettings,
  type DbClient,
} from "@opengeni/db";
import {
  acceptSessionUserMessage,
  createSessionForRequest,
  type ApiRouteDeps,
  type SessionWorkflowClient,
} from "@opengeni/core";
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

type SlackCall = {
  method: string;
  channel: string | null;
  timestamp: string | null;
};

type SlackReactionContextPage = {
  messages: Array<Record<string, unknown>>;
  nextCursor?: string;
  error?: string;
  status?: number;
  retryAfterSeconds?: number;
};

type SlackReactionContext = SlackReactionContextPage & {
  pages?: Record<string, SlackReactionContextPage>;
};

function fakeSlack(
  deniedChannels: Set<string> = new Set(),
  options: {
    failAfterAcceptTexts?: Set<string>;
    sharedChannels?: Set<string>;
  } = {},
) {
  const posts: SlackPost[] = [];
  const calls: SlackCall[] = [];
  const reactionContexts = new Map<string, SlackReactionContext>();
  const reactionContextHits: string[] = [];
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
    calls.push({
      method,
      channel: form.get("channel"),
      timestamp: form.get("ts"),
    });
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
          is_shared: options.sharedChannels?.has(channel) ?? false,
          is_ext_shared: options.sharedChannels?.has(channel) ?? false,
        },
      });
    }
    if (method === "conversations.replies") {
      const channel = form.get("channel") ?? "";
      const timestamp = form.get("ts") ?? "";
      const key = `${channel}:${timestamp}`;
      const rootContext = reactionContexts.get(key);
      const cursor = form.get("cursor");
      const context = cursor ? rootContext?.pages?.[cursor] : rootContext;
      if (!context) return Response.json({ ok: false, error: "message_not_found" });
      reactionContextHits.push(cursor ? `${key}:${cursor}` : key);
      const status = context.status ?? 200;
      if (status !== 200 || context.error) {
        return Response.json(status === 200 ? { ok: false, error: context.error } : { ok: false }, {
          status,
          headers: context.retryAfterSeconds
            ? { "retry-after": String(context.retryAfterSeconds) }
            : undefined,
        });
      }
      return Response.json({
        ok: true,
        messages: context.messages,
        response_metadata: { next_cursor: context.nextCursor ?? "" },
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
        return Response.json({
          ok: true,
          channel: accepted.channel,
          ts: accepted.timestamp,
        });
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
      return Response.json({
        ok: true,
        channel: form.get("channel"),
        ts: timestamp,
      });
    }
    return Response.json({ ok: false, error: `unexpected_${method}` });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    posts,
    calls,
    reactionContexts,
    reactionContextHits,
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
    managedBilling?: boolean;
    codexSubscriptionEnabled?: boolean;
    grantedScopes?: string[];
    ownerPermissions?: Permission[];
    sharedChannels?: string[];
    slackReactionSummon?: WorkspaceSlackReactionSummonSettings;
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
  const permissions = options.ownerPermissions ?? [
    "sessions:create",
    "sessions:read",
    "sessions:control",
  ];
  await grantWorkspaceAccess(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    permissions,
  });
  await grantWorkspaceAccess(client.db, {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: otherSubjectId,
    permissions: ["sessions:create", "sessions:read", "sessions:control"],
  });

  const teamId = `T_${suffix}`;
  const botId = `B_${suffix}`;
  const botUserId = `U_BOT_${suffix}`;
  const ownerSlackUserId = `U_OWNER_${suffix}`;
  const otherSlackUserId = `U_OTHER_${suffix}`;
  const settings = testSettings({
    productAccessMode: "managed",
    ...(options.managedBilling ? { usageLimitsMode: "managed", billingMode: "stripe" } : {}),
    ...(options.codexSubscriptionEnabled ? { codexSubscriptionEnabled: true } : {}),
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
    grantedScopes: options.grantedScopes ?? [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
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
  if (options.slackReactionSummon) {
    await updateWorkspaceSettings(client.db, owner.workspaceId, {
      slackReactionSummon: options.slackReactionSummon,
    });
  }
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
    sharedChannels: new Set(options.sharedChannels ?? []),
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

function reactionEvent(input: {
  teamId: string;
  eventId: string;
  userId: string;
  channelId: string;
  timestamp: string;
  reaction?: string;
}) {
  return {
    teamId: input.teamId,
    eventId: input.eventId,
    event: {
      type: "reaction_added",
      user: input.userId,
      reaction: input.reaction ?? "genie",
      item: {
        type: "message",
        channel: input.channelId,
        ts: input.timestamp,
      },
    },
  };
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

async function waitForBlockedAppQueries(blockerPid: number, expected: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await shared!.admin<{ count: number }[]>`
      with recursive blocked(pid) as (
        select pid
        from pg_stat_activity
        where datname = current_database()
          and ${blockerPid} = any(pg_blocking_pids(pid))
        union
        select activity.pid
        from pg_stat_activity activity
        join blocked blocker on blocker.pid = any(pg_blocking_pids(activity.pid))
        where activity.datname = current_database()
      )
      select count(*)::int as count
      from pg_stat_activity activity
      join blocked on blocked.pid = activity.pid
      where activity.usename = 'opengeni_app'
        and activity.state = 'active'
        and activity.wait_event_type = 'Lock'`;
    if ((row?.count ?? 0) >= expected) return;
    await Bun.sleep(10);
  }
  const activity = await shared!.admin<
    {
      pid: number;
      usename: string;
      state: string;
      wait_event_type: string | null;
      wait_event: string | null;
      blocking_pids: number[];
      query: string;
    }[]
  >`
    select pid, usename, state, wait_event_type, wait_event,
      pg_blocking_pids(pid) as blocking_pids,
      left(regexp_replace(query, E'[\\n\\r\\t ]+', ' ', 'g'), 240) as query
    from pg_stat_activity
    where datname = current_database()
    order by pid`;
  throw new Error(
    `timed out waiting for ${expected} blocked Slack interaction replicas: ${JSON.stringify(activity)}`,
  );
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

  test("reaction ingress filters disabled, legacy-scope, wrong-emoji, and disallowed-channel events before content fetch", async () => {
    if (!available) return;
    const enabledScopes = [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES];
    const value = await fixture({ grantedScopes: enabledScopes });
    const timestamp = "1705000000.000001";

    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_DISABLED_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId: "C_ALLOWED",
            timestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await updateWorkspaceSettings(client.db, value.owner.workspaceId, {
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: ["C_ALLOWED"] },
      },
    });
    for (const event of [
      reactionEvent({
        teamId: value.teamId,
        eventId: `E_REACTION_WRONG_EMOJI_${crypto.randomUUID()}`,
        userId: value.ownerSlackUserId,
        channelId: "C_ALLOWED",
        timestamp,
        reaction: "robot_face",
      }),
      reactionEvent({
        teamId: value.teamId,
        eventId: `E_REACTION_DISALLOWED_CHANNEL_${crypto.randomUUID()}`,
        userId: value.ownerSlackUserId,
        channelId: "C_OTHER",
        timestamp,
      }),
    ]) {
      expect((await postEvent(value.app, event)).status).toBe(200);
    }

    const legacy = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "bot_member" },
      },
    });
    expect(
      (
        await postEvent(
          legacy.app,
          reactionEvent({
            teamId: legacy.teamId,
            eventId: `E_REACTION_LEGACY_SCOPE_${crypto.randomUUID()}`,
            userId: legacy.ownerSlackUserId,
            channelId: "C_LEGACY",
            timestamp,
          }),
        )
      ).status,
    ).toBe(200);

    for (const workspaceId of [value.owner.workspaceId, legacy.owner.workspaceId]) {
      const [inbox] = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count
        from slack_interaction_inbox
        where workspace_id = ${workspaceId}`;
      expect(inbox!.count).toBe(0);
    }
    expect(value.slack.calls).toHaveLength(0);
    expect(legacy.slack.calls).toHaveLength(0);
  });

  test("an exact authorized reaction starts one bounded root-thread session across retry and remove-readd delivery", async () => {
    if (!available) return;
    const channelId = "C_REACTION";
    const rootTimestamp = "1706000000.000001";
    const reactedTimestamp = "1706000000.000002";
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Previously selected model",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });
    value.slack.reactionContexts.set(`${channelId}:${reactedTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_THREAD_ROOT",
          text: "Investigate the failed production deployment.",
        },
        {
          ts: reactedTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Compare the logs and propose the safest rollback.",
          files: [{ id: "F_REACTION", name: "deploy.log", title: "Deployment log" }],
        },
      ],
      nextCursor: "bounded-more",
    });
    const firstEvent = reactionEvent({
      teamId: value.teamId,
      eventId: `E_REACTION_FIRST_${crypto.randomUUID()}`,
      userId: value.ownerSlackUserId,
      channelId,
      timestamp: reactedTimestamp,
    });
    expect((await postEvent(value.app, firstEvent)).status).toBe(200);
    expect((await postEvent(value.app, firstEvent)).status).toBe(200);
    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            ...firstEvent,
            eventId: `E_REACTION_READD_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    const [queued] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(queued!.count).toBe(1);

    await drainAll({
      ...value.deps,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps);

    expect(value.slack.calls.filter((call) => call.method === "conversations.replies")).toEqual([
      {
        method: "conversations.replies",
        channel: channelId,
        timestamp: reactedTimestamp,
      },
    ]);
    expect(value.slack.reactionContextHits).toEqual([`${channelId}:${reactedTimestamp}`]);

    const [processed] = await shared!.admin<{ status: string; last_error_code: string | null }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(processed).toEqual({ status: "processed", last_error_code: null });

    const [route] = await interactions(value.owner.workspaceId);
    expect(route).toMatchObject({
      route_key: `${channelId}:${rootTimestamp}`,
      slack_thread_ts: rootTimestamp,
      visibility: "workspace",
    });
    expect(value.slack.calls.filter((call) => call.method === "conversations.info")).toHaveLength(
      2,
    );
    expect(value.slack.posts).toHaveLength(1);
    expect(value.slack.posts[0]).toMatchObject({
      channel: channelId,
      threadTimestamp: rootTimestamp,
    });
    expect(value.slack.posts[0]!.text).toContain("started from the :genie: reaction");

    const [session] = await shared!.admin<
      {
        first_party_mcp_tools: string[];
        initial_message: string;
        model: string;
      }[]
    >`
      select first_party_mcp_tools, initial_message, model
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.first_party_mcp_tools).toEqual([...DEFAULT_FIRST_PARTY_MCP_TOOLS]);
    expect(session!.model).toBe("gpt-5.6-terra");
    expect(session!.initial_message).toContain("[reacted message]");
    expect(session!.initial_message).toContain("Compare the logs and propose the safest rollback.");
    expect(session!.initial_message).toContain("Deployment log");
    expect(session!.initial_message).toContain("If the intended action is ambiguous");
    expect(session!.initial_message).toContain("Do not infer permission to ingest or persist");
    expect(session!.initial_message).toContain("bounded Slack context limit");
    const [persistence] = await shared!.admin<{ documents: number; memories: number }[]>`
      select
        (select count(*)::int from documents where workspace_id = ${value.owner.workspaceId}) as documents,
        (select count(*)::int from knowledge_memories where workspace_id = ${value.owner.workspaceId}) as memories`;
    expect(persistence).toEqual({ documents: 0, memories: 0 });
  });

  test("distinct same-owner reactions concurrently create one route with one durable message per Slack event", async () => {
    if (!available) return;
    const channelId = "C_REACTION_DISTINCT_CONCURRENT";
    const rootTimestamp = "1706050000.000001";
    const firstTimestamp = "1706050000.000002";
    const secondTimestamp = "1706050000.000003";
    const firstEventId = `E_REACTION_DISTINCT_FIRST_${crypto.randomUUID()}`;
    const secondEventId = `E_REACTION_DISTINCT_SECOND_${crypto.randomUUID()}`;
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    value.slack.reactionContexts.set(`${channelId}:${firstTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_THREAD_ROOT",
          text: "Investigate both independent deployment signals in this thread.",
        },
        {
          ts: firstTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "First distinct Slack reaction task.",
        },
      ],
    });
    value.slack.reactionContexts.set(`${channelId}:${secondTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_THREAD_ROOT",
          text: "Investigate both independent deployment signals in this thread.",
        },
        {
          ts: secondTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Second distinct Slack reaction task.",
        },
      ],
    });
    const firstEvent = reactionEvent({
      teamId: value.teamId,
      eventId: firstEventId,
      userId: value.ownerSlackUserId,
      channelId,
      timestamp: firstTimestamp,
    });
    const secondEvent = reactionEvent({
      teamId: value.teamId,
      eventId: secondEventId,
      userId: value.ownerSlackUserId,
      channelId,
      timestamp: secondTimestamp,
    });
    for (const event of [firstEvent, secondEvent, firstEvent]) {
      expect((await postEvent(value.app, event)).status).toBe(200);
    }
    const [queued] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(queued!.count).toBe(2);

    const { interaction } = await getOrCreateSlackInteraction(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      connectionId: value.connectionId,
      slackTeamId: value.teamId,
      slackChannelId: channelId,
      slackThreadTs: rootTimestamp,
      routeKey: `${channelId}:${rootTimestamp}`,
      triggeringProviderEventId: firstEventId,
      owningSubjectId: value.owner.subjectId,
      visibility: "workspace",
    });
    const replicaA = createDb(shared!.appUrl, { max: 1 });
    const replicaB = createDb(shared!.appUrl, { max: 1 });
    const replicaADeps = {
      ...value.deps,
      db: replicaA.db,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps;
    const replicaBDeps = {
      ...value.deps,
      db: replicaB.db,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps;
    let drains: Array<Promise<boolean>> = [];
    try {
      await shared!.admin.begin(async (lockTx) => {
        await lockTx`
          select id from slack_interactions
          where id = ${interaction.id}
          for update`;
        const [blocker] = await lockTx<{ pid: number }[]>`
          select pg_backend_pid()::int as pid`;
        if (!blocker) throw new Error("expected Slack route lock backend");
        drains = [
          drainSlackInteractionsOnce(replicaADeps),
          drainSlackInteractionsOnce(replicaBDeps),
        ];
        await waitForBlockedAppQueries(blocker.pid, 2);

        const [duringBind] = await shared!.admin<
          { sessions: number; routes: number; inboxes: number; messages: number }[]
        >`
          select
            (select count(*)::int from sessions
              where workspace_id = ${value.owner.workspaceId}) as sessions,
            (select count(*)::int from slack_interactions
              where workspace_id = ${value.owner.workspaceId}) as routes,
            (select count(*)::int from slack_interaction_inbox
              where workspace_id = ${value.owner.workspaceId}
                and status = 'processing') as inboxes,
            (select count(*)::int from session_events
              where workspace_id = ${value.owner.workspaceId}
                and session_id = ${interaction.sessionReservationId}
                and type = 'user.message') as messages`;
        expect(duringBind).toEqual({ sessions: 1, routes: 1, inboxes: 2, messages: 2 });
      });
      expect(await Promise.all(drains)).toEqual([true, true]);

      const messageRows = await shared!.admin<{ client_event_id: string; text: string }[]>`
        select client_event_id, payload ->> 'text' as text
        from session_events
        where workspace_id = ${value.owner.workspaceId}
          and session_id = ${interaction.sessionReservationId}
          and type = 'user.message'
        order by client_event_id`;
      expect(messageRows).toEqual([
        {
          client_event_id: `slack:${firstEventId}`,
          text: expect.stringContaining("First distinct Slack reaction task."),
        },
        {
          client_event_id: `slack:${secondEventId}`,
          text: expect.stringContaining("Second distinct Slack reaction task."),
        },
      ]);
      const [route] = await interactions(value.owner.workspaceId);
      expect(route).toMatchObject({
        id: interaction.id,
        session_id: interaction.sessionReservationId,
        route_key: `${channelId}:${rootTimestamp}`,
      });
      let inboxRows = await shared!.admin<
        { id: string; provider_event_id: string; status: string; attempt_count: number }[]
      >`
        select id, provider_event_id, status, attempt_count
        from slack_interaction_inbox
        where workspace_id = ${value.owner.workspaceId}
        order by provider_event_id`;
      for (const pendingInbox of inboxRows.filter((row) => row.status === "pending")) {
        await shared!.admin`
          update slack_interaction_inbox
          set retry_at = now() - interval '1 second'
          where id = ${pendingInbox.id}`;
        expect(await drainSlackInteractionsOnce(replicaADeps)).toBe(true);
      }
      inboxRows = await shared!.admin<
        { id: string; provider_event_id: string; status: string; attempt_count: number }[]
      >`
        select id, provider_event_id, status, attempt_count
        from slack_interaction_inbox
        where workspace_id = ${value.owner.workspaceId}
        order by provider_event_id`;
      expect(inboxRows.map(({ attempt_count: _attemptCount, ...row }) => row)).toEqual([
        {
          id: expect.any(String),
          provider_event_id: firstEventId,
          status: "processed",
        },
        {
          id: expect.any(String),
          provider_event_id: secondEventId,
          status: "processed",
        },
      ]);
      expect(inboxRows.every((row) => row.attempt_count >= 1 && row.attempt_count <= 2)).toBe(true);
      expect(value.slack.posts).toHaveLength(1);

      for (const retryInbox of inboxRows) {
        await shared!.admin`
          update slack_interaction_inbox
          set status = 'pending', claim_holder_id = null, claim_expires_at = null,
            retry_at = now(), last_error_code = 'forced_retry', processed_at = null,
            updated_at = now()
          where id = ${retryInbox.id}`;
        expect(await drainSlackInteractionsOnce(replicaADeps)).toBe(true);
        const [afterRetry] = await shared!.admin<{ messages: number; attempts: number }[]>`
          select
            (select count(*)::int from session_events
              where workspace_id = ${value.owner.workspaceId}
                and session_id = ${interaction.sessionReservationId}
                and type = 'user.message') as messages,
            (select attempt_count::int from slack_interaction_inbox
              where id = ${retryInbox.id}) as attempts`;
        expect(afterRetry).toEqual({
          messages: 2,
          attempts: retryInbox.attempt_count + 1,
        });
      }
      expect((await postEvent(value.app, firstEvent)).status).toBe(200);
      const [afterIngressReplay] = await shared!.admin<{ inboxes: number; messages: number }[]>`
        select
          (select count(*)::int from slack_interaction_inbox
            where workspace_id = ${value.owner.workspaceId}) as inboxes,
          (select count(*)::int from session_events
            where workspace_id = ${value.owner.workspaceId}
              and session_id = ${interaction.sessionReservationId}
              and type = 'user.message') as messages`;
      expect(afterIngressReplay).toEqual({ inboxes: 2, messages: 2 });
    } finally {
      await Promise.allSettled(drains);
      await Promise.all([replicaA.close(), replicaB.close()]);
    }
  }, 60_000);

  test("reaction retrieval paginates to the exact message and pins it under the prompt budget", async () => {
    if (!available) return;
    const channelId = "C_REACTION_PAGED";
    const rootTimestamp = "1706100000.000001";
    const reactedTimestamp = "1706100000.000017";
    const exactText = `Pinned deployment decision: ${"x".repeat(3_500)}`;
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    const firstPage = Array.from({ length: 15 }, (_, index) => ({
      ts: `1706100000.${String(index + 1).padStart(6, "0")}`,
      ...(index === 0 ? {} : { thread_ts: rootTimestamp }),
      user: index === 0 ? "U_THREAD_ROOT" : `U_CONTEXT_${index}`,
      text: `Long surrounding context ${index}: ${"c".repeat(550)}`,
    }));
    value.slack.reactionContexts.set(`${channelId}:${reactedTimestamp}`, {
      messages: firstPage,
      nextCursor: "reaction-page-2",
      pages: {
        "reaction-page-2": {
          messages: [
            {
              ts: "1706100000.000016",
              thread_ts: rootTimestamp,
              user: "U_CONTEXT_16",
              text: `Adjacent context before: ${"b".repeat(550)}`,
            },
            {
              ts: reactedTimestamp,
              thread_ts: rootTimestamp,
              user: value.ownerSlackUserId,
              text: exactText,
              files: [{ id: "F_PINNED", title: "Pinned deployment plan" }],
            },
            {
              ts: "1706100000.000018",
              thread_ts: rootTimestamp,
              user: "U_CONTEXT_18",
              text: `Adjacent context after: ${"a".repeat(550)}`,
            },
          ],
        },
      },
    });

    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_PAGED_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    expect(value.slack.reactionContextHits).toEqual([
      `${channelId}:${reactedTimestamp}`,
      `${channelId}:${reactedTimestamp}:reaction-page-2`,
    ]);
    const [route] = await interactions(value.owner.workspaceId);
    const [session] = await shared!.admin<{ initial_message: string }[]>`
      select initial_message
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.initial_message.length).toBeLessThanOrEqual(8_000);
    expect(session!.initial_message).toContain(exactText);
    expect(session!.initial_message).toContain("[reacted message]");
    expect(session!.initial_message).toContain("Pinned deployment plan");
    expect(session!.initial_message.indexOf("[reacted message]")).toBeLessThan(
      session!.initial_message.indexOf("Bounded surrounding thread context:"),
    );
    expect(session!.initial_message).toContain("bounded Slack context limit");
  });

  test("a concurrent linked reactor cannot take over an unbound reaction route", async () => {
    if (!available) return;
    const channelId = "C_REACTION_OWNER_RACE";
    const rootTimestamp = "1706150000.000001";
    const reactedTimestamp = "1706150000.000002";
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      linkOther: true,
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    value.slack.reactionContexts.set(`${channelId}:${reactedTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_THREAD_ROOT",
          text: "Investigate this deployment.",
        },
        {
          ts: reactedTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Use the exact owning subject for session creation.",
        },
      ],
    });
    const { interaction } = await getOrCreateSlackInteraction(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      connectionId: value.connectionId,
      slackTeamId: value.teamId,
      slackChannelId: channelId,
      slackThreadTs: rootTimestamp,
      routeKey: `${channelId}:${rootTimestamp}`,
      triggeringProviderEventId: `E_REACTION_OWNER_${crypto.randomUUID()}`,
      owningSubjectId: value.owner.subjectId,
      visibility: "workspace",
    });

    const racingEventId = `E_REACTION_RACING_USER_${crypto.randomUUID()}`;
    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: racingEventId,
            userId: value.otherSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    const [waiting] = await shared!.admin<
      {
        id: string;
        status: string;
        last_error_code: string;
        retry_at: Date | null;
      }[]
    >`
      select id, status, last_error_code, retry_at
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(waiting).toMatchObject({
      status: "pending",
      last_error_code: "slack_route_creation_pending",
    });
    expect(waiting!.retry_at).not.toBeNull();
    const [beforeOwner] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${value.owner.workspaceId}`;
    expect(beforeOwner!.count).toBe(0);

    const owningEventId = `E_REACTION_OWNING_USER_${crypto.randomUUID()}`;
    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: owningEventId,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);

    const [created] = await shared!.admin<
      {
        id: string;
        created_by_subject_id: string;
        create_idempotency_key: string;
      }[]
    >`
      select id, created_by_subject_id, create_idempotency_key
      from sessions
      where workspace_id = ${value.owner.workspaceId}`;
    expect(created).toEqual({
      id: interaction.sessionReservationId,
      created_by_subject_id: value.owner.subjectId,
      create_idempotency_key: `slack-interaction:${interaction.id}`,
    });

    await shared!.admin`
      update slack_interaction_inbox
      set retry_at = now() - interval '1 second'
      where id = ${waiting!.id}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    const [sessionCount] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${value.owner.workspaceId}`;
    expect(sessionCount!.count).toBe(1);
    const [racingInbox] = await shared!.admin<{ status: string; last_error_code: string | null }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where id = ${waiting!.id}`;
    expect(racingInbox).toEqual({ status: "processed", last_error_code: null });
    const clientEventIds = await shared!.admin<{ client_event_id: string }[]>`
      select client_event_id
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${created!.id}
        and type = 'user.message'
      order by client_event_id`;
    expect(clientEventIds).toEqual([
      { client_event_id: `slack:${owningEventId}` },
      { client_event_id: `slack:${racingEventId}` },
    ]);
  });

  test("reaction pagination resumes its durable cursor across a fresh claim after Slack throttling", async () => {
    if (!available) return;
    const channelId = "C_REACTION_RATE_LIMITED";
    const rootTimestamp = "1706200000.000001";
    const reactedTimestamp = "1706200000.000020";
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    value.slack.reactionContexts.set(`${channelId}:${reactedTimestamp}`, {
      messages: Array.from({ length: 15 }, (_, index) => ({
        ts: `1706200000.${String(index + 1).padStart(6, "0")}`,
        ...(index === 0 ? {} : { thread_ts: rootTimestamp }),
        user: `U_CONTEXT_${index}`,
        text: `Context ${index}`,
      })),
      nextCursor: "rate-limited-page",
      pages: {
        "rate-limited-page": {
          messages: [],
          status: 429,
          retryAfterSeconds: 30,
        },
      },
    });
    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_RATE_LIMITED_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await drainSlackInteractionsOnce(value.deps);

    const [inbox] = await shared!.admin<
      {
        id: string;
        status: string;
        attempt_count: number;
        retry_at: Date | null;
        last_error_code: string;
        reaction_context_checkpoint: unknown;
        checkpoint_bytes: number;
      }[]
    >`
      select id, status, attempt_count, retry_at, last_error_code,
        reaction_context_checkpoint,
        octet_length(reaction_context_checkpoint::text)::int as checkpoint_bytes
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_error_code: "http_429",
    });
    expect(inbox!.retry_at).not.toBeNull();
    expect(inbox!.reaction_context_checkpoint).toMatchObject({
      version: 1,
      binding: {
        inboxId: inbox!.id,
        accountId: value.owner.accountId,
        workspaceId: value.owner.workspaceId,
        connectionId: value.connectionId,
        slackTeamId: value.teamId,
        slackChannelId: channelId,
        slackMessageTs: reactedTimestamp,
      },
      state: {
        pageCount: 1,
        nextCursor: "rate-limited-page",
        seenCursors: ["rate-limited-page"],
      },
    });
    expect(inbox!.checkpoint_bytes).toBeLessThanOrEqual(131_072);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(0);
    expect(value.slack.posts).toHaveLength(0);

    value.slack.reactionContexts.get(`${channelId}:${reactedTimestamp}`)!.pages![
      "rate-limited-page"
    ] = {
      messages: [
        {
          ts: "1706200000.000016",
          thread_ts: rootTimestamp,
          user: "U_CONTEXT_16",
          text: "Context immediately before the reacted message",
        },
        {
          ts: reactedTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Resume from the stored cursor and investigate this exact message.",
        },
      ],
    };
    await shared!.admin`
      update slack_interaction_inbox
      set retry_at = now() - interval '1 second'
      where id = ${inbox!.id}`;
    const freshDeps = {
      ...value.deps,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps;
    expect(await drainSlackInteractionsOnce(freshDeps)).toBe(true);

    expect(value.slack.reactionContextHits).toEqual([
      `${channelId}:${reactedTimestamp}`,
      `${channelId}:${reactedTimestamp}:rate-limited-page`,
      `${channelId}:${reactedTimestamp}:rate-limited-page`,
    ]);
    const [processed] = await shared!.admin<
      {
        status: string;
        attempt_count: number;
        last_error_code: string | null;
        reaction_context_checkpoint: unknown | null;
      }[]
    >`
      select status, attempt_count, last_error_code, reaction_context_checkpoint
      from slack_interaction_inbox
      where id = ${inbox!.id}`;
    expect(processed).toEqual({
      status: "processed",
      attempt_count: 2,
      last_error_code: null,
      reaction_context_checkpoint: null,
    });
    expect(await interactions(value.owner.workspaceId)).toHaveLength(1);
    const [sessionCount] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${value.owner.workspaceId}`;
    expect(sessionCount!.count).toBe(1);
    expect(value.slack.posts).toHaveLength(1);
    expect(value.slack.posts[0]).toMatchObject({
      channel: channelId,
      threadTimestamp: rootTimestamp,
    });

    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_RATE_LIMITED_READD_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    const [deduplicated] = await shared!.admin<{ inboxes: number; sessions: number }[]>`
      select
        (select count(*)::int from slack_interaction_inbox
          where workspace_id = ${value.owner.workspaceId}) as inboxes,
        (select count(*)::int from sessions
          where workspace_id = ${value.owner.workspaceId}) as sessions`;
    expect(deduplicated).toEqual({ inboxes: 1, sessions: 1 });
  });

  test("reaction checkpoints fail closed when stale, malformed, or copied across workspace events", async () => {
    if (!available) return;
    const sourceChannelId = "C_REACTION_CHECKPOINT_SOURCE";
    const sourceTimestamp = "1706250000.000020";
    const source = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [sourceChannelId] },
      },
    });
    source.slack.reactionContexts.set(`${sourceChannelId}:${sourceTimestamp}`, {
      messages: [{ ts: "1706250000.000001", user: "U_ROOT", text: "Root" }],
      nextCursor: "checkpoint-page-2",
      pages: {
        "checkpoint-page-2": {
          messages: [],
          status: 429,
          retryAfterSeconds: 30,
        },
      },
    });
    expect(
      (
        await postEvent(
          source.app,
          reactionEvent({
            teamId: source.teamId,
            eventId: `E_REACTION_CHECKPOINT_SOURCE_${crypto.randomUUID()}`,
            userId: source.ownerSlackUserId,
            channelId: sourceChannelId,
            timestamp: sourceTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await drainSlackInteractionsOnce(source.deps);
    const [sourceInbox] = await shared!.admin<
      { id: string; reaction_context_checkpoint: unknown }[]
    >`
      select id, reaction_context_checkpoint
      from slack_interaction_inbox
      where workspace_id = ${source.owner.workspaceId}`;
    expect(sourceInbox!.reaction_context_checkpoint).not.toBeNull();

    await shared!.admin`
      update slack_interaction_inbox
      set reaction_context_checkpoint = jsonb_set(
            reaction_context_checkpoint,
            '{state,createdAtMs}',
            '0'::jsonb
          ),
          retry_at = now() - interval '1 second'
      where id = ${sourceInbox!.id}`;
    expect(await drainSlackInteractionsOnce(source.deps)).toBe(true);
    const [malformed] = await shared!.admin<
      {
        status: string;
        last_error_code: string | null;
        reaction_context_checkpoint: unknown | null;
      }[]
    >`
      select status, last_error_code, reaction_context_checkpoint
      from slack_interaction_inbox
      where id = ${sourceInbox!.id}`;
    expect(malformed).toEqual({
      status: "failed",
      last_error_code: "reaction_checkpoint_invalid",
      reaction_context_checkpoint: null,
    });
    expect(source.slack.reactionContextHits).toEqual([
      `${sourceChannelId}:${sourceTimestamp}`,
      `${sourceChannelId}:${sourceTimestamp}:checkpoint-page-2`,
    ]);

    const targetChannelId = "C_REACTION_CHECKPOINT_TARGET";
    const targetTimestamp = "1706250001.000020";
    const target = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [targetChannelId] },
      },
    });
    expect(
      (
        await postEvent(
          target.app,
          reactionEvent({
            teamId: target.teamId,
            eventId: `E_REACTION_CHECKPOINT_TARGET_${crypto.randomUUID()}`,
            userId: target.ownerSlackUserId,
            channelId: targetChannelId,
            timestamp: targetTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    const [targetInbox] = await shared!.admin<{ id: string }[]>`
      select id
      from slack_interaction_inbox
      where workspace_id = ${target.owner.workspaceId}`;
    await shared!.admin`
      update slack_interaction_inbox
      set reaction_context_checkpoint = ${shared!.admin.json(
        sourceInbox!.reaction_context_checkpoint,
      )}
      where id = ${targetInbox!.id}`;
    expect(await drainSlackInteractionsOnce(target.deps)).toBe(true);
    const [crossWorkspace] = await shared!.admin<
      {
        status: string;
        last_error_code: string | null;
        reaction_context_checkpoint: unknown | null;
      }[]
    >`
      select status, last_error_code, reaction_context_checkpoint
      from slack_interaction_inbox
      where id = ${targetInbox!.id}`;
    expect(crossWorkspace).toEqual({
      status: "failed",
      last_error_code: "reaction_checkpoint_invalid",
      reaction_context_checkpoint: null,
    });
    expect(target.slack.calls).toHaveLength(0);
    expect(await interactions(target.owner.workspaceId)).toHaveLength(0);
  });

  test("reaction checkpointing rejects a repeated provider cursor and clears terminal state", async () => {
    if (!available) return;
    const channelId = "C_REACTION_REPEATED_CURSOR";
    const reactedTimestamp = "1706260000.000020";
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    value.slack.reactionContexts.set(`${channelId}:${reactedTimestamp}`, {
      messages: [{ ts: "1706260000.000001", user: "U_ROOT", text: "Root" }],
      nextCursor: "repeated-cursor",
      pages: {
        "repeated-cursor": {
          messages: [{ ts: "1706260000.000002", user: "U_CONTEXT", text: "Context" }],
          nextCursor: "repeated-cursor",
        },
      },
    });
    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_REPEATED_CURSOR_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    const [inbox] = await shared!.admin<
      {
        status: string;
        attempt_count: number;
        last_error_code: string | null;
        reaction_context_checkpoint: unknown | null;
      }[]
    >`
      select status, attempt_count, last_error_code, reaction_context_checkpoint
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toEqual({
      status: "failed",
      attempt_count: 1,
      last_error_code: "reaction_pagination_invalid",
      reaction_context_checkpoint: null,
    });
    expect(value.slack.reactionContextHits).toEqual([
      `${channelId}:${reactedTimestamp}`,
      `${channelId}:${reactedTimestamp}:repeated-cursor`,
    ]);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(0);
    expect(value.slack.posts).toHaveLength(0);
  });

  test("reaction session admission failures are visible in the containing Slack thread", async () => {
    if (!available) return;
    const channelId = "C_REACTION_NO_CREDIT";
    const timestamp = "1706500000.000001";
    const value = await fixture({
      managedBilling: true,
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    value.slack.reactionContexts.set(`${channelId}:${timestamp}`, {
      messages: [
        {
          ts: timestamp,
          user: value.ownerSlackUserId,
          text: "Start a task that requires a billable model.",
        },
      ],
    });

    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_NO_CREDIT_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    expect(value.slack.posts.at(-1)).toMatchObject({
      channel: channelId,
      threadTimestamp: timestamp,
    });
    expect(value.slack.posts.at(-1)?.text).toContain("no available billing source");
    const [inbox] = await shared!.admin<{ status: string; last_error_code: string }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toEqual({ status: "failed", last_error_code: "http_402" });
  });

  test("reaction processing rejects unmapped, under-authorized, inaccessible, and shared-channel summons before message content", async () => {
    if (!available) return;
    const settings = {
      enabled: true,
      emoji: "genie",
      channelPolicy: { mode: "bot_member" as const },
    };
    const unmapped = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: settings,
    });
    await postEvent(
      unmapped.app,
      reactionEvent({
        teamId: unmapped.teamId,
        eventId: `E_REACTION_UNMAPPED_${crypto.randomUUID()}`,
        userId: "U_UNMAPPED_REACTION",
        channelId: "C_UNMAPPED_REACTION",
        timestamp: "1707000000.000001",
      }),
    );
    await drainAll(unmapped.deps);
    expect(unmapped.slack.calls).toHaveLength(0);

    const underAuthorized = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      ownerPermissions: ["sessions:create", "sessions:read"],
      slackReactionSummon: settings,
    });
    await postEvent(
      underAuthorized.app,
      reactionEvent({
        teamId: underAuthorized.teamId,
        eventId: `E_REACTION_UNDER_AUTHORIZED_${crypto.randomUUID()}`,
        userId: underAuthorized.ownerSlackUserId,
        channelId: "C_UNDER_AUTHORIZED",
        timestamp: "1707000001.000001",
      }),
    );
    await drainAll(underAuthorized.deps);
    expect(underAuthorized.slack.calls).toHaveLength(0);
    const [underAuthorizedInbox] = await shared!.admin<
      { status: string; last_error_code: string }[]
    >`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${underAuthorized.owner.workspaceId}`;
    expect(underAuthorizedInbox).toEqual({
      status: "failed",
      last_error_code: "reaction_session_permissions_denied",
    });

    const inaccessible = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      deniedChannels: ["C_DENIED_REACTION"],
      sharedChannels: ["C_SHARED_REACTION"],
      slackReactionSummon: settings,
    });
    for (const [channelId, timestamp] of [
      ["C_DENIED_REACTION", "1707000002.000001"],
      ["C_SHARED_REACTION", "1707000003.000001"],
    ] as const) {
      await postEvent(
        inaccessible.app,
        reactionEvent({
          teamId: inaccessible.teamId,
          eventId: `E_REACTION_INACCESSIBLE_${crypto.randomUUID()}`,
          userId: inaccessible.ownerSlackUserId,
          channelId,
          timestamp,
        }),
      );
    }
    await drainAll(inaccessible.deps);
    expect(
      inaccessible.slack.calls.filter((call) => call.method === "conversations.info"),
    ).toHaveLength(2);
    expect(
      inaccessible.slack.calls.filter((call) => call.method === "conversations.replies"),
    ).toHaveLength(0);

    for (const workspaceId of [
      unmapped.owner.workspaceId,
      underAuthorized.owner.workspaceId,
      inaccessible.owner.workspaceId,
    ]) {
      expect(await interactions(workspaceId)).toHaveLength(0);
    }
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

  test("ordinary Slack triggers retain sessions:create-only authorization", async () => {
    if (!available) return;
    const value = await fixture({
      ownerPermissions: ["sessions:create", "sessions:read"],
    });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_CREATE_ONLY_DM_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.ownerSlackUserId,
            channel: "D_CREATE_ONLY",
            ts: "1715000000.000001",
            text: "Create an ordinary Slack task without session control authority",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const routes = await interactions(value.owner.workspaceId);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      route_key: "D_CREATE_ONLY:1715000000.000001",
      visibility: "private",
    });
    const [inbox] = await shared!.admin<{ status: string; last_error_code: string | null }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toEqual({ status: "processed", last_error_code: null });
  });

  test("new Slack tasks preserve a later browser-selected turn model", async () => {
    if (!available) return;
    const value = await fixture({ codexSubscriptionEnabled: true });
    const browserSession = await createSessionForRequest(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      {
        initialMessage: "Initially selected Terra",
        model: "gpt-5.6-terra",
        sandboxBackend: "none",
      },
    );
    await acceptSessionUserMessage(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      browserSession.id,
      {
        text: "Switch this session to my connected Codex model",
        model: "codex/gpt-5.6-sol",
        clientEventId: `browser-model-switch-${crypto.randomUUID()}`,
      },
    );

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_PREFERRED_MODEL_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.ownerSlackUserId,
            channel: "D_PRIVATE",
            ts: "1710000002.000001",
            text: "Use my current OpenGeni model",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const [route] = await interactions(value.owner.workspaceId);
    const [session] = await shared!.admin<{ model: string }[]>`
      select model from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.model).toBe("codex/gpt-5.6-sol");
  });

  test("subject model lookup orders turns across sessions, resolves ties, and falls back without turns", async () => {
    if (!available) return;
    const value = await fixture({ codexSubscriptionEnabled: true });
    const olderSession = await createSessionForRequest(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      {
        initialMessage: "Older Terra session",
        model: "gpt-5.6-terra",
        sandboxBackend: "none",
      },
    );
    await acceptSessionUserMessage(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      olderSession.id,
      {
        text: "Choose Codex later in the older session",
        model: "codex/gpt-5.6-sol",
        clientEventId: `older-session-model-switch-${crypto.randomUUID()}`,
      },
    );
    const newerSession = await createSessionForRequest(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      {
        initialMessage: "Newer Luna session",
        model: "gpt-5.6-luna",
        sandboxBackend: "none",
      },
    );

    await shared!.admin`
      update sessions
      set created_at = '2026-08-02T10:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and id = ${olderSession.id}`;
    await shared!.admin`
      update session_turns
      set created_at = case
        when model = 'codex/gpt-5.6-sol' then '2026-08-02T13:00:00Z'::timestamptz
        else '2026-08-02T10:00:00Z'::timestamptz
      end
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${olderSession.id}`;
    await shared!.admin`
      update sessions
      set created_at = '2026-08-02T12:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and id = ${newerSession.id}`;
    await shared!.admin`
      update session_turns
      set created_at = '2026-08-02T12:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${newerSession.id}`;

    expect(
      await getLatestSessionModelForSubject(
        client.db,
        value.owner.workspaceId,
        value.owner.subjectId,
      ),
    ).toBe("codex/gpt-5.6-sol");

    await shared!.admin`
      update session_turns
      set created_at = '2026-08-02T14:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${olderSession.id}`;
    expect(
      await getLatestSessionModelForSubject(
        client.db,
        value.owner.workspaceId,
        value.owner.subjectId,
      ),
    ).toBe("codex/gpt-5.6-sol");

    const fallbackSession = await createSessionForRequest(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      {
        initialMessage: "Fallback-only session",
        model: "gpt-5.6-luna",
        sandboxBackend: "none",
      },
    );
    await shared!.admin`
      delete from session_turns
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${fallbackSession.id}`;
    await shared!.admin`
      update sessions
      set created_at = '2026-08-02T15:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and id = ${fallbackSession.id}`;
    expect(
      await getLatestSessionModelForSubject(
        client.db,
        value.owner.workspaceId,
        value.owner.subjectId,
      ),
    ).toBe("gpt-5.6-luna");
  });

  test("subject model lookup ignores other users and workspaces", async () => {
    if (!available) return;
    const value = await fixture({ codexSubscriptionEnabled: true });
    const ownerSession = await createSessionForRequest(
      value.deps,
      value.owner,
      value.owner.workspaceId,
      {
        initialMessage: "Owner Terra session",
        model: "gpt-5.6-terra",
        sandboxBackend: "none",
      },
    );
    const otherGrant = await getWorkspaceGrant(
      client.db,
      value.otherSubjectId,
      value.owner.workspaceId,
    );
    if (!otherGrant) throw new Error("other subject grant was not created");
    await acceptSessionUserMessage(
      value.deps,
      otherGrant,
      value.owner.workspaceId,
      ownerSession.id,
      {
        text: "Another user chooses Luna",
        model: "gpt-5.6-luna",
        clientEventId: `other-subject-model-switch-${crypto.randomUUID()}`,
      },
    );
    const otherSubjectSession = await createSessionForRequest(
      value.deps,
      otherGrant,
      value.owner.workspaceId,
      {
        initialMessage: "Other subject Codex session",
        model: "codex/gpt-5.6-sol",
        sandboxBackend: "none",
      },
    );

    const crossWorkspace = await bootstrapWorkspace(client.db, {
      accountExternalSource: "slack-interactions-cross-workspace-test",
      accountExternalId: `account-${crypto.randomUUID()}`,
      accountName: "Slack interactions cross-workspace",
      workspaceExternalSource: "slack-interactions-cross-workspace-test",
      workspaceExternalId: `workspace-${crypto.randomUUID()}`,
      workspaceName: "Slack interactions cross-workspace",
      subjectId: value.owner.subjectId,
    });
    const crossWorkspaceGrant = crossWorkspace.workspaceGrants[0]!;
    const crossWorkspaceSession = await createSessionForRequest(
      value.deps,
      crossWorkspaceGrant,
      crossWorkspaceGrant.workspaceId,
      {
        initialMessage: "Same subject in another workspace",
        model: "codex/gpt-5.6-sol",
        sandboxBackend: "none",
      },
    );

    await shared!.admin`
      update sessions
      set created_at = '2026-08-02T10:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and id = ${ownerSession.id}`;
    await shared!.admin`
      update session_turns
      set created_at = case
        when initiator_subject_id = ${value.otherSubjectId}
          then '2026-08-02T20:00:00Z'::timestamptz
        else '2026-08-02T10:00:00Z'::timestamptz
      end
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${ownerSession.id}`;
    await shared!.admin`
      update sessions
      set created_at = '2026-08-02T21:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and id = ${otherSubjectSession.id}`;
    await shared!.admin`
      update session_turns
      set created_at = '2026-08-02T21:00:00Z'::timestamptz
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${otherSubjectSession.id}`;
    await shared!.admin`
      update sessions
      set created_at = '2026-08-02T22:00:00Z'::timestamptz
      where workspace_id = ${crossWorkspaceGrant.workspaceId}
        and id = ${crossWorkspaceSession.id}`;
    await shared!.admin`
      update session_turns
      set created_at = '2026-08-02T22:00:00Z'::timestamptz
      where workspace_id = ${crossWorkspaceGrant.workspaceId}
        and session_id = ${crossWorkspaceSession.id}`;

    expect(
      await getLatestSessionModelForSubject(
        client.db,
        value.owner.workspaceId,
        value.owner.subjectId,
      ),
    ).toBe("gpt-5.6-terra");
  });

  test("new Slack tasks preserve the linked subject's latest session default", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Previously selected model",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_PREFERRED_MODEL_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.ownerSlackUserId,
            channel: "D_PRIVATE",
            ts: "1710000002.000001",
            text: "Use my current OpenGeni model",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const [route] = await interactions(value.owner.workspaceId);
    const [session] = await shared!.admin<{ model: string }[]>`
      select model from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.model).toBe("gpt-5.6-terra");
  });

  test("permanent session admission failures are visible in Slack and retain a useful code", async () => {
    if (!available) return;
    const value = await fixture({ managedBilling: true });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_NO_CREDIT_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: value.ownerSlackUserId,
            channel: "C_TEAM",
            ts: "1710000002.000001",
            text: `<@${value.botUserId}> start a task`,
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    expect(value.slack.posts.at(-1)?.text).toContain("no available billing source");
    const [inbox] = await shared!.admin<{ status: string; last_error_code: string }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toEqual({ status: "failed", last_error_code: "http_402" });
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
    expect(commandAck).toMatchObject({
      channel: "C_COMMAND",
      threadTimestamp: null,
    });

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
    const shortcut = new URLSearchParams({
      payload: shortcutPayload,
    }).toString();
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
    expect(pendingTransient).toMatchObject({
      status: "pending",
      attempt_count: 0,
      retry_at: null,
    });
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
      {
        type: "turn.completed",
        payload: { output: "Permanent delivery result" },
      },
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
