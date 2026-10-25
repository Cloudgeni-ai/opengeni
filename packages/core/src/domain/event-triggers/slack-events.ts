import type { EventActorKind, EventTypeDescriptor } from "@opengeni/contracts";
import { oneLine, truncateText, type NormalizedEventInput } from "./normalize";
import { WebhookBodyError, type WebhookAdapterReading } from "./webhook-adapters";

/**
 * Slack Events API callbacks as automation events. The Slack app already
 * receives them for conversations; a workspace with a Slack source also gets
 * channel activity as events. Direct messages to the app stay private and are
 * never recorded. Whether Opengeni's own app made an event is read from the
 * callback itself (`api_app_id` and the authorized bot user), so a stored
 * delivery reads the same on replay.
 */

const TEXT_MAX_CHARS = 1_500;

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function compact(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined),
  );
}

/** A Slack timestamp (`1700000000.000100`) as a date. */
function slackTime(value: unknown): Date | null {
  const seconds = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Math.round(seconds * 1000)) : null;
}

function channelKind(channelType: string | null, channelId: string | null): string | null {
  if (channelType === "channel") return "public";
  if (channelType === "group") return "private";
  if (channelType === "im" || channelType === "mpim") return "direct";
  if (!channelType && channelId) {
    if (channelId.startsWith("C")) return "public";
    if (channelId.startsWith("D")) return "direct";
  }
  return channelType ? "other" : null;
}

type Envelope = {
  teamId: string | null;
  eventId: string | null;
  eventTime: Date | null;
  appId: string | null;
  botUserIds: Set<string>;
  event: Json;
};

function readEnvelope(body: Uint8Array): Envelope | { ignored: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookBodyError("The body is not JSON");
  }
  const envelope = object(parsed);
  if (!envelope) throw new WebhookBodyError("The body is not a JSON object");
  if (envelope.type !== "event_callback") return { ignored: "Not a Slack event" };
  const event = object(envelope.event);
  if (!event) throw new WebhookBodyError("The Slack callback has no event");
  const botUserIds = new Set<string>();
  if (Array.isArray(envelope.authorizations)) {
    for (const authorization of envelope.authorizations) {
      const found = object(authorization);
      const user = text(found?.user_id, 64);
      if (user && found?.is_bot === true) botUserIds.add(user);
    }
  }
  return {
    teamId: text(envelope.team_id, 64),
    eventId: text(envelope.event_id),
    eventTime: slackTime(envelope.event_time),
    appId: text(envelope.api_app_id, 64),
    botUserIds,
    event,
  };
}

function actorKind(envelope: Envelope, message: Json): EventActorKind {
  const user = text(message.user, 64);
  const appId = text(object(message.bot_profile)?.app_id, 64) ?? text(message.app_id, 64);
  if ((appId && appId === envelope.appId) || (user && envelope.botUserIds.has(user))) {
    return "opengeni";
  }
  if (message.bot_id || message.subtype === "bot_message") return "bot";
  return user ? "person" : "unknown";
}

function channelUrl(teamId: string | null, channelId: string | null): string | null {
  return teamId && channelId ? `https://app.slack.com/client/${teamId}/${channelId}` : null;
}

function messageData(message: Json, channel: Json): Json {
  const ts = text(message.ts, 64);
  const threadTs = text(message.thread_ts, 64);
  const files = Array.isArray(message.files) ? message.files.length : 0;
  return compact({
    channel,
    user: text(message.user, 64),
    bot_id: text(message.bot_id, 64),
    text: typeof message.text === "string" ? truncateText(message.text, TEXT_MAX_CHARS) : null,
    ts,
    thread_ts: threadTs,
    in_thread: threadTs !== null && threadTs !== ts,
    files: files > 0 ? files : null,
  });
}

const MEMBER_SUBTYPES: Record<string, string> = {
  channel_join: "member.joined_channel",
  group_join: "member.joined_channel",
  channel_leave: "member.left_channel",
  group_leave: "member.left_channel",
};

function readMessage(envelope: Envelope): NormalizedEventInput | { ignored: string } {
  const { event } = envelope;
  const channelId = text(event.channel, 64);
  const kind = channelKind(text(event.channel_type, 32), channelId);
  if (kind === "direct") return { ignored: "Direct messages with Opengeni stay private" };
  if (kind !== "public" && kind !== "private") return { ignored: "Not a channel message" };
  const channel = { id: channelId, type: kind };
  const where = `channel ${channelId}`;
  const subtype = text(event.subtype, 64);
  const base = {
    externalId: envelope.eventId,
    url: channelUrl(envelope.teamId, channelId),
  };
  if (subtype === "message_changed") {
    const message = object(event.message) ?? {};
    const before = object(event.previous_message);
    if (typeof message.text === "string" && message.text === before?.text) {
      return { ignored: "Slack updated the message without changing its text" };
    }
    return {
      ...base,
      type: "message.edited",
      occurredAt: slackTime(event.ts) ?? envelope.eventTime ?? new Date(),
      subject: `${channelId}:${text(message.ts, 64) ?? "?"}`,
      summary: oneLine(`Message edited in ${where}: ${text(message.text, 400) ?? ""}`, 300),
      actor: { kind: actorKind(envelope, message), name: text(message.user, 64) },
      data: messageData(message, channel),
    };
  }
  if (subtype === "message_deleted") {
    const before = object(event.previous_message) ?? {};
    const ts = text(event.deleted_ts, 64) ?? text(before.ts, 64);
    return {
      ...base,
      type: "message.deleted",
      occurredAt: slackTime(event.ts) ?? envelope.eventTime ?? new Date(),
      subject: `${channelId}:${ts ?? "?"}`,
      summary: `Message deleted in ${where}`,
      actor: { kind: actorKind(envelope, before), name: text(before.user, 64) },
      data: compact({ channel, ts, user: text(before.user, 64) }),
    };
  }
  const memberType = subtype ? MEMBER_SUBTYPES[subtype] : undefined;
  if (memberType) {
    const user = text(event.user, 64);
    return {
      ...base,
      type: memberType,
      occurredAt: slackTime(event.ts) ?? envelope.eventTime ?? new Date(),
      subject: channelId,
      summary: `${user ?? "Someone"} ${memberType === "member.joined_channel" ? "joined" : "left"} ${where}`,
      actor: { kind: actorKind(envelope, event), name: user },
      data: compact({ channel, user }),
    };
  }
  if (
    subtype &&
    !["thread_broadcast", "file_share", "bot_message", "me_message"].includes(subtype)
  ) {
    return { ignored: `A Slack ${subtype.replaceAll("_", " ")} message` };
  }
  const ts = text(event.ts, 64);
  const threadTs = text(event.thread_ts, 64);
  const reply = threadTs !== null && threadTs !== ts;
  return {
    ...base,
    type: "message.posted",
    occurredAt: slackTime(ts) ?? envelope.eventTime ?? new Date(),
    subject: `${channelId}:${threadTs ?? ts ?? "?"}`,
    summary: oneLine(
      `${reply ? "Thread reply" : "Message"} in ${where}: ${text(event.text, 400) ?? "(no text)"}`,
      300,
    ),
    actor: { kind: actorKind(envelope, event), name: text(event.user, 64) },
    data: messageData(event, channel),
  };
}

function readReaction(envelope: Envelope): NormalizedEventInput | { ignored: string } {
  const { event } = envelope;
  const item = object(event.item) ?? {};
  const channelId = text(item.channel, 64);
  const kind = channelKind(null, channelId);
  if (kind === "direct") return { ignored: "Direct messages with Opengeni stay private" };
  const reaction = text(event.reaction, 100);
  const user = text(event.user, 64);
  const ts = text(item.ts, 64);
  return {
    externalId: envelope.eventId,
    type: "reaction.added",
    occurredAt: slackTime(event.event_ts) ?? envelope.eventTime ?? new Date(),
    subject: `${channelId ?? "?"}:${ts ?? "?"}`,
    summary: `${user ?? "Someone"} reacted :${reaction ?? "?"}: to a message in channel ${channelId ?? "?"}`,
    url: channelUrl(envelope.teamId, channelId),
    actor: { kind: actorKind(envelope, event), name: user },
    data: compact({
      reaction,
      user,
      item_user: text(event.item_user, 64),
      channel: compact({ id: channelId, type: kind }),
      ts,
    }),
  };
}

/** One verified Slack event callback as events. */
export function readSlackDelivery(input: {
  body: Uint8Array;
  receivedAt: Date;
}): WebhookAdapterReading {
  const envelope = readEnvelope(input.body);
  if ("ignored" in envelope) return { kind: "ignored", reason: envelope.ignored };
  const type = text(envelope.event.type, 64);
  const read =
    type === "message"
      ? readMessage(envelope)
      : type === "reaction_added"
        ? readReaction(envelope)
        : type === "app_mention"
          ? {
              ignored:
                "Mentions start a conversation with Opengeni; the message itself is an event",
            }
          : { ignored: `Slack ${type ?? "event"} events are not recorded` };
  if ("ignored" in read) return { kind: "ignored", reason: read.ignored };
  return { kind: "events", events: [read] };
}

const CHANNEL_FIELDS: Array<[string, string]> = [
  ["data.channel.id", "The channel's id (C...)"],
  ["data.channel.type", "public or private"],
];
const MESSAGE_FIELDS: Array<[string, string]> = [
  ...CHANNEL_FIELDS,
  ["data.user", "The Slack user id of the author"],
  ["data.text", "The message text"],
  ["data.in_thread", "Whether it is a reply in a thread"],
];

const SLACK_TYPES: Array<{ type: string; description: string; fields: Array<[string, string]> }> = [
  {
    type: "message.posted",
    description: "A message or thread reply in a channel the Opengeni app is in",
    fields: MESSAGE_FIELDS,
  },
  { type: "message.edited", description: "A channel message was edited", fields: MESSAGE_FIELDS },
  { type: "message.deleted", description: "A channel message was deleted", fields: CHANNEL_FIELDS },
  {
    type: "reaction.added",
    description: "Someone reacted to a message in a channel",
    fields: [
      ["data.reaction", "The emoji name, without colons"],
      ["data.user", "Who reacted"],
      ["data.item_user", "Who wrote the message"],
      ...CHANNEL_FIELDS,
    ],
  },
  {
    type: "member.joined_channel",
    description: "Someone joined a channel the Opengeni app is in",
    fields: [...CHANNEL_FIELDS, ["data.user", "Who joined"]],
  },
  {
    type: "member.left_channel",
    description: "Someone left a channel the Opengeni app is in",
    fields: [...CHANNEL_FIELDS, ["data.user", "Who left"]],
  },
];

/** A Slack source's event types. Slack only sends events from channels the app is in. */
export function slackEventTypeCatalog(): EventTypeDescriptor[] {
  return SLACK_TYPES.map((entry) => ({
    type: entry.type,
    description: entry.description,
    fields: entry.fields.map(([field, description]) => ({ field, description })),
    argumentsSchema: null,
    available: true,
    unavailableReason: null,
  }));
}
