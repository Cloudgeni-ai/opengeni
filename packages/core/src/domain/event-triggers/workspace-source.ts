import {
  createEventSource,
  listWorkspaceRecordingEventsForSource,
  recordEventSourceFeedDelivery,
  type Database,
  type EventSourceRecord,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { sha256Hex } from "./delivery-intake";
import type {
  EventSourceFeedAdapter,
  EventSourceFeedReadContext,
  EventSourceFeedReadOutcome,
} from "./event-source-feeds";
import { eventMatchesTrigger } from "./matching";
import { McpEventSourceUnavailableError } from "./mcp-event-source-client";
import { boundEvent } from "./normalize";
import {
  workspaceDeliveryBody,
  workspaceRecordingEvent,
  type WorkspaceRecordingFact,
} from "./workspace-events";

/**
 * "This workspace": what happens in Opengeni itself, as one person may see
 * it. Its feed reads the workspace's recording events from the database as
 * the source's owner, every 15 seconds while an automation listens. Events
 * are stamped when written, not when committed, so each read looks back 10
 * minutes and skips what the source already stored, but never before the
 * moment the feed started: the first read only learns where "now" is.
 */

export const WORKSPACE_EVENT_SOURCE_NAME = "This workspace";

const POLL_MS = 15_000;
/** Longer than any transaction that writes a recording event takes to commit. */
const LOOK_BACK_MS = 10 * 60_000;
/** Facts read per step; a larger backlog continues in the next step at once. */
const FACTS_PER_READ = 100;

/** The feed's position: when it started listening, and how far it has read. */
type WorkspaceFeedCursor = { from: Date; read: Date };

function parseCursor(cursor: string | null): WorkspaceFeedCursor | null {
  if (cursor === null) return null;
  try {
    const value = JSON.parse(cursor) as { from?: unknown; read?: unknown };
    const from = typeof value.from === "string" ? new Date(value.from) : null;
    const read = typeof value.read === "string" ? new Date(value.read) : null;
    if (!from || !read || Number.isNaN(from.getTime()) || Number.isNaN(read.getTime())) return null;
    return { from, read };
  } catch {
    return null;
  }
}

function cursorText(cursor: WorkspaceFeedCursor): string {
  return JSON.stringify({ from: cursor.from.toISOString(), read: cursor.read.toISOString() });
}

/**
 * The caller's "This workspace" source: one per person, so a second create
 * returns the first. A workspace-level caller has no view of its own.
 */
export async function createWorkspaceEventSource(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  ownerSubjectId: string | null;
  name?: string | undefined;
}): Promise<EventSourceRecord> {
  if (!input.ownerSubjectId) {
    throw new HTTPException(422, {
      message:
        "A This workspace source shows one person what they may see. Create it as that person.",
    });
  }
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "workspace",
    name: input.name ?? WORKSPACE_EVENT_SOURCE_NAME,
    ownerSubjectId: input.ownerSubjectId,
    visibility: "private",
  });
  return source;
}

async function readWorkspaceFeed(
  context: EventSourceFeedReadContext,
): Promise<EventSourceFeedReadOutcome> {
  const { deps, source, feed, now } = context;
  const owner = source.ownerSubjectId;
  if (!owner) throw new McpEventSourceUnavailableError("This source has no owner");
  const later = new Date(now.getTime() + POLL_MS);
  const position = parseCursor(feed.cursor);
  const read = await listWorkspaceRecordingEventsForSource(deps.db, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    subjectId: owner,
    // The first read only learns where "now" is; earlier events don't fire.
    since: position
      ? new Date(Math.max(position.from.getTime(), position.read.getTime() - LOOK_BACK_MS))
      : new Date(now.getTime() + 24 * 60 * 60_000),
    limit: FACTS_PER_READ,
  });
  const full = read.events.length === FACTS_PER_READ;
  // A full page continues from its last event, so nothing past it is skipped.
  const cursor = cursorText({
    from: position?.from ?? read.readAt,
    read: full ? read.events.at(-1)!.occurredAt : read.readAt,
  });
  if (position === null || read.events.length === 0) {
    return { cursor, nextActionAt: later };
  }
  const facts: WorkspaceRecordingFact[] = read.events.map((event) => ({
    id: event.id,
    recordingId: event.recordingId,
    type: event.type,
    data: event.data,
    occurredAt: event.occurredAt.toISOString(),
    title: event.title,
    purpose: event.purpose,
  }));
  const body = workspaceDeliveryBody(facts);
  const recorded = await recordEventSourceFeedDelivery(deps.db, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    cursor,
    delivery: {
      status: "accepted",
      reason: null,
      dedupeKey: `workspace:${sha256Hex(new TextEncoder().encode(facts.map((fact) => fact.id).join(",")))}`,
      body,
      bodyBytes: body.byteLength,
      bodySha256: sha256Hex(body),
      headers: {},
      events: facts.map((fact) => boundEvent(workspaceRecordingEvent(fact, owner), now)),
      match: eventMatchesTrigger,
    },
  });
  if (!recorded) throw new Error("The source was removed while its events were read");
  return { nextActionAt: full ? now : later };
}

export const workspaceFeed: EventSourceFeedAdapter = {
  appName: "Opengeni",
  read: readWorkspaceFeed,
  // Reading Opengeni's own database never needs a person to fix anything.
  blockedReason: () => null,
};
