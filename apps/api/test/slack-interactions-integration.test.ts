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
  getSlackBotUserLink,
  getSessionForSubject,
  getWorkspaceGrant,
  grantWorkspaceAccess,
  saveSlackBotUserLink,
  synchronizeCanonicalHumanLoginBindings,
  updateSlackTaskPolicy,
  updateWorkspaceSettings,
  withWorkspaceSessionActivityRls,
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
import type { ObjectHead, ObjectStorage } from "@opengeni/storage";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  createSlackUserLinkToken,
  drainSlackInteractionsOnce,
  registerSlackInteractionRoutes,
  SLACK_SESSION_INSTRUCTIONS,
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
  blocks: unknown[] | null;
  threadTimestamp: string | null;
  clientMessageId: string | null;
  timestamp: string;
};

type SlackCall = {
  method: string;
  channel: string | null;
  timestamp: string | null;
  latest?: string | null;
  inclusive?: string | null;
};

type SlackHomePublication = {
  userId: string;
  hash: string | null;
  view: { type: string; blocks: unknown[] };
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

type SlackPostPause = {
  entered: Promise<void>;
  release: () => void;
};

type SlackHomePause = SlackPostPause;

type SlackPrivateFileFixture = {
  channelId: string;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
};

function fakeSlack(
  deniedChannels: Set<string> = new Set(),
  options: {
    failAfterAcceptTexts?: Set<string>;
    sharedChannels?: Set<string>;
    mpimChannels?: Set<string>;
    installationTeamId?: string;
    externalTeamId?: string;
    externalUserIds?: Set<string>;
    guestUserIds?: Set<string>;
  } = {},
) {
  const posts: SlackPost[] = [];
  const homePublications: SlackHomePublication[] = [];
  const homeViewHashes = new Map<string, string>();
  const calls: SlackCall[] = [];
  const reactionContexts = new Map<string, SlackReactionContext>();
  const privateFiles = new Map<string, SlackPrivateFileFixture>();
  const privateFileFetches: string[] = [];
  let nextChannelInfoPause:
    | {
        channelId: string;
        signalEntered: () => void;
        released: Promise<void>;
      }
    | undefined;
  const channelInfoPauseAfterFile = new Map<
    string,
    {
      channelId: string;
      signalEntered: () => void;
      released: Promise<void>;
    }
  >();
  const privateFileRedirectAfterFetch = new Map<
    string,
    {
      channelId: string;
      signalEntered: () => void;
      released: Promise<void>;
    }
  >();
  const pauseChannelInfoAfterFile = (fileId: string, channelId: string): SlackPostPause => {
    if (channelInfoPauseAfterFile.has(fileId)) {
      throw new Error("Slack post-file channel-info pause already exists");
    }
    let signalEntered!: () => void;
    let signalReleased!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve;
    });
    channelInfoPauseAfterFile.set(fileId, { channelId, signalEntered, released });
    return {
      entered,
      release: () => {
        signalReleased();
      },
    };
  };
  const redirectPrivateFileThenPausePolicy = (
    fileId: string,
    channelId: string,
  ): SlackPostPause => {
    if (privateFileRedirectAfterFetch.has(fileId)) {
      throw new Error("Slack private-file redirect pause already exists");
    }
    let signalEntered!: () => void;
    let signalReleased!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve;
    });
    privateFileRedirectAfterFetch.set(fileId, { channelId, signalEntered, released });
    return {
      entered,
      release: () => {
        signalReleased();
      },
    };
  };
  const channelHistories = new Map<string, SlackReactionContextPage>();
  const reactionContextHits: string[] = [];
  const failuresByText = new Map<
    string,
    { error?: string; status?: number; retryAfterSeconds?: number }
  >();
  const postFailuresByChannel = new Map<
    string,
    { error?: string; status?: number; retryAfterSeconds?: number }
  >();
  const channelAccessFailures = new Map<
    string,
    { error?: string; status?: number; retryAfterSeconds?: number }
  >();
  const failedAfterAccept = new Set<string>();
  const postPauses = new Map<
    string,
    {
      signalEntered: () => void;
      released: Promise<void>;
    }
  >();
  const homePauses = new Map<
    string,
    {
      signalEntered: () => void;
      released: Promise<void>;
    }
  >();
  const pauseBeforePost = (textFragment: string): SlackPostPause => {
    if (postPauses.has(textFragment)) throw new Error("Slack post pause already exists");
    let signalEntered!: () => void;
    let signalReleased!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve;
    });
    postPauses.set(textFragment, { signalEntered, released });
    return {
      entered,
      release: () => {
        signalReleased();
      },
    };
  };
  const pauseBeforeHomePublish = (userId: string): SlackHomePause => {
    if (homePauses.has(userId)) throw new Error("Slack App Home pause already exists");
    let signalEntered!: () => void;
    let signalReleased!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve;
    });
    homePauses.set(userId, { signalEntered, released });
    return {
      entered,
      release: () => signalReleased(),
    };
  };
  let nextTimestamp = 1;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = url.pathname.replace(/^\/api\//, "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (url.hostname === "files.slack.com") {
      const fileId = url.pathname.split("/").filter(Boolean).at(-2) ?? "";
      privateFileFetches.push(fileId);
      const redirectPause = privateFileRedirectAfterFetch.get(fileId);
      if (redirectPause) {
        privateFileRedirectAfterFetch.delete(fileId);
        nextChannelInfoPause = redirectPause;
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://files.slack.com/files-pri/${fileId}/redirected-download`,
          },
        });
      }
      const file = privateFiles.get(fileId);
      return file
        ? new Response(file.bytes, { headers: { "content-type": file.contentType } })
        : new Response(null, { status: 404 });
    }
    calls.push({
      method,
      channel: form.get("channel"),
      timestamp: form.get("ts"),
      ...(form.has("latest") ? { latest: form.get("latest") } : {}),
      ...(form.has("inclusive") ? { inclusive: form.get("inclusive") } : {}),
    });
    if (method === "conversations.info") {
      const channel = form.get("channel") ?? "";
      if (nextChannelInfoPause?.channelId === channel) {
        const pause = nextChannelInfoPause;
        nextChannelInfoPause = undefined;
        pause.signalEntered();
        await pause.released;
      }
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
      const isShared = options.sharedChannels?.has(channel) ?? false;
      const externalTeamId = options.externalTeamId ?? "T_EXTERNAL";
      return Response.json({
        ok: true,
        channel: {
          id: channel,
          name: channel,
          is_member: !deniedChannels.has(channel),
          is_im: channel.startsWith("D"),
          is_private: channel.startsWith("D") || channel.startsWith("G"),
          is_mpim: options.mpimChannels?.has(channel) ?? false,
          is_shared: isShared,
          is_ext_shared: isShared,
          is_org_shared: false,
          is_pending_ext_shared: false,
          context_team_id: options.installationTeamId,
          connected_team_ids: isShared ? [externalTeamId] : [],
          shared_team_ids: isShared
            ? [options.installationTeamId, externalTeamId].filter(Boolean)
            : options.installationTeamId
              ? [options.installationTeamId]
              : [],
        },
      });
    }
    if (method === "users.info") {
      const userId = form.get("user") ?? "";
      const external = options.externalUserIds?.has(userId) ?? false;
      const guest = options.guestUserIds?.has(userId) ?? false;
      return Response.json({
        ok: true,
        user: {
          id: userId,
          team_id: external ? (options.externalTeamId ?? "T_EXTERNAL") : options.installationTeamId,
          is_external: external,
          is_restricted: guest,
          is_ultra_restricted: false,
        },
      });
    }
    if (method === "conversations.replies") {
      const channel = form.get("channel") ?? "";
      const timestamp = form.get("ts") ?? "";
      const key = `${channel}:${timestamp}`;
      const matchingPosts = posts.filter(
        (post) => post.channel === channel && post.threadTimestamp === timestamp,
      );
      const rootContext =
        reactionContexts.get(key) ?? (matchingPosts.length > 0 ? { messages: [] } : undefined);
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
        messages: [
          ...context.messages,
          ...matchingPosts.map((post) => ({
            ts: post.timestamp,
            bot_id: "B_OPEN_GENI",
            text: post.text,
            thread_ts: post.threadTimestamp,
            client_msg_id: post.clientMessageId,
          })),
        ],
        response_metadata: { next_cursor: context.nextCursor ?? "" },
      });
    }
    if (method === "conversations.history") {
      const channel = form.get("channel") ?? "";
      const context = channelHistories.get(channel) ?? { messages: [] };
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
        messages: [
          ...context.messages,
          ...posts
            .filter((post) => post.channel === channel && post.threadTimestamp === null)
            .map((post) => ({
              ts: post.timestamp,
              bot_id: "B_OPEN_GENI",
              text: post.text,
              client_msg_id: post.clientMessageId,
            })),
        ],
        response_metadata: { next_cursor: context.nextCursor ?? "" },
      });
    }
    if (method === "conversations.open") {
      const user = form.get("users") ?? "";
      return Response.json({ ok: true, channel: { id: `D_${user}` } });
    }
    if (method === "views.publish") {
      const view = JSON.parse(form.get("view") ?? "null") as SlackHomePublication["view"];
      const userId = form.get("user_id") ?? "";
      const paused = homePauses.get(userId);
      if (paused) {
        paused.signalEntered();
        await paused.released;
        homePauses.delete(userId);
      }
      const requestedHash = form.get("hash");
      const currentHash = homeViewHashes.get(userId);
      if (requestedHash && currentHash && requestedHash !== currentHash) {
        return Response.json({ ok: false, error: "hash_conflict" });
      }
      homePublications.push({ userId, hash: requestedHash, view });
      const nextHash = `home-view-${homePublications.length}`;
      homeViewHashes.set(userId, nextHash);
      return Response.json({
        ok: true,
        view: { id: `V_${homePublications.length}`, hash: nextHash },
      });
    }
    if (method === "files.info") {
      const fileId = form.get("file") ?? "";
      const postFilePause = channelInfoPauseAfterFile.get(fileId);
      if (postFilePause) {
        channelInfoPauseAfterFile.delete(fileId);
        nextChannelInfoPause = postFilePause;
      }
      const privateFile = privateFiles.get(fileId);
      if (privateFile) {
        return Response.json({
          ok: true,
          file: {
            id: fileId,
            name: privateFile.filename,
            mimetype: privateFile.contentType,
            size: privateFile.bytes.byteLength,
            channels: [privateFile.channelId],
            url_private_download: `https://files.slack.com/files-pri/${fileId}/download`,
          },
        });
      }
      for (const [key, root] of reactionContexts) {
        const channel = key.split(":", 1)[0]!;
        for (const page of [root, ...Object.values(root.pages ?? {})]) {
          for (const message of page.messages) {
            const file = Array.isArray(message.files)
              ? (message.files as Array<Record<string, unknown>>).find(
                  (candidate) => candidate.id === fileId,
                )
              : undefined;
            if (!file) continue;
            return Response.json({
              ok: true,
              file: {
                ...file,
                id: fileId,
                mimetype: file.mimetype ?? "application/octet-stream",
                size: file.size ?? 1,
                channels: [channel],
              },
            });
          }
        }
      }
      return Response.json({ ok: false, error: "file_not_found" });
    }
    if (method === "chat.postMessage") {
      const clientMessageId = form.get("client_msg_id");
      const timestamp = `1800000000.${String(nextTimestamp++).padStart(6, "0")}`;
      const post = {
        channel: form.get("channel") ?? "",
        text: form.get("text") ?? "",
        blocks: form.has("blocks") ? (JSON.parse(form.get("blocks")!) as unknown[]) : null,
        threadTimestamp: form.get("thread_ts"),
        clientMessageId,
        timestamp,
      };
      const paused = [...postPauses.entries()].find(([fragment]) => post.text.includes(fragment));
      if (paused) {
        const [fragment, gate] = paused;
        gate.signalEntered();
        await gate.released;
        postPauses.delete(fragment);
      }
      const configuredFailure =
        postFailuresByChannel.get(post.channel) ??
        [...failuresByText.entries()].find(([fragment]) => post.text.includes(fragment))?.[1];
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
      posts.push(post);
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
    if (method === "chat.update") {
      const channel = form.get("channel") ?? "";
      const timestamp = form.get("ts") ?? "";
      const post = posts.find(
        (candidate) => candidate.channel === channel && candidate.timestamp === timestamp,
      );
      if (!post) return Response.json({ ok: false, error: "message_not_found" });
      post.text = form.get("text") ?? "";
      post.blocks = form.has("blocks") ? (JSON.parse(form.get("blocks")!) as unknown[]) : null;
      return Response.json({ ok: true, channel, ts: timestamp });
    }
    return Response.json({ ok: false, error: `unexpected_${method}` });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    posts,
    homePublications,
    calls,
    reactionContexts,
    privateFiles,
    privateFileFetches,
    channelHistories,
    reactionContextHits,
    failuresByText,
    postFailuresByChannel,
    channelAccessFailures,
    pauseBeforePost,
    pauseChannelInfoAfterFile,
    redirectPrivateFileThenPausePolicy,
    pauseBeforeHomePublish,
    currentHomeViewHash: (userId: string) => homeViewHashes.get(userId) ?? null,
    setHomeViewHash: (userId: string, hash: string) => homeViewHashes.set(userId, hash),
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
    mpimChannels?: string[];
    externalOwnerTeamId?: string;
    guestOwner?: boolean;
    slackReactionSummon?: WorkspaceSlackReactionSummonSettings;
    slackCommand?: string;
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
    slackCommand: options.slackCommand ?? "/opengeni",
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
    mpimChannels: new Set(options.mpimChannels ?? []),
    installationTeamId: teamId,
    externalTeamId: options.externalOwnerTeamId ?? "T_EXTERNAL",
    externalUserIds: new Set(options.externalOwnerTeamId ? [ownerSlackUserId] : []),
    guestUserIds: new Set(options.guestOwner ? [ownerSlackUserId] : []),
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

function reactionObjectStorage() {
  const objects = new Map<string, { bytes: Uint8Array; head: ObjectHead }>();
  const storage = {
    bucket: "slack-reaction-test",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async headObject(key: string) {
      return objects.get(key)?.head ?? null;
    },
    async putObjectIfAbsent(input: {
      key: string;
      contentType: string;
      body: Uint8Array;
      sha256: string;
    }) {
      if (objects.has(input.key)) return false;
      objects.set(input.key, {
        bytes: input.body,
        head: {
          ContentLength: input.body.byteLength,
          ContentType: input.contentType,
          Metadata: { sha256: input.sha256 },
          VersionToken: "v1",
        },
      });
      return true;
    },
  } as ObjectStorage;
  return { storage, objects };
}

function fixturePng(): Uint8Array {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
}

function fixtureWebp(): Uint8Array {
  return new Uint8Array([
    82, 73, 70, 70, 14, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 2, 0, 0, 0, 47, 0,
  ]);
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
  test("App Home publishes only currently authorized tasks from the linked workspace", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Visible App Home task",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });
    const crossWorkspace = await bootstrapWorkspace(client.db, {
      accountExternalSource: "slack-app-home-cross-workspace",
      accountExternalId: `account-${crypto.randomUUID()}`,
      accountName: "Slack App Home isolation",
      workspaceExternalSource: "slack-app-home-cross-workspace",
      workspaceExternalId: `workspace-${crypto.randomUUID()}`,
      workspaceName: "Slack App Home isolation",
      subjectId: value.owner.subjectId,
    });
    const crossWorkspaceGrant = crossWorkspace.workspaceGrants[0]!;
    await createSessionForRequest(
      value.deps,
      crossWorkspaceGrant,
      crossWorkspaceGrant.workspaceId,
      {
        initialMessage: "Cross-workspace task must stay hidden",
        model: "gpt-5.6-terra",
        sandboxBackend: "none",
      },
    );

    const event = {
      teamId: value.teamId,
      eventId: `E_HOME_${crypto.randomUUID()}`,
      event: {
        type: "app_home_opened",
        user: value.ownerSlackUserId,
        tab: "home",
        view: { hash: "home-hash-initial" },
      },
    };
    value.slack.setHomeViewHash(value.ownerSlackUserId, "home-hash-initial");
    expect((await postEvent(value.app, event)).status).toBe(200);
    expect((await postEvent(value.app, event)).status).toBe(200);
    expect(value.slack.homePublications).toHaveLength(0);
    expect(await drainAll(value.deps)).toBe(1);
    expect(value.slack.homePublications).toHaveLength(1);
    const first = JSON.stringify(value.slack.homePublications[0]!.view.blocks);
    expect(first).toContain("Visible App Home task");
    expect(first).not.toContain("Cross-workspace task must stay hidden");
    expect(value.slack.homePublications[0]!.userId).toBe(value.ownerSlackUserId);
    expect(value.slack.calls.filter((call) => call.method === "views.publish")).toHaveLength(1);
  });

  test("App Home replaces task data with an access view after link revocation", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Must disappear after unlink",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });
    const event = {
      teamId: value.teamId,
      eventId: `E_HOME_REVOKED_${crypto.randomUUID()}`,
      event: {
        type: "app_home_opened",
        user: value.ownerSlackUserId,
        tab: "home",
        view: { hash: "home-hash-authorized" },
      },
    };
    value.slack.setHomeViewHash(value.ownerSlackUserId, "home-hash-authorized");
    expect((await postEvent(value.app, event)).status).toBe(200);
    expect(value.slack.homePublications).toHaveLength(0);
    expect(await drainAll(value.deps)).toBe(1);
    await shared!.admin`
      delete from slack_bot_user_links
      where workspace_id = ${value.owner.workspaceId}
        and connection_id = ${value.connectionId}
        and slack_user_id = ${value.ownerSlackUserId}`;
    expect(
      (
        await postEvent(value.app, {
          ...event,
          eventId: `${event.eventId}_2`,
          event: {
            ...event.event,
            view: { hash: value.slack.currentHomeViewHash(value.ownerSlackUserId) },
          },
        })
      ).status,
    ).toBe(200);
    expect(await drainAll(value.deps)).toBe(1);
    const revoked = JSON.stringify(value.slack.homePublications.at(-1)!.view.blocks);
    expect(revoked).toContain("Connect your OpenGeni account");
    expect(revoked).not.toContain("Must disappear after unlink");
  });

  test("App Home never publishes task data without Slack's current view hash", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Must remain hidden without a Slack view hash",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_HOME_NO_HASH_${crypto.randomUUID()}`,
          event: {
            type: "app_home_opened",
            user: value.ownerSlackUserId,
            tab: "home",
          },
        })
      ).status,
    ).toBe(200);
    expect(await drainAll(value.deps)).toBe(1);
    const view = JSON.stringify(value.slack.homePublications.at(-1)!.view.blocks);
    expect(view).toContain("Refresh OpenGeni Home");
    expect(view).not.toContain("Must remain hidden without a Slack view hash");
  });

  test("App Home serializes overlapping refreshes so revoked content cannot win last", async () => {
    if (!available) return;
    const value = await fixture();
    await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Must not overwrite the revoked view",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });
    const firstEvent = {
      teamId: value.teamId,
      eventId: `E_HOME_RACE_A_${crypto.randomUUID()}`,
      event: {
        type: "app_home_opened",
        user: value.ownerSlackUserId,
        tab: "home",
        view: { hash: "home-hash-a" },
      },
    };
    value.slack.setHomeViewHash(value.ownerSlackUserId, "home-hash-a");
    expect((await postEvent(value.app, firstEvent)).status).toBe(200);
    const pause = value.slack.pauseBeforeHomePublish(value.ownerSlackUserId);
    const firstDrain = drainSlackInteractionsOnce(value.deps);
    await pause.entered;

    await shared!.admin`
      delete from slack_bot_user_links
      where workspace_id = ${value.owner.workspaceId}
        and connection_id = ${value.connectionId}
        and slack_user_id = ${value.ownerSlackUserId}`;
    expect(
      (
        await postEvent(value.app, {
          ...firstEvent,
          eventId: `E_HOME_RACE_B_${crypto.randomUUID()}`,
          event: { ...firstEvent.event, view: { hash: "home-hash-a" } },
        })
      ).status,
    ).toBe(200);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);

    pause.release();
    expect(await firstDrain).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);
    expect(value.slack.homePublications.map((publication) => publication.hash)).toEqual([
      "home-hash-a",
      null,
    ]);
    const finalView = JSON.stringify(value.slack.homePublications.at(-1)!.view.blocks);
    expect(finalView).toContain("Connect your OpenGeni account");
    expect(finalView).not.toContain("Must not overwrite the revoked view");
  });

  test("App Home scans beyond the newest page for older tasks needing attention", async () => {
    if (!available) return;
    const value = await fixture();
    const urgent = await createSessionForRequest(value.deps, value.owner, value.owner.workspaceId, {
      initialMessage: "Older urgent task remains visible",
      model: "gpt-5.6-terra",
      sandboxBackend: "none",
    });
    await withWorkspaceSessionActivityRls(client.db, value.owner.workspaceId, async (db) => {
      await db.execute(sql`
        update sessions
        set status = 'failed', updated_at = now() - interval '2 hours'
        where workspace_id = ${value.owner.workspaceId} and id = ${urgent.id}`);
      await db.execute(sql`
        insert into sessions (
          account_id, workspace_id, status, initial_message, resources, tools, metadata,
          model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id,
          tool_policy, created_at, updated_at
        )
        select ${value.owner.accountId}, ${value.owner.workspaceId}, 'idle',
          'Newer completed task ' || n::text, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          'gpt-5.6-terra', 'medium', 'standard', 'none', gen_random_uuid(),
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null),
          statement_timestamp() - make_interval(secs => n),
          statement_timestamp() - make_interval(secs => n)
        from generate_series(1, 500) as generated(n)
      `);
    });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_HOME_SCAN_${crypto.randomUUID()}`,
          event: {
            type: "app_home_opened",
            user: value.ownerSlackUserId,
            tab: "home",
            view: { hash: "home-hash-pagination" },
          },
        })
      ).status,
    ).toBe(200);
    expect(await drainAll(value.deps)).toBe(1);
    const view = JSON.stringify(value.slack.homePublications.at(-1)!.view.blocks);
    expect(view).toContain("Older urgent task remains visible");
  });

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

  test("managed signed-link access requests remain token-free and complete only after admin approval", async () => {
    if (!available) return;
    const value = await fixture({
      ownerPermissions: ["workspace:admin", "members:manage", "sessions:create"],
    });
    const requesterId = `slack-access-requester-${crypto.randomUUID()}`;
    const otherId = `slack-access-other-${crypto.randomUUID()}`;
    const ownerId = value.owner.subjectId.replace(/^user:/, "");
    for (const userId of [requesterId, otherId, ownerId]) {
      await shared!.admin`
        insert into auth_users (id, name, email, email_verified)
        values (
          ${userId},
          ${userId === ownerId ? "Slack access admin" : "Slack access requester"},
          ${`${userId}@example.test`},
          true
        )
      `;
      await shared!.admin`
        insert into auth_identities (id, user_id, provider_id, account_id)
        values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})
      `;
      const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
      await shared!.admin`
        insert into auth_sessions (
          id, user_id, token, expires_at,
          identity_id, identity_revision, auth_revision
        ) values (
          ${`session-${userId}`}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
          ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
        )
      `;
    }
    Reflect.set(value.deps, "managedAuth", {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const userId = headers.get("x-test-managed-user");
          return {
            headers: new Headers(),
            response: userId
              ? {
                  session: {
                    id: `session-${userId}`,
                    userId,
                    expiresAt: new Date(Date.now() + 60_000),
                  },
                  user: {
                    id: userId,
                    email: `${userId}@example.test`,
                    name: userId === ownerId ? "Slack access admin" : "Slack access requester",
                  },
                }
              : null,
          };
        },
      },
    });

    const slackUserId = `U_ACCESS_${crypto.randomUUID()}`;
    const linkToken = createSlackUserLinkToken(signingMaterial, {
      workspaceId: value.owner.workspaceId,
      connectionId: value.connectionId,
      slackTeamId: value.teamId,
      slackUserId,
    });
    const basePath = `/v1/workspaces/${value.owner.workspaceId}/integrations/slack/user-link-intents`;
    const requesterHeaders = {
      "content-type": "application/json",
      "x-test-managed-user": requesterId,
    };
    const ownerHeaders = {
      "content-type": "application/json",
      "x-test-managed-user": ownerId,
    };

    const bearerRejected = await value.app.request(basePath, {
      method: "POST",
      headers: {
        ...requesterHeaders,
        authorization: "Bearer must-not-authorize-browser-linking",
      },
      body: JSON.stringify({ linkToken }),
    });
    expect(bearerRejected.status).toBe(401);

    for (const invalidToken of [
      `${linkToken}x`,
      createSlackUserLinkToken(
        signingMaterial,
        {
          workspaceId: value.owner.workspaceId,
          connectionId: value.connectionId,
          slackTeamId: value.teamId,
          slackUserId,
        },
        Date.now() - 16 * 60_000,
      ),
    ]) {
      const invalid = await value.app.request(basePath, {
        method: "POST",
        headers: requesterHeaders,
        body: JSON.stringify({ linkToken: invalidToken }),
      });
      expect(invalid.status).toBe(400);
      const body = await invalid.text();
      expect(body).toContain("Request a fresh link from Slack");
      expect(body).not.toContain("Slack interactions");
      expect(body).not.toContain(invalidToken);
    }

    const prepareResponse = await value.app.request(basePath, {
      method: "POST",
      headers: requesterHeaders,
      body: JSON.stringify({ linkToken }),
    });
    expect(prepareResponse.status).toBe(201);
    const prepared = (await prepareResponse.json()) as {
      id: string;
      status: string;
      version: number;
      workspaceDisplayName: string | null;
    };
    expect(prepared).toMatchObject({
      status: "prepared",
      version: 1,
      workspaceDisplayName: "Slack interactions",
    });
    expect(JSON.stringify(prepared)).not.toContain(linkToken);
    expect(JSON.stringify(prepared)).not.toContain("tokenDigest");
    const replayResponse = await value.app.request(basePath, {
      method: "POST",
      headers: requesterHeaders,
      body: JSON.stringify({ linkToken }),
    });
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toMatchObject({
      id: prepared.id,
      status: "prepared",
      version: 1,
    });

    const crossUser = await value.app.request(`${basePath}/${prepared.id}`, {
      headers: { "x-test-managed-user": otherId },
    });
    expect(crossUser.status).toBe(400);
    const crossUserBody = await crossUser.text();
    expect(crossUserBody).toContain("Request a fresh link from Slack");
    expect(crossUserBody).not.toContain("Slack interactions");

    const requestedResponse = await value.app.request(`${basePath}/${prepared.id}/request-access`, {
      method: "POST",
      headers: requesterHeaders,
      body: JSON.stringify({ expectedVersion: 1, idempotencyKey: crypto.randomUUID() }),
    });
    expect(requestedResponse.status).toBe(200);
    const requested = (await requestedResponse.json()) as { status: string; version: number };
    expect(requested).toMatchObject({ status: "pending", version: 2 });

    const listResponse = await value.app.request(
      `/v1/workspaces/${value.owner.workspaceId}/members/access-requests/slack`,
      { headers: { "x-test-managed-user": ownerId } },
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as { requests: Array<{ id: string }> };
    expect(listed.requests.map((request) => request.id)).toContain(prepared.id);

    const approveResponse = await value.app.request(
      `/v1/workspaces/${value.owner.workspaceId}/members/access-requests/slack/${prepared.id}/approve`,
      {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          expectedVersion: 2,
          idempotencyKey: crypto.randomUUID(),
          role: "member",
          permissions: ["sessions:create", "sessions:read"],
        }),
      },
    );
    expect(approveResponse.status).toBe(200);
    expect(await approveResponse.json()).toMatchObject({ status: "completed", version: 3 });

    const requesterSubjectId = `user:${requesterId}`;
    expect(
      await getWorkspaceGrant(client.db, requesterSubjectId, value.owner.workspaceId),
    ).toMatchObject({
      subjectId: requesterSubjectId,
      permissions: ["sessions:create", "sessions:read"],
    });
    expect(
      await getSlackBotUserLink(
        client.db,
        value.owner.workspaceId,
        value.connectionId,
        slackUserId,
      ),
    ).toMatchObject({ subjectId: requesterSubjectId });

    const completedResponse = await value.app.request(`${basePath}/${prepared.id}`, {
      headers: { "x-test-managed-user": requesterId },
    });
    expect(completedResponse.status).toBe(200);
    expect(await completedResponse.json()).toMatchObject({ status: "completed", version: 3 });

    const cancelSlackUserId = `U_CANCEL_${crypto.randomUUID()}`;
    const cancelToken = createSlackUserLinkToken(signingMaterial, {
      workspaceId: value.owner.workspaceId,
      connectionId: value.connectionId,
      slackTeamId: value.teamId,
      slackUserId: cancelSlackUserId,
    });
    const cancelPrepare = await value.app.request(basePath, {
      method: "POST",
      headers: { ...requesterHeaders, "x-test-managed-user": otherId },
      body: JSON.stringify({ linkToken: cancelToken }),
    });
    expect(cancelPrepare.status).toBe(201);
    const cancelPrepared = (await cancelPrepare.json()) as { id: string; version: number };
    const cancelResponse = await value.app.request(`${basePath}/${cancelPrepared.id}/cancel`, {
      method: "POST",
      headers: { ...requesterHeaders, "x-test-managed-user": otherId },
      body: JSON.stringify({
        expectedVersion: cancelPrepared.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toMatchObject({ status: "cancelled", version: 2 });
    expect(
      await getSlackBotUserLink(
        client.db,
        value.owner.workspaceId,
        value.connectionId,
        cancelSlackUserId,
      ),
    ).toBeNull();
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
      ownerPermissions: [
        "sessions:create",
        "sessions:read",
        "sessions:control",
        "scheduled_tasks:manage",
      ],
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
      3,
    );
    expect(value.slack.posts).toHaveLength(1);
    expect(value.slack.posts[0]).toMatchObject({
      channel: channelId,
      threadTimestamp: rootTimestamp,
    });
    expect(value.slack.posts[0]!.text).toContain("started from the :genie: reaction");
    expect(value.slack.posts[0]!.text).toMatch(
      /<https:\/\/app\.example\.test\/workspaces\/[^|]+\|Open in OpenGeni>/u,
    );
    expect(value.slack.posts[0]!.text.match(/Open in OpenGeni/gu) ?? []).toHaveLength(1);

    const postsBeforeCompletion = value.slack.posts.length;
    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      {
        type: "agent.message.completed",
        payload: { text: "The requested Slack check is complete." },
      },
      {
        type: "agent.message.completed",
        payload: { text: "The requested Slack check is complete." },
      },
      {
        type: "turn.completed",
        payload: {
          output: "The requested Slack check is complete.\n\nNo rollback is required.",
        },
      },
    ]);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);
    const completionPosts = value.slack.posts.slice(postsBeforeCompletion);
    expect(completionPosts).toHaveLength(1);
    expect(completionPosts[0]!.text).toMatch(
      /^The requested Slack check is complete\.\n\nNo rollback is required\.\n\nReply in this thread to continue\.\n\n<https:\/\/app\.example\.test\/workspaces\/[^/]+\/schedules\?sourceSessionId=[0-9a-f-]+\|Make recurring>$/u,
    );
    expect(completionPosts[0]!.text).not.toContain("Compare the logs");
    expect(completionPosts[0]!.text).not.toContain("Open in OpenGeni");
    expect(completionPosts[0]!.text).not.toContain("/sessions/");

    const [session] = await shared!.admin<
      {
        first_party_mcp_tools: string[];
        initial_message: string;
        initial_model_context: string | null;
        instructions: string | null;
        model: string;
      }[]
    >`
      select first_party_mcp_tools, initial_message, initial_model_context, instructions, model
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.first_party_mcp_tools).toEqual([...DEFAULT_FIRST_PARTY_MCP_TOOLS]);
    expect(session!.initial_model_context).toBeNull();
    expect(session!.instructions).toBe(SLACK_SESSION_INSTRUCTIONS);
    expect(session!.model).toBe("gpt-5.6-terra");
    expect(session!.initial_message).toContain("[reacted message]");
    expect(session!.initial_message).toContain("Compare the logs and propose the safest rollback.");
    expect(session!.initial_message).toContain("Deployment log");
    expect(session!.initial_message).toContain(
      "Execute a direct, safe, sufficiently specified request immediately",
    );
    expect(session!.initial_message).toContain("Ask one concise clarifying question only when");
    expect(session!.initial_message).toContain("Do not infer permission to ingest or persist");
    expect(session!.initial_message).toContain("bounded Slack context limit");
    const [persistence] = await shared!.admin<{ documents: number; memories: number }[]>`
      select
        (select count(*)::int from documents where workspace_id = ${value.owner.workspaceId}) as documents,
        (select count(*)::int from knowledge_memories where workspace_id = ${value.owner.workspaceId}) as memories`;
    expect(persistence).toEqual({ documents: 0, memories: 0 });
    const postPrincipals = await shared!.admin<{ subject_id: string }[]>`
      select subject_id
      from audit_events
      where workspace_id = ${value.owner.workspaceId}
        and action = 'slack_bot.message.post'
      order by occurred_at, id`;
    expect(new Set(postPrincipals.map((row) => row.subject_id))).toEqual(
      new Set(["service:slack-interaction"]),
    );
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
          {
            sessions: number;
            routes: number;
            inboxes: number;
            messages: number;
          }[]
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
        expect(duringBind).toEqual({
          sessions: 1,
          routes: 1,
          inboxes: 2,
          messages: 2,
        });
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
        {
          id: string;
          provider_event_id: string;
          status: string;
          attempt_count: number;
        }[]
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
        {
          id: string;
          provider_event_id: string;
          status: string;
          attempt_count: number;
        }[]
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

  test("an already-durable non-initial reaction settles after an ambiguous inbox outcome without mutable context replay", async () => {
    if (!available) return;
    const channelId = "C_REACTION_AMBIGUOUS_RETRY";
    const rootTimestamp = "1706070000.000001";
    const firstTimestamp = "1706070000.000002";
    const secondTimestamp = "1706070000.000003";
    const thirdTimestamp = "1706070000.000004";
    const firstEventId = `E_REACTION_AMBIGUOUS_A_${crypto.randomUUID()}`;
    const secondEventId = `E_REACTION_AMBIGUOUS_B_${crypto.randomUUID()}`;
    const thirdEventId = `E_REACTION_AMBIGUOUS_C_${crypto.randomUUID()}`;
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    const rootMessage = {
      ts: rootTimestamp,
      user: "U_AMBIGUOUS_ROOT",
      text: "Preserve each independent signal while this thread evolves.",
    };
    value.slack.reactionContexts.set(`${channelId}:${firstTimestamp}`, {
      messages: [
        rootMessage,
        {
          ts: firstTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Durable event A establishes the canonical session.",
        },
      ],
    });
    value.slack.reactionContexts.set(`${channelId}:${secondTimestamp}`, {
      messages: [
        rootMessage,
        {
          ts: secondTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Original durable event B task text.",
        },
      ],
    });
    value.slack.reactionContexts.set(`${channelId}:${thirdTimestamp}`, {
      messages: [
        rootMessage,
        {
          ts: secondTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Original durable event B task text.",
        },
        {
          ts: thirdTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Later durable event C changes the session tail.",
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
    const thirdEvent = reactionEvent({
      teamId: value.teamId,
      eventId: thirdEventId,
      userId: value.ownerSlackUserId,
      channelId,
      timestamp: thirdTimestamp,
    });

    expect((await postEvent(value.app, firstEvent)).status).toBe(200);
    await drainAll(value.deps);
    const [route] = await shared!.admin<
      {
        session_id: string;
        owning_subject_id: string;
        workspace_id: string;
        connection_id: string;
      }[]
    >`
      select session_id, owning_subject_id, workspace_id, connection_id
      from slack_interactions
      where workspace_id = ${value.owner.workspaceId}`;
    expect(route).toEqual({
      session_id: expect.any(String),
      owning_subject_id: value.owner.subjectId,
      workspace_id: value.owner.workspaceId,
      connection_id: value.connectionId,
    });

    expect((await postEvent(value.app, secondEvent)).status).toBe(200);
    const [secondInbox] = await shared!.admin<{ id: string }[]>`
      select id
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}
        and provider_event_id = ${secondEventId}`;
    if (!secondInbox || !/^[0-9a-f-]{36}$/.test(secondInbox.id)) {
      throw new Error("expected a valid event B inbox id");
    }
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `og_test_slack_inbox_ambiguity_${suffix}`;
    const triggerName = `og_test_slack_inbox_ambiguity_${suffix}`;
    await shared!.admin.unsafe(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if old.id = '${secondInbox.id}'::uuid
          and old.status = 'processing'
          and new.status = 'processed'
        then
          raise exception 'fixture ambiguous Slack inbox settlement';
        end if;
        return new;
      end;
      $$;
      create trigger ${triggerName}
        before update on slack_interaction_inbox
        for each row execute function ${functionName}();
    `);
    try {
      expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    } finally {
      await shared!.admin.unsafe(`
        drop trigger if exists ${triggerName} on slack_interaction_inbox;
        drop function if exists ${functionName}();
      `);
    }

    const [afterAmbiguousOutcome] = await shared!.admin<
      {
        status: string;
        attempt_count: number;
        retry_at: Date | null;
        processed_at: Date | null;
        last_error_code: string | null;
        messages: number;
      }[]
    >`
      select status, attempt_count, retry_at, processed_at, last_error_code,
        (select count(*)::int
          from session_events
          where workspace_id = ${value.owner.workspaceId}
            and session_id = ${route!.session_id}
            and client_event_id = ${`slack:${secondEventId}`}
            and type = 'user.message') as messages
      from slack_interaction_inbox
      where id = ${secondInbox.id}`;
    expect(afterAmbiguousOutcome).toMatchObject({
      status: "pending",
      attempt_count: 1,
      retry_at: expect.any(Date),
      processed_at: null,
      last_error_code: expect.any(String),
      messages: 1,
    });
    await shared!.admin`
      update slack_interaction_inbox
      set retry_at = now() + interval '1 hour'
      where id = ${secondInbox.id}`;

    expect((await postEvent(value.app, thirdEvent)).status).toBe(200);
    await drainAll(value.deps);
    const [thirdInbox] = await shared!.admin<{ status: string }[]>`
      select status
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}
        and provider_event_id = ${thirdEventId}`;
    expect(thirdInbox).toEqual({ status: "processed" });

    const secondContextKey = `${channelId}:${secondTimestamp}`;
    const secondContextHitsBeforeRetry = value.slack.reactionContextHits.filter(
      (hit) => hit === secondContextKey,
    ).length;
    expect(secondContextHitsBeforeRetry).toBe(1);
    value.slack.reactionContexts.set(secondContextKey, {
      messages: [
        {
          ...rootMessage,
          text: "Mutated root context that must not affect retry settlement.",
        },
        {
          ts: secondTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "MUTATED event B text that would change the command hash.",
        },
        {
          ts: thirdTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Later durable event C changes the session tail.",
        },
      ],
    });
    await shared!.admin`
      update slack_interaction_inbox
      set retry_at = now()
      where id = ${secondInbox.id}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(value.slack.reactionContextHits.filter((hit) => hit === secondContextKey).length).toBe(
      secondContextHitsBeforeRetry,
    );

    const [settledSecondInbox] = await shared!.admin<
      {
        status: string;
        attempt_count: number;
        processed_at: Date | null;
        last_error_code: string | null;
      }[]
    >`
      select status, attempt_count, processed_at, last_error_code
      from slack_interaction_inbox
      where id = ${secondInbox.id}`;
    expect(settledSecondInbox).toEqual({
      status: "processed",
      attempt_count: 2,
      processed_at: expect.any(Date),
      last_error_code: null,
    });
    const messages = await shared!.admin<
      {
        client_event_id: string;
        text: string;
        workspace_id: string;
        session_id: string;
      }[]
    >`
      select client_event_id, payload ->> 'text' as text, workspace_id, session_id
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${route!.session_id}
        and type = 'user.message'
      order by sequence`;
    expect(messages.map((message) => message.client_event_id)).toEqual([
      `slack:${firstEventId}`,
      `slack:${secondEventId}`,
      `slack:${thirdEventId}`,
    ]);
    expect(messages.every((message) => message.workspace_id === value.owner.workspaceId)).toBe(
      true,
    );
    expect(messages.every((message) => message.session_id === route!.session_id)).toBe(true);
    expect(messages[1]!.text).toContain("Original durable event B task text.");
    expect(messages[1]!.text).not.toContain("MUTATED event B text");
    expect(messages[2]!.text).toContain("Later durable event C changes the session tail.");

    expect((await postEvent(value.app, secondEvent)).status).toBe(200);
    const [afterExactIngressReplay] = await shared!.admin<{ inboxes: number; messages: number }[]>`
      select
        (select count(*)::int from slack_interaction_inbox
          where workspace_id = ${value.owner.workspaceId}) as inboxes,
        (select count(*)::int from session_events
          where workspace_id = ${value.owner.workspaceId}
            and session_id = ${route!.session_id}
            and type = 'user.message') as messages`;
    expect(afterExactIngressReplay).toEqual({ inboxes: 3, messages: 3 });
  }, 60_000);

  test("a reaction committed before route binding repairs the bind and acknowledgement without refetching context", async () => {
    if (!available) return;
    const channelId = "C_REACTION_UNBOUND_RETRY";
    const rootTimestamp = "1706080000.000001";
    const reactedTimestamp = "1706080000.000002";
    const eventId = `E_REACTION_UNBOUND_${crypto.randomUUID()}`;
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    const contextKey = `${channelId}:${reactedTimestamp}`;
    value.slack.reactionContexts.set(contextKey, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_UNBOUND_ROOT",
          text: "Keep the committed task recoverable across route binding.",
        },
        {
          ts: reactedTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Original task committed before the bind crash.",
        },
      ],
    });
    const event = reactionEvent({
      teamId: value.teamId,
      eventId,
      userId: value.ownerSlackUserId,
      channelId,
      timestamp: reactedTimestamp,
    });
    expect((await postEvent(value.app, event)).status).toBe(200);

    const suffix = crypto.randomUUID().replaceAll("-", "");
    const functionName = `og_test_slack_bind_ambiguity_${suffix}`;
    const triggerName = `og_test_slack_bind_ambiguity_${suffix}`;
    await shared!.admin.unsafe(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if old.workspace_id = '${value.owner.workspaceId}'::uuid
          and old.session_id is null
          and new.session_id is not null
        then
          raise exception 'fixture ambiguous Slack route bind';
        end if;
        return new;
      end;
      $$;
      create trigger ${triggerName}
        before update on slack_interactions
        for each row execute function ${functionName}();
    `);
    try {
      expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    } finally {
      await shared!.admin.unsafe(`
        drop trigger if exists ${triggerName} on slack_interactions;
        drop function if exists ${functionName}();
      `);
    }

    const [afterBindFailure] = await shared!.admin<
      {
        interaction_id: string;
        session_reservation_id: string;
        session_id: string | null;
        inbox_id: string;
        inbox_status: string;
        message_text: string;
        message_count: number;
      }[]
    >`
      select interaction.id as interaction_id,
        interaction.session_reservation_id,
        interaction.session_id,
        inbox.id as inbox_id,
        inbox.status as inbox_status,
        max(event.payload ->> 'text') as message_text,
        count(event.id)::int as message_count
      from slack_interactions interaction
      join slack_interaction_inbox inbox
        on inbox.workspace_id = interaction.workspace_id
        and inbox.connection_id = interaction.connection_id
        and inbox.provider_event_id = ${eventId}
      join session_events event
        on event.workspace_id = interaction.workspace_id
        and event.session_id = interaction.session_reservation_id
        and event.client_event_id = ${`slack:${eventId}`}
        and event.type = 'user.message'
      where interaction.workspace_id = ${value.owner.workspaceId}
      group by interaction.id, interaction.session_reservation_id,
        interaction.session_id, inbox.id, inbox.status`;
    if (!afterBindFailure) throw new Error("expected the unbound durable Slack reaction");
    const interactionId = afterBindFailure.interaction_id;
    const sessionReservationId = afterBindFailure.session_reservation_id;
    const inboxId = afterBindFailure.inbox_id;
    expect(afterBindFailure).toMatchObject({
      interaction_id: expect.any(String),
      session_reservation_id: expect.any(String),
      session_id: null,
      inbox_id: expect.any(String),
      inbox_status: "pending",
      message_text: expect.stringContaining("Original task committed before the bind crash."),
      message_count: 1,
    });
    expect(value.slack.posts).toHaveLength(0);
    const contextHitsBeforeRetry = value.slack.reactionContextHits.filter(
      (hit) => hit === contextKey,
    ).length;
    expect(contextHitsBeforeRetry).toBe(1);
    value.slack.reactionContexts.set(contextKey, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_UNBOUND_ROOT",
          text: "MUTATED root that the repair must not fetch.",
        },
        {
          ts: reactedTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "MUTATED task text that the repair must not recompute.",
        },
      ],
    });
    await shared!.admin`
      update slack_interaction_inbox
      set retry_at = now()
      where id = ${inboxId}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);

    const [repaired] = await shared!.admin<
      {
        session_reservation_id: string;
        session_id: string | null;
        inbox_status: string;
        message_text: string;
        message_count: number;
      }[]
    >`
      select interaction.session_reservation_id,
        interaction.session_id,
        inbox.status as inbox_status,
        max(event.payload ->> 'text') as message_text,
        count(event.id)::int as message_count
      from slack_interactions interaction
      join slack_interaction_inbox inbox
        on inbox.workspace_id = interaction.workspace_id
        and inbox.connection_id = interaction.connection_id
        and inbox.provider_event_id = ${eventId}
      join session_events event
        on event.workspace_id = interaction.workspace_id
        and event.session_id = interaction.session_reservation_id
        and event.client_event_id = ${`slack:${eventId}`}
        and event.type = 'user.message'
      where interaction.id = ${interactionId}
      group by interaction.session_reservation_id, interaction.session_id, inbox.status`;
    const repairedMessageText = repaired?.message_text;
    expect(repaired).toMatchObject({
      session_reservation_id: sessionReservationId,
      session_id: sessionReservationId,
      inbox_status: "processed",
      message_text: expect.stringContaining("Original task committed before the bind crash."),
      message_count: 1,
    });
    expect(repairedMessageText).not.toContain("MUTATED task text");
    expect(value.slack.reactionContextHits.filter((hit) => hit === contextKey)).toHaveLength(
      contextHitsBeforeRetry,
    );
    expect(value.slack.posts).toHaveLength(1);

    await shared!.admin`
      update slack_interaction_inbox
      set status = 'pending', claim_holder_id = null, claim_expires_at = null,
        retry_at = now(), last_error_code = 'forced_retry', processed_at = null,
        updated_at = now()
      where id = ${inboxId}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(value.slack.reactionContextHits.filter((hit) => hit === contextKey)).toHaveLength(
      contextHitsBeforeRetry,
    );
    expect(value.slack.posts).toHaveLength(1);
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
    expect(value.slack.posts[0]!.text).toMatch(
      /<https:\/\/app\.example\.test\/workspaces\/[^|]+\|Open in OpenGeni>/u,
    );
    expect(value.slack.posts[0]!.text.match(/Open in OpenGeni/gu) ?? []).toHaveLength(1);
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

  test("imports only exact reacted-message images in Slack order with refs-only durable history", async () => {
    if (!available) return;
    const channelId = "C_REACTION_IMAGES";
    const rootTimestamp = "1706050000.000001";
    const reactedTimestamp = "1706050000.000002";
    const value = await fixture({
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: [channelId] },
      },
    });
    const objectStore = reactionObjectStorage();
    Reflect.set(value.deps, "objectStorage", objectStore.storage);
    value.slack.privateFiles.set("F_REPLY_PNG", {
      channelId,
      filename: "reply-chart.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    value.slack.privateFiles.set("F_REPLY_WEBP", {
      channelId,
      filename: "reply-photo.webp",
      contentType: "image/webp",
      bytes: fixtureWebp(),
    });
    value.slack.privateFiles.set("F_PARENT", {
      channelId,
      filename: "parent-only.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    value.slack.reactionContexts.set(`${channelId}:${reactedTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: "U_THREAD_ROOT",
          text: "Parent context only.",
          files: [{ id: "F_PARENT", name: "parent-only.png", title: "Parent only" }],
        },
        {
          ts: reactedTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Compare these two images directly.",
          files: [
            { id: "F_REPLY_PNG", name: "reply-chart.png", title: "Reply chart" },
            { id: "F_REPLY_WEBP", name: "reply-photo.webp", title: "Reply photo" },
            { id: "F_REPLY_TEXT", name: "notes.txt", title: "Unsupported notes" },
          ],
        },
      ],
    });

    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_IMAGES_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: reactedTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const [route] = await interactions(value.owner.workspaceId);
    const [session] = await shared!.admin<
      {
        resources: Array<{ kind: string; fileId: string; mountPath: string }>;
        initial_message: string;
      }[]
    >`
      select resources, initial_message
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.resources.map((resource) => resource.mountPath)).toEqual([
      "attachments/slack/01-reply-chart.png",
      "attachments/slack/02-reply-photo.webp",
    ]);
    expect(session!.initial_message).toContain("Imported reacted-message attachments");
    expect(session!.initial_message).toContain("Some reacted-message attachments were omitted");
    expect(session!.initial_message).not.toContain("parent-only.png");
    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(3);
    expect(objectStore.objects.size).toBe(2);
    const [acceptedEvent] = await shared!.admin<{ payload: Record<string, unknown> }[]>`
      select payload
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${route!.session_id}
        and type = 'user.message'
      order by sequence
      limit 1`;
    expect(acceptedEvent!.payload.resources).toEqual(session!.resources);
    const durable = JSON.stringify({ session, acceptedEvent });
    expect(durable).not.toContain("files.slack.com");
    expect(durable).not.toContain(Buffer.from(fixturePng()).toString("base64"));
    expect(durable).not.toContain("slack-reactions/");

    const followupTimestamp = "1706050000.000003";
    value.slack.privateFiles.set("F_FOLLOWUP", {
      channelId,
      filename: "followup.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    value.slack.reactionContexts.set(`${channelId}:${followupTimestamp}`, {
      messages: [
        { ts: rootTimestamp, user: "U_THREAD_ROOT", text: "Parent context only." },
        {
          ts: followupTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Also inspect this follow-up image.",
          files: [{ id: "F_FOLLOWUP", name: "followup.png", title: "Follow-up" }],
        },
      ],
    });
    expect(
      (
        await postEvent(
          value.app,
          reactionEvent({
            teamId: value.teamId,
            eventId: `E_REACTION_IMAGES_FOLLOWUP_${crypto.randomUUID()}`,
            userId: value.ownerSlackUserId,
            channelId,
            timestamp: followupTimestamp,
          }),
        )
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    const acceptedEvents = await shared!.admin<{ payload: Record<string, unknown> }[]>`
      select payload
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${route!.session_id}
        and type = 'user.message'
      order by sequence`;
    expect(acceptedEvents).toHaveLength(2);
    expect(
      (acceptedEvents[1]!.payload.resources as Array<{ mountPath: string }>).map(
        (resource) => resource.mountPath,
      ),
    ).toEqual(["attachments/slack/03-followup.png"]);
    expect(acceptedEvents[1]!.payload.text).toContain("attachments/slack/03-followup.png");
    expect(acceptedEvents[1]!.payload.text).not.toContain("attachments/slack/01-followup.png");
    expect(objectStore.objects.size).toBe(3);
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
    const rootTimestamp = "1720000000.000001";
    const mentionTimestamp = "1720000000.000002";
    value.slack.reactionContexts.set(`C_TEAM:${rootTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Do we support Google Drive integration in OpenGeni currently?",
        },
        {
          ts: mentionTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: `<@${value.botUserId}> Can check this out?`,
        },
      ],
    });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_MENTION_${crypto.randomUUID()}`,
          event: {
            type: "message",
            user: value.ownerSlackUserId,
            channel: "C_TEAM",
            ts: mentionTimestamp,
            thread_ts: rootTimestamp,
            text: `<@${value.botUserId}> Can check this out?`,
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
    const [initialMessage] = await shared!.admin<{ text: string; model_context: string | null }[]>`
      select
        event.payload ->> 'text' as text,
        event.payload ->> 'modelContext' as model_context
      from session_events event
      where event.workspace_id = ${value.owner.workspaceId}
        and event.session_id = ${route!.session_id}
        and event.type = 'user.message'
      order by event.sequence asc
      limit 1`;
    expect(initialMessage!.text).toBe(`<@${value.botUserId}> Can check this out?`);
    expect(initialMessage!.model_context).toContain(
      "Do we support Google Drive integration in OpenGeni currently?",
    );
    expect(initialMessage!.model_context).not.toContain("Can check this out?");

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

  test("top-level mentions receive bounded preceding channel context", async () => {
    if (!available) return;
    const value = await fixture();
    const mentionTimestamp = "1721000000.000002";
    value.slack.channelHistories.set("C_TEAM", {
      messages: [
        {
          ts: mentionTimestamp,
          user: value.ownerSlackUserId,
          text: `<@${value.botUserId}> Can you answer this question?`,
        },
        {
          ts: "1721000000.000001",
          user: value.ownerSlackUserId,
          text: "What deployment is currently running in production?",
        },
      ],
    });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_TOP_LEVEL_CONTEXT_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: value.ownerSlackUserId,
            channel: "C_TEAM",
            ts: mentionTimestamp,
            text: `<@${value.botUserId}> Can you answer this question?`,
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const [initialMessage] = await shared!.admin<{ text: string; model_context: string | null }[]>`
      select
        event.payload ->> 'text' as text,
        event.payload ->> 'modelContext' as model_context
      from session_events event
      join slack_interactions interaction
        on interaction.workspace_id = event.workspace_id
        and interaction.session_id = event.session_id
      where event.workspace_id = ${value.owner.workspaceId}
        and event.type = 'user.message'
      order by event.sequence asc
      limit 1`;
    expect(initialMessage!.text).toBe(`<@${value.botUserId}> Can you answer this question?`);
    expect(initialMessage!.model_context).toContain(
      "What deployment is currently running in production?",
    );
    expect(initialMessage!.model_context).not.toContain("Can you answer this question?");
    expect(initialMessage!.model_context).toContain("exact accepted Slack invocation");
    expect(value.slack.calls).toContainEqual(
      expect.objectContaining({
        method: "conversations.history",
        channel: "C_TEAM",
        latest: mentionTimestamp,
        inclusive: "true",
      }),
    );
  });

  test("file-only Slack mentions import the exact authorized image once", async () => {
    if (!available) return;
    const value = await fixture();
    const channelId = "C_FILE_ONLY";
    const messageTimestamp = "1722000000.000001";
    const eventId = `E_FILE_ONLY_${crypto.randomUUID()}`;
    const objectStore = reactionObjectStorage();
    Reflect.set(value.deps, "objectStorage", objectStore.storage);
    value.slack.privateFiles.set("F_FILE_ONLY", {
      channelId,
      filename: "incident.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    value.slack.channelHistories.set(channelId, {
      messages: [
        {
          ts: messageTimestamp,
          user: value.ownerSlackUserId,
          text: "",
          files: [{ id: "F_FILE_ONLY", name: "incident.png", title: "Incident" }],
        },
      ],
    });
    const event = {
      teamId: value.teamId,
      eventId,
      event: {
        type: "app_mention",
        user: value.ownerSlackUserId,
        channel: channelId,
        ts: messageTimestamp,
        files: [{ id: "F_FILE_ONLY", name: "incident.png", title: "Incident" }],
      },
    };
    expect((await postEvent(value.app, event)).status).toBe(200);
    expect((await postEvent(value.app, event)).status).toBe(200);
    await drainAll(value.deps);

    const [route] = await interactions(value.owner.workspaceId);
    const [session] = await shared!.admin<
      {
        resources: Array<{ kind: string; mountPath: string }>;
        initial_message: string;
        initial_model_context: string | null;
      }[]
    >`
      select resources, initial_message, initial_model_context
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(session!.resources.map((resource) => resource.mountPath)).toEqual([
      "attachments/slack/01-incident.png",
    ]);
    expect(session!.initial_message).toBe("(file-only Slack invocation)");
    expect(session!.initial_model_context).toContain("Imported invocation attachments");
    expect(session!.initial_model_context).toContain("attachments/slack/01-incident.png");
    expect(objectStore.objects.size).toBe(1);
    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(1);
  });

  test("file-only Slack DMs import the exact authorized image", async () => {
    if (!available) return;
    const value = await fixture();
    const channelId = "D_FILE_ONLY";
    const messageTimestamp = "1722000000.000002";
    const objectStore = reactionObjectStorage();
    Reflect.set(value.deps, "objectStorage", objectStore.storage);
    value.slack.privateFiles.set("F_DM_FILE_ONLY", {
      channelId,
      filename: "private-incident.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    value.slack.channelHistories.set(channelId, {
      messages: [
        {
          ts: messageTimestamp,
          user: value.ownerSlackUserId,
          text: "",
          files: [
            {
              id: "F_DM_FILE_ONLY",
              name: "private-incident.png",
              title: "Private incident",
            },
          ],
        },
      ],
    });
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_DM_FILE_ONLY_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.ownerSlackUserId,
            channel: channelId,
            ts: messageTimestamp,
            files: [
              {
                id: "F_DM_FILE_ONLY",
                name: "private-incident.png",
                title: "Private incident",
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const [route] = await interactions(value.owner.workspaceId);
    const [session] = await shared!.admin<
      {
        resources: Array<{ kind: string; mountPath: string }>;
        initial_message: string;
        initial_model_context: string | null;
      }[]
    >`
      select resources, initial_message, initial_model_context
      from sessions
      where workspace_id = ${value.owner.workspaceId}
        and id = ${route!.session_id}`;
    expect(route).toMatchObject({ visibility: "private" });
    expect(session!.resources.map((resource) => resource.mountPath)).toEqual([
      "attachments/slack/01-private-incident.png",
    ]);
    expect(session!.initial_message).toBe("(file-only Slack invocation)");
    expect(session!.initial_model_context).toContain("Imported invocation attachments");
    expect(session!.initial_model_context).toContain("attachments/slack/01-private-incident.png");
    expect(objectStore.objects.size).toBe(1);
    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(1);
  });

  test("mixed Slack DMs and existing-thread replies import only their exact images", async () => {
    if (!available) return;
    const value = await fixture();
    const channelId = "D_MIXED_FILES";
    const rootTimestamp = "1722000000.000010";
    const replyTimestamp = "1722000000.000011";
    const rootEventId = `E_DM_MIXED_${crypto.randomUUID()}`;
    const replyEventId = `E_REPLY_MIXED_${crypto.randomUUID()}`;
    const objectStore = reactionObjectStorage();
    Reflect.set(value.deps, "objectStorage", objectStore.storage);
    value.slack.privateFiles.set("F_DM_MIXED", {
      channelId,
      filename: "initial-context.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    value.slack.privateFiles.set("F_REPLY_MIXED", {
      channelId,
      filename: "follow-up-context.webp",
      contentType: "image/webp",
      bytes: fixtureWebp(),
    });
    value.slack.channelHistories.set(channelId, {
      messages: [
        {
          ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Inspect the initial screenshot",
          files: [{ id: "F_DM_MIXED", name: "initial-context.png", title: "Initial context" }],
        },
      ],
    });
    const rootEvent = {
      teamId: value.teamId,
      eventId: rootEventId,
      event: {
        type: "message",
        channel_type: "im",
        user: value.ownerSlackUserId,
        channel: channelId,
        ts: rootTimestamp,
        text: "Inspect the initial screenshot",
        files: [{ id: "F_DM_MIXED", name: "initial-context.png", title: "Initial context" }],
      },
    };
    expect((await postEvent(value.app, rootEvent)).status).toBe(200);
    await drainAll(value.deps);

    value.slack.reactionContexts.set(`${channelId}:${rootTimestamp}`, {
      messages: [
        {
          ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Inspect the initial screenshot",
          files: [{ id: "F_DM_MIXED", name: "initial-context.png", title: "Initial context" }],
        },
        {
          ts: replyTimestamp,
          thread_ts: rootTimestamp,
          user: value.ownerSlackUserId,
          text: "Compare it with this follow-up",
          files: [
            {
              id: "F_REPLY_MIXED",
              name: "follow-up-context.webp",
              title: "Follow-up context",
            },
          ],
        },
      ],
    });
    const replyEvent = {
      teamId: value.teamId,
      eventId: replyEventId,
      event: {
        type: "message",
        user: value.ownerSlackUserId,
        channel: channelId,
        ts: replyTimestamp,
        thread_ts: rootTimestamp,
        text: "Compare it with this follow-up",
        files: [
          {
            id: "F_REPLY_MIXED",
            name: "follow-up-context.webp",
            title: "Follow-up context",
          },
        ],
      },
    };
    expect((await postEvent(value.app, replyEvent)).status).toBe(200);
    expect((await postEvent(value.app, replyEvent)).status).toBe(200);
    await drainAll(value.deps);

    const [route] = await interactions(value.owner.workspaceId);
    const messages = await shared!.admin<
      {
        text: string;
        model_context: string | null;
        resources: Array<{ mountPath: string }>;
      }[]
    >`
      select
        payload ->> 'text' as text,
        payload ->> 'modelContext' as model_context,
        payload -> 'resources' as resources
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${route!.session_id}
        and type = 'user.message'
      order by sequence`;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.resources.map((resource) => resource.mountPath)).toEqual([
      "attachments/slack/01-initial-context.png",
    ]);
    expect(messages[1]!.resources.map((resource) => resource.mountPath)).toEqual([
      "attachments/slack/02-follow-up-context.webp",
    ]);
    expect(messages[0]!.text).toBe("Inspect the initial screenshot");
    expect(messages[0]!.model_context).toContain("attachments/slack/01-initial-context.png");
    expect(messages[1]!.text).toBe("Compare it with this follow-up");
    expect(messages[1]!.model_context).toContain("attachments/slack/02-follow-up-context.webp");
    expect(messages[1]!.model_context).not.toContain("initial-context.png");
    expect(objectStore.objects.size).toBe(2);
    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(2);
  });

  test("requester-bound native controls update the exact Slack message and settle sibling handles", async () => {
    if (!available) return;
    const value = await fixture();
    const channelId = "D_NATIVE_ACTION";
    const rootTimestamp = "1760000000.000001";
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_NATIVE_ACTION_${crypto.randomUUID()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: value.ownerSlackUserId,
            channel: channelId,
            ts: rootTimestamp,
            text: "Start a task with native Slack controls",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);

    const acknowledgement = value.slack.posts.at(-1)!;
    expect(acknowledgement.blocks).not.toBeNull();
    const [statusHandle] = await shared!.admin<{ id: string }[]>`
      select id
      from slack_interaction_action_handles
      where workspace_id = ${value.owner.workspaceId}
        and action_kind = 'session_status'
        and status = 'pending'`;
    expect(statusHandle?.id).toBeTruthy();

    const payload = JSON.stringify({
      type: "block_actions",
      team: { id: value.teamId },
      user: { id: value.ownerSlackUserId },
      channel: { id: channelId },
      message: { ts: acknowledgement.timestamp, thread_ts: rootTimestamp },
      actions: [
        {
          action_id: "opengeni.session.status",
          action_ts: "1760000000.000002",
          value: statusHandle!.id,
        },
      ],
    });
    const response = await value.app.request(
      signedRequest(
        "/v1/integrations/slack/interactions",
        new URLSearchParams({ payload }).toString(),
        "application/x-www-form-urlencoded",
      ),
    );
    expect(response.status).toBe(200);
    await drainAll(value.deps);

    expect(acknowledgement.text).toContain("OpenGeni task status:");
    expect(value.slack.posts).toHaveLength(2);
    expect(value.slack.posts[1]).toMatchObject({
      channel: channelId,
      threadTimestamp: rootTimestamp,
      text: expect.stringContaining("OpenGeni task controls"),
    });
    const handles = await shared!.admin<
      { action_kind: string; status: string; result: string | null }[]
    >`
      select action_kind, status, result
      from slack_interaction_action_handles
      where workspace_id = ${value.owner.workspaceId}
        and message_operation_id = (
          select message_operation_id
          from slack_interaction_action_handles
          where id = ${statusHandle!.id}::uuid
        )
      order by action_kind`;
    expect(handles).toEqual([
      { action_kind: "session_pause", status: "stale", result: "superseded" },
      { action_kind: "session_status", status: "completed", result: "status" },
    ]);
  }, 60_000);

  test("slash commands and explicit message shortcuts each create one durable session surface", async () => {
    if (!available) return;
    const configuredCommand = "/opengeni-staging";
    const value = await fixture({ slackCommand: configuredCommand });
    const command = new URLSearchParams({
      command: configuredCommand,
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
      channel: { id: "C_SHORTCUT" },
      message: {
        ts: "1725000000.000001",
        text: "Explicitly send this channel message to OpenGeni",
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
          route_key: "C_SHORTCUT:1725000000.000001",
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
      command: configuredCommand,
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
        command: configuredCommand,
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

  test("human-DM shortcuts stay owner-private and continue in the invoking user's bot DM", async () => {
    if (!available) return;
    const sourceDm = "D_HUMAN_TO_HUMAN";
    const value = await fixture({
      deniedChannels: [sourceDm],
      linkOther: true,
    });
    const shortcut = async (slackUserId: string, triggerId: string) => {
      const payload = JSON.stringify({
        type: "message_action",
        trigger_id: triggerId,
        team: { id: value.teamId },
        user: { id: slackUserId },
        channel: { id: sourceDm },
        message: {
          ts: "1725000000.000001",
          text: "Explicitly send this human DM message to OpenGeni",
        },
      });
      return await value.app.request(
        signedRequest(
          "/v1/integrations/slack/interactions",
          new URLSearchParams({ payload }).toString(),
          "application/x-www-form-urlencoded",
        ),
      );
    };

    const ownerTriggerId = `shortcut-owner-${crypto.randomUUID()}`;
    expect((await shortcut(value.ownerSlackUserId, ownerTriggerId)).status).toBe(200);
    await drainAll(value.deps);

    const ownerAck = value.slack.posts.at(-1)!;
    expect(ownerAck).toMatchObject({
      channel: `D_${value.ownerSlackUserId}`,
      threadTimestamp: null,
    });
    expect(ownerAck.text).toContain("started a private task from the selected DM message");
    expect(ownerAck.text).toContain("source DM was not opened to the bot");
    expect(
      value.slack.calls.some(
        (call) => call.method === "conversations.info" && call.channel === sourceDm,
      ),
    ).toBe(false);

    let routes = await interactions(value.owner.workspaceId);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      route_key: `${ownerAck.channel}:${ownerAck.timestamp}`,
      slack_thread_ts: ownerAck.timestamp,
      visibility: "private",
    });

    // Reclaiming the exact durable event after acknowledgement reuses the same
    // session and post operation rather than recreating work after a crash.
    await shared!.admin`
      update slack_interaction_inbox
      set status = 'pending',
          claim_holder_id = null,
          claim_expires_at = null,
          retry_at = null,
          processed_at = null,
          updated_at = now()
      where workspace_id = ${value.owner.workspaceId}
        and provider_event_id = ${`shortcut:${ownerTriggerId}`}`;
    await drainAll(value.deps);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(1);
    expect(value.slack.posts).toHaveLength(1);

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_SHORTCUT_BOT_DM_REPLY_${crypto.randomUUID()}`,
          event: {
            type: "message",
            user: value.ownerSlackUserId,
            channel: ownerAck.channel,
            ts: "1725000000.000003",
            thread_ts: ownerAck.timestamp,
            text: "Continue the private shortcut task",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    const [ownerMessages] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${routes[0]!.session_id}
        and type = 'user.message'`;
    expect(ownerMessages!.count).toBe(2);

    // The same human-to-human DM may contain multiple linked workspace users.
    // Each explicit invocation receives a distinct private bot-DM route.
    expect(
      (await shortcut(value.otherSlackUserId, `shortcut-other-${crypto.randomUUID()}`)).status,
    ).toBe(200);
    await drainAll(value.deps);
    routes = await interactions(value.owner.workspaceId);
    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.visibility === "private")).toBe(true);
    expect(new Set(routes.map((route) => route.session_id)).size).toBe(2);
    expect(new Set(routes.map((route) => route.route_key)).size).toBe(2);
    expect(value.slack.posts.at(-1)?.channel).toBe(`D_${value.otherSlackUserId}`);

    const [persistence] = await shared!.admin<{ documents: number; memories: number }[]>`
      select
        (select count(*)::int from documents where workspace_id = ${value.owner.workspaceId}) as documents,
        (select count(*)::int from knowledge_memories where workspace_id = ${value.owner.workspaceId}) as memories`;
    expect(persistence).toEqual({ documents: 0, memories: 0 });
  });

  test("a reused human-DM shortcut route repairs a later durable session after bind failure", async () => {
    if (!available) return;
    const sourceDm = "D_REUSED_HUMAN_TO_HUMAN";
    const value = await fixture({
      deniedChannels: [sourceDm],
      linkOther: true,
    });
    const shortcut = async (triggerId: string) => {
      const payload = JSON.stringify({
        type: "message_action",
        trigger_id: triggerId,
        team: { id: value.teamId },
        user: { id: value.ownerSlackUserId },
        channel: { id: sourceDm },
        message: {
          ts: "1726000000.000001",
          text: "Recover this explicitly selected human DM message",
        },
      });
      return await value.app.request(
        signedRequest(
          "/v1/integrations/slack/interactions",
          new URLSearchParams({ payload }).toString(),
          "application/x-www-form-urlencoded",
        ),
      );
    };

    const firstTriggerId = `shortcut-failed-${crypto.randomUUID()}`;
    expect((await shortcut(firstTriggerId)).status).toBe(200);
    const firstFailureSuffix = crypto.randomUUID().replaceAll("-", "");
    const firstFailureFunction = `og_test_slack_first_session_failure_${firstFailureSuffix}`;
    const firstFailureTrigger = `og_test_slack_first_session_failure_${firstFailureSuffix}`;
    await shared!.admin.unsafe(`
      create function ${firstFailureFunction}() returns trigger language plpgsql as $$
      begin
        if new.workspace_id = '${value.owner.workspaceId}'::uuid then
          raise exception 'fixture first Slack shortcut session failure';
        end if;
        return new;
      end;
      $$;
      create trigger ${firstFailureTrigger}
        before insert on sessions
        for each row execute function ${firstFailureFunction}();
    `);
    try {
      expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    } finally {
      await shared!.admin.unsafe(`
        drop trigger if exists ${firstFailureTrigger} on sessions;
        drop function if exists ${firstFailureFunction}();
      `);
    }

    const [failedCreator] = await shared!.admin<
      {
        interaction_id: string;
        session_reservation_id: string;
        session_id: string | null;
        triggering_provider_event_id: string;
        inbox_id: string;
        inbox_status: string;
      }[]
    >`
      select interaction.id as interaction_id,
        interaction.session_reservation_id,
        interaction.session_id,
        interaction.triggering_provider_event_id,
        inbox.id as inbox_id,
        inbox.status as inbox_status
      from slack_interactions interaction
      join slack_interaction_inbox inbox
        on inbox.workspace_id = interaction.workspace_id
        and inbox.connection_id = interaction.connection_id
        and inbox.provider_event_id = ${`shortcut:${firstTriggerId}`}
      where interaction.workspace_id = ${value.owner.workspaceId}`;
    if (!failedCreator) throw new Error("expected the failed shortcut creator route");
    const interactionId = failedCreator.interaction_id;
    const sessionReservationId = failedCreator.session_reservation_id;
    const firstInboxId = failedCreator.inbox_id;
    expect(typeof interactionId).toBe("string");
    expect(typeof sessionReservationId).toBe("string");
    expect(typeof firstInboxId).toBe("string");
    expect(failedCreator).toEqual({
      interaction_id: interactionId,
      session_reservation_id: sessionReservationId,
      session_id: null,
      triggering_provider_event_id: `shortcut:${firstTriggerId}`,
      inbox_id: firstInboxId,
      inbox_status: "pending",
    });
    expect(value.slack.posts).toHaveLength(0);
    await shared!.admin`
      update slack_interaction_inbox
      set status = 'failed', claim_holder_id = null, claim_expires_at = null,
        retry_at = null, last_error_code = 'fixture_failed_creator',
        processed_at = now(), updated_at = now()
      where id = ${firstInboxId}`;

    const secondTriggerId = `shortcut-success-${crypto.randomUUID()}`;
    expect((await shortcut(secondTriggerId)).status).toBe(200);
    const bindFailureSuffix = crypto.randomUUID().replaceAll("-", "");
    const bindFailureFunction = `og_test_slack_reused_bind_failure_${bindFailureSuffix}`;
    const bindFailureTrigger = `og_test_slack_reused_bind_failure_${bindFailureSuffix}`;
    await shared!.admin.unsafe(`
      create function ${bindFailureFunction}() returns trigger language plpgsql as $$
      begin
        if old.workspace_id = '${value.owner.workspaceId}'::uuid
          and old.session_id is null
          and new.session_id is not null
        then
          raise exception 'fixture reused Slack shortcut bind failure';
        end if;
        return new;
      end;
      $$;
      create trigger ${bindFailureTrigger}
        before update on slack_interactions
        for each row execute function ${bindFailureFunction}();
    `);
    try {
      expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    } finally {
      await shared!.admin.unsafe(`
        drop trigger if exists ${bindFailureTrigger} on slack_interactions;
        drop function if exists ${bindFailureFunction}();
      `);
    }

    const [afterBindFailure] = await shared!.admin<
      {
        interaction_id: string;
        session_reservation_id: string;
        session_id: string | null;
        triggering_provider_event_id: string;
        inbox_id: string;
        inbox_status: string;
        session_count: number;
        message_count: number;
      }[]
    >`
      select interaction.id as interaction_id,
        interaction.session_reservation_id,
        interaction.session_id,
        interaction.triggering_provider_event_id,
        inbox.id as inbox_id,
        inbox.status as inbox_status,
        (select count(*)::int from sessions
          where workspace_id = ${value.owner.workspaceId}) as session_count,
        (select count(*)::int from session_events
          where workspace_id = ${value.owner.workspaceId}
            and session_id = interaction.session_reservation_id
            and client_event_id = ${`slack:shortcut:${secondTriggerId}`}
            and type = 'user.message') as message_count
      from slack_interactions interaction
      join slack_interaction_inbox inbox
        on inbox.workspace_id = interaction.workspace_id
        and inbox.connection_id = interaction.connection_id
        and inbox.provider_event_id = ${`shortcut:${secondTriggerId}`}
      where interaction.id = ${interactionId}`;
    if (!afterBindFailure) throw new Error("expected the durable unbound shortcut session");
    const secondInboxId = afterBindFailure.inbox_id;
    expect(typeof secondInboxId).toBe("string");
    expect(afterBindFailure).toEqual({
      interaction_id: interactionId,
      session_reservation_id: sessionReservationId,
      session_id: null,
      triggering_provider_event_id: `shortcut:${firstTriggerId}`,
      inbox_id: secondInboxId,
      inbox_status: "pending",
      session_count: 1,
      message_count: 1,
    });
    expect(value.slack.posts).toHaveLength(0);

    // Model a route stranded by the pre-gate race: a second pump delivered to
    // the source human DM, classified channel_not_found as permanent, and
    // closed delivery before the durable shortcut replay could acknowledge and
    // rekey it. Rekey must repair this exact pre-ack failure atomically.
    await shared!.admin`
      update slack_interactions
      set terminal_delivery_state = 'failed', delivery_attempt_count = 1,
        delivery_last_error_code = 'channel_not_found', updated_at = now()
      where id = ${interactionId}`;
    await shared!.admin`
      update slack_interaction_inbox
      set retry_at = now()
      where id = ${secondInboxId}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);

    const [repaired] = await shared!.admin<
      {
        session_reservation_id: string;
        session_id: string | null;
        triggering_provider_event_id: string;
        route_key: string;
        slack_channel_id: string;
        slack_thread_ts: string;
        ack_slack_message_ts: string;
        visibility: string;
        terminal_delivery_state: string;
        delivery_attempt_count: number;
        delivery_last_error_code: string | null;
        inbox_status: string;
        session_count: number;
        message_count: number;
      }[]
    >`
      select interaction.session_reservation_id,
        interaction.session_id,
        interaction.triggering_provider_event_id,
        interaction.route_key,
        interaction.slack_channel_id,
        interaction.slack_thread_ts,
        interaction.ack_slack_message_ts,
        interaction.visibility,
        interaction.terminal_delivery_state,
        interaction.delivery_attempt_count,
        interaction.delivery_last_error_code,
        inbox.status as inbox_status,
        (select count(*)::int from sessions
          where workspace_id = ${value.owner.workspaceId}) as session_count,
        (select count(*)::int from session_events
          where workspace_id = ${value.owner.workspaceId}
            and session_id = interaction.session_reservation_id
            and client_event_id = ${`slack:shortcut:${secondTriggerId}`}
            and type = 'user.message') as message_count
      from slack_interactions interaction
      join slack_interaction_inbox inbox
        on inbox.workspace_id = interaction.workspace_id
        and inbox.connection_id = interaction.connection_id
        and inbox.provider_event_id = ${`shortcut:${secondTriggerId}`}
      where interaction.id = ${interactionId}`;
    if (!repaired) throw new Error("expected the repaired private shortcut route");
    const acknowledgement = value.slack.posts[0]!;
    expect(acknowledgement).toMatchObject({
      channel: `D_${value.ownerSlackUserId}`,
      threadTimestamp: null,
    });
    expect(repaired).toMatchObject({
      session_reservation_id: sessionReservationId,
      session_id: sessionReservationId,
      triggering_provider_event_id: `shortcut:${firstTriggerId}`,
      route_key: `${acknowledgement.channel}:${acknowledgement.timestamp}`,
      slack_channel_id: acknowledgement.channel,
      slack_thread_ts: acknowledgement.timestamp,
      ack_slack_message_ts: acknowledgement.timestamp,
      visibility: "private",
      terminal_delivery_state: "open",
      delivery_attempt_count: 0,
      delivery_last_error_code: null,
      inbox_status: "processed",
      session_count: 1,
      message_count: 1,
    });
    expect(value.slack.posts).toHaveLength(1);
    expect(
      value.slack.calls.some(
        (call) => call.method === "conversations.info" && call.channel === sourceDm,
      ),
    ).toBe(false);

    await shared!.admin`
      update slack_interaction_inbox
      set status = 'pending', claim_holder_id = null, claim_expires_at = null,
        retry_at = now(), last_error_code = 'forced_retry', processed_at = null,
        updated_at = now()
      where id = ${secondInboxId}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(value.slack.posts).toHaveLength(1);
    const [afterReplay] = await shared!.admin<{ sessions: number; messages: number }[]>`
      select
        (select count(*)::int from sessions
          where workspace_id = ${value.owner.workspaceId}) as sessions,
        (select count(*)::int from session_events
          where workspace_id = ${value.owner.workspaceId}
            and session_id = ${sessionReservationId}
            and type = 'user.message') as messages`;
    expect(afterReplay).toEqual({ sessions: 1, messages: 1 });

    expect(
      await getSessionForSubject(
        client.db,
        value.owner.workspaceId,
        sessionReservationId,
        value.owner.subjectId,
      ),
    ).not.toBeNull();
    expect(
      await getSessionForSubject(
        client.db,
        value.owner.workspaceId,
        sessionReservationId,
        value.otherSubjectId,
      ),
    ).toBeNull();

    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_REUSED_SHORTCUT_REPLY_${crypto.randomUUID()}`,
          event: {
            type: "message",
            user: value.ownerSlackUserId,
            channel: acknowledgement.channel,
            ts: "1726000000.000003",
            thread_ts: acknowledgement.timestamp,
            text: "Continue only in the private bot-DM route",
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(value.deps);
    const [afterContinuation] = await shared!.admin<{ messages: number }[]>`
      select count(*)::int as messages
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${sessionReservationId}
        and type = 'user.message'`;
    expect(afterContinuation).toEqual({ messages: 2 });
  }, 60_000);

  test("private human-DM shortcut delivery waits for durable bot-DM rekey", async () => {
    if (!available) return;
    const [databasePosture] = await shared!.admin<
      {
        server_version_num: number;
        vector_version: string | null;
        app_is_superuser: boolean;
        interactions_force_rls: boolean;
      }[]
    >`
      select current_setting('server_version_num')::int as server_version_num,
        (select extversion from pg_extension where extname = 'vector') as vector_version,
        (select rolsuper from pg_roles where rolname = 'opengeni_app') as app_is_superuser,
        (select relrowsecurity and relforcerowsecurity
          from pg_class
          where oid = 'slack_interactions'::regclass) as interactions_force_rls`;
    expect(databasePosture!.server_version_num).toBeGreaterThanOrEqual(160000);
    expect(databasePosture!.vector_version).not.toBeNull();
    expect(databasePosture!.app_is_superuser).toBe(false);
    expect(databasePosture!.interactions_force_rls).toBe(true);

    const sourceDm = "D_BOUND_BEFORE_REKEY_SOURCE";
    const value = await fixture({
      deniedChannels: [sourceDm],
      linkOther: true,
    });
    value.slack.postFailuresByChannel.set(sourceDm, { error: "channel_not_found" });
    const acknowledgementPause = value.slack.pauseBeforePost(
      "started a private task from the selected DM message",
    );
    const triggerId = `shortcut-bound-before-rekey-${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      type: "message_action",
      trigger_id: triggerId,
      team: { id: value.teamId },
      user: { id: value.ownerSlackUserId },
      channel: { id: sourceDm },
      message: {
        ts: "1727000000.000001",
        text: "Keep delivery private while the bot-DM route is not durable",
      },
    });
    expect(
      (
        await value.app.request(
          signedRequest(
            "/v1/integrations/slack/interactions",
            new URLSearchParams({ payload }).toString(),
            "application/x-www-form-urlencoded",
          ),
        )
      ).status,
    ).toBe(200);

    const firstPump = drainSlackInteractionsOnce(value.deps);
    let acknowledgementReleased = false;
    const releaseAcknowledgement = () => {
      if (acknowledgementReleased) return;
      acknowledgementReleased = true;
      acknowledgementPause.release();
    };
    try {
      await acknowledgementPause.entered;
      const [boundBeforeRekey] = await shared!.admin<
        {
          id: string;
          session_id: string;
          route_key: string;
          slack_channel_id: string;
          slack_thread_ts: string;
          ack_slack_message_ts: string | null;
          terminal_delivery_state: string;
          delivery_attempt_count: number;
          delivery_last_error_code: string | null;
        }[]
      >`
      select id, session_id, route_key, slack_channel_id, slack_thread_ts,
        ack_slack_message_ts, terminal_delivery_state, delivery_attempt_count,
        delivery_last_error_code
      from slack_interactions
      where workspace_id = ${value.owner.workspaceId}`;
      if (!boundBeforeRekey) throw new Error("expected the bound pre-rekey shortcut route");
      const interactionId = boundBeforeRekey.id;
      const sessionId = boundBeforeRekey.session_id;
      expect(typeof interactionId).toBe("string");
      expect(typeof sessionId).toBe("string");
      expect(boundBeforeRekey).toEqual({
        id: interactionId,
        session_id: sessionId,
        route_key: `${sourceDm}:1727000000.000001:shortcut-user:${value.ownerSlackUserId}`,
        slack_channel_id: sourceDm,
        slack_thread_ts: "1727000000.000001",
        ack_slack_message_ts: null,
        terminal_delivery_state: "open",
        delivery_attempt_count: 0,
        delivery_last_error_code: null,
      });
      await appendSessionEvents(client.db, value.owner.workspaceId, sessionId, [
        { type: "turn.completed", payload: { output: "Private rekeyed result" } },
      ]);

      const replicaDeps = {
        ...value.deps,
        bus: new MemoryEventBus(),
      } as ApiRouteDeps;
      expect(await drainSlackInteractionsOnce(replicaDeps)).toBe(false);
      expect(
        value.slack.calls.filter(
          (call) => call.method === "chat.postMessage" && call.channel === sourceDm,
        ),
      ).toHaveLength(0);
      const [beforeAcknowledgement] = await shared!.admin<
        {
          source_post_operations: number;
          terminal_delivery_state: string;
          delivery_attempt_count: number;
          delivery_last_error_code: string | null;
        }[]
      >`
      select
        (select count(*)::int from slack_bot_post_operations
          where workspace_id = ${value.owner.workspaceId}
            and target_kind = 'channel'
            and target_id = ${sourceDm}) as source_post_operations,
        terminal_delivery_state,
        delivery_attempt_count,
        delivery_last_error_code
      from slack_interactions
      where id = ${interactionId}`;
      expect(beforeAcknowledgement).toEqual({
        source_post_operations: 0,
        terminal_delivery_state: "open",
        delivery_attempt_count: 0,
        delivery_last_error_code: null,
      });
      expect(value.slack.posts).toHaveLength(0);

      releaseAcknowledgement();
      expect(await firstPump).toBe(true);
      expect(value.slack.posts).toHaveLength(1);
      const acknowledgement = value.slack.posts[0]!;
      expect(acknowledgement).toMatchObject({
        channel: `D_${value.ownerSlackUserId}`,
        threadTimestamp: null,
      });
      const [rekeyed] = await shared!.admin<
        {
          route_key: string;
          slack_channel_id: string;
          slack_thread_ts: string;
          ack_slack_message_ts: string;
          terminal_delivery_state: string;
          delivery_attempt_count: number;
          delivery_last_error_code: string | null;
        }[]
      >`
      select route_key, slack_channel_id, slack_thread_ts, ack_slack_message_ts,
        terminal_delivery_state, delivery_attempt_count, delivery_last_error_code
      from slack_interactions
      where id = ${interactionId}`;
      expect(rekeyed).toEqual({
        route_key: `${acknowledgement.channel}:${acknowledgement.timestamp}`,
        slack_channel_id: acknowledgement.channel,
        slack_thread_ts: acknowledgement.timestamp,
        ack_slack_message_ts: acknowledgement.timestamp,
        terminal_delivery_state: "open",
        delivery_attempt_count: 0,
        delivery_last_error_code: null,
      });

      expect(await drainSlackInteractionsOnce(replicaDeps)).toBe(true);
      expect(value.slack.posts).toHaveLength(2);
      const resultPost = value.slack.posts[1]!;
      expect(resultPost.channel).toBe(acknowledgement.channel);
      expect(resultPost.threadTimestamp).toBe(acknowledgement.timestamp);
      expect(resultPost.text).toContain("Private rekeyed result");
      expect(
        value.slack.calls.filter(
          (call) => call.method === "chat.postMessage" && call.channel === sourceDm,
        ),
      ).toHaveLength(0);
      expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
        terminal_delivery_state: "completed",
      });

      await shared!.admin`
      update slack_interactions
      set terminal_delivery_state = 'open',
        last_delivered_session_event_sequence = 0,
        delivery_claim_holder_id = null,
        delivery_claim_expires_at = null,
        updated_at = now()
      where id = ${interactionId}`;
      expect(await drainSlackInteractionsOnce(replicaDeps)).toBe(true);
      expect(value.slack.posts).toHaveLength(2);

      await shared!.admin`
      update slack_interaction_inbox
      set status = 'pending', claim_holder_id = null, claim_expires_at = null,
        retry_at = now(), processed_at = null, updated_at = now()
      where workspace_id = ${value.owner.workspaceId}
        and provider_event_id = ${`shortcut:${triggerId}`}`;
      expect(await drainSlackInteractionsOnce(replicaDeps)).toBe(true);
      expect(value.slack.posts).toHaveLength(2);
      expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
        terminal_delivery_state: "completed",
      });

      expect(
        await getSessionForSubject(
          client.db,
          value.owner.workspaceId,
          sessionId,
          value.owner.subjectId,
        ),
      ).not.toBeNull();
      expect(
        await getSessionForSubject(
          client.db,
          value.owner.workspaceId,
          sessionId,
          value.otherSubjectId,
        ),
      ).toBeNull();
      expect(
        (
          await postEvent(value.app, {
            teamId: value.teamId,
            eventId: `E_BOUND_BEFORE_REKEY_REPLY_${crypto.randomUUID()}`,
            event: {
              type: "message",
              user: value.ownerSlackUserId,
              channel: acknowledgement.channel,
              ts: "1727000000.000003",
              thread_ts: acknowledgement.timestamp,
              text: "Continue through the owner-only bot-DM route",
            },
          })
        ).status,
      ).toBe(200);
      await drainAll(replicaDeps);
      const [continuation] = await shared!.admin<{ messages: number }[]>`
      select count(*)::int as messages
      from session_events
      where workspace_id = ${value.owner.workspaceId}
        and session_id = ${sessionId}
        and type = 'user.message'`;
      expect(continuation).toEqual({ messages: 2 });
    } finally {
      releaseAcknowledgement();
      await firstPump.catch(() => undefined);
    }
  }, 60_000);

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
    expect(value.slack.posts.at(-1)?.text).toContain("/capabilities#slack_link=");
    expect(value.slack.posts.at(-1)?.text).not.toContain("/capabilities?slack_link=");
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

  test("shared conversations fail closed by default and exact policy hands work off privately", async () => {
    if (!available) return;
    const deniedChannel = "C_SHARED_DENIED";
    const denied = await fixture({
      sharedChannels: [deniedChannel],
      externalOwnerTeamId: "T_PARTNER_DENIED",
    });
    expect(
      (
        await postEvent(denied.app, {
          teamId: denied.teamId,
          eventId: `E_SHARED_DENIED_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: denied.ownerSlackUserId,
            channel: deniedChannel,
            ts: "1731000000.000001",
            text: `<@${denied.botUserId}> do not expose this`,
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(denied.deps);
    expect(denied.slack.posts).toHaveLength(1);
    expect(denied.slack.posts[0]).toMatchObject({ channel: `D_${denied.ownerSlackUserId}` });
    expect(denied.slack.posts[0]!.text).toContain("No conversation content was read or retained");
    expect(denied.slack.calls.some((call) => call.method === "conversations.history")).toBe(false);
    expect(denied.slack.calls.some((call) => call.method === "files.info")).toBe(false);
    expect(await interactions(denied.owner.workspaceId)).toHaveLength(0);

    const allowedChannel = "C_SHARED_ALLOWED";
    const partnerTeamId = "T_PARTNER_ALLOWED";
    const allowed = await fixture({
      sharedChannels: [allowedChannel],
      externalOwnerTeamId: partnerTeamId,
    });
    const objectStore = reactionObjectStorage();
    Reflect.set(allowed.deps, "objectStorage", objectStore.storage);
    allowed.slack.privateFiles.set("F_SHARED_ALLOWED", {
      channelId: allowedChannel,
      filename: "partner-incident.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    const policyUpdate = await updateSlackTaskPolicy(client.db, {
      accountId: allowed.owner.accountId,
      workspaceId: allowed.owner.workspaceId,
      policy: {
        allowedTeamIds: [allowed.teamId, partnerTeamId],
        allowedConversationIds: [allowedChannel],
        allowGuestInitiators: false,
        allowExternalInitiators: true,
        allowMpim: false,
        sharedConversationMode: "private_handoff",
        resultPublicationMode: "approval_required",
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: allowed.owner.subjectId,
      principalKind: "human_session",
      reason: "Allow this exact partner channel with private delivery",
    });
    allowed.slack.channelHistories.set(allowedChannel, {
      messages: [
        {
          ts: "1731000001.000001",
          user: allowed.ownerSlackUserId,
          text: `<@${allowed.botUserId}> investigate privately`,
          files: [
            {
              id: "F_SHARED_ALLOWED",
              name: "partner-incident.png",
              title: "Partner incident",
            },
          ],
        },
      ],
    });
    expect(
      (
        await postEvent(allowed.app, {
          teamId: allowed.teamId,
          eventId: `E_SHARED_ALLOWED_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: allowed.ownerSlackUserId,
            channel: allowedChannel,
            ts: "1731000001.000001",
            text: `<@${allowed.botUserId}> investigate privately`,
            files: [
              {
                id: "F_SHARED_ALLOWED",
                name: "partner-incident.png",
                title: "Partner incident",
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    await drainAll(allowed.deps);
    const allowedRoutes = await interactions(allowed.owner.workspaceId);
    expect(allowedRoutes).toHaveLength(1);
    expect(allowedRoutes[0]).toMatchObject({ visibility: "private" });
    expect(allowed.slack.posts.at(-1)).toMatchObject({
      channel: `D_${allowed.ownerSlackUserId}`,
      threadTimestamp: null,
    });
    expect(allowed.slack.posts.at(-1)!.text).toContain("Results stay private");
    expect(allowed.slack.posts.some((post) => post.channel === allowedChannel)).toBe(false);
    const [allowedSession] = await shared!.admin<
      {
        resources: Array<{ kind: string; mountPath: string }>;
        initial_message: string;
        initial_model_context: string | null;
      }[]
    >`
      select resources, initial_message, initial_model_context
      from sessions
      where workspace_id = ${allowed.owner.workspaceId}
        and id = ${allowedRoutes[0]!.session_id}`;
    expect(allowedSession!.resources.map((resource) => resource.mountPath)).toEqual([
      "attachments/slack/01-partner-incident.png",
    ]);
    expect(allowedSession!.initial_message).toBe(`<@${allowed.botUserId}> investigate privately`);
    expect(allowedSession!.initial_model_context).toContain("Imported invocation attachments");
    expect(allowed.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(1);
    expect(objectStore.objects.size).toBe(1);

    const allowedRoute = allowedRoutes[0]!;
    const postsBeforeResult = allowed.slack.posts.length;
    await appendSessionEvents(client.db, allowed.owner.workspaceId, allowedRoute.session_id, [
      {
        type: "turn.completed",
        payload: { output: "Partner-safe result for the shared thread." },
      },
    ]);
    expect(await drainSlackInteractionsOnce(allowed.deps)).toBe(true);
    const [finalPost] = allowed.slack.posts.slice(postsBeforeResult);
    expect(finalPost).toBeDefined();
    expect(finalPost!.channel).toBe(`D_${allowed.ownerSlackUserId}`);
    expect(finalPost!.blocks).not.toBeNull();
    const [publishHandle] = await shared!.admin<{ id: string }[]>`
      select id from slack_interaction_action_handles
      where workspace_id = ${allowed.owner.workspaceId}
        and interaction_id = ${allowedRoute.id}::uuid
        and action_kind = 'shared_result_publish'
        and status = 'pending'`;
    expect(publishHandle?.id).toBeTruthy();
    const publicationPayload = JSON.stringify({
      type: "block_actions",
      team: { id: allowed.teamId },
      user: { id: allowed.ownerSlackUserId },
      channel: { id: finalPost!.channel },
      message: { ts: finalPost!.timestamp, thread_ts: finalPost!.threadTimestamp },
      actions: [
        {
          action_id: "opengeni.shared_result.publish",
          action_ts: "1731000002.000001",
          value: publishHandle!.id,
        },
      ],
    });
    expect(
      (
        await allowed.app.request(
          signedRequest(
            "/v1/integrations/slack/interactions",
            new URLSearchParams({ payload: publicationPayload }).toString(),
            "application/x-www-form-urlencoded",
          ),
        )
      ).status,
    ).toBe(200);
    await drainAll(allowed.deps);
    expect(allowed.slack.posts.at(-1)).toMatchObject({
      channel: allowedChannel,
      threadTimestamp: "1731000001.000001",
      text: expect.stringContaining("Partner-safe result for the shared thread."),
    });
    const [settledPublish] = await shared!.admin<{ status: string; result: string }[]>`
      select status, result from slack_interaction_action_handles
      where id = ${publishHandle!.id}::uuid`;
    expect(settledPublish).toEqual({ status: "completed", result: "published" });

    const emptyOutputSourceTs = "1731000002.500001";
    allowed.slack.channelHistories.set(allowedChannel, {
      messages: [
        {
          ts: emptyOutputSourceTs,
          user: allowed.ownerSlackUserId,
          text: `<@${allowed.botUserId}> keep fallback private`,
        },
      ],
    });
    await postEvent(allowed.app, {
      teamId: allowed.teamId,
      eventId: `E_SHARED_EMPTY_OUTPUT_${crypto.randomUUID()}`,
      event: {
        type: "app_mention",
        user: allowed.ownerSlackUserId,
        channel: allowedChannel,
        ts: emptyOutputSourceTs,
        text: `<@${allowed.botUserId}> keep fallback private`,
      },
    });
    await drainAll(allowed.deps);
    const emptyOutputRoute = (await interactions(allowed.owner.workspaceId)).find(
      (candidate) => candidate.id !== allowedRoute.id,
    )!;
    const postsBeforeEmptyOutput = allowed.slack.posts.length;
    await appendSessionEvents(client.db, allowed.owner.workspaceId, emptyOutputRoute.session_id, [
      {
        type: "agent.message.completed",
        payload: { text: "Fallback-only private result" },
      },
      { type: "turn.completed", payload: { output: "   " } },
    ]);
    await drainAll(allowed.deps);
    const [emptyOutputFinalPost] = allowed.slack.posts.slice(postsBeforeEmptyOutput);
    expect(emptyOutputFinalPost).toMatchObject({
      channel: `D_${allowed.ownerSlackUserId}`,
      blocks: null,
    });
    expect(emptyOutputFinalPost!.text).toContain("Fallback-only private result");
    const emptyOutputHandles = await shared!.admin<{ id: string }[]>`
      select id from slack_interaction_action_handles
      where workspace_id = ${allowed.owner.workspaceId}
        and interaction_id = ${emptyOutputRoute.id}::uuid
        and action_kind = 'shared_result_publish'`;
    expect(emptyOutputHandles).toHaveLength(0);

    const staleSourceTs = "1731000003.000001";
    allowed.slack.channelHistories.set(allowedChannel, {
      messages: [
        {
          ts: staleSourceTs,
          user: allowed.ownerSlackUserId,
          text: `<@${allowed.botUserId}> prepare another result`,
        },
      ],
    });
    await postEvent(allowed.app, {
      teamId: allowed.teamId,
      eventId: `E_SHARED_STALE_${crypto.randomUUID()}`,
      event: {
        type: "app_mention",
        user: allowed.ownerSlackUserId,
        channel: allowedChannel,
        ts: staleSourceTs,
        text: `<@${allowed.botUserId}> prepare another result`,
      },
    });
    await drainAll(allowed.deps);
    const staleRoute = (await interactions(allowed.owner.workspaceId)).find(
      (candidate) => candidate.id !== allowedRoute.id && candidate.id !== emptyOutputRoute.id,
    )!;
    await appendSessionEvents(client.db, allowed.owner.workspaceId, staleRoute.session_id, [
      { type: "turn.completed", payload: { output: "This result must remain private." } },
    ]);
    await drainAll(allowed.deps);
    const staleFinalPost = allowed.slack.posts.at(-1)!;
    const [staleHandle] = await shared!.admin<{ id: string }[]>`
      select id from slack_interaction_action_handles
      where workspace_id = ${allowed.owner.workspaceId}
        and interaction_id = ${staleRoute.id}::uuid
        and action_kind = 'shared_result_publish'
        and status = 'pending'`;
    expect(staleHandle?.id).toBeTruthy();
    await updateSlackTaskPolicy(client.db, {
      accountId: allowed.owner.accountId,
      workspaceId: allowed.owner.workspaceId,
      policy: {
        ...policyUpdate.revision.policy,
        sharedConversationMode: "deny",
        resultPublicationMode: "never",
      },
      expectedCurrentRevisionId: policyUpdate.revision.id,
      expectedActivationVersion: policyUpdate.head.activationVersion,
      actorSubjectId: allowed.owner.subjectId,
      principalKind: "human_session",
      reason: "Revoke shared publication before the requester acts",
    });
    const sharedPostsBeforeStaleClick = allowed.slack.posts.filter(
      (post) => post.channel === allowedChannel,
    ).length;
    const stalePayload = JSON.stringify({
      type: "block_actions",
      team: { id: allowed.teamId },
      user: { id: allowed.ownerSlackUserId },
      channel: { id: staleFinalPost.channel },
      message: { ts: staleFinalPost.timestamp, thread_ts: staleFinalPost.threadTimestamp },
      actions: [
        {
          action_id: "opengeni.shared_result.publish",
          action_ts: "1731000004.000001",
          value: staleHandle!.id,
        },
      ],
    });
    await allowed.app.request(
      signedRequest(
        "/v1/integrations/slack/interactions",
        new URLSearchParams({ payload: stalePayload }).toString(),
        "application/x-www-form-urlencoded",
      ),
    );
    await drainAll(allowed.deps);
    expect(allowed.slack.posts.filter((post) => post.channel === allowedChannel)).toHaveLength(
      sharedPostsBeforeStaleClick,
    );
    const [staleSettlement] = await shared!.admin<{ status: string; result: string }[]>`
      select status, result from slack_interaction_action_handles
      where id = ${staleHandle!.id}::uuid`;
    expect(staleSettlement).toEqual({ status: "stale", result: "stale" });
  });

  test("shared image import revalidates policy after file metadata and before byte fetch", async () => {
    if (!available) return;
    const channelId = "C_SHARED_IMAGE_DRIFT";
    const partnerTeamId = "T_PARTNER_IMAGE_DRIFT";
    const value = await fixture({
      sharedChannels: [channelId],
      externalOwnerTeamId: partnerTeamId,
    });
    const objectStore = reactionObjectStorage();
    Reflect.set(value.deps, "objectStorage", objectStore.storage);
    value.slack.privateFiles.set("F_SHARED_IMAGE_DRIFT", {
      channelId,
      filename: "must-not-download.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    const policyUpdate = await updateSlackTaskPolicy(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      policy: {
        allowedTeamIds: [value.teamId, partnerTeamId],
        allowedConversationIds: [channelId],
        allowGuestInitiators: false,
        allowExternalInitiators: true,
        allowMpim: false,
        sharedConversationMode: "private_handoff",
        resultPublicationMode: "never",
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: value.owner.subjectId,
      principalKind: "human_session",
      reason: "Authorize the exact shared image handoff",
    });
    const messageTimestamp = "1731000010.000001";
    value.slack.channelHistories.set(channelId, {
      messages: [
        {
          ts: messageTimestamp,
          user: value.ownerSlackUserId,
          text: `<@${value.botUserId}> inspect this privately`,
          files: [
            {
              id: "F_SHARED_IMAGE_DRIFT",
              name: "must-not-download.png",
              title: "Must not download",
            },
          ],
        },
      ],
    });
    const pause = value.slack.pauseChannelInfoAfterFile("F_SHARED_IMAGE_DRIFT", channelId);
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_SHARED_IMAGE_DRIFT_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: value.ownerSlackUserId,
            channel: channelId,
            ts: messageTimestamp,
            text: `<@${value.botUserId}> inspect this privately`,
            files: [
              {
                id: "F_SHARED_IMAGE_DRIFT",
                name: "must-not-download.png",
                title: "Must not download",
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const draining = drainAll(value.deps);
    await pause.entered;
    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(1);
    await updateSlackTaskPolicy(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      policy: {
        ...policyUpdate.revision.policy,
        sharedConversationMode: "deny",
      },
      expectedCurrentRevisionId: policyUpdate.revision.id,
      expectedActivationVersion: policyUpdate.head.activationVersion,
      actorSubjectId: value.owner.subjectId,
      principalKind: "human_session",
      reason: "Revoke the shared handoff before file bytes are fetched",
    });
    pause.release();
    await draining;

    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(1);
    expect(value.slack.privateFileFetches).toHaveLength(0);
    expect(objectStore.objects.size).toBe(0);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(0);
    const [inbox] = await shared!.admin<{ status: string; last_error_code: string | null }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toEqual({
      status: "failed",
      last_error_code: "slack_shared_policy_changed_before_read",
    });
  });

  test("shared image import revalidates policy before a redirected byte fetch", async () => {
    if (!available) return;
    const channelId = "C_SHARED_IMAGE_REDIRECT_DRIFT";
    const partnerTeamId = "T_PARTNER_IMAGE_REDIRECT_DRIFT";
    const value = await fixture({
      sharedChannels: [channelId],
      externalOwnerTeamId: partnerTeamId,
    });
    const objectStore = reactionObjectStorage();
    Reflect.set(value.deps, "objectStorage", objectStore.storage);
    const fileId = "F_SHARED_IMAGE_REDIRECT_DRIFT";
    value.slack.privateFiles.set(fileId, {
      channelId,
      filename: "must-not-follow.png",
      contentType: "image/png",
      bytes: fixturePng(),
    });
    const policyUpdate = await updateSlackTaskPolicy(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      policy: {
        allowedTeamIds: [value.teamId, partnerTeamId],
        allowedConversationIds: [channelId],
        allowGuestInitiators: false,
        allowExternalInitiators: true,
        allowMpim: false,
        sharedConversationMode: "private_handoff",
        resultPublicationMode: "never",
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      actorSubjectId: value.owner.subjectId,
      principalKind: "human_session",
      reason: "Authorize the exact shared image handoff",
    });
    const messageTimestamp = "1731000011.000001";
    value.slack.channelHistories.set(channelId, {
      messages: [
        {
          ts: messageTimestamp,
          user: value.ownerSlackUserId,
          text: `<@${value.botUserId}> inspect this privately`,
          files: [
            {
              id: fileId,
              name: "must-not-follow.png",
              title: "Must not follow",
            },
          ],
        },
      ],
    });
    const pause = value.slack.redirectPrivateFileThenPausePolicy(fileId, channelId);
    expect(
      (
        await postEvent(value.app, {
          teamId: value.teamId,
          eventId: `E_SHARED_IMAGE_REDIRECT_DRIFT_${crypto.randomUUID()}`,
          event: {
            type: "app_mention",
            user: value.ownerSlackUserId,
            channel: channelId,
            ts: messageTimestamp,
            text: `<@${value.botUserId}> inspect this privately`,
            files: [
              {
                id: fileId,
                name: "must-not-follow.png",
                title: "Must not follow",
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const draining = drainAll(value.deps);
    await pause.entered;
    expect(value.slack.privateFileFetches).toEqual([fileId]);
    await updateSlackTaskPolicy(client.db, {
      accountId: value.owner.accountId,
      workspaceId: value.owner.workspaceId,
      policy: {
        ...policyUpdate.revision.policy,
        sharedConversationMode: "deny",
      },
      expectedCurrentRevisionId: policyUpdate.revision.id,
      expectedActivationVersion: policyUpdate.head.activationVersion,
      actorSubjectId: value.owner.subjectId,
      principalKind: "human_session",
      reason: "Revoke the shared handoff before the redirected file fetch",
    });
    pause.release();
    await draining;

    expect(value.slack.calls.filter((call) => call.method === "files.info")).toHaveLength(1);
    expect(value.slack.privateFileFetches).toEqual([fileId]);
    expect(objectStore.objects.size).toBe(0);
    expect(await interactions(value.owner.workspaceId)).toHaveLength(0);
    const [sessionCount] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${value.owner.workspaceId}`;
    expect(sessionCount?.count ?? 0).toBe(0);
    const [inbox] = await shared!.admin<{ status: string; last_error_code: string | null }[]>`
      select status, last_error_code
      from slack_interaction_inbox
      where workspace_id = ${value.owner.workspaceId}`;
    expect(inbox).toEqual({
      status: "failed",
      last_error_code: "slack_shared_policy_changed_before_read",
    });
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
    const deferredProgress = await shared!.admin<
      { session_event_sequence: number; slot: number; status: string }[]
    >`
      select delivery.session_event_sequence, delivery.slot, operation.status
      from slack_interaction_progress_deliveries delivery
      join slack_bot_post_operations operation
        on operation.workspace_id = ${value.owner.workspaceId}
       and operation.operation_id = delivery.operation_id
      where delivery.interaction_id = ${route!.id}
      order by delivery.slot`;
    expect(deferredProgress.map((progress) => progress.status)).toEqual([
      "completed",
      "outcome_unknown",
    ]);
    expect(deferredProgress[1]!.slot).toBe(deferredProgress[0]!.slot + 1);
    const [deferredCursor] = await shared!.admin<
      { last_delivered_session_event_sequence: number; progress_count: number }[]
    >`
      select last_delivered_session_event_sequence, progress_count
      from slack_interactions
      where id = ${route!.id}`;
    expect(deferredCursor?.last_delivered_session_event_sequence).toBeLessThan(
      deferredProgress[0]!.session_event_sequence,
    );
    expect(deferredCursor?.progress_count).toBe(2);

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
    expect(delivered.at(-1)?.text).not.toContain("Open in OpenGeni");
    expect(delivered.at(-1)?.text).not.toContain("/sessions/");
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

  test("reconciles production-shaped final output across pages and replica claims", async () => {
    if (!available) return;
    const value = await fixture();
    await postEvent(value.app, {
      teamId: value.teamId,
      eventId: `E_PAGED_FINAL_${crypto.randomUUID()}`,
      event: {
        type: "message",
        channel_type: "im",
        user: value.ownerSlackUserId,
        channel: "D_PAGED_FINAL",
        ts: "1745000000.000001",
        text: "Run a task whose final output crosses a delivery page",
      },
    });
    await drainAll(value.deps);
    const [route] = await interactions(value.owner.workspaceId);
    const postsBeforeResult = value.slack.posts.length;

    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      ...Array.from({ length: 101 }, (_, index) => ({
        type: "session.status.changed",
        payload: { status: "running", pageFixture: index },
      })),
      {
        type: "agent.message.completed",
        payload: { text: "Production-shaped final result" },
      },
    ]);

    // Delivery pages are chronological. The first page advances across only
    // the oldest status events; the streamed assistant result is on page two.
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(value.slack.posts).toHaveLength(postsBeforeResult);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(value.slack.posts.slice(postsBeforeResult).map((post) => post.text)).toEqual([
      "Production-shaped final result",
    ]);

    // The terminal settlement writes a superset assistant shape plus
    // turn.completed atomically. Two replicas converge on the already-used
    // same-turn progress operation instead of posting a second result.
    await appendSessionEvents(client.db, value.owner.workspaceId, route!.session_id, [
      {
        type: "agent.message.completed",
        payload: { text: "Production-shaped final result\n\nAdditional final detail" },
      },
      {
        type: "turn.completed",
        payload: { output: "Production-shaped final result\n\nAdditional final detail" },
      },
    ]);
    const replicaDeps = {
      ...value.deps,
      bus: new MemoryEventBus(),
    } as ApiRouteDeps;
    expect(
      (
        await Promise.all([
          drainSlackInteractionsOnce(value.deps),
          drainSlackInteractionsOnce(replicaDeps),
        ])
      ).sort(),
    ).toEqual([false, true]);
    const resultPosts = value.slack.posts.slice(postsBeforeResult);
    expect(resultPosts).toHaveLength(1);
    expect(resultPosts[0]!.text).toBe("Production-shaped final result");
    expect(resultPosts[0]!.text).not.toContain("Open in OpenGeni");
    expect(resultPosts[0]!.text).not.toContain("/sessions/");
    expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
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
    ).toHaveLength(0);
    expect(value.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
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
    ).toHaveLength(0);

    value.slack.failuresByText.delete("Rate limited result");
    await shared!.admin`
      update slack_interactions set delivery_retry_at = now() where id = ${route!.id}`;
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(true);
    expect(await drainSlackInteractionsOnce(value.deps)).toBe(false);
    expect(
      value.slack.posts.filter((post) => post.text.includes("Rate limited result")),
    ).toHaveLength(1);
    expect(value.slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(3);
    expect((await interactions(value.owner.workspaceId))[0]).toMatchObject({
      terminal_delivery_state: "completed",
    });
  });
});
