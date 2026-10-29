import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  SHARED_SESSION_MAX_BYTES,
  SHARED_SESSION_MAX_MESSAGES,
  SharedSessionSnapshot,
  SessionEventType,
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
  isTurnExecutionEvidence,
  orderTimelineEvents,
  prescanTurnAnchors,
} from "@opengeni/contracts/timeline-order";
import {
  findLiveSessionShareLink,
  getLiveSessionShareLink,
  getManagedUserProfilesByIds,
  getSession,
  getWorkspaceGrant,
  listLiveSessionShareLinks,
  listSessionEvents,
  listWorkspaceMembers,
  revokeSessionShareLink as revokeStoredSessionShareLink,
  saveSessionShareLink,
  namedSubjectHasLiveWorkspaceAuthority,
  withWorkspaceSubjectRls,
  type Database,
  type SessionShareLinkRecord,
} from "@opengeni/db";
import { hasPermission } from "../access";
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

type SnapshotEvent = Pick<SessionEvent, "id" | "type" | "sequence" | "turnId" | "payload">;

/**
 * The events that decide what the chat shows: each message and reply, and
 * the queue and turn signals that say whether a queued message ever ran
 * (edited, deleted or cancelled before it started means it never appears).
 * Every kind the timeline counts as a turn having run is included, so older
 * chats missing `turn.started` place messages exactly as the chat does.
 * Streaming deltas, tool calls and model usage are left out: they only ever
 * follow their turn's model request, which already counts, so they can't
 * change the result and would only add bulky reads.
 */
function isOrderingOnlyAfterModelRequest(type: string): boolean {
  return (
    type.endsWith(".delta") || type.startsWith("agent.toolCall.") || type === "agent.model.usage"
  );
}

export const SNAPSHOT_EVENT_TYPES: readonly SessionEvent["type"][] = [
  ...new Set<SessionEvent["type"]>([
    "user.message",
    "agent.message.completed",
    "turn.queued",
    "turn.started",
    "turn.cancelled",
    "session.queue.changed",
    "session.control.steer_requested",
    ...SessionEventType.options.filter(
      (type) => isTurnExecutionEvidence(type) && !isOrderingOnlyAfterModelRequest(type),
    ),
  ]),
];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The text a link shows for one message. Images become a short note (a link
 * shows text only), and links to the chat's own files and artifacts keep only
 * their words, since nobody outside the chat can open them: inline links,
 * reference links and their definitions, and bare autolinks alike.
 */
const PRIVATE_SCHEME = "(?:artifact|sandbox|opengeni|site|document|knowledge):";
const PRIVATE_INLINE_LINK = new RegExp(
  `\\[([^\\]\\n]*)\\]\\(\\s*<?${PRIVATE_SCHEME}[^)\\n]*\\)`,
  "giu",
);
const PRIVATE_REFERENCE_DEFINITION = new RegExp(
  `^[ \\t]{0,3}\\[([^\\]\\n]+)\\]:[ \\t]*<?${PRIVATE_SCHEME}[^\\n]*(?:\\n|$)`,
  "gimu",
);
const PRIVATE_AUTOLINK = new RegExp(`( ?)<${PRIVATE_SCHEME}([^>\\s]*)>`, "giu");

/** A private link's readable words: a file's name, never an opaque id. */
function privateLinkWords(target: string): string {
  const name = target.split(/[/\\]/u).filter(Boolean).at(-1) ?? "";
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Keep the name as written.
  }
  return /^[0-9a-f-]{16,}$/iu.test(decoded) ? "" : decoded;
}

export function sharedMessageText(text: string): string {
  const references = new Set<string>();
  const withoutDefinitions = text.replace(PRIVATE_REFERENCE_DEFINITION, (_match, label: string) => {
    references.add(label.trim().toLowerCase());
    return "";
  });
  return withoutDefinitions
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/gu, "[image not included]")
    .replace(PRIVATE_INLINE_LINK, (_match, label: string) => label)
    .replace(/\[([^\]\n]*)\]\[([^\]\n]*)\]/gu, (match, label: string, reference: string) =>
      references.has((reference || label).trim().toLowerCase()) ? label : match,
    )
    .replace(/\[([^\]\n]+)\](?![[(:])/gu, (match, label: string) =>
      references.has(label.trim().toLowerCase()) ? label : match,
    )
    .replace(PRIVATE_AUTOLINK, (_match, space: string, target: string) => {
      const words = privateLinkWords(target);
      return words ? `${space}${words}` : "";
    })
    .trim();
}

function looksLikeEmail(value: string): boolean {
  return /\S+@\S+\.\S+/u.test(value);
}

/**
 * The name a link shows above a person's messages: the name the chat shows
 * for them, never an email address or an internal id. Null when the chat has
 * no such name for them.
 */
export function sharedSenderName(
  subjectId: string,
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (name && name !== subjectId && !looksLikeEmail(name)) {
      return name.length > 120 ? `${name.slice(0, 119)}…` : name;
    }
  }
  return null;
}

/** Who sent a person's message: its initiator, or the chat's starter for an older message without one. */
function messageSubject(
  payload: Record<string, unknown>,
  starterSubjectId: string | null,
): { subjectId: string | null; label: string | null } | null {
  const initiator = record(payload.initiator);
  if (initiator.kind === undefined) return { subjectId: starterSubjectId, label: null };
  // Only what a person typed; schedules, services and other agents are not "the person".
  if (initiator.kind !== "subject") return null;
  return {
    subjectId: typeof initiator.subjectId === "string" ? initiator.subjectId : null,
    label: typeof initiator.label === "string" ? initiator.label : null,
  };
}

/** The people who sent messages in `events`, for looking up their names. */
export function snapshotSenderSubjectIds(
  events: readonly SnapshotEvent[],
  starterSubjectId: string | null,
): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "user.message") continue;
    const subject = messageSubject(record(event.payload), starterSubjectId);
    if (subject?.subjectId) ids.add(subject.subjectId);
  }
  return [...ids];
}

/**
 * The visible conversation in `events` (any order), exactly as the chat's
 * timeline shows it: each message a person sent that the timeline shows (a
 * queued message appears only once it ran; one edited, deleted or cancelled
 * before it started never does), placed where the timeline places it, and
 * each turn's reply as the chat shows it (its last final answer; for a
 * finished turn with only progress notes, the first and last of them). The
 * newest messages are kept when the conversation is larger than a link holds.
 */
export function buildSharedSessionSnapshot(
  events: readonly SnapshotEvent[],
  people: { starterSubjectId?: string | null; names?: ReadonlyMap<string, string> } = {},
): {
  snapshot: SharedSessionSnapshot;
  throughSequence: number;
} {
  const starterSubjectId = people.starterSubjectId ?? null;
  // The timeline's own rules decide which messages show and where.
  const shown = orderTimelineEvents(events, prescanTurnAnchors(events));
  const position = new Map<SnapshotEvent, number>();
  shown.forEach((event, index) => position.set(event, index));
  const settled = new Set<string>();
  const replies = new Map<string, { position: number; text: string; final: boolean }[]>();
  const entries: { position: number; message: SharedSessionMessage }[] = [];
  let throughSequence = 0;
  for (const event of events) throughSequence = Math.max(throughSequence, event.sequence);
  for (const event of shown) {
    const payload = record(event.payload);
    const at = position.get(event)!;
    if (event.type === "user.message") {
      const subject = messageSubject(payload, starterSubjectId);
      if (!subject) continue;
      const text = typeof payload.text === "string" ? sharedMessageText(payload.text) : "";
      if (!text) continue;
      const sender = subject.subjectId ? people.names?.get(subject.subjectId) : undefined;
      entries.push({
        position: at,
        message: { role: "user", text, ...(sender ? { sender } : {}) },
      });
    } else if (event.type === "agent.message.completed") {
      const text = typeof payload.text === "string" ? sharedMessageText(payload.text) : "";
      if (!text) continue;
      const key = event.turnId ?? `sequence:${event.sequence}`;
      const turn = replies.get(key) ?? [];
      turn.push({ position: at, text, final: payload.phase !== "commentary" });
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
    const chosen = final
      ? [final]
      : settled.has(key) && messages.length > 0
        ? [...new Set([messages[0]!, messages.at(-1)!])]
        : [];
    for (const message of chosen) {
      entries.push({
        position: message.position,
        message: { role: "assistant", text: message.text },
      });
    }
  }
  entries.sort((a, b) => a.position - b.position);
  const kept: SharedSessionMessage[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]!.message;
    const size =
      Buffer.byteLength(message.text, "utf8") +
      Buffer.byteLength(message.sender ?? "", "utf8") +
      32;
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

/** A title as plain words: markdown markers, link targets and code ticks removed. */
export function plainShareTitle(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
    .replace(/(^|[^\p{L}\p{N}])[*_](?=\S)(.+?)(?<=\S)[*_](?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/`+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function shareTitle(session: Session, snapshot: SharedSessionSnapshot): string {
  // A chat still waiting for its title reads better by its first question.
  const title =
    session.title?.trim() === AUTOMATIC_SESSION_TITLE_FALLBACK ? "" : session.title?.trim();
  const fallback = snapshot.messages
    .find((message) => message.role === "user")
    ?.text.split("\n")
    .map(plainShareTitle)
    .find(Boolean);
  const chosen = (title && plainShareTitle(title)) || fallback || "Shared conversation";
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
      includeTypes: SNAPSHOT_EVENT_TYPES,
    });
    for (const event of batch) {
      events.push({
        id: event.id,
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

/**
 * The names the chat shows for the people who wrote in it, in the chat's own
 * order: their profile name, else their name in the workspace, else the name
 * their message carried. Email addresses and ids are skipped.
 */
async function senderNames(
  db: Database,
  workspaceId: string,
  events: readonly SnapshotEvent[],
  starterSubjectId: string | null,
): Promise<Map<string, string>> {
  const subjectIds = snapshotSenderSubjectIds(events, starterSubjectId);
  const userIds = subjectIds.flatMap((subjectId) =>
    subjectId.startsWith("user:") ? [subjectId.slice("user:".length)] : [],
  );
  const profiles = new Map(
    (await getManagedUserProfilesByIds(db, userIds)).map((profile) => [
      `user:${profile.id}`,
      profile.name,
    ]),
  );
  const memberLabels = new Map(
    (await listWorkspaceMembers(db, workspaceId)).map((member) => [
      member.subjectId,
      member.subjectLabel,
    ]),
  );
  const labels = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "user.message") continue;
    const initiator = record(record(event.payload).initiator);
    if (typeof initiator.subjectId === "string" && typeof initiator.label === "string") {
      labels.set(initiator.subjectId, initiator.label);
    }
  }
  const names = new Map<string, string>();
  for (const subjectId of subjectIds) {
    const name = sharedSenderName(
      subjectId,
      profiles.get(subjectId),
      memberLabels.get(subjectId),
      labels.get(subjectId),
    );
    if (name) names.set(subjectId, name);
  }
  return names;
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
  const events = await readVisibleConversation(deps.db, input.workspaceId, input.sessionId);
  const starterSubjectId =
    session.createdBy.kind === "subject" ? session.createdBy.subjectId : null;
  const { snapshot, throughSequence } = buildSharedSessionSnapshot(events, {
    starterSubjectId,
    names: await senderNames(deps.db, input.workspaceId, events, starterSubjectId),
  });
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

/**
 * A link lasts only while the person who shared the chat can still read it:
 * checked on every read, so leaving the organization or workspace, losing
 * access to its chats, or the chat being deleted stops the link at once.
 */
async function creatorStillReadsChat(db: Database, link: SessionShareLinkRecord): Promise<boolean> {
  const subject = {
    accountId: link.accountId,
    workspaceId: link.workspaceId,
    subjectId: link.createdBySubjectId,
  };
  if (!(await namedSubjectHasLiveWorkspaceAuthority(db, subject))) return false;
  return await withWorkspaceSubjectRls(
    db,
    link.workspaceId,
    link.createdBySubjectId,
    async (tx) => {
      // A personal workspace has no membership row; its owner reads every chat in it.
      const membership = await getWorkspaceGrant(tx, link.createdBySubjectId, link.workspaceId);
      if (membership && !hasPermission(membership.permissions, "sessions:read")) return false;
      return (await getSession(tx, link.workspaceId, link.sessionId)) !== null;
    },
  );
}

/** What anyone holding a link reads; null when it doesn't open (unknown, stopped, turned off, or its sharer lost access). */
export async function readSharedSession(
  deps: SessionShareLinkDeps,
  shareId: string,
): Promise<SharedSession | null> {
  if (!sharingAllowed(deps)) return null;
  const link = await findLiveSessionShareLink(deps.db, shareId);
  if (!link || !(await creatorStillReadsChat(deps.db, link))) return null;
  const snapshot = SharedSessionSnapshot.safeParse(link.snapshot);
  if (!snapshot.success) return null;
  return {
    title: link.title,
    sharedAt: link.updatedAt.toISOString(),
    messages: snapshot.data.messages,
    omittedMessageCount: snapshot.data.omittedMessageCount,
  };
}
