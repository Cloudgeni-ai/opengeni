import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/contracts";
import { listSessionEvents, listWorkspaceControlEvents, type Database } from "@opengeni/db";
import {
  formatSessionEventSse,
  formatSse,
  SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  type EventBus,
} from "@opengeni/events";

const SESSION_REPLAY_PAGE_SIZE = 100;
const WORKSPACE_CONTROL_REPLAY_PAGE_SIZE = 100;

export type ByteBoundedSseStream = {
  stream: ReadableStream<Uint8Array>;
  write: (frame: string) => Promise<boolean>;
  close: () => void;
  fail: (error: unknown) => void;
  stopped: () => boolean;
};

/**
 * A byte-counted SSE body. `ReadableStreamDefaultController.enqueue()` does not
 * itself wait for a slow HTTP consumer, so replaying bounded frames without
 * checking `desiredSize` can still accumulate an unbounded server-side queue.
 *
 * One writer is expected per stream. A write waits until the full encoded frame
 * fits inside the byte high-water mark. Cancellation wakes that writer and
 * returns `false`, allowing durable replay to stop without reading more pages.
 */
export function createByteBoundedSseStream(
  maxQueuedBytes = SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  onCancel: () => void = () => {},
): ByteBoundedSseStream {
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new RangeError("SSE byte high-water mark must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  let capacityWake: (() => void) | null = null;

  const wakeWriter = () => {
    const wake = capacityWake;
    capacityWake = null;
    wake?.();
  };
  const stop = (settle: () => void) => {
    if (stopped) return;
    stopped = true;
    wakeWriter();
    try {
      settle();
    } catch {
      // A concurrent consumer cancellation may already have settled the body.
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start: (rawController) => {
        controller = rawController;
      },
      pull: () => {
        wakeWriter();
      },
      cancel: () => {
        if (stopped) return;
        stopped = true;
        wakeWriter();
        onCancel();
      },
    },
    {
      highWaterMark: maxQueuedBytes,
      size: (chunk) => chunk?.byteLength ?? 0,
    },
  );

  return {
    stream,
    write: async (frame) => {
      const chunk = encoder.encode(frame);
      if (chunk.byteLength > maxQueuedBytes) {
        throw new RangeError(
          `SSE frame cannot fit in the configured queue (${chunk.byteLength} > ${maxQueuedBytes} bytes)`,
        );
      }
      while (!stopped) {
        const desired = controller.desiredSize;
        if (desired === null) return false;
        if (desired >= chunk.byteLength) {
          controller.enqueue(chunk);
          return true;
        }
        await new Promise<void>((resolve) => {
          capacityWake = resolve;
        });
      }
      return false;
    },
    close: () => stop(() => controller.close()),
    fail: (error) => stop(() => controller.error(error)),
    stopped: () => stopped,
  };
}

export type LatestWinsDelivery<T extends { sequence: number }> = {
  publish: (events: readonly T[]) => void;
  stop: () => void;
  whenIdle: () => Promise<void>;
  pendingSequence: () => number | null;
};

/**
 * Keep at most one live notification while an earlier notification is being
 * delivered. The notification is only a cursor target: `send` gap-fills every
 * missing durable event from Postgres, so replacing N intermediate notices with
 * their newest sequence loses no event and prevents backpressure from migrating
 * into the NATS subscription queue.
 */
export function createLatestWinsDelivery<T extends { sequence: number }>(
  send: (event: T) => Promise<void>,
  onError: (error: unknown) => void,
): LatestWinsDelivery<T> {
  let newest: T | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const start = () => {
    if (stopped || running || !newest) return;
    const run = async () => {
      while (!stopped && newest) {
        const target = newest;
        newest = null;
        await send(target);
      }
    };
    running = run()
      .catch((error) => {
        stopped = true;
        newest = null;
        onError(error);
      })
      .finally(() => {
        running = null;
        start();
      });
  };

  return {
    publish: (events) => {
      if (stopped) return;
      for (const event of events) {
        if (!newest || event.sequence > newest.sequence) newest = event;
      }
      start();
    },
    stop: () => {
      stopped = true;
      newest = null;
    },
    whenIdle: async () => {
      while (running) await running;
    },
    pendingSequence: () => newest?.sequence ?? null,
  };
}

export async function sseSessionStream(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  after: number,
  signal: AbortSignal,
): Promise<Response> {
  let lastSent = after;
  let bootstrapping = true;
  let newestBuffered: SessionEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let delivery: LatestWinsDelivery<SessionEvent> | null = null;
  const channel = createByteBoundedSseStream(SESSION_EVENT_SSE_FRAME_MAX_BYTES, () => {
    delivery?.stop();
    unsubscribe?.();
  });

  const fail = (error: unknown) => {
    delivery?.stop();
    unsubscribe?.();
    channel.fail(error);
  };
  const writeFrame = async (frame: string) => {
    if (!(await channel.write(frame))) {
      throw new SseStreamStoppedError();
    }
  };
  const send = async (event: SessionEvent) => {
    if (event.sequence <= lastSent) return;
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
            await writeFrame(formatSessionEventSse(missed));
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
    await writeFrame(formatSessionEventSse(event));
    lastSent = event.sequence;
  };
  delivery = createLatestWinsDelivery(send, fail);

  void (async () => {
    unsubscribe = await bus.subscribe(workspaceId, sessionId, (events) => {
      if (bootstrapping) {
        for (const event of events) {
          if (!newestBuffered || event.sequence > newestBuffered.sequence) {
            newestBuffered = event;
          }
        }
      } else {
        delivery?.publish(events);
      }
    });

    await replaySessionEvents(
      (cursor, limit) => listSessionEvents(db, workspaceId, sessionId, cursor, limit),
      send,
      after,
      SESSION_REPLAY_PAGE_SIZE,
    );
    await writeFrame(": connected\n\n");
    bootstrapping = false;
    const buffered = newestBuffered;
    newestBuffered = null;
    if (buffered) delivery.publish([buffered]);
  })().catch((error) => {
    if (!(error instanceof SseStreamStoppedError)) fail(error);
  });

  const abort = () => {
    delivery?.stop();
    unsubscribe?.();
    channel.close();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  return new Response(channel.stream, {
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
  let lastSent = after;
  let bootstrapping = true;
  let newestBuffered: WorkspaceControlEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let delivery: LatestWinsDelivery<WorkspaceControlEvent> | null = null;
  const channel = createByteBoundedSseStream(SESSION_EVENT_SSE_FRAME_MAX_BYTES, () => {
    delivery?.stop();
    unsubscribe?.();
  });

  const fail = (error: unknown) => {
    delivery?.stop();
    unsubscribe?.();
    channel.fail(error);
  };
  const writeFrame = async (frame: string) => {
    if (!(await channel.write(frame))) throw new SseStreamStoppedError();
  };
  const send = async (event: WorkspaceControlEvent) => {
    if (event.sequence <= lastSent) return;
    if (event.sequence > lastSent + 1) {
      while (lastSent + 1 < event.sequence) {
        const previousLastSent = lastSent;
        const missing = await listWorkspaceControlEvents(
          db,
          workspaceId,
          lastSent,
          Math.min(WORKSPACE_CONTROL_REPLAY_PAGE_SIZE, event.sequence - lastSent - 1),
        );
        for (const missed of missing) {
          if (missed.sequence >= event.sequence) break;
          if (missed.sequence > lastSent) {
            await writeFrame(formatSse(missed));
            lastSent = missed.sequence;
          }
        }
        if (lastSent === previousLastSent) {
          throw new Error(
            `Workspace control replay made no progress before sequence ${event.sequence}; last sent ${lastSent}`,
          );
        }
      }
    }
    await writeFrame(formatSse(event));
    lastSent = event.sequence;
  };
  delivery = createLatestWinsDelivery(send, fail);

  void (async () => {
    unsubscribe = await bus.subscribeWorkspaceControl(workspaceId, (event) => {
      if (bootstrapping) {
        if (!newestBuffered || event.sequence > newestBuffered.sequence) newestBuffered = event;
      } else {
        delivery?.publish([event]);
      }
    });
    await replayWorkspaceControlEvents(
      (cursor, limit) => listWorkspaceControlEvents(db, workspaceId, cursor, limit),
      send,
      after,
      WORKSPACE_CONTROL_REPLAY_PAGE_SIZE,
    );
    await writeFrame(": connected\n\n");
    bootstrapping = false;
    const buffered = newestBuffered;
    newestBuffered = null;
    if (buffered) delivery.publish([buffered]);
  })().catch((error) => {
    if (!(error instanceof SseStreamStoppedError)) fail(error);
  });

  const abort = () => {
    delivery?.stop();
    unsubscribe?.();
    channel.close();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  return new Response(channel.stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

async function replayWorkspaceControlEvents(
  loadPage: (after: number, limit: number) => Promise<WorkspaceControlEvent[]>,
  send: (event: WorkspaceControlEvent) => Promise<void>,
  after: number,
  pageSize: number,
): Promise<void> {
  let cursor = after;
  while (true) {
    const previousCursor = cursor;
    const page = await loadPage(cursor, pageSize);
    if (page.length === 0) return;
    for (const event of page.sort((a, b) => a.sequence - b.sequence)) {
      if (event.sequence <= cursor) continue;
      await send(event);
      cursor = event.sequence;
    }
    if (page.length < pageSize) return;
    if (cursor === previousCursor) {
      throw new Error(
        `Workspace control replay made no progress after sequence ${cursor}; refusing to repeat a full stale page`,
      );
    }
  }
}

class SseStreamStoppedError extends Error {}
