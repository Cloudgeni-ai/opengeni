import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Settings } from "@opengeni/config";
import { normalizeConversationInboundEnvelope } from "@opengeni/core";

const uuid = z.string().uuid();
const opaque = z.string().min(1).max(512);
// Teams repeats rich text as inline HTML. Only activity.text is consumed; the
// representation is never parsed, fetched, or forwarded as an attachment.
const InlineTextRepresentation = z.object({
  contentType: z.literal("text/html"),
  content: z.string(),
  contentUrl: z.null().optional(),
});
const Activity = z.object({
  type: z.literal("message"),
  id: opaque,
  timestamp: z.string().datetime({ offset: true }),
  channelId: z.literal("msteams"),
  serviceUrl: z.string().url(),
  from: z.object({
    id: opaque,
    aadObjectId: uuid,
    name: z.string().max(512).optional(),
    role: z.string().optional(),
  }),
  recipient: z.object({ id: opaque }),
  conversation: z.object({
    id: opaque,
    conversationType: z.enum(["personal", "channel", "groupChat"]),
    tenantId: uuid.optional(),
  }),
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    channel: z.object({ id: opaque }).optional(),
  }),
  replyToId: opaque.optional(),
  text: z.string().max(32768).default(""),
  entities: z
    .array(
      z
        .object({
          type: z.string(),
          mentioned: z.object({ id: z.string() }).optional(),
          text: z.string().optional(),
        })
        .passthrough(),
    )
    .max(100)
    .optional(),
  attachments: z.array(z.unknown()).max(16).optional(),
});
export type TeamsMessage = {
  tenantId: string;
  actorId: string;
  /** The sender's Teams display name, when Teams sends one. */
  actorName?: string | null;
  channelId: string | null;
  conversationId: string;
  threadId: string | null;
  serviceUrl: string;
  botId: string;
  eventId: string;
  personal: boolean;
  groupChat: boolean;
  text: string;
  occurredAt: string;
  identity: string;
  routeIdentity: string;
};

/** DM ownership changes get a fresh session without moving the former human's history.
 * So does a DM that starts landing in the sender's Personal workspace: its
 * earlier chat stays where it was, and turning Personal workspaces off again
 * returns to it. */
export function teamsRouteId(
  message: Pick<TeamsMessage, "personal" | "routeIdentity">,
  generation: string,
  subjectId: string,
  sessionWorkspaceId: string | null = null,
): string {
  return message.personal
    ? createHash("sha256")
        .update(
          JSON.stringify(
            sessionWorkspaceId
              ? [message.routeIdentity, generation, subjectId, sessionWorkspaceId]
              : [message.routeIdentity, generation, subjectId],
          ),
        )
        .digest("hex")
    : `${message.routeIdentity}:${generation}`;
}
export function teamsBotConfigured(s: Settings): boolean {
  return Boolean(
    s.teamsBotClientId && s.teamsBotClientSecret && s.teamsBotTenantId && s.integrationsStateSecret,
  );
}
export function teamsTenantEnabled(s: Settings, tenantId: string): boolean {
  return (
    teamsBotConfigured(s) &&
    (s.teamsBotEnabled ||
      s.teamsBotAllowedTenantIds.some((id) => id.toLowerCase() === tenantId.toLowerCase()))
  );
}
/** A Teams display name on one line, at most 256 characters; null when empty. */
export function teamsDisplayName(value: string | undefined): string | null {
  return value?.replace(/\s+/g, " ").trim().slice(0, 256) || null;
}
/** Accept public-cloud Teams connector URLs only, even after SDK signature validation. */
export function teamsServiceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !(
      url.hostname === "smba.trafficmanager.net" ||
      url.hostname.endsWith(".smba.trafficmanager.net") ||
      url.hostname === "smba.infra.teams.microsoft.com" ||
      url.hostname.endsWith(".smba.infra.teams.microsoft.com")
    )
  ) {
    throw new Error("teams_service_url_rejected");
  }
  return url.toString();
}
export type TeamsMessageRejection = {
  reason:
    | "schema"
    | "bot_sender"
    | "attachments"
    | "tenant_mismatch"
    | "missing_channel"
    | "missing_mention"
    | "empty_text";
  schemaPaths?: string;
  timestampType?: string;
  attachmentCount?: number;
  htmlAttachmentCount?: number;
};

/** Called only by the SDK's authenticated activity callback, never raw HTTP JSON.
 * Diagnostics contain fixed reasons and shape metadata, never provider content or identities. */
export function normalizeTeamsMessage(
  raw: unknown,
  onRejected?: (diagnostic: TeamsMessageRejection) => void,
): TeamsMessage | null {
  const reject = (diagnostic: TeamsMessageRejection): null => {
    onRejected?.(diagnostic);
    return null;
  };
  const parsed = Activity.safeParse(raw);
  if (!parsed.success) {
    const timestamp =
      raw && typeof raw === "object" ? (raw as { timestamp?: unknown }).timestamp : undefined;
    return reject({
      reason: "schema",
      schemaPaths: parsed.error.issues
        .slice(0, 8)
        .map((issue) => issue.path.join("."))
        .join(","),
      timestampType: timestamp instanceof Date ? "date" : typeof timestamp,
    });
  }
  const a = parsed.data;
  if (a.from.role === "bot" || a.from.id === a.recipient.id)
    return reject({ reason: "bot_sender" });
  if (a.attachments?.some((value) => !InlineTextRepresentation.safeParse(value).success))
    return reject({
      reason: "attachments",
      attachmentCount: a.attachments.length,
      htmlAttachmentCount: a.attachments.filter(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          (value as { contentType?: unknown }).contentType === "text/html",
      ).length,
    });
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId)
    return reject({ reason: "tenant_mismatch" });
  const personal = a.conversation.conversationType === "personal";
  const groupChat = a.conversation.conversationType === "groupChat";
  if (!personal && !groupChat && !a.channelData.channel?.id)
    return reject({ reason: "missing_channel" });
  let text = a.text;
  const mentions = (a.entities ?? []).filter(
    (e) => e.type === "mention" && e.mentioned?.id === a.recipient.id,
  );
  // Channel messages must explicitly invoke the bot. Never ambient-listen to a channel.
  if (!personal && !mentions.length) return reject({ reason: "missing_mention" });
  for (const mention of mentions) if (mention.text) text = text.replace(mention.text, "");
  text = text.trim();
  if (!text) return reject({ reason: "empty_text" });
  const threadId = personal || groupChat ? null : teamsChannelThreadId(a);
  const envelope = normalizeConversationInboundEnvelope({
    provider: "microsoft.teams",
    installationId: tenantId,
    actor: { providerActorId: a.from.aadObjectId.toLowerCase(), kind: "human" },
    route: { providerConversationId: a.conversation.id, providerThreadId: threadId },
    providerEventId: a.id,
    providerMessageId: a.id,
    occurredAt: new Date(a.timestamp).toISOString(),
    signal: { kind: "continue" },
    text,
  });
  return {
    tenantId,
    actorId: a.from.aadObjectId.toLowerCase(),
    actorName: teamsDisplayName(a.from.name),
    channelId: personal || groupChat ? null : a.channelData.channel!.id,
    conversationId: a.conversation.id,
    threadId,
    serviceUrl: teamsServiceUrl(a.serviceUrl),
    botId: a.recipient.id,
    eventId: a.id,
    personal,
    groupChat,
    text,
    occurredAt: a.timestamp,
    identity: envelope.eventIdentity,
    routeIdentity: envelope.route.identity,
  };
}

/**
 * The sender and chat of a 1:1 message the bot can't read, because it carries
 * a file or image, or has no text, so it can be told what to send instead.
 * Null for anything else, including every message `normalizeTeamsMessage`
 * accepts. Like it, call it only with an authenticated activity.
 */
export function teamsUnreadablePersonalMessage(raw: unknown): {
  tenantId: string;
  actorId: string;
  conversationId: string;
  serviceUrl: string;
  botId: string;
  eventId: string;
  personal: true;
  threadId: null;
} | null {
  const parsed = Activity.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.from.role === "bot" || a.from.id === a.recipient.id) return null;
  if (a.conversation.conversationType !== "personal") return null;
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId) return null;
  const files = a.attachments?.some((value) => !InlineTextRepresentation.safeParse(value).success);
  if (!files && a.text.trim()) return null;
  let serviceUrl: string;
  try {
    serviceUrl = teamsServiceUrl(a.serviceUrl);
  } catch {
    return null;
  }
  return {
    tenantId,
    actorId: a.from.aadObjectId.toLowerCase(),
    conversationId: a.conversation.id,
    serviceUrl,
    botId: a.recipient.id,
    eventId: a.id,
    personal: true,
    threadId: null,
  };
}

/**
 * The root post of the channel thread an activity belongs to. Teams names it
 * in the conversation id (`19:…@thread.tacv2;messageid=<root>`) for the root
 * post and every reply, while `replyToId` can be missing on a reply. So the
 * suffix wins; a reply to an unknown root falls back to `replyToId`, and only
 * then to the activity itself.
 */
export function teamsChannelThreadId(a: {
  id: string;
  replyToId?: string | undefined;
  conversation: { id: string };
}): string {
  const suffix = /;messageid=([^;]+)/i.exec(a.conversation.id)?.[1]?.trim();
  return suffix || a.replyToId || a.id;
}

/** A conversation id without its per-thread `;messageid=` suffix. */
export function teamsThreadlessConversationId(conversationId: string): string {
  return conversationId.replace(/;messageid=[^;]*/i, "");
}

export const TEAMS_CONTEXT_MESSAGE_MAX_CHARS = 4000;

/** Teams message text as plain text: mentions become `@Name`, tags drop, entities decode. */
export function teamsPlainText(value: string): string {
  return value
    .replace(/<at[^>]*>(.*?)<\/at>/gis, "@$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ContextActivity = z.object({
  type: z.literal("message"),
  id: opaque,
  timestamp: z.string().datetime({ offset: true }),
  channelId: z.literal("msteams"),
  from: z.object({
    id: opaque,
    aadObjectId: uuid,
    name: z.string().max(512).optional(),
    role: z.string().optional(),
  }),
  recipient: z.object({ id: opaque }),
  conversation: z.object({
    id: opaque,
    conversationType: z.enum(["personal", "channel", "groupChat"]),
    tenantId: uuid.optional(),
  }),
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    channel: z.object({ id: opaque }).optional(),
  }),
  replyToId: opaque.optional(),
  text: z.string().default(""),
  entities: z
    .array(
      z
        .object({ type: z.string(), mentioned: z.object({ id: z.string() }).optional() })
        .passthrough(),
    )
    .max(100)
    .optional(),
  attachments: z.array(z.unknown()).max(64).optional(),
});

/** One human message in a shared Teams conversation, kept only as context for a later mention. */
export type TeamsContextMessage = {
  tenantId: string;
  botId: string;
  groupChat: boolean;
  channelId: string | null;
  /** The conversation without a thread suffix: the group chat, or the channel. */
  conversationId: string;
  /** The channel thread's root post id, or null in a group chat. */
  threadId: string | null;
  messageId: string;
  actorId: string;
  actorName: string | null;
  text: string;
  hasAttachments: boolean;
  mentioned: boolean;
  occurredAt: string;
};

/**
 * Context for later mentions: any human message in a channel or group chat,
 * mentioned or not. With resource-specific consent Teams delivers the
 * unmentioned ones too. This never starts work; `normalizeTeamsMessage` still
 * decides what invokes Opengeni. Personal chats, bots and malformed activities
 * return null.
 */
export function teamsContextMessage(raw: unknown): TeamsContextMessage | null {
  const parsed = ContextActivity.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  // Bot Framework ids for bots start with 28:, people's with 29:.
  if (a.from.role === "bot" || a.from.id === a.recipient.id || a.from.id.startsWith("28:"))
    return null;
  const type = a.conversation.conversationType;
  if (type === "personal") return null;
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId) return null;
  const groupChat = type === "groupChat";
  if (!groupChat && !a.channelData.channel?.id) return null;
  const text = teamsPlainText(a.text);
  const hasAttachments = (a.attachments ?? []).some(
    (value) =>
      !(
        value &&
        typeof value === "object" &&
        (value as { contentType?: unknown }).contentType === "text/html"
      ),
  );
  if (!text && !hasAttachments) return null;
  return {
    tenantId,
    botId: a.recipient.id,
    groupChat,
    channelId: groupChat ? null : a.channelData.channel!.id,
    conversationId: teamsThreadlessConversationId(a.conversation.id),
    threadId: groupChat ? null : teamsChannelThreadId(a),
    messageId: a.id,
    actorId: a.from.aadObjectId.toLowerCase(),
    actorName: teamsDisplayName(a.from.name),
    text: text.slice(0, TEAMS_CONTEXT_MESSAGE_MAX_CHARS),
    hasAttachments,
    mentioned: (a.entities ?? []).some(
      (e) => e.type === "mention" && e.mentioned?.id === a.recipient.id,
    ),
    occurredAt: new Date(a.timestamp).toISOString(),
  };
}
const ContextRevisionActivity = z.object({
  type: z.enum(["messageUpdate", "messageDelete"]),
  id: opaque,
  channelId: z.literal("msteams"),
  recipient: z.object({ id: opaque }),
  conversation: z.object({
    id: opaque,
    conversationType: z.enum(["personal", "channel", "groupChat"]),
    tenantId: uuid.optional(),
  }),
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    channel: z.object({ id: opaque }).optional(),
    eventType: z.string().max(64).optional(),
  }),
  text: z.string().optional(),
  attachments: z.array(z.unknown()).max(64).optional(),
});

/** A Teams edit or deletion of a channel or group chat message. */
export type TeamsContextRevision = {
  tenantId: string;
  botId: string;
  /** The conversation without a thread suffix, as recorded. */
  conversationId: string;
  messageId: string;
  /** The new content of an edit; null for a deletion. */
  edit: { text: string; hasAttachments: boolean } | null;
};

/**
 * Edits (`messageUpdate`/`editMessage`) and deletions
 * (`messageDelete`/`softDeleteMessage`) of shared-conversation messages, so
 * recorded context follows them. Other activities return null.
 */
export function teamsContextRevision(raw: unknown): TeamsContextRevision | null {
  const parsed = ContextRevisionActivity.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.conversation.conversationType === "personal") return null;
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId) return null;
  const eventType = a.channelData.eventType;
  const base = {
    tenantId,
    botId: a.recipient.id,
    conversationId: teamsThreadlessConversationId(a.conversation.id),
    messageId: a.id,
  };
  if (a.type === "messageDelete")
    return !eventType || eventType === "softDeleteMessage" ? { ...base, edit: null } : null;
  if (eventType && eventType !== "editMessage") return null;
  // An edit without its new text says nothing about the content.
  if (a.text === undefined) return null;
  return {
    ...base,
    edit: {
      text: teamsPlainText(a.text).slice(0, TEAMS_CONTEXT_MESSAGE_MAX_CHARS),
      hasAttachments: (a.attachments ?? []).some(
        (value) =>
          !(
            value &&
            typeof value === "object" &&
            (value as { contentType?: unknown }).contentType === "text/html"
          ),
      ),
    },
  };
}

const PersonalInstall = z.object({
  type: z.literal("conversationUpdate"),
  channelId: z.literal("msteams"),
  serviceUrl: z.string().url(),
  from: z
    .object({ id: opaque, aadObjectId: uuid.optional(), role: z.string().optional() })
    .optional(),
  recipient: z.object({ id: opaque }),
  conversation: z.object({
    id: opaque,
    conversationType: z.literal("personal"),
    tenantId: uuid.optional(),
  }),
  channelData: z.object({ tenant: z.object({ id: uuid }) }),
  membersAdded: z
    .array(z.object({ id: z.string() }).passthrough())
    .min(1)
    .max(16),
});
export type TeamsPersonalInstall = {
  tenantId: string;
  /** The person who added the bot, when Teams names a person (never a bot). */
  actorId: string | null;
  conversationId: string;
  serviceUrl: string;
  botId: string;
};
/**
 * The bot was added to someone's personal scope. Called only by the SDK's
 * authenticated activity callback; the caller still checks the bot identity.
 */
export function teamsPersonalInstall(raw: unknown): TeamsPersonalInstall | null {
  const parsed = PersonalInstall.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (
    !a.membersAdded.some((member) => member.id === a.recipient.id) ||
    (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId)
  )
    return null;
  let serviceUrl: string;
  try {
    serviceUrl = teamsServiceUrl(a.serviceUrl);
  } catch {
    return null;
  }
  const person = a.from && a.from.role !== "bot" && a.from.id !== a.recipient.id ? a.from : null;
  return {
    tenantId,
    actorId: person?.aadObjectId?.toLowerCase() ?? null,
    conversationId: a.conversation.id,
    serviceUrl,
    botId: a.recipient.id,
  };
}

const FeedbackInvoke = z.object({
  type: z.literal("invoke"),
  name: z.literal("message/submitAction"),
  id: opaque,
  channelId: z.literal("msteams"),
  serviceUrl: z.string().url(),
  from: z.object({ id: opaque, aadObjectId: uuid, role: z.string().optional() }),
  recipient: z.object({ id: opaque }),
  conversation: z.object({
    id: opaque,
    conversationType: z.enum(["personal", "channel", "groupChat"]),
    tenantId: uuid.optional(),
  }),
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    channel: z.object({ id: opaque }).optional(),
  }),
  replyToId: opaque,
  value: z.object({
    actionName: z.literal("feedback"),
    actionValue: z.object({
      reaction: z.enum(["like", "dislike"]),
      feedback: z.string().optional(),
    }),
  }),
});
export type TeamsFeedback = {
  tenantId: string;
  actorId: string;
  conversationId: string;
  personal: boolean;
  groupChat: boolean;
  /** The Teams channel, for feedback in a channel. */
  channelId: string | null;
  /** The bot message the feedback is about. */
  replyToId: string;
  eventId: string;
  sentiment: "positive" | "negative";
  /** What the person wrote in the feedback form, if anything. */
  comment: string | null;
  botId: string;
};
/**
 * A thumbs up or down from Teams' feedback buttons on a bot message. Called
 * only by the SDK's authenticated activity callback.
 */
export function normalizeTeamsFeedback(raw: unknown): TeamsFeedback | null {
  const parsed = FeedbackInvoke.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (
    a.from.role === "bot" ||
    a.from.id === a.recipient.id ||
    (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId)
  )
    return null;
  const personal = a.conversation.conversationType === "personal";
  const groupChat = a.conversation.conversationType === "groupChat";
  if (!personal && !groupChat && !a.channelData.channel?.id) return null;
  // Teams sends the form as JSON text: {"feedbackText": "..."}. Long text is
  // kept, shortened.
  let comment: string | null = null;
  const form = a.value.actionValue.feedback;
  if (form && form.length <= 262_144)
    try {
      const value = JSON.parse(form) as { feedbackText?: unknown } | null;
      if (value && typeof value.feedbackText === "string" && value.feedbackText.trim()) {
        // At most 4000 UTF-16 code units, the feedback limit, without
        // splitting a surrogate pair.
        const text = value.feedbackText.trim();
        let end = Math.min(text.length, 4000);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
        comment = text.slice(0, end);
      }
    } catch {
      comment = null;
    }
  return {
    tenantId,
    actorId: a.from.aadObjectId.toLowerCase(),
    conversationId: a.conversation.id,
    personal,
    groupChat,
    channelId: personal || groupChat ? null : a.channelData.channel!.id,
    replyToId: a.replyToId,
    eventId: a.id,
    sentiment: a.value.actionValue.reaction === "like" ? "positive" : "negative",
    comment,
    botId: a.recipient.id,
  };
}
const Proof = z
  .object({
    version: z.literal(1),
    purpose: z.enum(["setup", "link"]),
    tenantId: uuid,
    actorId: uuid,
    workspaceId: uuid.nullable(),
    generation: uuid.nullable(),
    /**
     * The Teams display name of the person an account link is for, so a
     * refused link can say whose it is. Display only: the Microsoft sign-in
     * proves `actorId`.
     */
    actorName: z.string().min(1).max(256).optional(),
    /** The 1:1 chat the setup link was sent to, so setup can confirm there. */
    conversation: z
      .object({ id: opaque, serviceUrl: z.string().url().max(512) })
      .strict()
      .optional(),
    nonce: uuid,
    expiresAt: z.number().int(),
  })
  .strict();
export type TeamsLinkProof = z.infer<typeof Proof>;
/**
 * Link proofs are short-lived. A setup proof also has to cover signing up for
 * Opengeni, creating a shared workspace and the Microsoft sign-in; its
 * single-use nonce still prevents replay.
 */
const PROOF_TTL_MS: Record<TeamsLinkProof["purpose"], number> = {
  link: 10 * 60_000,
  setup: 60 * 60_000,
};
export function mintTeamsProof(
  secret: string,
  input: Omit<TeamsLinkProof, "version" | "nonce" | "expiresAt">,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify(
      Proof.parse({
        ...input,
        version: 1,
        nonce: randomUUID(),
        expiresAt: now + PROOF_TTL_MS[input.purpose],
      }),
    ),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(`teams-link-v1:${payload}`).digest("base64url")}`;
}
export function verifyTeamsProof(secret: string, token: string, now = Date.now()): TeamsLinkProof {
  if (token.length > 4096) throw new Error("teams_link_invalid");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("teams_link_invalid");
  const expected = createHmac("sha256", secret).update(`teams-link-v1:${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("teams_link_invalid");
  const proof = Proof.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  if (proof.expiresAt <= now || proof.expiresAt > now + PROOF_TTL_MS[proof.purpose])
    throw new Error("teams_link_expired");
  return proof;
}
