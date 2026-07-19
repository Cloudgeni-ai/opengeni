import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/contracts";
import { listSessionEvents, listWorkspaceControlEvents, type Database } from "@opengeni/db";
import { formatSse, type EventBus } from "@opengeni/events";

/** session_events.sequence is a PostgreSQL integer (int4). */
export const MAX_SESSION_EVENT_SEQUENCE = 2_147_483_647;

export async function sseSessionStream(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  after: number,
  signal: AbortSignal,
): Promise<Response> {
  const encoder = new TextEncoder();
  const initialAfter = normalizeSseCursor(after);
  let lastSent = initialAfter;
  let replaying = true;
  const buffered: SessionEvent[] = [];
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    replaying = false;
    buffered.length = 0;
    const release = unsubscribe;
    unsubscribe = null;
    try {
      release?.();
    } catch {
      // A stream is already terminating; subscription cleanup is best-effort.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const fail = (error: unknown) => {
        if (stopped) return;
        stop();
        // The SDK treats a stream transport failure as reconnectable. On a real
        // HTTP connection controller.error becomes a network read failure; keep
        // the same TypeError semantics for in-process adapters and tests.
        const transient =
          error instanceof TypeError
            ? error
            : new TypeError("session event stream delivery failed", { cause: error });
        try {
          controller.error(transient);
        } catch {
          // Cancellation may have closed the controller concurrently.
        }
      };
      const sendOne = async (event: SessionEvent) => {
        if (stopped || event.sequence <= lastSent) {
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
          if (stopped) return;
          for (const missed of missing) {
            if (missed.sequence > lastSent) {
              controller.enqueue(encoder.encode(formatSse(missed)));
              lastSent = missed.sequence;
            }
          }
        }
        // A gap read can include the event that triggered it (for example when
        // an invalid legacy cursor was normalized by the durable read layer).
        // Re-check after catch-up so the triggering event is never emitted twice.
        if (event.sequence <= lastSent) {
          return;
        }
        controller.enqueue(encoder.encode(formatSse(event)));
        lastSent = event.sequence;
      };
      // Replay, its buffered NATS catch-up, and the first post-replay live
      // callback can overlap while a gap read is suspended. Funnel every event
      // through one promise chain so `lastSent` remains a monotonic per-stream
      // cursor and an older gap fill cannot emit after (or regress) a newer one.
      let sendTail: Promise<void> = Promise.resolve();
      const send = (event: SessionEvent): Promise<void> => {
        const queued = sendTail.then(async () => await sendOne(event));
        // Keep the queue itself recoverable so one rejection cannot poison every
        // later chain link. The owning caller still receives `queued` and routes
        // the failure through the single fail-closed path below.
        sendTail = queued.catch(() => undefined);
        return queued;
      };

      try {
        const release = await bus.subscribe(workspaceId, sessionId, async (events) => {
          if (stopped) return;
          if (replaying) {
            buffered.push(...events);
            return;
          }
          try {
            for (const event of events.sort((a, b) => a.sequence - b.sequence)) {
              await send(event);
            }
          } catch (error) {
            fail(error);
          }
        });
        if (stopped) {
          release();
          return;
        }
        unsubscribe = release;

        await replaySessionEvents(
          (cursor, limit) => listSessionEvents(db, workspaceId, sessionId, cursor, limit),
          send,
          initialAfter,
        );
        if (stopped) return;
        replaying = false;
        for (const event of buffered.sort((a, b) => a.sequence - b.sequence)) {
          await send(event);
        }
        buffered.length = 0;
        if (!stopped) controller.enqueue(encoder.encode(": connected\n\n"));
      } catch (error) {
        fail(error);
      }
    },
    cancel: stop,
  });

  signal.addEventListener("abort", stop, { once: true });

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
  let cursor = normalizeSseCursor(after);
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

function normalizeSseCursor(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_SESSION_EVENT_SEQUENCE, Math.max(0, Math.floor(value)))
    : 0;
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
