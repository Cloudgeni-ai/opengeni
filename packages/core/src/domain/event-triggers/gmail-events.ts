import type { EventActorKind, EventTypeDescriptor } from "@opengeni/contracts";
import { oneLine, type NormalizedEventInput } from "./normalize";

/**
 * New Gmail inbox messages as automation events. The feed reads each new
 * message's headers and snippet (never its body) and keeps them as the
 * delivery body, so a stored delivery reads the same on replay. Mail that
 * Opengeni's own Gmail tools wrote carries a Message-ID at
 * `opengeni.invalid` and counts as Opengeni's own event, so an automation
 * that emails its owner does not wake itself.
 */

export const GMAIL_MESSAGE_RECEIVED = "message.received";

/** The headers the feed reads with each message. */
export const GMAIL_EVENT_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID"] as const;

/** One new message as the feed keeps it: Gmail's ids, labels, snippet and the read headers. */
export type GmailMessageMetadata = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  /** Milliseconds since the epoch, as Gmail gives it. */
  internalDate: string | null;
  /** Header values by lower-case name. */
  headers: Record<string, string>;
};

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown, max = 1_000): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

/** A Gmail message resource (`format=metadata`) as feed metadata; null when it is not one. */
export function gmailMessageMetadata(value: unknown): GmailMessageMetadata | null {
  const message = object(value);
  const id = text(message?.id, 256);
  const threadId = text(message?.threadId, 256);
  if (!message || !id || !threadId) return null;
  const headers: Record<string, string> = {};
  const wanted = new Set(GMAIL_EVENT_HEADERS.map((name) => name.toLowerCase()));
  const listed = object(message.payload)?.headers;
  for (const entry of Array.isArray(listed) ? listed : []) {
    const name = text(object(entry)?.name, 100)?.toLowerCase();
    const headerValue = text(object(entry)?.value, 2_000);
    if (name && headerValue && wanted.has(name) && !(name in headers)) headers[name] = headerValue;
  }
  return {
    id,
    threadId,
    labelIds: Array.isArray(message.labelIds)
      ? message.labelIds.filter((label): label is string => typeof label === "string").slice(0, 50)
      : [],
    snippet: text(message.snippet, 500) ?? "",
    internalDate: text(message.internalDate, 20),
    headers,
  };
}

/** `Jane Doe <jane@example.com>` as its display name and lower-case address. */
export function parseMailbox(value: string | undefined): {
  name: string | null;
  address: string | null;
} {
  if (!value) return { name: null, address: null };
  const angle = /<([^<>\s]+@[^<>\s]+)>/u.exec(value);
  if (angle?.[1]) {
    const name = value
      .slice(0, angle.index)
      .trim()
      .replace(/^"(.*)"$/u, "$1")
      .trim();
    return { name: name || null, address: angle[1].toLowerCase() };
  }
  const bare = /[^\s<>"',;:]+@[^\s<>"',;:]+/u.exec(value);
  return { name: null, address: bare ? bare[0].toLowerCase() : null };
}

function messageTime(message: GmailMessageMetadata): Date | null {
  const millis = Number(message.internalDate);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis);
  const parsed = message.headers.date ? Date.parse(message.headers.date) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function actorKind(message: GmailMessageMetadata): EventActorKind {
  return /@opengeni\.invalid>?\s*$/iu.test(message.headers["message-id"] ?? "")
    ? "opengeni"
    : "person";
}

/** A link that opens the message's conversation in the mailbox's own Gmail. */
export function gmailThreadUrl(mailbox: string, threadId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(threadId)}`;
}

/** One new inbox message as a `message.received` event. */
export function gmailMessageEvent(
  mailbox: string,
  message: GmailMessageMetadata,
  receivedAt: Date,
): NormalizedEventInput {
  const from = parseMailbox(message.headers.from);
  const subject = message.headers.subject ? oneLine(message.headers.subject, 300) : null;
  const sender = from.name ?? from.address ?? "an unknown sender";
  return {
    externalId: message.id,
    type: GMAIL_MESSAGE_RECEIVED,
    occurredAt: messageTime(message) ?? receivedAt,
    subject,
    summary: oneLine(`Email from ${sender}: ${subject ?? "(no subject)"}`, 300),
    url: gmailThreadUrl(mailbox, message.threadId),
    actor: { kind: actorKind(message), name: from.name ?? from.address },
    data: Object.fromEntries(
      Object.entries({
        mailbox,
        message_id: message.id,
        thread_id: message.threadId,
        from: message.headers.from,
        from_name: from.name,
        from_address: from.address,
        to: message.headers.to,
        cc: message.headers.cc,
        subject: message.headers.subject,
        snippet: message.snippet || null,
        labels: message.labelIds,
        date: messageTime(message)?.toISOString(),
      }).filter(([, value]) => value !== null && value !== undefined),
    ),
  };
}

/** The stored body of one feed read: the mailbox and the new messages, in order. */
export function gmailDeliveryBody(
  mailbox: string,
  messages: readonly GmailMessageMetadata[],
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ mailbox, messages }));
}

/** The events a stored Gmail delivery carries, to replay it. */
export function gmailDeliveryEvents(body: Uint8Array, receivedAt: Date): NormalizedEventInput[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return [];
  }
  const stored = object(value);
  const mailbox = text(stored?.mailbox, 320);
  if (!stored || !mailbox || !Array.isArray(stored.messages)) return [];
  return stored.messages.flatMap((entry) => {
    const message = object(entry);
    if (!message || typeof message.id !== "string" || typeof message.threadId !== "string") {
      return [];
    }
    const headers = object(message.headers) ?? {};
    return [
      gmailMessageEvent(
        mailbox,
        {
          id: message.id,
          threadId: message.threadId,
          labelIds: Array.isArray(message.labelIds)
            ? message.labelIds.filter((label): label is string => typeof label === "string")
            : [],
          snippet: text(message.snippet, 500) ?? "",
          internalDate: text(message.internalDate, 20),
          headers: Object.fromEntries(
            Object.entries(headers).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string",
            ),
          ),
        },
        receivedAt,
      ),
    ];
  });
}

const MESSAGE_FIELDS: Array<[string, string]> = [
  ["data.from_address", "The sender's address, in lower case"],
  ["data.from", "The From header, with the sender's name"],
  ["data.subject", "The subject line"],
  ["data.to", "The To header"],
  ["data.snippet", "The start of the message text"],
  ["data.labels", "Gmail label ids, such as IMPORTANT or CATEGORY_PERSONAL"],
  ["data.thread_id", "The conversation the message belongs to"],
];

/** A Gmail source's event types. */
export function gmailEventTypeCatalog(): EventTypeDescriptor[] {
  return [
    {
      type: GMAIL_MESSAGE_RECEIVED,
      description: "A new message arrived in the inbox",
      fields: MESSAGE_FIELDS.map(([field, description]) => ({ field, description })),
      argumentsSchema: null,
      available: true,
      unavailableReason: null,
      unavailableReasonCode: null,
      unavailableReasonDetail: null,
    },
  ];
}
