import type { SessionEvent } from "@opengeni/contracts";
import { listSessionEvents, type Database } from "@opengeni/db";
import { formatSse, type EventBus } from "@opengeni/events";

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
  const buffered: SessionEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (rawController) => {
      controller = rawController;
      const send = async (event: SessionEvent) => {
        if (event.sequence <= lastSent) {
          return;
        }
        if (event.sequence > lastSent + 1) {
          const missing = await listSessionEvents(
            db,
            workspaceId,
            sessionId,
            lastSent,
            event.sequence - lastSent - 1,
          );
          for (const missed of missing) {
            if (missed.sequence > lastSent) {
              controller.enqueue(encoder.encode(formatSse(missed)));
              lastSent = missed.sequence;
            }
          }
        }
        controller.enqueue(encoder.encode(formatSse(event)));
        lastSent = event.sequence;
      };

      unsubscribe = await bus.subscribe(workspaceId, sessionId, async (events) => {
        if (replaying) {
          buffered.push(...events);
          return;
        }
        for (const event of events.sort((a, b) => a.sequence - b.sequence)) {
          await send(event);
        }
      });

      await replaySessionEvents(
        (cursor, limit) => listSessionEvents(db, workspaceId, sessionId, cursor, limit),
        send,
        after,
      );
      replaying = false;
      for (const event of buffered.sort((a, b) => a.sequence - b.sequence)) {
        await send(event);
      }
      buffered.length = 0;
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
  pageSize = 1000,
): Promise<void> {
  let cursor = after;
  while (true) {
    const page = await loadPage(cursor, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const event of page.sort((a, b) => a.sequence - b.sequence)) {
      await send(event);
      cursor = Math.max(cursor, event.sequence);
    }
    if (page.length < pageSize) {
      return;
    }
  }
}
