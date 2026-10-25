import type { Settings } from "@opengeni/config";
import {
  claimEventSourceFeed,
  finishEventSourceFeedStep,
  getEventSource,
  listDueEventSourceFeeds,
  setEventStreamTriggerStatus,
  type Database,
  type EventSourceFeedRecord,
  type EventSourceRecord,
  type EventStatusReason,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { gmailFeed } from "./gmail-source";
import type { McpEventsFetch } from "./mcp-event-source-client";
import { EventSourceBlockedError, eventStatusReason } from "./status-reason";
import { postTriggerNotices } from "./trigger-notices";
import { workspaceFeed } from "./workspace-source";

/**
 * Reads the sources whose events Opengeni takes from the app's own change
 * history (Gmail), or from its own database ("This workspace"). One step reads one source's feed as the source's owner,
 * records what changed since its cursor and advances the cursor, while a
 * runnable automation listens to the source. A feed nothing listens to
 * forgets its cursor and idles; triggers and source changes wake it.
 *
 * A failure a person has to fix (a sign-in, a removed connector) blocks the
 * source's triggers with a plain reason, tells each automation's owner once,
 * and the feed retries every 15 minutes; the first good read unblocks them.
 * Other failures retry with backoff and block after an hour.
 */

export type EventSourceFeedPumpDeps = {
  db: Database;
  settings: Settings;
  bus: EventBus;
  /** Replaces the pinned integration transport, for tests. */
  fetch?: McpEventsFetch | undefined;
  observability?: Pick<Observability, "warn" | "error"> | undefined;
  now?: () => Date;
};

/** What one read found out: where to continue and when to read again. */
export type EventSourceFeedReadOutcome = {
  /** The new cursor; undefined when the read stored it with its events. */
  cursor?: string | null;
  gapPending?: boolean;
  nextActionAt: Date;
};

export type EventSourceFeedReadContext = {
  deps: EventSourceFeedPumpDeps;
  source: EventSourceRecord;
  feed: EventSourceFeedRecord;
  now: Date;
};

/** How Opengeni reads one kind of app's change history. */
export type EventSourceFeedAdapter = {
  /** Read what changed since the feed's cursor, record it, and say where to continue. */
  read(context: EventSourceFeedReadContext): Promise<EventSourceFeedReadOutcome>;
  /** A failure a person has to fix, in plain language; null when retrying may help. */
  blockedReason(error: unknown, source: EventSourceRecord): EventStatusReason | null;
  /** The app's name in messages, such as Gmail. */
  appName: string;
};

const FEED_ADAPTERS: Partial<Record<EventSourceRecord["kind"], EventSourceFeedAdapter>> = {
  gmail: gmailFeed,
  workspace: workspaceFeed,
};

const LEASE_MS = 5 * 60_000;
/** A feed nothing listens to is looked at again this often, besides being woken. */
const IDLE_RECHECK_MS = 60 * 60_000;
const BLOCKED_RETRY_MS = 15 * 60_000;
const TRANSIENT_FIRST_RETRY_MS = 30_000;
const BLOCK_AFTER_FAILING_MS = 60 * 60_000;

async function setTriggers(
  deps: EventSourceFeedPumpDeps,
  source: EventSourceRecord,
  change: { blocked: true; reason: EventStatusReason } | { blocked: false },
): Promise<void> {
  const notices = await setEventStreamTriggerStatus(
    deps.db,
    source.workspaceId,
    { sourceId: source.id, streamKey: "" },
    change.blocked ? "blocked" : "active",
    change.blocked ? change.reason : null,
  );
  await postTriggerNotices(
    deps,
    source.workspaceId,
    notices,
    change.blocked ? { blocked: true, reason: change.reason.text } : change,
  );
}

/** Read one source's feed, if it is due and no other pump holds it. */
export async function runEventSourceFeedStep(
  deps: EventSourceFeedPumpDeps,
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  const claimed = await claimEventSourceFeed(deps.db, workspaceId, sourceId, LEASE_MS);
  if (!claimed) return;
  const { feed } = claimed;
  const now = deps.now?.() ?? new Date();
  const source = await getEventSource(deps.db, workspaceId, sourceId);
  const adapter = source ? FEED_ADAPTERS[source.kind] : undefined;
  if (!claimed.wanted || !source || !adapter) {
    await finishEventSourceFeedStep(deps.db, workspaceId, sourceId, {
      cursor: null,
      gapPending: false,
      nextActionAt: new Date(now.getTime() + IDLE_RECHECK_MS),
      outcome: { kind: "success" },
    });
    return;
  }
  try {
    const outcome = await adapter.read({ deps, source, feed, now });
    await finishEventSourceFeedStep(deps.db, workspaceId, sourceId, {
      ...outcome,
      outcome: { kind: "success" },
    });
    await setTriggers(deps, source, { blocked: false });
  } catch (error) {
    await handleReadFailure(deps, adapter, source, feed, error, now);
  }
}

async function handleReadFailure(
  deps: EventSourceFeedPumpDeps,
  adapter: EventSourceFeedAdapter,
  source: EventSourceRecord,
  feed: EventSourceFeedRecord,
  error: unknown,
  now: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const finish = (nextActionAt: Date) =>
    finishEventSourceFeedStep(deps.db, source.workspaceId, source.id, {
      nextActionAt,
      outcome: { kind: "failure", error: message },
    });
  let reason =
    error instanceof EventSourceBlockedError ? error.reason : adapter.blockedReason(error, source);
  if (reason === null) {
    const failingFor = feed.failingSince ? now.getTime() - feed.failingSince.getTime() : 0;
    if (failingFor < BLOCK_AFTER_FAILING_MS) {
      deps.observability?.warn("Event source feed read failed; it will retry", {
        sourceId: source.id,
        failures: feed.failures + 1,
        error: message,
      });
      const backoff = Math.min(
        TRANSIENT_FIRST_RETRY_MS * 2 ** Math.min(feed.failures, 10),
        BLOCKED_RETRY_MS,
      );
      await finish(new Date(now.getTime() + backoff));
      return;
    }
    reason = eventStatusReason(
      "not_answering",
      `${adapter.appName} hasn't answered for over an hour`,
    );
  }
  await finish(new Date(now.getTime() + BLOCKED_RETRY_MS));
  await setTriggers(deps, source, { blocked: true, reason });
}

/** One bounded pass over due feeds. Returns how many it read. */
export async function pumpDueEventSourceFeeds(
  deps: EventSourceFeedPumpDeps,
  options: { limit?: number; concurrency?: number } = {},
): Promise<number> {
  const due = await listDueEventSourceFeeds(deps.db, options.limit ?? 32);
  const queue = [...due];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await runEventSourceFeedStep(deps, next.workspaceId, next.sourceId);
      } catch (error) {
        deps.observability?.error("Event source feed read crashed; it will retry", {
          sourceId: next.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, due.length)) }, worker),
  );
  return due.length;
}
