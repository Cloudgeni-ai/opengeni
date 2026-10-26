import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  SHARED_SESSION_MAX_BYTES,
  SHARED_SESSION_MAX_MESSAGES,
  SharedSessionSnapshot,
  type AccessGrant,
  type Session,
  type SessionEvent,
  type SessionShareLink,
  type SessionShareLinkList,
  type SessionShareLinkState,
  type SharedSession,
  type SharedSessionMessage,
} from "@opengeni/contracts";
import {
  findLiveSessionShareLink,
  getLiveSessionShareLink,
  getSession,
  listLiveSessionShareLinks,
  listSessionEvents,
  revokeSessionShareLink as revokeStoredSessionShareLink,
  saveSessionShareLink,
  type Database,
  type SessionShareLinkRecord,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/**
 * Read-only chat share links. The person who started a chat can create one
 * link for it; anyone holding the link reads a snapshot of the visible
 * conversation taken at that moment. Sharing again refreshes the same link;
 * stopping it ends the link for good.
 *
 * The snapshot is built here, on the server, from only two kinds of event:
 * the person's own messages and the replies the chat shows them. Tool calls,
 * tool output, files, attachments, quoted annotations, hidden model context
 * and progress notes never enter it, so nothing the agent read but didn't
 * show can leak through a link.
 */

export type SessionShareLinkDeps = {
  db: Database;
  settings: Pick<Settings, "privacyChatShareLinksAllowed">;
};

// Plain refusals, read by the person and, through app actions, the agent.
export const SHARE_LINKS_OFF_MESSAGE = "Share links are turned off on this server.";
export const SHARE_LINKS_EXTERNAL_PERSON_MESSAGE =
  "Share links aren't available here. Nothing was shared.";
export const SHARE_LINKS_NOT_STARTER_MESSAGE =
  "Only the person who started this chat can create or stop its share link. Nothing was changed.";

const EVENT_PAGE = 500;
const MAX_EVENT_PAGES = 400;
const MAX_TITLE_CHARS = 200;

type SnapshotEvent = Pick<SessionEvent, "type" | "sequence" | "turnId" | "payload">;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The text a link shows for one message. Images become a short note (a link
 * shows text only), and links to the chat's own files and artifacts keep only
 * their words, since nobody outside the chat can open them.
 */
export function sharedMessageText(text: string): string {
  return text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/gu, "[image not included]")
    .replace(
      /\[([^\]\n]*)\]\(\s*<?(?:artifact|sandbox|opengeni|site|document|knowledge):[^)\n]*\)/giu,
      (_match, label: string) => label,
    )
    .trim();
}

/**
 * The visible conversation in `events` (any order): each message a person
 * sent, and each turn's reply as the chat shows it (its last final answer;
 * for a finished turn with only progress notes, the first and last of them).
 * The newest messages are kept when the conversation is larger than a link
 * holds.
 */
export function buildSharedSessionSnapshot(events: readonly SnapshotEvent[]): {
  snapshot: SharedSessionSnapshot;
  throughSequence: number;
} {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const settled = new Set<string>();
  const replies = new Map<string, { sequence: number; text: string; final: boolean }[]>();
  const entries: { sequence: number; message: SharedSessionMessage }[] = [];
  let throughSequence = 0;
  for (const event of ordered) {
    throughSequence = Math.max(throughSequence, event.sequence);
    const payload = record(event.payload);
    if (event.type === "user.message") {
      const initiator = record(payload.initiator);
      // Only what a person typed; schedules, services and other agents are not "the person".
      if (initiator.kind !== undefined && initiator.kind !== "subject") continue;
      const text = typeof payload.text === "string" ? sharedMessageText(payload.text) : "";
      if (text) entries.push({ sequence: event.sequence, message: { role: "user", text } });
    } else if (event.type === "agent.message.completed") {
      const text = typeof payload.text === "string" ? sharedMessageText(payload.text) : "";
      if (!text) continue;
      const key = event.turnId ?? `sequence:${event.sequence}`;
      const turn = replies.get(key) ?? [];
      turn.push({ sequence: event.sequence, text, final: payload.phase !== "commentary" });
      replies.set(key, turn);
      if (!event.turnId) settled.add(key);
    } else if (
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled") &&
      event.turnId
    ) {
      settled.add(event.turnId);
    }
  }
  for (const [key, messages] of replies) {
    const final = messages.filter((message) => message.final).at(-1);
    const shown = final
      ? [final]
      : settled.has(key) && messages.length > 0
        ? [...new Set([messages[0]!, messages.at(-1)!])]
        : [];
    for (const message of shown) {
      entries.push({
        sequence: message.sequence,
        message: { role: "assistant", text: message.text },
      });
    }
  }
  entries.sort((a, b) => a.sequence - b.sequence);
  const kept: SharedSessionMessage[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]!.message;
    const size = Buffer.byteLength(message.text, "utf8") + 32;
    if (kept.length >= SHARED_SESSION_MAX_MESSAGES || bytes + size > SHARED_SESSION_MAX_BYTES) {
      break;
    }
    bytes += size;
    kept.unshift(message);
  }
  return {
    snapshot: { messages: kept, omittedMessageCount: entries.length - kept.length },
    throughSequence,
  };
}

function shareTitle(session: Session, snapshot: SharedSessionSnapshot): string {
  // A chat still waiting for its title reads better by its first question.
  const title =
    session.title?.trim() === AUTOMATIC_SESSION_TITLE_FALLBACK ? "" : session.title?.trim();
  const fallback = snapshot.messages
    .find((message) => message.role === "user")
    ?.text.split("\n")
    .find((line) => line.trim())
    ?.trim();
  const chosen = title || fallback || "Shared conversation";
  return chosen.length > MAX_TITLE_CHARS ? `${chosen.slice(0, MAX_TITLE_CHARS - 1)}…` : chosen;
}

function messageCount(link: SessionShareLinkRecord): number {
  const parsed = SharedSessionSnapshot.safeParse(link.snapshot);
  return parsed.success ? parsed.data.messages.length : 0;
}

function shareUrl(webBaseUrl: string, shareId: string): string {
  return `${webBaseUrl.replace(/\/+$/u, "")}/share/${shareId}`;
}

function toPublicLink(link: SessionShareLinkRecord, webBaseUrl: string): SessionShareLink {
  return {
    shareId: link.shareId,
    url: shareUrl(webBaseUrl, link.shareId),
    workspaceId: link.workspaceId,
    sessionId: link.sessionId,
    title: link.title,
    messageCount: messageCount(link),
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

function sharingAllowed(deps: SessionShareLinkDeps): boolean {
  return deps.settings.privacyChatShareLinksAllowed !== false;
}

/** Someone who uses Opengeni through another product, such as a person in an embedded chat. */
function isExternalPerson(subjectId: string): boolean {
  return subjectId.startsWith("external_user:");
}

/** The chat, when this person may share it: they started it, signed in as themselves. */
async function requireSharableSession(
  deps: SessionShareLinkDeps,
  grant: AccessGrant,
  workspaceId: string,
  sessionId: string,
): Promise<Session> {
  if (!sharingAllowed(deps)) {
    throw new HTTPException(403, { message: SHARE_LINKS_OFF_MESSAGE });
  }
  if (isExternalPerson(grant.subjectId)) {
    throw new HTTPException(403, { message: SHARE_LINKS_EXTERNAL_PERSON_MESSAGE });
  }
  const session = await getSession(deps.db, workspaceId, sessionId);
  if (!session) throw new HTTPException(404, { message: "session not found" });
  if (
    !grant.subjectId.startsWith("user:") ||
    session.parentSessionId !== null ||
    session.createdBy.kind !== "subject" ||
    session.createdBy.subjectId !== grant.subjectId
  ) {
    throw new HTTPException(403, { message: SHARE_LINKS_NOT_STARTER_MESSAGE });
  }
  return session;
}

async function readVisibleConversation(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SnapshotEvent[]> {
  const events: SnapshotEvent[] = [];
  let after = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const batch = await listSessionEvents(db, workspaceId, sessionId, {
      after,
      limit: EVENT_PAGE,
      includeTypes: [
        "user.message",
        "agent.message.completed",
        "turn.completed",
        "turn.failed",
        "turn.cancelled",
      ],
    });
    for (const event of batch) {
      events.push({
        type: event.type,
        sequence: event.sequence,
        turnId: event.turnId,
        payload: event.payload,
      });
      after = Math.max(after, event.sequence);
    }
    if (batch.length < EVENT_PAGE) break;
  }
  return events;
}

/** Whether this person can share the chat here, and their live link. */
export async function getSessionShareLinkState(
  deps: SessionShareLinkDeps,
  grant: AccessGrant,
  input: { workspaceId: string; sessionId: string; webBaseUrl: string },
): Promise<SessionShareLinkState> {
  const enabled = sharingAllowed(deps) && !isExternalPerson(grant.subjectId);
  if (!enabled) return { enabled: false, link: null };
  const link = await getLiveSessionShareLink(
    deps.db,
    { accountId: grant.accountId, workspaceId: input.workspaceId },
    { sessionId: input.sessionId, createdBySubjectId: grant.subjectId },
  );
  return { enabled: true, link: link ? toPublicLink(link, input.webBaseUrl) : null };
}

/**
 * Share the chat as it is now: create this person's link, or refresh the
 * snapshot behind their existing one (the link stays the same).
 */
export async function createSessionShareLink(
  deps: SessionShareLinkDeps,
  grant: AccessGrant,
  input: { workspaceId: string; sessionId: string; webBaseUrl: string },
): Promise<{ link: SessionShareLink; created: boolean }> {
  const session = await requireSharableSession(deps, grant, input.workspaceId, input.sessionId);
  const { snapshot, throughSequence } = buildSharedSessionSnapshot(
    await readVisibleConversation(deps.db, input.workspaceId, input.sessionId),
  );
  const saved = await saveSessionShareLink(
    deps.db,
    { accountId: grant.accountId, workspaceId: input.workspaceId },
    {
      sessionId: input.sessionId,
      createdBySubjectId: grant.subjectId,
      shareId: randomBytes(16).toString("base64url"),
      title: shareTitle(session, snapshot),
      snapshot,
      snapshotThroughSequence: throughSequence,
    },
  );
  return { link: toPublicLink(saved.link, input.webBaseUrl), created: saved.created };
}

/** Stop this person's link to the chat. Stopping a chat that has none is a no-op. */
export async function revokeSessionShareLink(
  deps: SessionShareLinkDeps,
  grant: AccessGrant,
  input: { workspaceId: string; sessionId: string },
): Promise<{ revoked: boolean }> {
  if (isExternalPerson(grant.subjectId)) {
    throw new HTTPException(403, { message: SHARE_LINKS_EXTERNAL_PERSON_MESSAGE });
  }
  // Stopping always works, even with sharing turned off since.
  const revoked = await revokeStoredSessionShareLink(
    deps.db,
    { accountId: grant.accountId, workspaceId: input.workspaceId },
    { sessionId: input.sessionId, createdBySubjectId: grant.subjectId },
  );
  return { revoked: revoked !== null };
}

/** This person's live links in a workspace, newest first. */
export async function listSessionShareLinks(
  deps: SessionShareLinkDeps,
  grant: AccessGrant,
  input: { workspaceId: string; webBaseUrl: string; limit?: number },
): Promise<SessionShareLinkList> {
  if (isExternalPerson(grant.subjectId)) return { links: [] };
  const links = await listLiveSessionShareLinks(
    deps.db,
    { accountId: grant.accountId, workspaceId: input.workspaceId },
    { createdBySubjectId: grant.subjectId, limit: input.limit ?? 100 },
  );
  return { links: links.map((link) => toPublicLink(link, input.webBaseUrl)) };
}

/** What anyone holding a link reads; null when it doesn't open (unknown, stopped or turned off). */
export async function readSharedSession(
  deps: SessionShareLinkDeps,
  shareId: string,
): Promise<SharedSession | null> {
  if (!sharingAllowed(deps)) return null;
  const link = await findLiveSessionShareLink(deps.db, shareId);
  if (!link) return null;
  const snapshot = SharedSessionSnapshot.safeParse(link.snapshot);
  if (!snapshot.success) return null;
  return {
    title: link.title,
    sharedAt: link.updatedAt.toISOString(),
    messages: snapshot.data.messages,
    omittedMessageCount: snapshot.data.omittedMessageCount,
  };
}
