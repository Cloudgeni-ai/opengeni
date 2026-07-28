import { createHmac } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_FORBIDDEN_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  type AccessGrant,
  type ConnectionMetadata,
  type OpenGeniSlackBotConnectionMetadata,
} from "@opengeni/contracts";
import {
  isTrustedScheduledSlackBotSession,
  openGeniSlackBotMetadata,
  requireOpenGeniSlackBotConnection,
  scheduledSlackBotConnectionId,
} from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  claimSlackBotPostOperation,
  completeSlackBotPostOperation,
  getSession,
  recordAuditEvent,
  releaseSlackBotPostOperationClaim,
  type Database,
} from "@opengeni/db";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";

const SLACK_API_BASE = "https://slack.com/api/";
const SLACK_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const SLACK_TIMEOUT_MS = 10_000;
const MAX_CHANNEL_PAGE = 200;
const MAX_HISTORY_PAGE = 100;
const MAX_USER_PAGE = 200;
const MAX_PROJECTED_TEXT = 4_000;
const SLACK_POST_CLAIM_LEASE_MS = 30_000;

type SlackPayload = Record<string, unknown> & { ok?: unknown; error?: unknown };

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
    throw new HTTPException(502, { message: "Slack installation token exchange failed" });
  }
  if (!response.ok) {
    throw new HTTPException(502, { message: "Slack installation token exchange failed" });
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
    throw new HTTPException(502, { message: "Slack installation did not return a bot token" });
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

type SlackBotOperation = "channels.list" | "channel_history.read" | "users.list" | "message.post";

type SlackBotContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  sessionId?: string | null;
  scheduledTaskId?: string | null;
};

export class SlackBotProviderError extends Error {
  constructor(readonly code: string) {
    super(`Slack bot request failed: ${safeSlackCode(code)}`);
    this.name = "SlackBotProviderError";
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
  assertExactOpenGeniSlackBotScopes(grantedScopes);
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
    throw new HTTPException(422, { message: "Slack credential must identify an active bot user" });
  }
  const profile = slackRecord(user.profile);
  const displayName = slackString(profile?.display_name) || slackString(profile?.real_name);
  if (displayName !== "OpenGeni") {
    throw new HTTPException(422, {
      message: 'Slack bot display name must be exactly "OpenGeni"',
    });
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
  const connectionId = boundConnectionId ?? input.requestedConnectionId;
  if (!connectionId) {
    throw new Error("connectionId is required outside a Slack-bot-bound scheduled session");
  }
  if (!boundConnectionId && !input.grant.permissions.includes("connections:read")) {
    throw new Error("connections:read is required to select an OpenGeni Slack bot connection");
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

  async postMessage(input: {
    operationId: string;
    channelId?: string;
    userId?: string;
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
        const opened = await this.call(headers, "conversations.open", { users: input.userId });
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
        return this.completedPostResult(claim.operation, input.operationId);
      }
      claimAcquired = true;
      providerCallStarted = true;
      const posted = await this.call(headers, "chat.postMessage", {
        channel: channelId,
        text: input.text,
        client_msg_id: input.operationId,
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
      return this.completedPostResult(completed.operation, input.operationId);
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
        providerCallStarted && slackPostOutcomeMayBeAmbiguous(error) ? "ambiguous" : "failed",
        failureCode,
        input.operationId,
      );
      throw error;
    }
  }

  private async requireMemberChannel(headers: Record<string, string>, channelId: string) {
    const payload = await this.call(headers, "conversations.info", { channel: channelId });
    const projected = projectChannel(payload.channel);
    if (!projected || projected.isMember !== true) {
      throw new SlackBotProviderError("not_in_channel");
    }
    return projected;
  }

  private async call(
    headers: Record<string, string>,
    method: string,
    params: Record<string, string>,
  ): Promise<SlackPayload> {
    return (await slackApiFetchWithHeaders(this.fetchImpl, method, headers, params)).payload;
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
      destinationUrl: `${SLACK_API_BASE}${slackMethodForOperation(operation)}`,
    });
    if (result.status !== "ok" || result.connectionId !== this.connection.id) {
      throw new Error("OpenGeni Slack bot connection needs to be reinstalled");
    }
    return result.headers;
  }

  private receipt(operation: SlackBotOperation, operationId?: string): SlackBotReceipt {
    return {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      connectionId: this.connection.id,
      slackTeamId: this.metadata.slackTeamId,
      operation,
      ...(operationId ? { operationId, clientMessageId: operationId } : {}),
    };
  }

  private completedPostResult(
    operation: {
      slackChannelId: string | null;
      slackMessageTimestamp: string | null;
    },
    operationId: string,
  ) {
    if (!operation.slackChannelId || !operation.slackMessageTimestamp) {
      throw new Error("completed Slack post operation is missing its provider result");
    }
    return {
      channelId: operation.slackChannelId,
      timestamp: operation.slackMessageTimestamp,
      receipt: this.receipt("message.post", operationId),
    };
  }

  private postRequestDigest(input: {
    operationId: string;
    targetKind: "channel" | "user";
    targetId: string;
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
          text: input.text,
        }),
      )
      .digest("hex");
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
    await response.body?.cancel().catch(() => undefined);
    throw new SlackBotProviderError(`http_${response.status}`);
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

function assertExactOpenGeniSlackBotScopes(grantedScopes: string[]): void {
  const required = new Set<string>(OPENGENI_SLACK_BOT_REQUIRED_SCOPES);
  const granted = new Set(grantedScopes);
  const missing = [...required].filter((scope) => !granted.has(scope));
  const forbidden = OPENGENI_SLACK_BOT_FORBIDDEN_SCOPES.filter((scope) => granted.has(scope));
  const unsupported = grantedScopes.filter((scope) => !required.has(scope));
  if (missing.length || forbidden.length || unsupported.length) {
    const facts = [
      ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
      ...(forbidden.length ? [`forbidden: ${forbidden.join(", ")}`] : []),
      ...(unsupported.length ? [`unsupported: ${unsupported.join(", ")}`] : []),
    ];
    throw new HTTPException(422, {
      message: `Slack bot scopes must exactly match the OpenGeni manifest (${facts.join("; ")})`,
    });
  }
}

function parseGrantedScopes(header: string | null): string[] {
  if (!header) {
    throw new HTTPException(422, { message: "Slack did not report granted bot scopes" });
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
    isArchived: channel.is_archived === true,
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
  };
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

function slackMethodForOperation(operation: SlackBotOperation): string {
  switch (operation) {
    case "channels.list":
      return "conversations.list";
    case "channel_history.read":
      return "conversations.history";
    case "users.list":
      return "users.list";
    case "message.post":
      return "chat.postMessage";
  }
}

function boundedInt(value: number | undefined, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
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

function slackPostOutcomeMayBeAmbiguous(error: unknown): boolean {
  if (!(error instanceof SlackBotProviderError)) return true;
  return (
    error.code === "transport_error" ||
    error.code === "invalid_response" ||
    error.code.startsWith("http_")
  );
}
