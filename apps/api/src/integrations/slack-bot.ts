import { createHmac, timingSafeEqual } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  evaluateOpenGeniSlackBotScopes,
  type AccessGrant,
  type ConnectionMetadata,
  type OpenGeniSlackBotConnectionMetadata,
} from "@opengeni/contracts";
import {
  isOpenGeniSlackBotConnection,
  isTrustedScheduledSlackBotSession,
  openGeniSlackBotMetadata,
  requireOpenGeniSlackBotConnection,
  scheduledSlackBotConnectionId,
} from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  claimSlackBotDeleteOperation,
  claimSlackBotPostOperation,
  completeSlackBotDeleteOperation,
  completeSlackBotPostOperation,
  getSession,
  listConnectionsMetadata,
  markSlackBotDeleteOperationProviderStarted,
  recordAuditEvent,
  releaseSlackBotDeleteOperationClaim,
  releaseSlackBotPostOperationClaim,
  setConnectionStatus,
  type Database,
} from "@opengeni/db";
import {
  readResponseBodyBounded,
  readResponseJsonBounded,
  type FetchLike,
} from "@opengeni/network";
import { HTTPException } from "hono/http-exception";

const SLACK_API_BASE = "https://slack.com/api/";
const SLACK_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const SLACK_FILE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const SLACK_FILE_CONTENT_PAGE_CHARS = 50_000;
const SLACK_TIMEOUT_MS = 10_000;
const MAX_CHANNEL_PAGE = 200;
const MAX_HISTORY_PAGE = 100;
const MAX_THREAD_PAGE = 100;
const MAX_REACTION_CONTEXT_MESSAGES = 15;
const MAX_REACTION_CONTEXT_PAGES = 8;
const MAX_USER_PAGE = 200;
const MAX_FILE_PAGE = 200;
const MAX_FILE_CURSOR_LENGTH = 1_024;
const SLACK_FILE_CURSOR_VERSION = "files-v1";
const MAX_PROJECTED_TEXT = 4_000;
const SLACK_POST_CLAIM_LEASE_MS = 30_000;
const SLACK_DELETE_CLAIM_LEASE_MS = 30_000;

type SlackPayload = Record<string, unknown> & { ok?: unknown; error?: unknown };

export type SlackFilesListPage = { count: number; page: number };

export type SlackFilesCursorContext = {
  connectionId: string;
  key: Uint8Array;
};

export type VerifiedOpenGeniSlackBot = {
  grantedScopes: string[];
  metadata: OpenGeniSlackBotConnectionMetadata;
};

export async function exchangeOpenGeniSlackAuthorizationCode(
  input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
  let response: Response;
  try {
    response = await fetchImpl(`${SLACK_API_BASE}oauth.v2.access`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch {
    throw new HTTPException(502, {
      message: "Slack installation token exchange failed",
    });
  }
  if (!response.ok) {
    throw new HTTPException(502, {
      message: "Slack installation token exchange failed",
    });
  }
  const payload = await readResponseJsonBounded<unknown>(
    response,
    SLACK_RESPONSE_MAX_BYTES,
    "Slack OAuth response",
  );
  const record = slackRecord(payload);
  if (!record || record.ok !== true) {
    throw new SlackBotProviderError(slackString(record?.error) || "oauth_exchange_failed");
  }
  const accessToken = slackString(record.access_token);
  if (!accessToken?.startsWith("xoxb-")) {
    throw new HTTPException(502, {
      message: "Slack installation did not return a bot token",
    });
  }
  return accessToken;
}

export type SlackBotReceipt = {
  credentialRole: typeof OPENGENI_SLACK_BOT_CREDENTIAL_ROLE;
  credentialLabel: typeof OPENGENI_SLACK_BOT_CREDENTIAL_LABEL;
  connectionId: string;
  slackTeamId: string;
  operation: SlackBotOperation;
  operationId?: string;
  clientMessageId?: string;
};

type SlackBotOperation =
  | "channels.list"
  | "channel_history.read"
  | "thread_replies.read"
  | "users.list"
  | "files.list"
  | "file.info"
  | "file.content.read"
  | "message.post"
  | "message.delete";

type SlackBotContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  sessionId?: string | null;
  scheduledTaskId?: string | null;
};

export class SlackBotProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Slack bot request failed: ${safeSlackCode(code)}`);
    this.name = "SlackBotProviderError";
  }
}

const SLACK_CREDENTIAL_REJECTION_CODES = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

function slackCredentialRejected(error: unknown): error is SlackBotProviderError {
  return error instanceof SlackBotProviderError && SLACK_CREDENTIAL_REJECTION_CODES.has(error.code);
}

export type SlackBotCredentialVerificationFailureReason = "scope_mismatch" | "identity_mismatch";

export class SlackBotCredentialVerificationError extends HTTPException {
  constructor(
    readonly failureReason: SlackBotCredentialVerificationFailureReason,
    message: string,
  ) {
    super(422, { message });
    this.name = "SlackBotCredentialVerificationError";
  }
}

/**
 * Validates a write-only xoxb credential before it can enter encrypted storage.
 * Slack does not expose the app's display_information name to this scope set;
 * users.info provides the authoritative installed bot display name, while the
 * documented manifest fixes the app name itself to the same exact value.
 */
export async function verifyOpenGeniSlackBotCredential(
  token: string,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<VerifiedOpenGeniSlackBot> {
  const authResponse = await slackApiFetch(fetchImpl, "auth.test", token, {});
  const grantedScopes = parseGrantedScopes(authResponse.response.headers.get("x-oauth-scopes"));
  assertOpenGeniSlackBotScopes(grantedScopes);
  const auth = authResponse.payload;
  const slackTeamId = requiredSlackString(auth.team_id, "team_id");
  const slackTeamName = requiredSlackString(auth.team, "team");
  const botUserId = requiredSlackString(auth.user_id, "user_id");
  const botId = requiredSlackString(auth.bot_id, "bot_id");

  const userResponse = await slackApiFetch(fetchImpl, "users.info", token, {
    user: botUserId,
  });
  const user = slackRecord(userResponse.payload.user);
  if (!user || user.is_bot !== true || user.deleted === true) {
    throw new SlackBotCredentialVerificationError(
      "identity_mismatch",
      "Slack credential must identify an active bot user",
    );
  }
  const profile = slackRecord(user.profile);
  const displayName = slackString(profile?.display_name) || slackString(profile?.real_name);
  if (displayName !== "OpenGeni") {
    throw new SlackBotCredentialVerificationError(
      "identity_mismatch",
      'Slack bot display name must be exactly "OpenGeni"',
    );
  }

  return {
    grantedScopes,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId,
      slackTeamName,
      botUserId,
      botId,
      botDisplayName: "OpenGeni",
      verifiedAt: now.toISOString(),
    },
  };
}

export async function resolveSlackBotConnectionForTool(input: {
  db: Database;
  grant: AccessGrant;
  sessionId: string | null;
  requestedConnectionId?: string;
}): Promise<{
  connection: ConnectionMetadata;
  metadata: OpenGeniSlackBotConnectionMetadata;
  context: SlackBotContext;
}> {
  const session = input.sessionId
    ? await getSession(input.db, input.grant.workspaceId, input.sessionId)
    : null;
  if (input.sessionId && !session) {
    throw new Error("signed Slack bot session was not found");
  }
  const boundConnectionId = scheduledSlackBotConnectionId(session?.metadata);
  if (boundConnectionId && (!session || !isTrustedScheduledSlackBotSession(session))) {
    throw new Error("OpenGeni Slack bot routing metadata is not scheduler-authorized");
  }
  if (
    boundConnectionId &&
    input.requestedConnectionId &&
    input.requestedConnectionId !== boundConnectionId
  ) {
    throw new Error("this scheduled session is bound to a different OpenGeni Slack bot connection");
  }
  if (!boundConnectionId && !input.grant.permissions.includes("connections:read")) {
    throw new Error("connections:read is required to select an OpenGeni Slack bot connection");
  }
  let connectionId = boundConnectionId ?? input.requestedConnectionId;
  if (!connectionId) {
    const activeConnections = (
      await listConnectionsMetadata(input.db, input.grant.workspaceId, null)
    ).filter(
      (connection) => connection.status === "active" && isOpenGeniSlackBotConnection(connection),
    );
    if (activeConnections.length === 0) {
      throw new Error("no active OpenGeni Slack bot connection is installed in this workspace");
    }
    if (activeConnections.length > 1) {
      const principals = new Set(
        activeConnections.map((candidate) => {
          const metadata = openGeniSlackBotMetadata(candidate.metadata)!;
          return `${metadata.slackTeamId}:${metadata.botId}:${metadata.botUserId}`;
        }),
      );
      if (principals.size > 1) {
        throw new Error(
          "connectionId is required because this workspace has multiple active OpenGeni Slack bot connections",
        );
      }
    }
    connectionId = activeConnections[0]!.id;
  }
  const connection = await requireOpenGeniSlackBotConnection(
    input.db,
    input.grant.workspaceId,
    connectionId,
  );
  const metadata = openGeniSlackBotMetadata(connection.metadata);
  if (!metadata) {
    throw new Error("OpenGeni Slack bot connection metadata is invalid");
  }
  return {
    connection,
    metadata,
    context: {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      subjectId: input.grant.subjectId,
      sessionId: input.sessionId,
      scheduledTaskId:
        typeof session?.metadata.scheduledTaskId === "string"
          ? session.metadata.scheduledTaskId
          : null,
    },
  };
}

export class OpenGeniSlackBotClient {
  private readonly resolveCredential: ReturnType<typeof buildConnectionTokenResolver>;

  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
    private readonly connection: ConnectionMetadata,
    private readonly metadata: OpenGeniSlackBotConnectionMetadata,
    private readonly context: SlackBotContext,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.resolveCredential = buildConnectionTokenResolver(db, settings);
  }

  async listChannels(input: { limit?: number; cursor?: string } = {}) {
    return await this.withAudit("channels.list", async (headers) => {
      const payload = await this.call(headers, "conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: String(boundedInt(input.limit, MAX_CHANNEL_PAGE, 100)),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        channels: slackArray(payload.channels)
          .map(projectChannel)
          .filter((channel): channel is NonNullable<typeof channel> => channel !== null),
        nextCursor: responseCursor(payload),
      };
    });
  }

  async verifyChannelAccess(channelId: string) {
    const headers = await this.headersFor("channel_history.read");
    return await this.requireMemberChannel(headers, channelId);
  }

  async channelHistory(input: { channelId: string; limit?: number; cursor?: string }) {
    return await this.withAudit("channel_history.read", async (headers) => {
      const info = await this.requireMemberChannel(headers, input.channelId);
      const payload = await this.call(headers, "conversations.history", {
        channel: input.channelId,
        limit: String(boundedInt(input.limit, MAX_HISTORY_PAGE, 50)),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        channel: info,
        messages: slackArray(payload.messages).map(projectMessage),
        nextCursor: responseCursor(payload),
      };
    });
  }

  async threadReplies(input: {
    channelId: string;
    threadTimestamp: string;
    limit?: number;
    cursor?: string;
  }) {
    return await this.withAudit("thread_replies.read", async (headers) => {
      const info = await this.requireMemberChannel(headers, input.channelId);
      const payload = await this.call(headers, "conversations.replies", {
        channel: input.channelId,
        ts: input.threadTimestamp,
        limit: String(boundedInt(input.limit, MAX_THREAD_PAGE, 50)),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        channel: info,
        threadTimestamp: input.threadTimestamp,
        messages: slackArray(payload.messages).map(projectMessage),
        nextCursor: responseCursor(payload),
      };
    });
  }

  async reactionMessageContext(input: { channelId: string; messageTimestamp: string }) {
    return await this.withAudit("thread_replies.read", async (headers) => {
      const info = await this.requireMemberChannel(headers, input.channelId);
      if (info.isShared || info.isExternallyShared || info.isOrgShared) {
        throw new SlackBotProviderError("slack_connect_unsupported");
      }
      const messages: ReturnType<typeof projectMessage>[] = [];
      const seenMessageTimestamps = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let nextCursor: string | null = null;
      let threadTimestamp: string | null = null;
      let reactedMessage: ReturnType<typeof projectMessage> | null = null;

      for (let page = 0; page < MAX_REACTION_CONTEXT_PAGES; page += 1) {
        const payload = await this.call(headers, "conversations.replies", {
          channel: input.channelId,
          // Slack accepts either the parent timestamp or a message timestamp from
          // inside the thread and returns the containing thread.
          ts: input.messageTimestamp,
          limit: String(MAX_REACTION_CONTEXT_MESSAGES),
          ...(cursor ? { cursor } : {}),
        });
        const pageMessages = slackArray(payload.messages)
          .map(projectMessage)
          .filter((message) => message.timestamp.length > 0);
        const first = pageMessages[0];
        threadTimestamp ??= first?.threadTimestamp || first?.timestamp || null;
        for (const message of pageMessages) {
          if (seenMessageTimestamps.has(message.timestamp)) continue;
          seenMessageTimestamps.add(message.timestamp);
          messages.push(message);
        }
        reactedMessage =
          reactedMessage ??
          pageMessages.find((message) => message.timestamp === input.messageTimestamp) ??
          null;
        nextCursor = responseCursor(payload);
        if (reactedMessage || !nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          throw new SlackBotProviderError("invalid_response");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      if (!reactedMessage || !threadTimestamp) {
        throw new SlackBotProviderError("message_not_found");
      }
      const boundedMessages = selectSlackReactionContextMessages(
        messages,
        reactedMessage.timestamp,
      );
      return {
        channel: info,
        threadTimestamp,
        reactedMessage,
        messages: boundedMessages,
        truncated: nextCursor !== null || messages.length > boundedMessages.length,
      };
    });
  }

  async listUsers(input: { limit?: number; cursor?: string } = {}) {
    return await this.withAudit("users.list", async (headers) => {
      const payload = await this.call(headers, "users.list", {
        limit: String(boundedInt(input.limit, MAX_USER_PAGE, 100)),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        users: slackArray(payload.members)
          .map(projectUser)
          .filter((user): user is NonNullable<typeof user> => user !== null),
        nextCursor: responseCursor(payload),
      };
    });
  }

  async listFiles(input: { channelId: string; limit?: number; cursor?: string }) {
    return await this.withAudit("files.list", async (headers) => {
      const requestedPage = this.fileListPage(input);
      const info = await this.requireMemberChannel(headers, input.channelId);
      const payload = await this.call(headers, "files.list", {
        channel: input.channelId,
        count: String(requestedPage.count),
        page: String(requestedPage.page),
      });
      const files = slackArray(payload.files)
        .map(projectFile)
        .filter((file): file is NonNullable<typeof file> => file !== null);
      const nextPage = nextSlackFilesListPage(payload, requestedPage, files.length);
      return {
        channel: info,
        files,
        nextCursor:
          nextPage === null
            ? null
            : this.fileListCursor({
                channelId: input.channelId,
                count: requestedPage.count,
                page: nextPage,
              }),
      };
    });
  }

  async fileInfo(input: { channelId: string; fileId: string; parentFileId?: string }) {
    return await this.withAudit("file.info", async (headers) => {
      const info = await this.requireMemberChannel(headers, input.channelId);
      const { file } = await this.requireFileForChannel(headers, "file.info", input);
      return { channel: info, file };
    });
  }

  async fileContent(input: {
    channelId: string;
    fileId: string;
    parentFileId?: string;
    offset?: number;
  }) {
    return await this.withAudit("file.content.read", async (headers) => {
      const info = await this.requireMemberChannel(headers, input.channelId);
      const { fileRecord, file, parentFileRecord } = await this.requireFileForChannel(
        headers,
        "file.content.read",
        input,
      );
      const embeddedTranscript = embeddedHuddleTranscription(fileRecord, parentFileRecord);
      const { contentType, content } =
        embeddedTranscript ?? (await this.readPrivateFileText(fileRecord, "file.content.read"));
      const offset =
        typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0
          ? input.offset
          : 0;
      if (offset > content.length) {
        throw new SlackBotProviderError("invalid_file_offset");
      }
      const page = content.slice(offset, offset + SLACK_FILE_CONTENT_PAGE_CHARS);
      const nextOffset = offset + page.length < content.length ? offset + page.length : null;
      return {
        channel: info,
        file,
        contentType,
        offset,
        content: page,
        nextOffset,
        truncated: nextOffset !== null,
      };
    });
  }

  async postMessage(input: {
    operationId: string;
    channelId?: string;
    userId?: string;
    threadTimestamp?: string;
    text: string;
  }) {
    const operation = "message.post" as const;
    const claimHolderId = crypto.randomUUID();
    let claimAcquired = false;
    let providerCallStarted = false;
    try {
      const headers = await this.headersFor(operation);
      let channelId = input.channelId;
      if (input.userId) {
        const opened = await this.call(headers, "conversations.open", {
          users: input.userId,
        });
        channelId = requiredSlackString(slackRecord(opened.channel)?.id, "channel.id");
      } else if (channelId) {
        await this.requireMemberChannel(headers, channelId);
      }
      if (!channelId) {
        throw new Error("exactly one of channelId or userId is required");
      }
      const targetKind = input.userId ? "user" : "channel";
      const targetId = input.userId ?? input.channelId!;
      const requestDigest = this.postRequestDigest({
        operationId: input.operationId,
        targetKind,
        targetId,
        ...(input.threadTimestamp ? { threadTimestamp: input.threadTimestamp } : {}),
        text: input.text,
      });
      const claim = await claimSlackBotPostOperation(this.db, {
        accountId: this.context.accountId,
        workspaceId: this.context.workspaceId,
        connectionId: this.connection.id,
        operationId: input.operationId,
        targetKind,
        targetId,
        requestDigest,
        claimHolderId,
        claimLeaseMs: SLACK_POST_CLAIM_LEASE_MS,
      });
      if (claim.kind === "connection_not_found") {
        throw new Error("OpenGeni Slack bot connection no longer exists");
      }
      if (claim.kind === "conflict") {
        throw new Error("operationId is already bound to a different Slack post request");
      }
      if (claim.kind === "in_progress") {
        throw new Error("Slack post operation is already in progress; retry the same operationId");
      }
      if (claim.kind === "completed") {
        return this.completedPostResult(claim.operation, input.operationId, input.threadTimestamp);
      }
      claimAcquired = true;
      providerCallStarted = true;
      const posted = await this.call(headers, "chat.postMessage", {
        channel: channelId,
        text: input.text,
        client_msg_id: input.operationId,
        ...(input.threadTimestamp ? { thread_ts: input.threadTimestamp } : {}),
      });
      const slackChannelId = requiredSlackString(posted.channel, "channel");
      const slackMessageTimestamp = requiredSlackString(posted.ts, "ts");
      const completed = await completeSlackBotPostOperation(this.db, {
        accountId: this.context.accountId,
        workspaceId: this.context.workspaceId,
        connectionId: this.connection.id,
        operationId: input.operationId,
        claimHolderId,
        slackChannelId,
        slackMessageTimestamp,
        subjectId: this.context.subjectId,
        auditMetadata: this.auditMetadata(operation, "succeeded", undefined, input.operationId),
      });
      if (completed.kind !== "completed") {
        throw new Error("Slack post completion lost its durable operation claim");
      }
      claimAcquired = false;
      return this.completedPostResult(
        completed.operation,
        input.operationId,
        input.threadTimestamp,
      );
    } catch (error) {
      const failureCode = safeFailureCode(error);
      if (claimAcquired) {
        await releaseSlackBotPostOperationClaim(this.db, {
          accountId: this.context.accountId,
          workspaceId: this.context.workspaceId,
          connectionId: this.connection.id,
          operationId: input.operationId,
          claimHolderId,
          failureCode,
        }).catch(() => undefined);
      }
      await this.recordAudit(
        operation,
        providerCallStarted && slackMutationOutcomeMayBeAmbiguous(error) ? "ambiguous" : "failed",
        failureCode,
        input.operationId,
      );
      throw error;
    }
  }

  async deleteMessage(input: { operationId: string; channelId: string; timestamp: string }) {
    const operation = "message.delete" as const;
    const claimHolderId = crypto.randomUUID();
    const principal = this.deletePrincipal();
    const requestDigest = this.deleteRequestDigest(input);
    let claimAcquired = false;
    let providerCallStarted = false;
    let outcomeUnknown = false;
    try {
      const claim = await claimSlackBotDeleteOperation(this.db, {
        accountId: this.context.accountId,
        workspaceId: this.context.workspaceId,
        connectionId: this.connection.id,
        operationId: input.operationId,
        principalType: principal.type,
        principalId: principal.id,
        toolName: "slack_bot_delete_message",
        channelId: input.channelId,
        messageTimestamp: input.timestamp,
        requestDigest,
        claimHolderId,
        claimLeaseMs: SLACK_DELETE_CLAIM_LEASE_MS,
      });
      if (claim.kind === "connection_not_found") {
        throw new Error("OpenGeni Slack bot connection no longer exists");
      }
      if (claim.kind === "conflict") {
        throw new Error("operationId is already bound to a different Slack delete request");
      }
      if (claim.kind === "in_progress") {
        throw new Error(
          "Slack delete operation is already in progress; retry the same operationId",
        );
      }
      if (claim.kind === "completed") {
        return this.completedDeleteResult(claim.operation, input.operationId);
      }
      claimAcquired = true;
      outcomeUnknown = claim.kind === "reconcile";
      const headers = await this.headersFor(operation);
      await this.requireMemberChannel(headers, input.channelId);
      if (claim.kind === "reconcile") {
        const exists = await this.slackMessageExists(input.channelId, input.timestamp);
        if (!exists) {
          const completed = await completeSlackBotDeleteOperation(this.db, {
            accountId: this.context.accountId,
            workspaceId: this.context.workspaceId,
            connectionId: this.connection.id,
            operationId: input.operationId,
            claimHolderId,
            slackChannelId: input.channelId,
            slackMessageTimestamp: input.timestamp,
            subjectId: this.context.subjectId,
            auditMetadata: this.auditMetadata(operation, "succeeded", undefined, input.operationId),
          });
          if (completed.kind !== "completed") {
            throw new Error("Slack delete reconciliation lost its durable operation claim");
          }
          claimAcquired = false;
          return this.completedDeleteResult(completed.operation, input.operationId);
        }
      }
      const providerStarted = await markSlackBotDeleteOperationProviderStarted(this.db, {
        accountId: this.context.accountId,
        workspaceId: this.context.workspaceId,
        connectionId: this.connection.id,
        operationId: input.operationId,
        claimHolderId,
      });
      if (!providerStarted) {
        throw new Error("Slack delete operation lost its durable claim before provider call");
      }
      providerCallStarted = true;
      const deleted = await this.call(headers, "chat.delete", {
        channel: input.channelId,
        ts: input.timestamp,
      }).catch((error) => {
        if (error instanceof SlackBotProviderError && error.code === "message_not_found") {
          return { ok: true, channel: input.channelId, ts: input.timestamp };
        }
        throw error;
      });
      const completed = await completeSlackBotDeleteOperation(this.db, {
        accountId: this.context.accountId,
        workspaceId: this.context.workspaceId,
        connectionId: this.connection.id,
        operationId: input.operationId,
        claimHolderId,
        slackChannelId: requiredSlackString(deleted.channel, "channel"),
        slackMessageTimestamp: requiredSlackString(deleted.ts, "ts"),
        subjectId: this.context.subjectId,
        auditMetadata: this.auditMetadata(operation, "succeeded", undefined, input.operationId),
      });
      if (completed.kind !== "completed") {
        throw new Error("Slack delete completion lost its durable operation claim");
      }
      claimAcquired = false;
      return this.completedDeleteResult(completed.operation, input.operationId);
    } catch (error) {
      const failureCode = safeFailureCode(error);
      const ambiguous = providerCallStarted && slackMutationOutcomeMayBeAmbiguous(error);
      if (claimAcquired) {
        await releaseSlackBotDeleteOperationClaim(this.db, {
          accountId: this.context.accountId,
          workspaceId: this.context.workspaceId,
          connectionId: this.connection.id,
          operationId: input.operationId,
          claimHolderId,
          outcomeUnknown: outcomeUnknown || ambiguous,
          failureCode,
        }).catch(() => undefined);
      }
      await this.recordAudit(
        operation,
        ambiguous ? "ambiguous" : "failed",
        failureCode,
        input.operationId,
      );
      throw error;
    }
  }

  private async slackMessageExists(channelId: string, timestamp: string): Promise<boolean> {
    const headers = await this.headersForDestination(
      "message.delete",
      `${SLACK_API_BASE}chat.getPermalink`,
    );
    try {
      await this.call(headers, "chat.getPermalink", {
        channel: channelId,
        message_ts: timestamp,
      });
      return true;
    } catch (error) {
      if (error instanceof SlackBotProviderError && error.code === "message_not_found") {
        return false;
      }
      throw error;
    }
  }

  private async requireMemberChannel(headers: Record<string, string>, channelId: string) {
    const payload = await this.call(headers, "conversations.info", {
      channel: channelId,
    });
    const projected = projectChannel(payload.channel);
    // Slack omits `is_member` for a bot's one-to-one App Home conversation.
    // A successful conversations.info response with `is_im` is itself proof
    // that this installation can address that direct conversation.
    if (!projected || (projected.isMember !== true && projected.isDirectMessage !== true)) {
      throw new SlackBotProviderError("not_in_channel");
    }
    return projected;
  }

  private async requireFileForChannel(
    headers: Record<string, string>,
    operation: "file.info" | "file.content.read",
    input: { channelId: string; fileId: string; parentFileId?: string },
  ) {
    const payload = await this.call(headers, "files.info", {
      file: input.fileId,
      ...(operation === "file.content.read" ? { include_transcription: "true" } : {}),
    });
    const fileRecord = slackRecord(payload.file);
    const file = projectFile(fileRecord);
    if (!fileRecord || !file) {
      throw new SlackBotProviderError("file_not_found");
    }
    if (fileIsSharedToChannel(fileRecord, input.channelId)) {
      return { fileRecord, file, parentFileRecord: null };
    }
    if (!input.parentFileId || input.parentFileId === input.fileId) {
      throw new SlackBotProviderError("file_not_found");
    }
    const parentPayload = await this.call(headers, "files.info", {
      file: input.parentFileId,
    });
    const parentRecord = slackRecord(parentPayload.file);
    if (!parentRecord || !fileIsSharedToChannel(parentRecord, input.channelId)) {
      throw new SlackBotProviderError("file_not_found");
    }
    if (parentReferencesSlackFile(parentRecord, input.fileId)) {
      return { fileRecord, file, parentFileRecord: parentRecord };
    }
    const parent = await this.readPrivateFileText(parentRecord, operation);
    if (!embeddedSlackFileIds(parent.content).has(input.fileId)) {
      throw new SlackBotProviderError("file_not_found");
    }
    return { fileRecord, file, parentFileRecord: parentRecord };
  }

  private async readPrivateFileText(
    fileRecord: Record<string, unknown>,
    operation: "file.info" | "file.content.read",
  ): Promise<{ contentType: string; content: string }> {
    const downloadUrl = privateSlackFileUrl(fileRecord);
    if (!downloadUrl) {
      throw new SlackBotProviderError("file_content_unavailable");
    }
    let response: Response;
    try {
      response = await this.fetchPrivateFile(downloadUrl, operation);
    } catch (error) {
      if (
        error instanceof SlackBotProviderError &&
        error.code === "file_requires_user_access" &&
        slackString(fileRecord.mode) === "huddle_transcript"
      ) {
        throw new SlackBotProviderError("huddle_transcript_requires_participant_access");
      }
      throw error;
    }
    const contentType = normalizedContentType(response.headers.get("content-type"));
    if (!isSupportedSlackTextContentType(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new SlackBotProviderError("unsupported_file_type");
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await readResponseBodyBounded(
          response,
          SLACK_FILE_RESPONSE_MAX_BYTES,
          "Slack file content",
        ),
      );
      return { contentType, content };
    } catch {
      throw new SlackBotProviderError("invalid_file_content");
    }
  }

  private async call(
    headers: Record<string, string>,
    method: string,
    params: Record<string, string>,
  ): Promise<SlackPayload> {
    try {
      return (await slackApiFetchWithHeaders(this.fetchImpl, method, headers, params)).payload;
    } catch (error) {
      if (slackCredentialRejected(error)) {
        await setConnectionStatus(this.db, this.context.workspaceId, "needs_reauth", error.code, {
          id: this.connection.id,
          version: this.connection.version,
          subjectId: null,
        }).catch(() => false);
      }
      throw error;
    }
  }

  private async withAudit<T extends Record<string, unknown>>(
    operation: SlackBotOperation,
    run: (headers: Record<string, string>) => Promise<T>,
  ): Promise<T & { receipt: SlackBotReceipt }> {
    try {
      const headers = await this.headersFor(operation);
      const result = await run(headers);
      await this.recordAudit(operation, "succeeded");
      return { ...result, receipt: this.receipt(operation) };
    } catch (error) {
      await this.recordAudit(operation, "failed", safeFailureCode(error));
      throw error;
    }
  }

  private async headersFor(operation: SlackBotOperation): Promise<Record<string, string>> {
    return await this.headersForDestination(
      operation,
      `${SLACK_API_BASE}${slackMethodForOperation(operation)}`,
    );
  }

  private async headersForDestination(
    operation: SlackBotOperation,
    destinationUrl: string,
  ): Promise<Record<string, string>> {
    const result = await this.resolveCredential({
      workspaceId: this.context.workspaceId,
      serverId: "opengeni-slack-bot",
      toolName: `slack_bot_${operation.replaceAll(".", "_")}`,
      connectionRef: {
        connectionId: this.connection.id,
        providerDomain: "slack.com",
        kind: "app_install",
        scopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
        subjectScope: "workspace",
      },
      destinationUrl,
    });
    if (result.status !== "ok" || result.connectionId !== this.connection.id) {
      throw new Error("OpenGeni Slack bot connection needs to be reinstalled");
    }
    return result.headers;
  }

  private async fetchPrivateFile(
    url: URL,
    operation: "file.info" | "file.content.read",
  ): Promise<Response> {
    const response = await this.fetchPrivateFileOnce(url, operation);
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new SlackBotProviderError(`http_${response.status}`);
    let redirected: URL;
    try {
      redirected = new URL(location, url);
      assertPrivateSlackFileUrl(redirected);
    } catch {
      throw new SlackBotProviderError("invalid_file_redirect");
    }
    if (isSlackInteractiveFileRedirect(redirected)) {
      throw new SlackBotProviderError("file_requires_user_access");
    }
    return await this.fetchPrivateFileOnce(redirected, operation);
  }

  private async fetchPrivateFileOnce(
    url: URL,
    operation: "file.info" | "file.content.read",
  ): Promise<Response> {
    const headers = await this.headersForDestination(operation, url.toString());
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          ...headers,
          accept: "text/*, application/json, application/xml, application/xhtml+xml",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
    } catch {
      throw new SlackBotProviderError("transport_error");
    }
    if (!response.ok && (response.status < 300 || response.status >= 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new SlackBotProviderError(`http_${response.status}`);
    }
    return response;
  }

  private receipt(operation: SlackBotOperation, operationId?: string): SlackBotReceipt {
    return {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      connectionId: this.connection.id,
      slackTeamId: this.metadata.slackTeamId,
      operation,
      ...(operationId ? { operationId } : {}),
      ...(operation === "message.post" && operationId ? { clientMessageId: operationId } : {}),
    };
  }

  private completedPostResult(
    operation: {
      slackChannelId: string | null;
      slackMessageTimestamp: string | null;
    },
    operationId: string,
    threadTimestamp?: string,
  ) {
    if (!operation.slackChannelId || !operation.slackMessageTimestamp) {
      throw new Error("completed Slack post operation is missing its provider result");
    }
    return {
      channelId: operation.slackChannelId,
      timestamp: operation.slackMessageTimestamp,
      threadTimestamp: threadTimestamp ?? null,
      receipt: this.receipt("message.post", operationId),
    };
  }

  private completedDeleteResult(
    operation: {
      slackChannelId: string | null;
      slackMessageTimestamp: string | null;
    },
    operationId: string,
  ) {
    if (!operation.slackChannelId || !operation.slackMessageTimestamp) {
      throw new Error("completed Slack delete operation is missing its provider result");
    }
    return {
      channelId: operation.slackChannelId,
      timestamp: operation.slackMessageTimestamp,
      deleted: true,
      receipt: this.receipt("message.delete", operationId),
    };
  }

  private postRequestDigest(input: {
    operationId: string;
    targetKind: "channel" | "user";
    targetId: string;
    threadTimestamp?: string;
    text: string;
  }): string {
    const key = environmentsEncryptionKeyBytes(this.settings);
    if (!key) throw new Error("connection encryption is not configured");
    return createHmac("sha256", key)
      .update(
        JSON.stringify({
          operationId: input.operationId,
          connectionId: this.connection.id,
          targetKind: input.targetKind,
          targetId: input.targetId,
          threadTimestamp: input.threadTimestamp ?? null,
          text: input.text,
        }),
      )
      .digest("hex");
  }

  private deleteRequestDigest(input: {
    operationId: string;
    channelId: string;
    timestamp: string;
  }): string {
    const key = environmentsEncryptionKeyBytes(this.settings);
    if (!key) throw new Error("connection encryption is not configured");
    return createHmac("sha256", key)
      .update(
        JSON.stringify({
          operationId: input.operationId,
          connectionId: this.connection.id,
          toolName: "slack_bot_delete_message",
          channelId: input.channelId,
          timestamp: input.timestamp,
        }),
      )
      .digest("hex");
  }

  private deletePrincipal(): { type: "subject" | "service"; id: string } {
    if (this.context.subjectId) {
      return { type: "subject", id: this.context.subjectId };
    }
    if (this.context.scheduledTaskId) {
      return {
        type: "service",
        id: `scheduler:${this.context.scheduledTaskId}`,
      };
    }
    return {
      type: "service",
      id: `session:${this.context.sessionId ?? "workspace"}`,
    };
  }

  private fileListPage(input: {
    channelId: string;
    limit?: number;
    cursor?: string;
  }): SlackFilesListPage {
    const key = environmentsEncryptionKeyBytes(this.settings);
    if (!key) throw new Error("connection encryption is not configured");
    return resolveSlackFilesListPage(input, {
      connectionId: this.connection.id,
      key,
    });
  }

  private fileListCursor(input: { channelId: string; count: number; page: number }): string {
    const key = environmentsEncryptionKeyBytes(this.settings);
    if (!key) throw new Error("connection encryption is not configured");
    return createSlackFilesListCursor(input, {
      connectionId: this.connection.id,
      key,
    });
  }

  private async recordAudit(
    operation: SlackBotOperation,
    outcome: "succeeded" | "failed" | "ambiguous",
    failureCode?: string,
    operationId?: string,
  ): Promise<void> {
    await recordAuditEvent(this.db, {
      accountId: this.context.accountId,
      workspaceId: this.context.workspaceId,
      subjectId: this.context.subjectId,
      action: `slack_bot.${operation}`,
      targetType: "connection",
      targetId: this.connection.id,
      metadata: this.auditMetadata(operation, outcome, failureCode, operationId),
    });
  }

  private auditMetadata(
    operation: SlackBotOperation,
    outcome: "succeeded" | "failed" | "ambiguous",
    failureCode?: string,
    operationId?: string,
  ): Record<string, unknown> {
    return {
      ...this.receipt(operation, operationId),
      outcome,
      ...(failureCode ? { failureCode } : {}),
      ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
      ...(this.context.scheduledTaskId ? { scheduledTaskId: this.context.scheduledTaskId } : {}),
    };
  }
}

export function createOpenGeniSlackBotClient(
  deps: { db: Database; settings: Settings; slackFetch?: typeof fetch },
  resolved: Awaited<ReturnType<typeof resolveSlackBotConnectionForTool>>,
): OpenGeniSlackBotClient {
  return new OpenGeniSlackBotClient(
    deps.db,
    deps.settings,
    resolved.connection,
    resolved.metadata,
    resolved.context,
    deps.slackFetch,
  );
}

export async function createOpenGeniSlackBotInteractionClient(
  deps: { db: Database; settings: Settings; slackFetch?: typeof fetch },
  input: {
    accountId: string;
    workspaceId: string;
    connectionId: string;
    subjectId: string;
    sessionId?: string | null;
  },
): Promise<OpenGeniSlackBotClient> {
  const connection = await requireOpenGeniSlackBotConnection(
    deps.db,
    input.workspaceId,
    input.connectionId,
  );
  if (connection.accountId !== input.accountId) {
    throw new Error("OpenGeni Slack bot connection tenant mismatch");
  }
  const metadata = openGeniSlackBotMetadata(connection.metadata);
  if (!metadata) throw new Error("OpenGeni Slack bot connection metadata is invalid");
  return new OpenGeniSlackBotClient(
    deps.db,
    deps.settings,
    connection,
    metadata,
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      sessionId: input.sessionId ?? null,
      scheduledTaskId: null,
    },
    deps.slackFetch,
  );
}

async function slackApiFetch(
  fetchImpl: FetchLike,
  method: string,
  token: string,
  params: Record<string, string>,
) {
  return await slackApiFetchWithHeaders(
    fetchImpl,
    method,
    { authorization: `Bearer ${token}` },
    params,
  );
}

async function slackApiFetchWithHeaders(
  fetchImpl: FetchLike,
  method: string,
  credentialHeaders: Record<string, string>,
  params: Record<string, string>,
): Promise<{ response: Response; payload: SlackPayload }> {
  if (!/^[a-z]+\.[a-z]+$/i.test(method)) {
    throw new Error("invalid Slack API method");
  }
  const url = new URL(method, SLACK_API_BASE);
  const body = new URLSearchParams(params);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...credentialHeaders,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch {
    throw new SlackBotProviderError("transport_error");
  }
  if (!response.ok) {
    const retryAfterMs = slackRetryAfterMs(response);
    await response.body?.cancel().catch(() => undefined);
    throw new SlackBotProviderError(`http_${response.status}`, retryAfterMs);
  }
  let payload: SlackPayload;
  try {
    payload = await readResponseJsonBounded<SlackPayload>(
      response,
      SLACK_RESPONSE_MAX_BYTES,
      `Slack ${method} response`,
    );
  } catch {
    throw new SlackBotProviderError("invalid_response");
  }
  if (payload.ok !== true) {
    throw new SlackBotProviderError(slackString(payload.error) || "unknown_error");
  }
  return { response, payload };
}

function slackRetryAfterMs(response: Response): number | null {
  if (response.status !== 429) return null;
  const raw = response.headers.get("retry-after");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  return Math.min(seconds, 3_600) * 1_000;
}

function assertOpenGeniSlackBotScopes(grantedScopes: string[]): void {
  const policy = evaluateOpenGeniSlackBotScopes(grantedScopes);
  if (!policy.accepted) {
    const facts = [
      ...(policy.missingRequired.length ? [`missing: ${policy.missingRequired.join(", ")}`] : []),
      ...(policy.unsupported.length ? [`unsupported: ${policy.unsupported.join(", ")}`] : []),
    ];
    throw new SlackBotCredentialVerificationError(
      "scope_mismatch",
      `Slack bot scopes do not satisfy the OpenGeni manifest (${facts.join("; ")})`,
    );
  }
}

function parseGrantedScopes(header: string | null): string[] {
  if (!header) {
    throw new SlackBotCredentialVerificationError(
      "scope_mismatch",
      "Slack did not report granted bot scopes",
    );
  }
  return [
    ...new Set(
      header
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function projectChannel(value: unknown) {
  const channel = slackRecord(value);
  const id = slackString(channel?.id);
  if (!channel || !id) return null;
  return {
    id,
    name: boundedSlackString(channel.name, 256),
    isPrivate: channel.is_private === true,
    isMember: channel.is_member === true,
    isDirectMessage: channel.is_im === true,
    isArchived: channel.is_archived === true,
    isShared: channel.is_shared === true,
    isExternallyShared: channel.is_ext_shared === true,
    isOrgShared: channel.is_org_shared === true,
    topic: boundedSlackString(slackRecord(channel.topic)?.value, 1_024),
    purpose: boundedSlackString(slackRecord(channel.purpose)?.value, 1_024),
    numMembers:
      typeof channel.num_members === "number" && Number.isSafeInteger(channel.num_members)
        ? channel.num_members
        : null,
  };
}

function projectMessage(value: unknown) {
  const message = slackRecord(value) ?? {};
  return {
    timestamp: boundedSlackString(message.ts, 64),
    userId: boundedSlackString(message.user, 64),
    botId: boundedSlackString(message.bot_id, 64),
    threadTimestamp: boundedSlackString(message.thread_ts, 64),
    text: boundedSlackString(message.text, MAX_PROJECTED_TEXT),
    files: slackArray(message.files)
      .map(projectFile)
      .filter((file): file is NonNullable<typeof file> => file !== null),
  };
}

function selectSlackReactionContextMessages(
  messages: ReturnType<typeof projectMessage>[],
  reactedTimestamp: string,
) {
  if (messages.length <= MAX_REACTION_CONTEXT_MESSAGES) return messages;
  const reactedIndex = messages.findIndex((message) => message.timestamp === reactedTimestamp);
  if (reactedIndex < 0) return [];

  const selected = new Set<number>([0, reactedIndex]);
  for (
    let distance = 1;
    selected.size < MAX_REACTION_CONTEXT_MESSAGES && distance < messages.length;
    distance += 1
  ) {
    const before = reactedIndex - distance;
    const after = reactedIndex + distance;
    if (before > 0) selected.add(before);
    if (selected.size < MAX_REACTION_CONTEXT_MESSAGES && after < messages.length) {
      selected.add(after);
    }
  }
  for (let index = 0; selected.size < MAX_REACTION_CONTEXT_MESSAGES; index += 1) {
    if (index >= messages.length) break;
    selected.add(index);
  }
  return [...selected].sort((left, right) => left - right).map((index) => messages[index]!);
}

function projectFile(value: unknown) {
  const file = slackRecord(value);
  const id = slackString(file?.id);
  if (!file || !id) return null;
  const canvasMetadata = slackRecord(file.canvas_metadata);
  return {
    id,
    name: boundedSlackString(file.name, 512),
    title: boundedSlackString(file.title, 512),
    mimetype: boundedSlackString(file.mimetype, 256),
    filetype: boundedSlackString(file.filetype, 128),
    mode: boundedSlackString(file.mode, 64),
    size:
      typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0
        ? file.size
        : null,
    originatingHuddleId: boundedSlackString(canvasMetadata?.originating_huddle_id, 64),
    huddleTranscriptFileId: boundedSlackString(file.huddle_transcript_file_id, 64),
  };
}

function parentReferencesSlackFile(
  parentFile: Record<string, unknown>,
  childFileId: string,
): boolean {
  if (slackString(parentFile.huddle_transcript_file_id) === childFileId) {
    return true;
  }
  return slackArray(parentFile.embedded_file_ids).some(
    (candidate) => slackString(candidate) === childFileId,
  );
}

function fileIsSharedToChannel(file: Record<string, unknown>, channelId: string): boolean {
  if (
    [file.channels, file.groups, file.ims].some((value) =>
      slackArray(value).some((candidate) => slackString(candidate) === channelId),
    )
  ) {
    return true;
  }
  const shares = slackRecord(file.shares);
  return ["public", "private"].some((visibility) => {
    const byChannel = slackRecord(shares?.[visibility]);
    return Boolean(byChannel && Object.hasOwn(byChannel, channelId));
  });
}

function privateSlackFileUrl(file: Record<string, unknown>): URL | null {
  const raw = slackString(file.url_private_download) || slackString(file.url_private);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    assertPrivateSlackFileUrl(url);
    return url;
  } catch {
    throw new SlackBotProviderError("invalid_file_url");
  }
}

function assertPrivateSlackFileUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "slack.com" && !hostname.endsWith(".slack.com"))) {
    throw new Error("Slack file URL must use HTTPS on slack.com");
  }
  if (url.username || url.password) {
    throw new Error("Slack file URL must not contain credentials");
  }
}

function isSlackInteractiveFileRedirect(url: URL): boolean {
  return url.pathname === "/" && url.searchParams.has("redir");
}

function normalizedContentType(value: string | null): string {
  return (value ?? "application/octet-stream").split(";", 1)[0]!.trim().toLowerCase();
}

function isSupportedSlackTextContentType(value: string): boolean {
  return (
    value.startsWith("text/") ||
    value === "application/json" ||
    value === "application/xml" ||
    value === "application/xhtml+xml" ||
    value === "application/vnd.slack-docs" ||
    value === "application/vnd.slack-huddle-transcript"
  );
}

function embeddedHuddleTranscription(
  fileRecord: Record<string, unknown>,
  parentFileRecord: Record<string, unknown> | null,
): { contentType: string; content: string } | null {
  for (const record of [fileRecord, parentFileRecord]) {
    if (!record) continue;
    const transcription = slackRecord(record.huddle_transcription);
    if (!transcription) continue;
    const content = JSON.stringify(transcription);
    if (content !== "{}") {
      return { contentType: "application/json", content };
    }
  }
  return null;
}

function embeddedSlackFileIds(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/\bFile ID:\s*sf:([A-Z][A-Z0-9]{4,63})\b/g)].map((match) => match[1]!),
  );
}

function projectUser(value: unknown) {
  const user = slackRecord(value);
  const id = slackString(user?.id);
  if (!user || !id) return null;
  const profile = slackRecord(user.profile);
  return {
    id,
    name: boundedSlackString(user.name, 256),
    displayName: boundedSlackString(profile?.display_name, 256),
    realName: boundedSlackString(profile?.real_name, 256),
    isBot: user.is_bot === true,
    deleted: user.deleted === true,
  };
}

function responseCursor(payload: SlackPayload): string | null {
  return boundedSlackString(slackRecord(payload.response_metadata)?.next_cursor, 1_024) || null;
}

export function resolveSlackFilesListPage(
  input: { channelId: string; limit?: number; cursor?: string },
  context: SlackFilesCursorContext,
): SlackFilesListPage {
  const requestedCount = boundedInt(input.limit, MAX_FILE_PAGE, 100);
  if (!input.cursor) return { count: requestedCount, page: 1 };
  if (input.cursor.length > MAX_FILE_CURSOR_LENGTH) {
    throw new SlackBotProviderError("invalid_files_cursor");
  }
  const [version, encoded, signature, extra] = input.cursor.split(".");
  if (
    version !== SLACK_FILE_CURSOR_VERSION ||
    !encoded ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  ) {
    throw new SlackBotProviderError("invalid_files_cursor");
  }
  const expectedSignature = createHmac("sha256", context.key).update(encoded).digest();
  const receivedSignature = Buffer.from(signature, "base64url");
  if (
    receivedSignature.toString("base64url") !== signature ||
    receivedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new SlackBotProviderError("invalid_files_cursor");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw new Error("non-canonical cursor");
    }
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SlackBotProviderError("invalid_files_cursor");
  }
  const cursor = slackRecord(decoded);
  if (
    !cursor ||
    Object.keys(cursor).sort().join(",") !== "channelId,connectionId,count,page" ||
    cursor.connectionId !== context.connectionId ||
    cursor.channelId !== input.channelId ||
    !positiveSafeInt(cursor.count) ||
    cursor.count > MAX_FILE_PAGE ||
    !positiveSafeInt(cursor.page) ||
    (input.limit !== undefined && requestedCount !== cursor.count)
  ) {
    throw new SlackBotProviderError("invalid_files_cursor");
  }
  return { count: cursor.count, page: cursor.page };
}

export function createSlackFilesListCursor(
  input: { channelId: string; count: number; page: number },
  context: SlackFilesCursorContext,
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      connectionId: context.connectionId,
      channelId: input.channelId,
      count: input.count,
      page: input.page,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", context.key).update(encoded).digest("base64url");
  return `${SLACK_FILE_CURSOR_VERSION}.${encoded}.${signature}`;
}

export function nextSlackFilesListPage(
  payload: SlackPayload,
  requested: SlackFilesListPage,
  returnedFileCount: number,
): number | null {
  const responseMetadata = slackRecord(payload.response_metadata);
  const paging = slackRecord(payload.paging);
  if (responseMetadata && Object.hasOwn(responseMetadata, "next_cursor")) {
    throw new SlackBotProviderError("invalid_files_paging");
  }
  const count = paging?.count;
  const total = paging?.total;
  const page = paging?.page;
  const pages = paging?.pages;
  if (
    !positiveSafeInt(count) ||
    !nonNegativeSafeInt(total) ||
    !positiveSafeInt(page) ||
    !nonNegativeSafeInt(pages) ||
    count !== requested.count ||
    page !== requested.page ||
    returnedFileCount > count ||
    pages !== (total === 0 ? 0 : Math.ceil(total / count)) ||
    page > Math.max(1, pages)
  ) {
    throw new SlackBotProviderError("invalid_files_paging");
  }
  if (page >= pages) return null;
  const nextPage = page + 1;
  if (!positiveSafeInt(nextPage)) {
    throw new SlackBotProviderError("invalid_files_paging");
  }
  return nextPage;
}

function slackMethodForOperation(operation: SlackBotOperation): string {
  switch (operation) {
    case "channels.list":
      return "conversations.list";
    case "channel_history.read":
      return "conversations.history";
    case "thread_replies.read":
      return "conversations.replies";
    case "users.list":
      return "users.list";
    case "files.list":
      return "files.list";
    case "file.info":
    case "file.content.read":
      return "files.info";
    case "message.post":
      return "chat.postMessage";
    case "message.delete":
      return "chat.delete";
  }
}

function boundedInt(value: number | undefined, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function positiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function slackArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function slackRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function slackString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredSlackString(value: unknown, field: string): string {
  const result = slackString(value);
  if (!result || result.length > 256) {
    throw new SlackBotProviderError(`invalid_${field.replaceAll(".", "_")}`);
  }
  return result;
}

function boundedSlackString(value: unknown, max: number): string {
  return slackString(value).slice(0, max);
}

function safeSlackCode(value: string): string {
  return /^[a-z0-9_.:-]{1,128}$/i.test(value) ? value : "unknown_error";
}

function safeFailureCode(error: unknown): string {
  if (error instanceof SlackBotProviderError) return safeSlackCode(error.code);
  return "local_validation_failed";
}

function slackMutationOutcomeMayBeAmbiguous(error: unknown): boolean {
  if (!(error instanceof SlackBotProviderError)) return true;
  return (
    error.code === "transport_error" ||
    error.code === "invalid_response" ||
    error.code.startsWith("http_")
  );
}
