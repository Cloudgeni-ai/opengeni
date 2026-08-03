import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  hasOpenGeniSlackReactionScope,
  resolveWorkspaceSlackReactionSummonSettings,
  SlackReactionChannelListResponse,
  type AccessGrant,
  type FirstPartyMcpToolName,
  type HumanInputQuestion,
  type SessionEvent,
  type WorkspaceSlackReactionSummonSettings,
  workspaceSlackReactionChannelAllowed,
} from "@opengeni/contracts";
import {
  acceptSessionHumanInputResponse,
  advanceSlackInteractionDelivery,
  bindSlackInteractionSession,
  claimSlackInteractionDelivery,
  claimSlackInteractionProgressDelivery,
  claimSlackInteractionInbox,
  closeSlackInteractionDelivery,
  deferSlackInteractionDelivery,
  deleteSlackBotUserLink,
  enqueueSlackInteractionInbox,
  getConnectionMetadata,
  getOrCreateSlackInteraction,
  getLatestSessionModelForSubject,
  getSlackBotUserLink,
  getSlackInteractionByRoute,
  getWorkspace,
  getWorkspaceGrant,
  listSessionEventPage,
  listSessionHumanInputRequests,
  rekeySlackInteractionRoute,
  reopenSlackInteractionDelivery,
  releaseSlackInteractionDelivery,
  releaseSlackInteractionInbox,
  resolveSlackInstallationRoute,
  saveSlackBotUserLink,
  saveSlackInteractionInboxReactionCheckpoint,
  settleSlackInteractionInbox,
  type SlackInstallationRoute,
  type SlackInteraction,
  type SlackInteractionInboxEntry,
  type SlackInteractionTriggerKind,
} from "@opengeni/db";
import {
  acceptSessionUserMessage,
  controlHumanSessionWorkstream,
  createSessionForRequest,
  hasPermission,
  requireAccessGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import { publishDurableSessionEvents } from "@opengeni/events";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createOpenGeniSlackBotInteractionClient,
  type OpenGeniSlackBotClient,
  SlackBotProviderError,
} from "./slack-bot";

export const SLACK_INTERACTION_MAX_BODY_BYTES = 256 * 1024;
export const SLACK_SIGNATURE_REPLAY_WINDOW_SECONDS = 300;
export const SLACK_DELIVERY_EVENT_TYPES = [
  "agent.message.completed",
  "session.humanInput.requested",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.status.changed",
] as const;

const MAX_SLACK_TEXT_CHARS = 3_500;
const MAX_SLACK_INPUT_CHARS = 8_000;
const MAX_SLACK_REACTION_CONTEXT_MESSAGES = 15;
const MAX_SLACK_REACTION_FILE_SUMMARY_CHARS = 1_500;
const MAX_PROGRESS_MESSAGES = 3;
const SLACK_USER_LINK_TTL_MS = 15 * 60_000;
const INBOX_LEASE_MS = 30_000;
const DELIVERY_LEASE_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_DELIVERY_RETRY_MS = 5 * 60_000;
export const SLACK_TASK_INSTRUCTIONS = [
  "This turn originated from Slack. Slack message and thread context is task-local only.",
  "Do not write Slack context to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy unless a separate explicit authorized user action requests it.",
  "Never expose private reasoning, credentials, secrets, raw logs, or unbounded output.",
  "Keep user-visible output concise, bounded, and safe to send back to Slack.",
].join(" ");

/**
 * Slack-originated tasks may retrieve the workspace bot's bounded read surface
 * on demand. Connector tools are explicit-only, so freeze that narrow context
 * selection at session creation while keeping Slack mutations out of the model
 * surface; interaction delivery remains owned by the durable delivery pump.
 */
export const SLACK_TASK_FIRST_PARTY_MCP_TOOLS = [
  ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
  "slack_bot_list_channels",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
] satisfies readonly FirstPartyMcpToolName[];

export type NormalizedSlackInteraction = {
  providerEventId: string;
  providerMessageId: string;
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  slackMessageTs: string;
  slackThreadTs: string | null;
  triggerKind: SlackInteractionTriggerKind;
  text: string;
};

export function verifySlackRequestSignature(
  input: {
    timestamp: string | null;
    signature: string | null;
    rawBody: string;
  },
  signingSecret: string,
  nowMs = Date.now(),
): boolean {
  if (
    !/^\d{1,16}$/.test(input.timestamp ?? "") ||
    !/^v0=[0-9a-f]{64}$/.test(input.signature ?? "")
  ) {
    return false;
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestamp) > SLACK_SIGNATURE_REPLAY_WINDOW_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest("hex")}`;
  const actualBytes = Buffer.from(input.signature!, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function slackEventInboxEntry(
  payload: unknown,
  bot: Pick<SlackInstallationRoute, "botId" | "botUserId">,
): NormalizedSlackInteraction | null {
  const envelope = record(payload);
  if (!envelope || envelope.type !== "event_callback") return null;
  const event = record(envelope.event);
  const teamId = boundedString(envelope.team_id, 64);
  const eventId = boundedString(envelope.event_id, 256);
  if (!event || !teamId || !eventId) return null;
  if (event.bot_id || event.bot_profile || event.subtype || event.user === bot.botUserId)
    return null;
  const userId = boundedString(event.user, 64);
  const channelId = boundedString(event.channel, 64);
  const timestamp = boundedString(event.ts, 64);
  const threadTimestamp = boundedString(event.thread_ts, 64);
  const text = boundedText(event.text);
  if (!userId || !channelId || !timestamp || !text) return null;
  let triggerKind: SlackInteractionTriggerKind;
  if (event.type === "app_mention") {
    // A mention is always an explicit invocation. In particular, a mention in
    // an otherwise-unmapped existing thread adopts that thread as the new
    // OpenGeni session surface; only ordinary message replies require a
    // pre-existing route.
    triggerKind = "app_mention";
  } else if (event.type === "message" && threadTimestamp) {
    triggerKind = "thread_reply";
  } else if (event.type === "message" && event.channel_type === "im") {
    triggerKind = "dm";
  } else {
    return null;
  }
  return {
    providerEventId: eventId,
    providerMessageId: `${teamId}:${channelId}:${timestamp}`,
    slackTeamId: teamId,
    slackUserId: userId,
    slackChannelId: channelId,
    slackMessageTs: timestamp,
    slackThreadTs: threadTimestamp,
    triggerKind,
    text,
  };
}

export function slackReactionInboxEntry(
  payload: unknown,
  bot: Pick<SlackInstallationRoute, "botUserId">,
  settings: WorkspaceSlackReactionSummonSettings,
): NormalizedSlackInteraction | null {
  const envelope = record(payload);
  if (!envelope || envelope.type !== "event_callback") return null;
  const event = record(envelope.event);
  const item = record(event?.item);
  const teamId = boundedString(envelope.team_id, 64);
  const eventId = boundedString(envelope.event_id, 256);
  const userId = boundedString(event?.user, 64);
  const reaction = boundedString(event?.reaction, 64);
  const channelId = boundedString(item?.channel, 64);
  const timestamp = boundedString(item?.ts, 64);
  if (
    !settings.enabled ||
    !event ||
    event.type !== "reaction_added" ||
    item?.type !== "message" ||
    !teamId ||
    !eventId ||
    !userId ||
    userId === bot.botUserId ||
    !reaction ||
    reaction !== settings.emoji ||
    !channelId ||
    !workspaceSlackReactionChannelAllowed(settings, channelId) ||
    !timestamp
  ) {
    return null;
  }
  const stableReactionIdentity = createHash("sha256")
    .update([teamId, userId, channelId, timestamp, reaction].join("\n"))
    .digest("hex");
  return {
    providerEventId: eventId,
    providerMessageId: `reaction:${stableReactionIdentity}`,
    slackTeamId: teamId,
    slackUserId: userId,
    slackChannelId: channelId,
    slackMessageTs: timestamp,
    slackThreadTs: null,
    triggerKind: "reaction",
    // Store only the exact emoji name before authorization/content fetch. The
    // provider message and bounded thread are projected at durable claim time.
    text: reaction,
  };
}

export function registerSlackInteractionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/integrations/slack/events", async (c) => {
    const signed = await readSignedSlackRequest(c, deps);
    const payload = parseJsonObject(signed.rawBody);
    if (payload.type === "url_verification") {
      const challenge = boundedString(payload.challenge, 512);
      if (!challenge) throw new HTTPException(400, { message: "invalid Slack challenge" });
      return c.json({ challenge });
    }
    const teamId = boundedString(payload.team_id, 64);
    if (!teamId) throw new HTTPException(400, { message: "invalid Slack event" });
    const installation = await resolveSlackInstallationRoute(deps.db, teamId);
    if (!installation)
      throw new HTTPException(403, {
        message: "Slack installation unavailable",
      });
    const event = record(payload.event);
    if (event?.type === "reaction_added") {
      const [workspace, connection] = await Promise.all([
        getWorkspace(deps.db, installation.workspaceId),
        getConnectionMetadata(deps.db, installation.workspaceId, installation.connectionId, null),
      ]);
      if (!workspace || !connection || !hasOpenGeniSlackReactionScope(connection.grantedScopes)) {
        return c.json({ ok: true });
      }
      const reactionEntry = slackReactionInboxEntry(
        payload,
        installation,
        resolveWorkspaceSlackReactionSummonSettings(workspace.settings),
      );
      if (reactionEntry) {
        await enqueueNormalizedSlackInteraction(deps, installation, reactionEntry);
      }
      return c.json({ ok: true });
    }
    const entry = slackEventInboxEntry(payload, installation);
    if (entry) await enqueueNormalizedSlackInteraction(deps, installation, entry);
    return c.json({ ok: true });
  });

  app.post("/v1/integrations/slack/commands", async (c) => {
    const signed = await readSignedSlackRequest(c, deps);
    const form = new URLSearchParams(signed.rawBody);
    if (form.get("command") !== "/opengeni") {
      throw new HTTPException(400, { message: "invalid Slack command" });
    }
    const entry = normalizedFormInteraction(form, "slash_command");
    const installation = await resolveSlackInstallationRoute(deps.db, entry.slackTeamId);
    if (!installation)
      throw new HTTPException(403, {
        message: "Slack installation unavailable",
      });
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: installation.accountId,
      workspaceId: installation.workspaceId,
      connectionId: installation.connectionId,
      subjectId: "service:slack-interaction",
    });
    try {
      await client.verifyChannelAccess(entry.slackChannelId);
    } catch (error) {
      if (error instanceof SlackBotProviderError && error.code === "not_in_channel") {
        return c.text(
          "OpenGeni is not a member of this channel. Add @OpenGeni, then run /opengeni again.",
          200,
        );
      }
      // Slash commands are not replayed through the Events API. A transient
      // membership preflight failure must therefore fall through to the
      // durable inbox, whose normal claim/backoff path retries the same task.
      // Permanent provider/local failures remain an honest request failure.
      if (!(error instanceof SlackBotProviderError) || permanentSlackDeliveryError(error)) {
        throw error;
      }
    }
    await enqueueNormalizedSlackInteraction(deps, installation, entry);
    return c.text("OpenGeni accepted this task and will reply in a thread.", 200);
  });

  app.post("/v1/integrations/slack/interactions", async (c) => {
    const signed = await readSignedSlackRequest(c, deps);
    const form = new URLSearchParams(signed.rawBody);
    const payload = parseJsonObject(form.get("payload") ?? "");
    if (payload.type !== "message_action") {
      throw new HTTPException(400, {
        message: "unsupported Slack interaction",
      });
    }
    const team = record(payload.team);
    const user = record(payload.user);
    const channel = record(payload.channel);
    const message = record(payload.message);
    const triggerId = boundedString(payload.trigger_id, 256);
    const teamId = boundedString(team?.id, 64);
    const userId = boundedString(user?.id, 64);
    const channelId = boundedString(channel?.id, 64);
    const messageTs = boundedString(message?.ts, 64);
    const threadTs = boundedString(message?.thread_ts, 64);
    const text = boundedText(message?.text);
    if (!triggerId || !teamId || !userId || !channelId || !messageTs || !text) {
      throw new HTTPException(400, {
        message: "invalid Slack message shortcut",
      });
    }
    const installation = await resolveSlackInstallationRoute(deps.db, teamId);
    if (!installation)
      throw new HTTPException(403, {
        message: "Slack installation unavailable",
      });
    await enqueueNormalizedSlackInteraction(deps, installation, {
      providerEventId: `shortcut:${triggerId}`,
      providerMessageId: `shortcut:${triggerId}`,
      slackTeamId: teamId,
      slackUserId: userId,
      slackChannelId: channelId,
      slackMessageTs: messageTs,
      slackThreadTs: threadTs,
      triggerKind: "message_shortcut",
      text,
    });
    return c.json({ ok: true });
  });

  app.post("/v1/workspaces/:workspaceId/integrations/slack/user-links", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const body = record(await c.req.json().catch(() => null));
    const linkToken = boundedString(body?.linkToken, 2_048);
    const signingSecret = deps.settings.slackSigningSecret;
    const link =
      linkToken && signingSecret ? verifySlackUserLinkToken(signingSecret, linkToken) : null;
    if (!link || link.workspaceId !== workspaceId) {
      throw new HTTPException(400, {
        message: "invalid or expired Slack identity link",
      });
    }
    const route = await resolveSlackInstallationRoute(deps.db, link.slackTeamId);
    if (!route || route.workspaceId !== workspaceId || route.connectionId !== link.connectionId) {
      throw new HTTPException(404, {
        message: "Slack installation not found",
      });
    }
    return c.json(
      await saveSlackBotUserLink(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        connectionId: link.connectionId,
        slackTeamId: link.slackTeamId,
        slackUserId: link.slackUserId,
        subjectId: grant.subjectId,
        linkedBySubjectId: grant.subjectId,
      }),
      201,
    );
  });

  app.delete(
    "/v1/workspaces/:workspaceId/integrations/slack/user-links/:slackUserId",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      await requireAccessGrant(c, deps, workspaceId, "connections:write");
      const connectionId = boundedString(c.req.query("connectionId"), 64);
      if (!connectionId) throw new HTTPException(400, { message: "connectionId is required" });
      return c.json({
        deleted: await deleteSlackBotUserLink(
          deps.db,
          workspaceId,
          connectionId,
          c.req.param("slackUserId"),
        ),
      });
    },
  );

  app.get("/v1/workspaces/:workspaceId/integrations/slack/reaction-channels", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const connectionId = boundedString(c.req.query("connectionId"), 64);
    if (!connectionId) throw new HTTPException(400, { message: "connectionId is required" });
    const cursor = boundedString(c.req.query("cursor"), 1_024);
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: grant.accountId,
      workspaceId,
      connectionId,
      subjectId: grant.subjectId,
    });
    const result = await client.listChannels({
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    return c.json(
      SlackReactionChannelListResponse.parse({
        channels: result.channels
          .filter(
            (channel) =>
              channel.isMember &&
              !channel.isArchived &&
              !channel.isShared &&
              !channel.isExternallyShared &&
              !channel.isOrgShared,
          )
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            isPrivate: channel.isPrivate,
          })),
        nextCursor: result.nextCursor || null,
      }),
    );
  });
}

export async function drainSlackInteractionsOnce(deps: ApiRouteDeps): Promise<boolean> {
  const holder = crypto.randomUUID();
  const entry = await claimSlackInteractionInbox(deps.db, holder, INBOX_LEASE_MS);
  if (entry) {
    try {
      await processSlackInboxEntry(deps, entry);
      await settleSlackInteractionInbox(deps.db, {
        entry,
        claimHolderId: holder,
        outcome: "processed",
      });
    } catch (error) {
      const code = safeErrorCode(error);
      console.error("[slack-interactions] inbox processing failed", {
        workspaceId: entry.workspaceId,
        connectionId: entry.connectionId,
        providerEventId: entry.providerEventId,
        triggerKind: entry.triggerKind,
        attemptCount: entry.attemptCount,
        errorCode: code,
      });
      if (
        entry.attemptCount >= 5 ||
        permanentSlackInteractionError(error) ||
        permanentSlackDeliveryError(error)
      ) {
        await settleSlackInteractionInbox(deps.db, {
          entry,
          claimHolderId: holder,
          outcome: "failed",
          errorCode: code,
        });
      } else {
        await releaseSlackInteractionInbox(deps.db, {
          entry,
          claimHolderId: holder,
          errorCode: code,
          retryAt: new Date(Date.now() + slackDeliveryRetryMs(error, entry.attemptCount)),
        });
      }
    }
    return true;
  }

  const deliveryHolder = crypto.randomUUID();
  const interaction = await claimSlackInteractionDelivery(
    deps.db,
    deliveryHolder,
    DELIVERY_LEASE_MS,
  );
  if (!interaction) return false;
  try {
    await deliverSlackSessionEvents(deps, interaction, deliveryHolder);
  } catch (error) {
    const errorCode = slackDeliveryErrorCode(error);
    if (
      interaction.deliveryAttemptCount >= MAX_DELIVERY_ATTEMPTS ||
      permanentSlackDeliveryError(error)
    ) {
      await closeSlackInteractionDelivery(deps.db, {
        ...interaction,
        claimHolderId: deliveryHolder,
        sequence: interaction.lastDeliveredSessionEventSequence,
        state: "failed",
        errorCode,
      }).catch(() => undefined);
    } else {
      await deferSlackInteractionDelivery(deps.db, {
        ...interaction,
        claimHolderId: deliveryHolder,
        retryAt: new Date(
          Date.now() + slackDeliveryRetryMs(error, interaction.deliveryAttemptCount),
        ),
        errorCode,
      }).catch(() => undefined);
    }
  }
  return true;
}

export function startSlackInteractionPump(
  deps: ApiRouteDeps,
  options: { intervalMs?: number; maxPerTick?: number } = {},
): () => void {
  let stopped = false;
  let running = false;
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
  const maxPerTick = Math.max(1, Math.min(50, options.maxPerTick ?? 10));
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let index = 0; index < maxPerTick; index += 1) {
        if (!(await drainSlackInteractionsOnce(deps))) break;
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function processSlackInboxEntry(deps: ApiRouteDeps, entry: SlackInteractionInboxEntry) {
  if (entry.triggerKind === "reaction") {
    await processSlackReactionInboxEntry(deps, entry);
    return;
  }
  const routeKey = slackRouteKey(entry.slackChannelId, entry.slackThreadTs ?? entry.slackMessageTs);
  const existing = await getSlackInteractionByRoute(
    deps.db,
    entry.workspaceId,
    entry.connectionId,
    routeKey,
  );
  if (entry.triggerKind === "thread_reply" && !existing) return;

  const link = await getSlackBotUserLink(
    deps.db,
    entry.workspaceId,
    entry.connectionId,
    entry.slackUserId,
  );
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    accountId: entry.accountId,
    workspaceId: entry.workspaceId,
    connectionId: entry.connectionId,
    subjectId: link?.subjectId ?? "service:slack-interaction",
    ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
  });
  await client.verifyChannelAccess(entry.slackChannelId);
  if (!link) {
    await client.postMessage({
      operationId: deterministicUuid(`slack-link:${entry.id}`),
      userId: entry.slackUserId,
      text: `Link your Slack identity to OpenGeni before starting work: ${linkUrl(deps, entry)}. No session was created.`,
    });
    return;
  }
  const grant = await getWorkspaceGrant(deps.db, link.subjectId, entry.workspaceId, {
    principalKind: "human_session",
  });
  if (!grant || grant.accountId !== entry.accountId) {
    throw new SlackInteractionPermanentError("identity_access_revoked");
  }

  if (existing?.sessionId) {
    await continueSlackSession(deps, grant, existing, entry);
    return;
  }
  if (!hasPermission(grant.permissions, "sessions:create")) {
    throw new SlackInteractionPermanentError("sessions_create_denied");
  }
  const { interaction } = await getOrCreateSlackInteraction(deps.db, {
    accountId: entry.accountId,
    workspaceId: entry.workspaceId,
    connectionId: entry.connectionId,
    slackTeamId: entry.slackTeamId,
    slackChannelId: entry.slackChannelId,
    slackThreadTs: entry.slackThreadTs ?? entry.slackMessageTs,
    routeKey,
    triggeringProviderEventId: entry.providerEventId,
    owningSubjectId: grant.subjectId,
    visibility: entry.triggerKind === "dm" ? "private" : "workspace",
  });
  if (interaction.sessionId) {
    await continueSlackSession(deps, grant, interaction, entry);
    return;
  }
  const preferredModel = await getLatestSessionModelForSubject(
    deps.db,
    entry.workspaceId,
    grant.subjectId,
  );
  let session: Awaited<ReturnType<typeof createSessionForRequest>>;
  try {
    session = await createSessionForRequest(deps, grant, entry.workspaceId, {
      requestedSessionId: interaction.sessionReservationId,
      initialMessage: entry.text,
      turnInstructions: SLACK_TASK_INSTRUCTIONS,
      firstPartyMcpTools: [...SLACK_TASK_FIRST_PARTY_MCP_TOOLS],
      ...(preferredModel ? { model: preferredModel } : {}),
      idempotencyKey: `slack:${entry.connectionId}:${entry.providerEventId}`,
      clientEventId: `slack:${entry.providerEventId}`,
    });
  } catch (error) {
    if (error instanceof HTTPException) {
      await client.postMessage({
        operationId: deterministicUuid(`slack-admission-failed:${interaction.id}`),
        channelId: entry.slackChannelId,
        ...(entry.triggerKind === "slash_command"
          ? {}
          : { threadTimestamp: entry.slackThreadTs ?? entry.slackMessageTs }),
        text: slackAdmissionFailureText(error),
      });
    }
    throw error;
  }
  const bound = await bindSlackInteractionSession(deps.db, {
    ...interaction,
    owningSubjectId: grant.subjectId,
    sessionId: session.id,
  });
  if (!bound) throw new Error("Slack route could not bind its durable session");
  const ack = await client.postMessage({
    operationId: deterministicUuid(`slack-ack:${interaction.id}`),
    channelId: entry.slackChannelId,
    ...(entry.triggerKind === "slash_command"
      ? {}
      : { threadTimestamp: entry.slackThreadTs ?? entry.slackMessageTs }),
    text: `OpenGeni started this task. ${openSessionText(deps, entry.workspaceId, session.id)} Reply in this thread to continue, or reply \`stop\` to stop. Start a new top-level DM or invoke /opengeni again for a new session.`,
  });
  if (entry.triggerKind === "slash_command") {
    await rekeySlackInteractionRoute(deps.db, {
      ...interaction,
      routeKey: slackRouteKey(entry.slackChannelId, ack.timestamp),
      slackThreadTs: ack.timestamp,
      ackSlackMessageTs: ack.timestamp,
    });
  }
}

async function processSlackReactionInboxEntry(
  deps: ApiRouteDeps,
  entry: SlackInteractionInboxEntry,
) {
  const [workspace, connection, link] = await Promise.all([
    getWorkspace(deps.db, entry.workspaceId),
    getConnectionMetadata(deps.db, entry.workspaceId, entry.connectionId, null),
    getSlackBotUserLink(deps.db, entry.workspaceId, entry.connectionId, entry.slackUserId),
  ]);
  const settings = resolveWorkspaceSlackReactionSummonSettings(workspace?.settings);
  if (
    !workspace ||
    !connection ||
    !settings.enabled ||
    entry.text !== settings.emoji ||
    !workspaceSlackReactionChannelAllowed(settings, entry.slackChannelId) ||
    !hasOpenGeniSlackReactionScope(connection.grantedScopes) ||
    !link
  ) {
    return;
  }
  const grant = await getWorkspaceGrant(deps.db, link.subjectId, entry.workspaceId, {
    principalKind: "human_session",
  });
  if (!grant || grant.accountId !== entry.accountId) {
    throw new SlackInteractionPermanentError("identity_access_revoked");
  }
  if (
    !hasPermission(grant.permissions, "sessions:create") ||
    !hasPermission(grant.permissions, "sessions:control")
  ) {
    throw new SlackInteractionPermanentError("reaction_session_permissions_denied");
  }

  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    accountId: entry.accountId,
    workspaceId: entry.workspaceId,
    connectionId: entry.connectionId,
    subjectId: grant.subjectId,
  });
  const context = await client.reactionMessageContext({
    channelId: entry.slackChannelId,
    messageTimestamp: entry.slackMessageTs,
    checkpoint: entry.reactionContextCheckpoint,
    checkpointBinding: {
      inboxId: entry.id,
      accountId: entry.accountId,
      workspaceId: entry.workspaceId,
      connectionId: entry.connectionId,
      providerEventId: entry.providerEventId,
      providerMessageId: entry.providerMessageId,
      slackTeamId: entry.slackTeamId,
      slackChannelId: entry.slackChannelId,
      slackMessageTs: entry.slackMessageTs,
    },
    saveCheckpoint: async (checkpoint) => {
      if (!entry.claimHolderId) {
        throw new Error("Slack reaction inbox checkpoint requires an active claim");
      }
      const saved = await saveSlackInteractionInboxReactionCheckpoint(deps.db, {
        entry,
        claimHolderId: entry.claimHolderId,
        checkpoint,
      });
      if (!saved) throw new Error("Slack reaction inbox checkpoint claim was lost");
    },
  });
  const preparedEntry: SlackInteractionInboxEntry = {
    ...entry,
    slackThreadTs: context.threadTimestamp,
    text: slackReactionTaskText(context),
  };
  const routeKey = slackRouteKey(entry.slackChannelId, context.threadTimestamp);
  const existing = await getSlackInteractionByRoute(
    deps.db,
    entry.workspaceId,
    entry.connectionId,
    routeKey,
  );
  if (existing?.sessionId) {
    await continueSlackReactionSession(deps, grant, existing, preparedEntry);
    return;
  }
  const { interaction } = await getOrCreateSlackInteraction(deps.db, {
    accountId: entry.accountId,
    workspaceId: entry.workspaceId,
    connectionId: entry.connectionId,
    slackTeamId: entry.slackTeamId,
    slackChannelId: entry.slackChannelId,
    slackThreadTs: context.threadTimestamp,
    routeKey,
    triggeringProviderEventId: entry.providerEventId,
    owningSubjectId: grant.subjectId,
    visibility: "workspace",
  });
  if (interaction.sessionId) {
    await continueSlackReactionSession(deps, grant, interaction, preparedEntry);
    return;
  }
  if (interaction.owningSubjectId !== grant.subjectId) {
    // The route insert freezes the causal owner. Another linked user may race
    // the same previously-unmapped Slack thread on a different API replica,
    // but must not create the reserved session under their own authority.
    // Retry until the owner binds the session; the later user can then
    // continue the workspace-visible interaction through the normal path.
    throw new SlackInteractionRetryableError("slack_route_creation_pending");
  }
  const preferredModel = await getLatestSessionModelForSubject(
    deps.db,
    entry.workspaceId,
    grant.subjectId,
  );
  let session: Awaited<ReturnType<typeof createSessionForRequest>>;
  try {
    session = await createSessionForRequest(deps, grant, entry.workspaceId, {
      requestedSessionId: interaction.sessionReservationId,
      initialMessage: preparedEntry.text,
      turnInstructions: SLACK_TASK_INSTRUCTIONS,
      // The exact reacted message and bounded containing thread are already in
      // the prompt; do not expose general Slack history tools for this trigger.
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      ...(preferredModel ? { model: preferredModel } : {}),
      // Every reaction entry converging on this route must use the same create
      // key. This closes the same-owner multi-event race while the owner check
      // above prevents a different subject from winning creation authority.
      idempotencyKey: `slack-interaction:${interaction.id}`,
      clientEventId: `slack:${entry.providerEventId}`,
    });
    // The route-wide create key converges every replica on one reserved
    // session, but its first writer's initial message is the only event created
    // by that operation. Replay this exact Slack event through the normal
    // per-message idempotency boundary: the create winner is recognized as the
    // initial event, while every distinct loser appends one durable task.
    await acceptSlackReactionTask(deps, grant, session.id, preparedEntry);
  } catch (error) {
    if (error instanceof HTTPException) {
      await client.postMessage({
        operationId: deterministicUuid(`slack-reaction-admission-failed:${interaction.id}`),
        channelId: entry.slackChannelId,
        threadTimestamp: context.threadTimestamp,
        text: slackAdmissionFailureText(error),
      });
    }
    throw error;
  }
  const bound = await bindSlackInteractionSession(deps.db, {
    ...interaction,
    owningSubjectId: grant.subjectId,
    sessionId: session.id,
  });
  if (!bound) throw new Error("Slack reaction route could not bind its durable session");
  await client.postMessage({
    operationId: deterministicUuid(`slack-reaction-ack:${interaction.id}`),
    channelId: entry.slackChannelId,
    threadTimestamp: context.threadTimestamp,
    text: `OpenGeni started from the :${settings.emoji}: reaction. ${openSessionText(deps, entry.workspaceId, session.id)} If the intended action is unclear, OpenGeni will ask in this thread. Reply here to continue, or reply \`stop\` to stop.`,
  });
}

type SlackReactionMessageContext = Awaited<
  ReturnType<OpenGeniSlackBotClient["reactionMessageContext"]>
>;

export function slackReactionTaskText(context: SlackReactionMessageContext) {
  const reactedLine = slackReactionMessageLine(context.reactedMessage, true);
  const surroundingLines = context.messages
    .slice(0, MAX_SLACK_REACTION_CONTEXT_MESSAGES)
    .filter((message) => message.timestamp !== context.reactedMessage.timestamp)
    .map((message) => slackReactionMessageLine(message, false));
  const truncationNotice =
    "The containing thread was truncated at the bounded Slack context limit.";
  let prompt = [
    "A linked, authorized Slack user explicitly summoned OpenGeni by reacting to one message.",
    "Use only the exact reacted message and bounded containing-thread context below.",
    "If the intended action is ambiguous, ask a concise clarifying question in the originating thread before taking action.",
    "Do not infer permission to ingest or persist this Slack content into Knowledge, Memory, preferences, policy, instructions, or the Workspace Charter.",
    "",
    "Exact reacted message:",
    reactedLine,
    "",
    "Bounded surrounding thread context:",
  ].join("\n");
  let truncated = context.truncated;
  for (const line of surroundingLines) {
    const candidate = `${prompt}\n${line}`;
    if (candidate.length + 1 + truncationNotice.length > MAX_SLACK_INPUT_CHARS) {
      truncated = true;
      break;
    }
    prompt = candidate;
  }
  return truncated ? `${prompt}\n${truncationNotice}` : prompt;
}

function slackReactionMessageLine(
  message: SlackReactionMessageContext["reactedMessage"],
  reacted: boolean,
) {
  const actor = message.userId || (message.botId ? `bot:${message.botId}` : "unknown");
  const text = message.text.trim() || "(no text)";
  const fileLabels: string[] = [];
  let fileChars = 0;
  let filesTruncated = false;
  for (const file of message.files) {
    const label = file.title || file.name || file.id;
    if (!label) continue;
    const addedChars = label.length + (fileLabels.length > 0 ? 2 : 0);
    if (fileChars + addedChars > MAX_SLACK_REACTION_FILE_SUMMARY_CHARS) {
      filesTruncated = true;
      break;
    }
    fileLabels.push(label);
    fileChars += addedChars;
  }
  const fileSummary = fileLabels.length
    ? ` Files: ${fileLabels.join(", ")}${filesTruncated ? ", …" : ""}.`
    : "";
  return `- ${message.timestamp || "unknown"} ${actor}${reacted ? " [reacted message]" : ""}: ${text}${fileSummary}`;
}

async function continueSlackReactionSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  interaction: SlackInteraction,
  entry: SlackInteractionInboxEntry,
) {
  if (
    !interaction.sessionId ||
    (interaction.visibility === "private" && interaction.owningSubjectId !== grant.subjectId)
  ) {
    throw new SlackInteractionPermanentError("session_owner_mismatch");
  }
  await reopenSlackInteractionDelivery(deps.db, interaction);
  await acceptSlackReactionTask(deps, grant, interaction.sessionId, entry);
}

async function acceptSlackReactionTask(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  entry: SlackInteractionInboxEntry,
) {
  const clientEventId = `slack:${entry.providerEventId}`;
  const initialMessages = await listSessionEventPage(deps.db, entry.workspaceId, sessionId, {
    after: 0,
    limit: 1,
    includeTypes: ["user.message"],
    payloadMode: "none",
    maxBytes: 16 * 1024,
  });
  if (initialMessages.events[0]?.clientEventId === clientEventId) return;
  await acceptSessionUserMessage(deps, grant, entry.workspaceId, sessionId, {
    text: entry.text,
    turnInstructions: SLACK_TASK_INSTRUCTIONS,
    clientEventId,
  });
}

async function continueSlackSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  interaction: SlackInteraction,
  entry: SlackInteractionInboxEntry,
) {
  if (
    !interaction.sessionId ||
    (interaction.visibility === "private" && interaction.owningSubjectId !== grant.subjectId)
  ) {
    throw new SlackInteractionPermanentError("session_owner_mismatch");
  }
  await reopenSlackInteractionDelivery(deps.db, interaction);
  if (entry.text.trim().toLowerCase() === "stop") {
    if (!hasPermission(grant.permissions, "sessions:control")) {
      throw new SlackInteractionPermanentError("sessions_control_denied");
    }
    await controlHumanSessionWorkstream(
      deps,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        sessionId: interaction.sessionId,
      },
      {
        action: "pause",
        clientEventId: deterministicUuid(`slack-stop:${entry.providerEventId}`),
        reason: "Stopped from the originating Slack thread",
      },
    );
    return;
  }
  const pending = await listSessionHumanInputRequests(
    deps.db,
    entry.workspaceId,
    interaction.sessionId,
    { status: "pending", limit: 2 },
  );
  if (pending.length === 1) {
    const response = humanInputResponse(pending[0]!.questions, entry.text);
    if (response) {
      const accepted = await acceptSessionHumanInputResponse(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: interaction.sessionId,
        requestId: pending[0]!.id,
        response,
        respondedBy: grant.subjectId,
        clientEventId: `slack:${entry.providerEventId}`,
      });
      if (accepted.action === "accepted") {
        await publishDurableSessionEvents(
          deps.bus,
          grant.workspaceId,
          interaction.sessionId,
          accepted.events,
        );
        if (accepted.workflowWakeRevision !== null) {
          await deps.workflowClient.signalApprovalDecision({
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: interaction.sessionId,
            eventId: accepted.events[0]?.id ?? pending[0]!.id,
            workflowId: `session-${interaction.sessionId}`,
            workflowWakeRevision: accepted.workflowWakeRevision,
          });
        }
        return;
      }
    }
  }
  if (!hasPermission(grant.permissions, "sessions:control")) {
    throw new SlackInteractionPermanentError("sessions_control_denied");
  }
  await acceptSessionUserMessage(deps, grant, entry.workspaceId, interaction.sessionId, {
    text: entry.text,
    turnInstructions: SLACK_TASK_INSTRUCTIONS,
    clientEventId: `slack:${entry.providerEventId}`,
  });
}

async function deliverSlackSessionEvents(
  deps: ApiRouteDeps,
  interaction: SlackInteraction,
  claimHolderId: string,
) {
  if (!interaction.sessionId) return;
  const page = await listSessionEventPage(deps.db, interaction.workspaceId, interaction.sessionId, {
    after: interaction.lastDeliveredSessionEventSequence,
    limit: 100,
    includeTypes: [...SLACK_DELIVERY_EVENT_TYPES],
    authoritativeLatest: true,
    maxBytes: 256 * 1024,
  });
  if (page.events.length === 0) {
    await releaseSlackInteractionDelivery(deps.db, {
      ...interaction,
      claimHolderId,
    });
    return;
  }
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    accountId: interaction.accountId,
    workspaceId: interaction.workspaceId,
    connectionId: interaction.connectionId,
    subjectId: interaction.owningSubjectId,
    sessionId: interaction.sessionId,
  });
  let lastSequence = interaction.lastDeliveredSessionEventSequence;
  let terminal: Exclude<SlackInteraction["terminalDeliveryState"], "open"> | null = null;
  let latestAssistantText = "";
  // Monitoring pages are newest-first. Slack delivery is a timeline surface:
  // replay oldest-to-newest so progress cannot appear after a terminal result
  // and the final message remains the final message in the thread.
  for (const event of [...page.events].sort((left, right) => left.sequence - right.sequence)) {
    lastSequence = Math.max(lastSequence, event.sequence);
    if (event.type === "agent.message.completed") {
      latestAssistantText = safePayloadText(event.payload, "text");
      if (latestAssistantText) {
        const progress = await claimSlackInteractionProgressDelivery(deps.db, {
          accountId: interaction.accountId,
          workspaceId: interaction.workspaceId,
          interactionId: interaction.id,
          claimHolderId,
          sessionEventSequence: event.sequence,
          maxProgress: MAX_PROGRESS_MESSAGES,
        });
        if (progress.kind === "not_owned") {
          throw new Error("Slack progress delivery lost its durable interaction claim");
        }
        if (progress.kind === "claimed") {
          await postDelivery(
            client,
            interaction,
            event,
            latestAssistantText,
            "progress",
            progress.delivery.operationId,
          );
        }
      }
    } else if (event.type === "session.humanInput.requested") {
      const requests = await listSessionHumanInputRequests(
        deps.db,
        interaction.workspaceId,
        interaction.sessionId,
        { status: "pending", limit: 1 },
      );
      const request = requests[0];
      if (request) {
        await postDelivery(
          client,
          interaction,
          event,
          `OpenGeni needs your input:\n${formatQuestions(request.questions)}\nReply in this thread, or use ${openSessionText(deps, interaction.workspaceId, interaction.sessionId)}.`,
          "human-input",
        );
      }
    } else if (event.type === "turn.completed") {
      const output = safePayloadText(event.payload, "output") || latestAssistantText;
      await postDelivery(
        client,
        interaction,
        event,
        `${output || "OpenGeni finished this task."}\n\n${openSessionText(deps, interaction.workspaceId, interaction.sessionId)} Reply in this thread to continue.`,
        "final",
      );
      terminal = "completed";
    } else if (event.type === "turn.failed") {
      await postDelivery(
        client,
        interaction,
        event,
        `OpenGeni could not complete this task. ${openSessionText(deps, interaction.workspaceId, interaction.sessionId)} for the bounded failure details.`,
        "failed",
      );
      terminal = "failed";
    } else if (event.type === "turn.cancelled") {
      await postDelivery(client, interaction, event, "OpenGeni stopped this task.", "cancelled");
      terminal = "cancelled";
    }
  }
  if (terminal) {
    await closeSlackInteractionDelivery(deps.db, {
      ...interaction,
      claimHolderId,
      sequence: lastSequence,
      state: terminal,
    });
  } else {
    await advanceSlackInteractionDelivery(deps.db, {
      ...interaction,
      claimHolderId,
      sequence: lastSequence,
    });
    await releaseSlackInteractionDelivery(deps.db, {
      ...interaction,
      claimHolderId,
    });
  }
}

async function postDelivery(
  client: Awaited<ReturnType<typeof createOpenGeniSlackBotInteractionClient>>,
  interaction: SlackInteraction,
  event: SessionEvent,
  text: string,
  kind: string,
  operationId = deterministicUuid(`slack-delivery:${interaction.id}:${event.sequence}:${kind}`),
) {
  await client.postMessage({
    operationId,
    channelId: interaction.slackChannelId,
    threadTimestamp: interaction.slackThreadTs,
    text: boundedOutput(text),
  });
}

async function enqueueNormalizedSlackInteraction(
  deps: ApiRouteDeps,
  route: SlackInstallationRoute,
  entry: NormalizedSlackInteraction,
) {
  await enqueueSlackInteractionInbox(deps.db, {
    accountId: route.accountId,
    workspaceId: route.workspaceId,
    connectionId: route.connectionId,
    ...entry,
  });
}

async function readSignedSlackRequest(c: Context, deps: ApiRouteDeps) {
  const signingSecret = deps.settings.slackSigningSecret;
  if (!signingSecret)
    throw new HTTPException(503, {
      message: "Slack interactions are disabled",
    });
  const rawBytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > SLACK_INTERACTION_MAX_BODY_BYTES) {
    throw new HTTPException(rawBytes.byteLength > SLACK_INTERACTION_MAX_BODY_BYTES ? 413 : 400, {
      message: "invalid Slack request body",
    });
  }
  const rawBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  if (
    !verifySlackRequestSignature(
      {
        timestamp: c.req.header("x-slack-request-timestamp") ?? null,
        signature: c.req.header("x-slack-signature") ?? null,
        rawBody,
      },
      signingSecret,
    )
  ) {
    throw new HTTPException(401, { message: "invalid Slack signature" });
  }
  return { rawBody };
}

function normalizedFormInteraction(
  form: URLSearchParams,
  triggerKind: "slash_command",
): NormalizedSlackInteraction {
  const teamId = boundedString(form.get("team_id"), 64);
  const userId = boundedString(form.get("user_id"), 64);
  const channelId = boundedString(form.get("channel_id"), 64);
  const triggerId = boundedString(form.get("trigger_id"), 256);
  const text = boundedText(form.get("text"));
  if (!teamId || !userId || !channelId || !triggerId || !text) {
    throw new HTTPException(400, { message: "invalid Slack command payload" });
  }
  return {
    providerEventId: `command:${triggerId}`,
    providerMessageId: `command:${triggerId}`,
    slackTeamId: teamId,
    slackUserId: userId,
    slackChannelId: channelId,
    slackMessageTs: triggerId.slice(0, 64),
    slackThreadTs: null,
    triggerKind,
    text,
  };
}

function humanInputResponse(questions: HumanInputQuestion[], text: string) {
  if (questions.length !== 1) return null;
  const question = questions[0]!;
  if (question.kind === "text") {
    return {
      outcome: "answered" as const,
      answers: [{ questionId: question.id, values: [text] }],
    };
  }
  const normalized = text.trim().toLowerCase();
  const matches = question.options.filter(
    (option) => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized,
  );
  if (matches.length !== 1) return null;
  return {
    outcome: "answered" as const,
    answers: [{ questionId: question.id, values: [matches[0]!.id] }],
  };
}

function formatQuestions(questions: HumanInputQuestion[]) {
  return questions
    .slice(0, 5)
    .map((question, index) => {
      const options = question.options
        .slice(0, 10)
        .map((option) => option.label)
        .join(", ");
      return `${index + 1}. ${boundedOutput(question.prompt)}${options ? ` (${options})` : ""}`;
    })
    .join("\n");
}

function openSessionText(deps: ApiRouteDeps, workspaceId: string, sessionId: string) {
  const base = deps.settings.webBaseUrl ?? deps.settings.publicBaseUrl;
  return base
    ? `Open in OpenGeni: ${new URL(`/workspaces/${workspaceId}/sessions/${sessionId}`, base).toString()}`
    : "Open this session in OpenGeni";
}

function linkUrl(deps: ApiRouteDeps, entry: SlackInteractionInboxEntry) {
  const base = deps.settings.webBaseUrl ?? deps.settings.publicBaseUrl;
  const signingSecret = deps.settings.slackSigningSecret;
  if (!base || !signingSecret) return "OpenGeni Settings → Integrations → Slack";
  const url = new URL(`/workspaces/${entry.workspaceId}/capabilities`, base);
  url.searchParams.set("slack_link", createSlackUserLinkToken(signingSecret, entry));
  return url.toString();
}

type SlackUserLinkToken = {
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  slackUserId: string;
  expiresAt: number;
};

export function createSlackUserLinkToken(
  signingSecret: string,
  entry: Pick<
    SlackInteractionInboxEntry,
    "workspaceId" | "connectionId" | "slackTeamId" | "slackUserId"
  >,
  nowMs = Date.now(),
) {
  const payload = Buffer.from(
    JSON.stringify({
      workspaceId: entry.workspaceId,
      connectionId: entry.connectionId,
      slackTeamId: entry.slackTeamId,
      slackUserId: entry.slackUserId,
      expiresAt: nowMs + SLACK_USER_LINK_TTL_MS,
    } satisfies SlackUserLinkToken),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySlackUserLinkToken(
  signingSecret: string,
  token: string,
  nowMs = Date.now(),
): SlackUserLinkToken | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || payload.length > 1_500 || signature.length > 128)
    return null;
  const expected = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }
  try {
    const value = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const workspaceId = boundedString(value?.workspaceId, 64);
    const connectionId = boundedString(value?.connectionId, 64);
    const slackTeamId = boundedString(value?.slackTeamId, 64);
    const slackUserId = boundedString(value?.slackUserId, 64);
    const expiresAt = value?.expiresAt;
    if (
      !workspaceId ||
      !connectionId ||
      !slackTeamId ||
      !slackUserId ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < nowMs ||
      expiresAt > nowMs + SLACK_USER_LINK_TTL_MS
    ) {
      return null;
    }
    return { workspaceId, connectionId, slackTeamId, slackUserId, expiresAt };
  } catch {
    return null;
  }
}

function slackRouteKey(channelId: string, threadTs: string) {
  return `${channelId}:${threadTs}`;
}

function deterministicUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    const result = record(parsed);
    if (result) return result;
  } catch {
    // normalized below
  }
  throw new HTTPException(400, { message: "invalid Slack JSON payload" });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max
    ? value
    : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_SLACK_INPUT_CHARS);
}

function boundedOutput(value: string) {
  return value.length <= MAX_SLACK_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_SLACK_TEXT_CHARS - 20)}\n… output truncated`;
}

function safePayloadText(payload: unknown, field: string) {
  const value = record(payload)?.[field];
  return typeof value === "string" ? boundedOutput(value) : "";
}

function safeErrorCode(error: unknown) {
  if (error instanceof SlackBotProviderError) return error.code.slice(0, 128);
  if (error instanceof SlackInteractionPermanentError) return error.code.slice(0, 128);
  if (error instanceof SlackInteractionRetryableError) return error.code.slice(0, 128);
  if (error instanceof HTTPException) return `http_${error.status}`;
  const raw = error instanceof Error ? error.name : "slack_interaction_error";
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 128) || "error"
  );
}

function slackAdmissionFailureText(error: HTTPException) {
  if (error.status === 402) {
    return "OpenGeni could not start this task because the selected model has no available billing source. Open OpenGeni, select a connected subscription model, and try again.";
  }
  if (error.status === 429) {
    return "OpenGeni could not start this task because this workspace has reached a usage limit. Try again later or review the workspace limits in OpenGeni.";
  }
  return "OpenGeni could not start this task because the workspace rejected the session settings. Open OpenGeni, select an available model, and try again.";
}

class SlackInteractionPermanentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SlackInteractionPermanentError";
  }
}

class SlackInteractionRetryableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SlackInteractionRetryableError";
  }
}

function permanentSlackInteractionError(error: unknown) {
  return error instanceof SlackInteractionPermanentError || error instanceof HTTPException;
}

const PERMANENT_SLACK_DELIVERY_CODES = new Set([
  "account_inactive",
  "cannot_reply_to_message",
  "channel_not_found",
  "invalid_auth",
  "invalid_ts",
  "is_archived",
  "message_not_found",
  "not_authed",
  "not_in_channel",
  "reaction_checkpoint_invalid",
  "reaction_checkpoint_too_large",
  "reaction_pagination_exhausted",
  "reaction_pagination_invalid",
  "slack_connect_unsupported",
  "token_expired",
  "token_revoked",
]);

function permanentSlackDeliveryError(error: unknown) {
  if (!(error instanceof SlackBotProviderError)) return false;
  if (PERMANENT_SLACK_DELIVERY_CODES.has(error.code)) return true;
  const status = /^http_(\d{3})$/.exec(error.code)?.[1];
  return status
    ? Number(status) >= 400 && Number(status) < 500 && status !== "408" && status !== "429"
    : false;
}

function slackDeliveryRetryMs(error: unknown, attemptCount: number) {
  if (error instanceof SlackBotProviderError && error.retryAfterMs) {
    return error.retryAfterMs;
  }
  return Math.min(1_000 * 2 ** Math.max(0, attemptCount - 1), MAX_DELIVERY_RETRY_MS);
}

function slackDeliveryErrorCode(error: unknown) {
  if (error instanceof SlackBotProviderError) return error.code.slice(0, 128);
  return safeErrorCode(error);
}
