import { OpenGeniApiError, type Session, type SessionEvent } from "@opengeni/sdk";
import { normalizeAgentIcon } from "../src/lib/agent-icons";
import {
  AUTO_APPLY_WINDOW_MS,
  blockKey,
  hasActionBlock,
  splitActionBlocks,
} from "../src/lib/blocks";
import { claimBlock, getAppliedBlock, releaseBlock, settleBlock } from "./db";
import {
  api,
  applyProfileUpdate,
  asHeaders,
  createAgent,
  listAgentSessions,
  simpleMetadata,
  type ProfileUpdate,
} from "./opengeni";

/**
 * Agents act on the app through `geni-agent` and `geni-profile` blocks in their
 * replies. The server applies them as soon as a reply lands, whether or not
 * anyone has the chat open; an open chat shows the same block as a card and
 * applies it too. The block key makes both paths apply it once.
 */
export type BlockRequest = {
  workspaceId: string;
  key: string;
  kind: "agent" | "profile";
  sourceSessionId: string;
  payload: Record<string, unknown>;
};

/** Opengeni being briefly unavailable (a deploy, a busy database, no network) is worth waiting out. */
export function isTransient(error: unknown) {
  if (error instanceof OpenGeniApiError) return error.retryable;
  // fetch failures: Bun sets a system code (ECONNRESET, ConnectionRefused); browsers throw TypeError.
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" || (error instanceof TypeError && /fetch|network/i.test(error.message))
  );
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];

async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(error)) throw error;
      await Bun.sleep(delay);
    }
  }
}

function requiredName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("The agent needs a name");
  return value.trim().slice(0, 40);
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/** Applies a block once. Returns its row: applied, or still applying elsewhere. */
export async function applyBlock(input: BlockRequest) {
  const existing = getAppliedBlock(input.key);
  if (existing?.state === "applied") return existing;
  const owner = claimBlock(input.key, input.workspaceId, input.kind);
  if (!owner) return getAppliedBlock(input.key);
  try {
    if (input.kind === "agent") {
      const payload = input.payload;
      const name = requiredName(payload.name);
      // The idempotency key makes a retried create return the same agent.
      const session = await withRetry(() =>
        createAgent({
          workspaceId: input.workspaceId,
          role: "agent",
          name,
          icon: normalizeAgentIcon(payload.icon),
          description: text(payload.description, 160),
          instructions: text(payload.instructions, 8000),
          firstMessage: text(payload.firstMessage, 8000),
          shared: payload.shared === true,
          idempotencyKey: `simple-app:block:${input.key}`.slice(0, 200),
        }),
      );
      settleBlock(input.key, owner, { sessionId: session.id, name });
    } else {
      const update = input.payload as ProfileUpdate;
      const profile = await withRetry(() =>
        applyProfileUpdate(input.workspaceId, input.sourceSessionId, update),
      );
      settleBlock(input.key, owner, { sessionId: input.sourceSessionId, name: profile.name });
    }
  } catch (error) {
    releaseBlock(input.key, owner);
    throw error;
  }
  return getAppliedBlock(input.key);
}

type Watch = {
  /** Replaced by each later request, so a refreshed sign-in carries over. */
  headers: Record<string, string>;
  /** Per agent chat: every block at or before this sequence is handled. */
  cursors: Map<string, number>;
  /** Chats whose reply is being followed live. */
  following: Set<string>;
  queue: Promise<void>;
  /** Chats that changed while a scan was queued. */
  dirty: Set<string> | "all";
  /** When the app last listed the agents itself (its own poll). */
  listedAt: number;
  timer: ReturnType<typeof setInterval>;
};

const watches = new Map<string, Watch>();
const RESCAN_MS = 15_000;
const MESSAGE = "agent.message.completed" as SessionEvent["type"];
const SETTLED: ReadonlySet<string> = new Set(["idle", "failed", "cancelled", "requires_action"]);
/** A block that keeps failing is given up on after this many scans (each with its own retries). */
const MAX_FAILURES = 6;
const failures = new Map<string, number>();

/**
 * Starts applying the workspace's blocks in the background (once per
 * workspace; later calls refresh the credentials). A chat that is replying is
 * followed live, so its block applies the moment the reply lands; the app's
 * own agent list polls and a slow rescan notice which chats started replying.
 */
export function watchBlocks(workspaceId: string, headers: Record<string, string>) {
  const current = watches.get(workspaceId);
  if (current) {
    for (const name of Object.keys(current.headers)) delete current.headers[name];
    Object.assign(current.headers, headers);
    return;
  }
  const watch: Watch = {
    headers: { ...headers },
    cursors: new Map(),
    following: new Set(),
    queue: Promise.resolve(),
    dirty: new Set(),
    listedAt: 0,
    timer: setInterval(() => {
      // The app's own poll already covers a window that is open.
      if (Date.now() - watch.listedAt > RESCAN_MS) schedule(workspaceId, "all");
    }, RESCAN_MS),
  };
  watches.set(workspaceId, watch);
  schedule(workspaceId, "all");
}

/** The agent list the app just read: look at any chat with new events. */
export function noteAgentSessions(workspaceId: string, sessions: Session[]) {
  const watch = watches.get(workspaceId);
  if (!watch) return;
  watch.listedAt = Date.now();
  const changed = sessions.filter(
    (session) =>
      !watch.following.has(session.id) &&
      (session.lastSequence ?? 0) > (watch.cursors.get(session.id) ?? -1),
  );
  if (changed.length) schedule(workspaceId, new Set(changed.map((session) => session.id)));
}

/** A chat the app just started: follow its first reply from the beginning. */
export function followNewAgent(workspaceId: string, sessionId: string) {
  const watch = watches.get(workspaceId);
  if (!watch) return;
  watch.cursors.set(sessionId, 0);
  follow(workspaceId, watch, sessionId, 0);
}

function schedule(workspaceId: string, ids: Set<string> | "all") {
  const watch = watches.get(workspaceId);
  if (!watch) return;
  const idle = watch.dirty !== "all" && watch.dirty.size === 0;
  if (ids === "all" || watch.dirty === "all") watch.dirty = "all";
  else for (const id of ids) watch.dirty.add(id);
  if (!idle) return; // the queued scan picks these up
  watch.queue = watch.queue
    .then(() => asHeaders(watch.headers, () => scan(workspaceId, watch)))
    .catch((error: unknown) => {
      // Signed out: stop until the app is used again (its next request restarts this).
      if (error instanceof OpenGeniApiError && error.status === 401) {
        clearInterval(watch.timer);
        watches.delete(workspaceId);
        return;
      }
      console.warn("Checking agent replies failed", error);
    });
}

async function scan(workspaceId: string, watch: Watch) {
  const dirty = watch.dirty;
  watch.dirty = new Set();
  const sessions =
    dirty === "all"
      ? await listAgentSessions(workspaceId)
      : (
          await Promise.all(
            [...dirty].map((id) => api.getSession(workspaceId, id).catch(() => null)),
          )
        ).filter((session): session is Session => session !== null);
  for (const session of sessions) {
    if (simpleMetadata(session)?.kind !== "agent" || watch.following.has(session.id)) continue;
    const last = session.lastSequence ?? 0;
    const cursor = watch.cursors.get(session.id);
    if (cursor === undefined || last > cursor) {
      try {
        const { replies, readTo } = await readReplies(workspaceId, session.id, cursor, last);
        // A blank agent still named "New agent" never got its profile, however old the reply.
        const unnamed = simpleMetadata(session)?.blank === true && session.title === "New agent";
        const pending = await applyReplies(workspaceId, session.id, replies, unnamed);
        watch.cursors.set(session.id, pending ?? readTo);
      } catch (error) {
        if (error instanceof OpenGeniApiError && error.status === 401) throw error;
        console.warn(`Checking replies in ${session.id} failed`, error);
        continue;
      }
    }
    if (!SETTLED.has(session.status)) {
      follow(workspaceId, watch, session.id, watch.cursors.get(session.id) ?? last);
    }
  }
}

/** Reads one chat's events live until it stops replying. */
function follow(workspaceId: string, watch: Watch, sessionId: string, after: number) {
  if (watch.following.has(sessionId)) return;
  watch.following.add(sessionId);
  void asHeaders(watch.headers, async () => {
    const stop = new AbortController();
    for await (const event of api.streamEvents(workspaceId, sessionId, {
      after,
      signal: stop.signal,
    })) {
      if (event.type === MESSAGE) {
        const pending = await applyReplies(workspaceId, sessionId, [event]);
        if (pending !== null) {
          // Leave it to the rescan, which starts again from this reply.
          watch.cursors.set(sessionId, pending);
          return;
        }
      }
      watch.cursors.set(sessionId, event.sequence);
      if (event.type === "session.status.changed") {
        const status = (event.payload as { status?: unknown }).status;
        if (typeof status === "string" && SETTLED.has(status)) stop.abort();
      }
    }
  })
    .catch((error: unknown) => console.warn(`Following ${sessionId} stopped`, error))
    .finally(() => watch.following.delete(sessionId));
}

/**
 * Finished replies after the cursor (on first sight, only the latest few), and
 * the sequence the read covers.
 */
async function readReplies(
  workspaceId: string,
  sessionId: string,
  cursor: number | undefined,
  last: number,
) {
  if (cursor === undefined) {
    const replies = await api.listEvents(workspaceId, sessionId, {
      before: last + 1,
      direction: "before",
      limit: 20,
      includeTypes: [MESSAGE],
    });
    return { replies, readTo: last };
  }
  const replies: SessionEvent[] = [];
  let after = cursor;
  for (;;) {
    const page = await api.listEventPage(workspaceId, sessionId, {
      after,
      limit: 100,
      includeTypes: [MESSAGE],
    });
    replies.push(...page.events);
    const next = page.nextAfter ?? page.events.at(-1)?.sequence ?? null;
    if (!page.hasMore || next === null || next <= after) {
      // Without more pages the read covers everything up to the session's last event.
      return { replies, readTo: page.hasMore ? after : Math.max(after, last) };
    }
    after = next;
  }
}

/**
 * Applies every fresh block in order. Returns null when all are handled, or
 * the sequence just before the first reply that must be tried again.
 */
async function applyReplies(
  workspaceId: string,
  sessionId: string,
  replies: SessionEvent[],
  oldProfiles = false,
): Promise<number | null> {
  for (const event of [...replies].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type !== MESSAGE) continue;
    const payload = event.payload as { text?: unknown; phase?: unknown };
    // Progress notes are hidden in the chat, so their blocks never count.
    if (payload.phase === "commentary") continue;
    const old = Date.now() - Date.parse(event.occurredAt) > AUTO_APPLY_WINDOW_MS;
    if (old && !oldProfiles) continue;
    if (typeof payload.text !== "string" || !hasActionBlock(payload.text)) continue;
    for (const segment of splitActionBlocks(payload.text)) {
      if (segment.type !== "block" || !segment.block.payload) continue;
      if (old && segment.block.kind !== "profile") continue;
      const key = await blockKey(sessionId, segment.block);
      if (getAppliedBlock(key)?.state === "applied") continue;
      let again = false;
      try {
        const row = await applyBlock({
          workspaceId,
          key,
          kind: segment.block.kind,
          sourceSessionId: sessionId,
          payload: segment.block.payload,
        });
        // Someone else is applying it; look again in case they fail.
        again = row?.state !== "applied";
      } catch (error) {
        console.warn("Applying a block failed", error);
        again = isTransient(error);
      }
      if (!again) {
        failures.delete(key);
        continue;
      }
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count < MAX_FAILURES) return event.sequence - 1;
      failures.delete(key);
    }
  }
  return null;
}
