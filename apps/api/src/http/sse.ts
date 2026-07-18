import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/contracts";
import { listSessionEvents, listWorkspaceControlEvents, type Database } from "@opengeni/db";
import { formatSessionEventSse, formatSse, type EventBus } from "@opengeni/events";

const SESSION_REPLAY_PAGE_SIZE = 100;

export async function sseSessionStream(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  after: number,
  signal: AbortSignal,
): Promise<Response> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let lastSent = after;
  let replaying = true;
  // Durable Postgres replay is authoritative. While it runs, retaining only the
  // newest live notification is sufficient: sending it gap-backfills every
  // intervening sequence. Browser/API memory therefore stays O(1) even when a
  // hot session emits faster than replay can drain.
  let newestBuffered: SessionEvent | null = null;
  let delivery = Promise.resolve();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (rawController) => {
      controller = rawController;
      const send = async (event: SessionEvent) => {
        if (event.sequence <= lastSent) {
          return;
        }
        if (event.sequence > lastSent + 1) {
          while (lastSent + 1 < event.sequence) {
            const previousLastSent = lastSent;
            const missing = await listSessionEvents(db, workspaceId, sessionId, {
              after: lastSent,
              limit: Math.min(SESSION_REPLAY_PAGE_SIZE, event.sequence - lastSent - 1),
            });
            if (missing.length === 0) {
              throw new Error(
                `Session event replay stalled before sequence ${event.sequence}; last sent ${lastSent}`,
              );
            }
            for (const missed of missing) {
              if (missed.sequence >= event.sequence) break;
              if (missed.sequence > lastSent) {
                controller.enqueue(encoder.encode(formatSessionEventSse(missed)));
                lastSent = missed.sequence;
              }
            }
            if (lastSent === previousLastSent) {
              throw new Error(
                `Session event replay made no progress before sequence ${event.sequence}; last sent ${lastSent}`,
              );
            }
          }
        }
        controller.enqueue(encoder.encode(formatSessionEventSse(event)));
        lastSent = event.sequence;
      };
      const enqueue = (events: SessionEvent[]) => {
        delivery = delivery.then(async () => {
          for (const event of events.sort((a, b) => a.sequence - b.sequence)) {
            await send(event);
          }
        });
        return delivery;
      };

      unsubscribe = await bus.subscribe(workspaceId, sessionId, async (events) => {
        if (replaying) {
          for (const event of events) {
            if (!newestBuffered || event.sequence > newestBuffered.sequence) {
              newestBuffered = event;
            }
          }
          return;
        }
        await enqueue(events);
      });

      await replaySessionEvents(
        (cursor, limit) => listSessionEvents(db, workspaceId, sessionId, cursor, limit),
        send,
        after,
        SESSION_REPLAY_PAGE_SIZE,
      );
      replaying = false;
      const buffered = newestBuffered;
      newestBuffered = null;
      if (buffered) {
        await enqueue([buffered]);
      }
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel: () => {
      unsubscribe?.();
    },
  });

  signal.addEventListener(
    "abort",
    () => {
      unsubscribe?.();
    },
    { once: true },
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function replaySessionEvents(
  loadPage: (after: number, limit: number) => Promise<SessionEvent[]>,
  send: (event: SessionEvent) => Promise<void>,
  after: number,
  pageSize = SESSION_REPLAY_PAGE_SIZE,
): Promise<void> {
  let cursor = after;
  while (true) {
    const previousCursor = cursor;
    const page = await loadPage(cursor, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const event of page.sort((a, b) => a.sequence - b.sequence)) {
      if (event.sequence <= cursor) continue;
      await send(event);
      cursor = event.sequence;
    }
    if (page.length < pageSize) {
      return;
    }
    if (cursor === previousCursor) {
      throw new Error(
        `Session event replay made no progress after sequence ${cursor}; refusing to repeat a full stale page`,
      );
    }
  }
}

export async function sseWorkspaceControlStream(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  after: number,
  signal: AbortSignal,
): Promise<Response> {
  const encoder = new TextEncoder();
  let lastSent = after;
  let replaying = true;
  const buffered: WorkspaceControlEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const send = (event: WorkspaceControlEvent) => {
        if (event.sequence <= lastSent) return;
        controller.enqueue(encoder.encode(formatSse(event)));
        lastSent = event.sequence;
      };
      unsubscribe = await bus.subscribeWorkspaceControl(workspaceId, async (event) => {
        if (replaying) {
          buffered.push(event);
        } else {
          send(event);
        }
      });
      let cursor = after;
      while (true) {
        const page = await listWorkspaceControlEvents(db, workspaceId, cursor, 1000);
        for (const event of page) {
          send(event);
          cursor = Math.max(cursor, event.sequence);
        }
        if (page.length < 1000) break;
      }
      replaying = false;
      for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) {
        send(event);
      }
      buffered.length = 0;
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel: () => unsubscribe?.(),
  });
  signal.addEventListener("abort", () => unsubscribe?.(), { once: true });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
