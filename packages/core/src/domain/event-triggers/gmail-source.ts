import { createPinnedIntegrationTransport } from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import type { McpConnectionAccountBinding } from "@opengeni/contracts";
import {
  createEventSource,
  recordEventSourceFeedDelivery,
  type Database,
  type EventSourceRecord,
  type EventStatusReason,
} from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { GMAIL_REST_API_BASE, isOfficialGmailMcpConfig } from "@opengeni/runtime/gmail-rest-mcp";
import { HTTPException } from "hono/http-exception";
import { accountIdentity } from "../mcp-account-routes";
import { sha256Hex } from "./delivery-intake";
import type {
  EventSourceFeedAdapter,
  EventSourceFeedReadContext,
  EventSourceFeedReadOutcome,
} from "./event-source-feeds";
import {
  GMAIL_EVENT_HEADERS,
  gmailDeliveryBody,
  gmailMessageEvent,
  gmailMessageMetadata,
  type GmailMessageMetadata,
} from "./gmail-events";
import { eventMatchesTrigger } from "./matching";
import {
  McpEventSourceUnavailableError,
  ownerConnectionBindings,
  ownerConnectionHeaders,
  workspaceMcpServers,
  type EventSourceOwner,
  type McpEventsFetch,
} from "./mcp-event-source-client";
import { boundEvent } from "./normalize";
import { eventStatusReason } from "./status-reason";

/**
 * The Gmail source: one person's mailbox, read with the Gmail connection
 * their chats use. Gmail sends nothing Opengeni can receive without an
 * operator's Pub/Sub setup, so the source's feed reads the mailbox history
 * every minute while an automation listens, and records each new inbox
 * message as a `message.received` event. The history id is the feed's
 * cursor; when Gmail no longer has the history since it, the feed starts
 * from now and marks the gap.
 */

const POLL_MS = 60_000;
const HISTORY_PAGE_SIZE = 500;
const HISTORY_MAX_PAGES = 10;
/** New messages read per step; a larger backlog continues in the next step at once. */
const MESSAGES_PER_READ = 100;
const MESSAGE_READ_CONCURRENCY = 5;
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const DELIVERY_BODY_MAX_BYTES = 1024 * 1024;
const RECONNECT = "Reconnect Gmail to keep its mail coming";

export type GmailSourceDeps = {
  db: Database;
  settings: Settings;
  /** Replaces the pinned integration transport, for tests. */
  fetch?: McpEventsFetch | undefined;
};

/** Gmail answered with an error status. */
export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export function gmailMailboxSourceKey(mailbox: string): string {
  return `email:${mailbox.toLowerCase()}`;
}

function sourceMailbox(source: EventSourceRecord): string {
  return source.externalKey?.replace(/^email:/u, "") ?? "";
}

/**
 * One connection per Gmail mailbox. A person can connect the same mailbox
 * more than once, for example from two workspaces; it is still one account,
 * read with this workspace's connection when there is one.
 */
export function gmailAccountBindings(
  bindings: readonly McpConnectionAccountBinding[],
  workspaceId: string,
): McpConnectionAccountBinding[] {
  const accounts = new Map<string, McpConnectionAccountBinding>();
  for (const binding of bindings) {
    const identity = accountIdentity(binding);
    const mailbox = identity.includes("@") ? identity.toLowerCase() : binding.connectionId;
    const kept = accounts.get(mailbox);
    if (
      !kept ||
      (kept.originWorkspaceId !== workspaceId && binding.originWorkspaceId === workspaceId)
    ) {
      accounts.set(mailbox, binding);
    }
  }
  return [...accounts.values()];
}

type GmailApi = {
  connectionId: string;
  get(path: string, query?: Record<string, string | readonly string[]>): Promise<unknown>;
};

/**
 * Gmail's REST API as the owner, with the Gmail connection their chats use.
 * Without `connectionId`, the owner's only Gmail connection.
 */
async function gmailApi(
  deps: GmailSourceDeps,
  owner: EventSourceOwner,
  connectionId: string | null,
): Promise<GmailApi> {
  const servers = (await workspaceMcpServers(deps, owner.workspaceId)).filter((server) =>
    isOfficialGmailMcpConfig(server.url, server.connectionRef),
  );
  if (servers.length === 0) {
    throw new McpEventSourceUnavailableError(
      "connector_removed",
      "Gmail is no longer added to this workspace",
    );
  }
  const bindings = await ownerConnectionBindings(deps, owner, servers);
  let binding = bindings.find((candidate) => candidate.connectionId === connectionId);
  if (!connectionId) {
    const accounts = gmailAccountBindings(bindings, owner.workspaceId);
    if (accounts.length > 1) {
      throw new HTTPException(422, {
        message: "You have more than one Gmail account connected. Choose which one to use.",
      });
    }
    binding = accounts[0];
  }
  const server = servers.find((candidate) => candidate.id === binding?.canonicalServerId);
  if (!binding || !server) throw new McpEventSourceUnavailableError("reconnect", RECONNECT);
  const headers = ownerConnectionHeaders(deps, owner, server, binding, {
    toolName: "events",
    destinationUrl: GMAIL_REST_API_BASE,
    reconnect: RECONNECT,
  });
  const transport =
    deps.fetch ?? createPinnedIntegrationTransport({ network: deps.settings }).fetch;
  let signed: Record<string, string> | null = null;
  const request = async (url: string, forceRefresh: boolean): Promise<Response> => {
    if (signed === null || forceRefresh) signed = await headers(forceRefresh);
    return await transport(url, {
      method: "GET",
      headers: { ...signed, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };
  return {
    connectionId: binding.connectionId,
    async get(path, query = {}) {
      const url = new URL(`${GMAIL_REST_API_BASE}${path}`);
      for (const [name, value] of Object.entries(query)) {
        for (const entry of typeof value === "string" ? [value] : value) {
          url.searchParams.append(name, entry);
        }
      }
      let response = await request(url.toString(), false);
      if (response.status === 401) {
        await response.body?.cancel();
        response = await request(url.toString(), true);
      }
      if (!response.ok) {
        const body = await readResponseJsonBounded<{
          error?: { message?: string; errors?: Array<{ reason?: string }>; status?: string };
        }>(response, 64 * 1024, "Gmail error").catch(() => null);
        const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;
        throw new GmailApiError(
          response.status,
          reason,
          `Gmail answered ${response.status}${body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ""}`,
        );
      }
      return await readResponseJsonBounded(response, RESPONSE_MAX_BYTES, "Gmail response");
    },
  };
}

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function historyId(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,30}$/u.test(value) ? value : null;
}

async function readProfile(api: GmailApi): Promise<{ mailbox: string; historyId: string }> {
  const profile = object(await api.get("/profile"));
  const mailbox = typeof profile.emailAddress === "string" ? profile.emailAddress : null;
  const current = historyId(profile.historyId);
  if (!mailbox || !current) throw new Error("Gmail's profile had no address or history id");
  return { mailbox: mailbox.toLowerCase(), historyId: current };
}

/** Add the caller's Gmail mailbox as a source, or return the one they have. */
export async function createGmailEventSource(input: {
  db: Database;
  settings: Settings;
  fetch?: McpEventsFetch | undefined;
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  ownerSubjectId: string | null;
  connectionId?: string | undefined;
  name?: string | undefined;
}): Promise<EventSourceRecord> {
  const ownerSubjectId = input.ownerSubjectId;
  if (!ownerSubjectId) {
    throw new HTTPException(422, {
      message: "A Gmail source reads one person's mailbox. Create it as that person.",
    });
  }
  const owner = { accountId: input.accountId, workspaceId: input.workspaceId, ownerSubjectId };
  let api: GmailApi;
  let profile: { mailbox: string; historyId: string };
  try {
    api = await gmailApi(input, owner, input.connectionId ?? null);
    profile = await readProfile(api);
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof McpEventSourceUnavailableError) {
      throw new HTTPException(422, {
        message:
          error.reason.code === "reconnect"
            ? "Connect your Gmail account first, then add it as a source"
            : `${error.message}. Add it, connect your account, then try again.`,
      });
    }
    const blocked = gmailBlockedReason(error);
    if (blocked) throw new HTTPException(422, { message: blocked.text });
    throw new HTTPException(503, {
      message: `Couldn't reach Gmail (${(error instanceof Error ? error.message : String(error)).slice(0, 200)}). Try again shortly.`,
    });
  }
  const { source, created } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "gmail",
    name: input.name ?? `Gmail (${profile.mailbox})`.slice(0, 120),
    ownerSubjectId,
    visibility: "private",
    externalKey: gmailMailboxSourceKey(profile.mailbox),
    connectionId: api.connectionId,
  });
  if (!created && source.ownerSubjectId !== ownerSubjectId) {
    throw new HTTPException(409, {
      message: "Someone else in this workspace already receives this mailbox's mail as events",
    });
  }
  return source;
}

/** What a person has to fix when Gmail refuses, in plain language; null when retrying may help. */
export function gmailBlockedReason(error: unknown): EventStatusReason | null {
  if (!(error instanceof GmailApiError)) return null;
  if (error.status === 401) return eventStatusReason("reconnect", RECONNECT);
  if (
    error.status === 403 &&
    !["rateLimitExceeded", "userRateLimitExceeded", "backendError"].includes(error.reason ?? "")
  ) {
    return eventStatusReason(
      "missing_permission",
      "Gmail doesn't let Opengeni read this mailbox any more. Reconnect Gmail and allow reading mail.",
    );
  }
  if (error.status === 400 && error.reason === "failedPrecondition") {
    return eventStatusReason("app_not_enabled", "Gmail isn't turned on for this account");
  }
  return null;
}

/** History records of new inbox messages since `start`, up to the read budget. */
async function readNewMessageIds(
  api: GmailApi,
  start: string,
): Promise<{ messageIds: string[]; cursor: string; more: boolean } | { expired: true }> {
  const messageIds: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    let response: Json;
    try {
      response = object(
        await api.get("/history", {
          startHistoryId: start,
          historyTypes: "messageAdded",
          labelId: "INBOX",
          maxResults: String(HISTORY_PAGE_SIZE),
          ...(pageToken ? { pageToken } : {}),
        }),
      );
    } catch (error) {
      // Gmail keeps about a week of history; an older cursor is gone.
      if (error instanceof GmailApiError && error.status === 404) return { expired: true };
      throw error;
    }
    const records = Array.isArray(response.history) ? response.history : [];
    for (const record of records.map(object)) {
      const added = Array.isArray(record.messagesAdded) ? record.messagesAdded : [];
      for (const entry of added) {
        const message = object(object(entry).message);
        const id = typeof message.id === "string" ? message.id : null;
        const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
        if (!id || seen.has(id) || (labels.length > 0 && !labels.includes("INBOX"))) continue;
        seen.add(id);
        messageIds.push(id);
      }
      const recordId = historyId(record.id);
      // Stop at a record boundary once the budget is used; the rest is read next.
      if (messageIds.length >= MESSAGES_PER_READ && recordId) {
        return { messageIds, cursor: recordId, more: true };
      }
    }
    pageToken = typeof response.nextPageToken === "string" ? response.nextPageToken : null;
    const latest = historyId(response.historyId);
    if (!pageToken) return { messageIds, cursor: latest ?? start, more: false };
    const last = historyId(object(records.at(-1)).id);
    if (page === HISTORY_MAX_PAGES - 1 && last) return { messageIds, cursor: last, more: true };
  }
  return { messageIds, cursor: start, more: true };
}

/** The headers and snippet of each message, in order; messages deleted meanwhile are left out. */
async function readMessages(
  api: GmailApi,
  ids: readonly string[],
): Promise<GmailMessageMetadata[]> {
  const read = new Array<GmailMessageMetadata | null>(ids.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < ids.length; index = next++) {
      try {
        read[index] = gmailMessageMetadata(
          await api.get(`/messages/${encodeURIComponent(ids[index]!)}`, {
            format: "metadata",
            metadataHeaders: GMAIL_EVENT_HEADERS,
          }),
        );
      } catch (error) {
        if (!(error instanceof GmailApiError && error.status === 404)) throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MESSAGE_READ_CONCURRENCY, ids.length) }, worker));
  return read.filter((message): message is GmailMessageMetadata => message !== null);
}

async function readGmailFeed(
  context: EventSourceFeedReadContext,
): Promise<EventSourceFeedReadOutcome> {
  const { deps, source, feed, now } = context;
  const mailbox = sourceMailbox(source);
  const owner = source.ownerSubjectId;
  if (!owner || !mailbox) {
    throw new McpEventSourceUnavailableError("unavailable", "This source has no mailbox");
  }
  const api = await gmailApi(
    deps,
    { accountId: source.accountId, workspaceId: source.workspaceId, ownerSubjectId: owner },
    source.connectionId,
  );
  const later = new Date(now.getTime() + POLL_MS);
  if (feed.cursor === null) {
    // The first read only learns where "now" is; earlier mail is not replayed.
    const profile = await readProfile(api);
    if (profile.mailbox !== mailbox) {
      throw new McpEventSourceUnavailableError(
        "account_changed",
        `This Gmail connection now signs in as ${profile.mailbox}, not ${mailbox}. Reconnect ${mailbox}.`,
        profile.mailbox,
      );
    }
    return { cursor: profile.historyId, nextActionAt: later };
  }
  const found = await readNewMessageIds(api, feed.cursor);
  if ("expired" in found) {
    const profile = await readProfile(api);
    return { cursor: profile.historyId, gapPending: true, nextActionAt: later };
  }
  const nextActionAt = found.more ? now : later;
  const messages = await readMessages(api, found.messageIds);
  if (messages.length === 0) return { cursor: found.cursor, nextActionAt };
  const body = gmailDeliveryBody(mailbox, messages);
  const missing = found.messageIds.length - messages.length;
  const recorded = await recordEventSourceFeedDelivery(deps.db, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    cursor: found.cursor,
    delivery: {
      status: "accepted",
      reason:
        missing > 0
          ? `${missing} message${missing === 1 ? " was" : "s were"} deleted before Opengeni read ${missing === 1 ? "it" : "them"}`
          : null,
      dedupeKey: `gmail:${feed.cursor}:${found.cursor}`,
      body: body.byteLength <= DELIVERY_BODY_MAX_BYTES ? body : null,
      bodyBytes: body.byteLength,
      bodySha256: sha256Hex(body),
      headers: {},
      events: messages.map((message) => boundEvent(gmailMessageEvent(mailbox, message, now), now)),
      match: eventMatchesTrigger,
    },
  });
  if (!recorded) throw new Error("The source was removed while its mail was read");
  return { nextActionAt };
}

export const gmailFeed: EventSourceFeedAdapter = {
  appName: "Gmail",
  read: readGmailFeed,
  blockedReason: (error) => gmailBlockedReason(error),
};
