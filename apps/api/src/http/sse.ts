import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/contracts";
import { listSessionEvents, listWorkspaceControlEvents, type Database } from "@opengeni/db";
import {
  formatSessionEventSse,
  formatSse,
  SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  type EventBus,
} from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

const SESSION_REPLAY_PAGE_SIZE = 100;
const WORKSPACE_CONTROL_REPLAY_PAGE_SIZE = 100;
export const SSE_QUEUED_FRAME_MAX_COUNT = 1;
export const SSE_WRITE_STALL_TIMEOUT_MS = 30_000;

export type SseDeliveryBoundObservation = {
  reason: "desired_size_non_positive" | "stall_timeout" | "frame_too_large";
  desiredSize: number | null;
  queuedFrames: number;
  queuedBytes: number;
};

export type ByteBoundedSseStreamOptions = {
  maxQueuedBytes?: number;
  stallTimeoutMs?: number;
  onStop?: () => void;
  onObservation?: (observation: SseDeliveryBoundObservation) => void;
};

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
 * One writer is expected per stream. The Web Streams queue holds at most one
 * complete frame, and that frame must fit inside the byte cap. A second write
 * waits for consumer pull only for a bounded interval; cancellation or a stalled
 * reader wakes it and terminates upstream delivery before another durable page is
 * read. One frame is deliberate: it makes both queued-frame count and queued
 * bytes independently bounded instead of relying on byte accounting alone.
 */
export function createByteBoundedSseStream(
  options: ByteBoundedSseStreamOptions = {},
): ByteBoundedSseStream {
  const maxQueuedBytes = options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES;
  const stallTimeoutMs = options.stallTimeoutMs ?? SSE_WRITE_STALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new RangeError("SSE byte high-water mark must be a positive safe integer");
  }
  if (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new RangeError("SSE write stall timeout must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  let capacityWake: (() => void) | null = null;
  let queuedFrames = 0;
  let queuedBytes = 0;

  const wakeWriter = () => {
    const wake = capacityWake;
    capacityWake = null;
    wake?.();
  };
  const stop = (settle: () => void) => {
    if (stopped) return;
    stopped = true;
    wakeWriter();
    options.onStop?.();
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
        // With a one-frame high-water mark, pull after an enqueue means that
        // frame has left the controller queue (either delivered to a pending
        // read or consumed by the HTTP adapter). There is no hidden second frame.
        queuedFrames = 0;
        queuedBytes = 0;
        wakeWriter();
      },
      cancel: () => {
        if (stopped) return;
        stopped = true;
        wakeWriter();
        options.onStop?.();
      },
    },
    {
      highWaterMark: SSE_QUEUED_FRAME_MAX_COUNT,
      size: () => 1,
    },
  );

  return {
    stream,
    write: async (frame) => {
      const chunk = encoder.encode(frame);
      if (chunk.byteLength > maxQueuedBytes) {
        const error = new RangeError(
          `SSE frame cannot fit in the configured queue (${chunk.byteLength} > ${maxQueuedBytes} bytes)`,
        );
        options.onObservation?.({
          reason: "frame_too_large",
          desiredSize: controller.desiredSize,
          queuedFrames,
          queuedBytes,
        });
        stop(() => controller.error(error));
        throw error;
      }
      for (;;) {
        if (stopped) return false;
        const desired = controller.desiredSize;
        if (desired === null) return false;
        if (desired >= 1 && queuedFrames === 0) {
          controller.enqueue(chunk);
          queuedFrames = 1;
          queuedBytes = chunk.byteLength;
          return true;
        }
        options.onObservation?.({
          reason: "desired_size_non_positive",
          desiredSize: desired,
          queuedFrames,
          queuedBytes,
        });
        const outcome = await new Promise<"capacity" | "timeout">((resolve) => {
          let settled = false;
          const finish = (result: "capacity" | "timeout") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (capacityWake === wake) capacityWake = null;
            resolve(result);
          };
          const wake = () => finish("capacity");
          const timer = setTimeout(() => finish("timeout"), stallTimeoutMs);
          capacityWake = wake;
        });
        if (outcome === "timeout" && !stopped) {
          const error = new TypeError(
            `SSE consumer did not drain the single-frame queue within ${stallTimeoutMs}ms`,
          );
          options.onObservation?.({
            reason: "stall_timeout",
            desiredSize: controller.desiredSize,
            queuedFrames,
            queuedBytes,
          });
          stop(() => controller.error(error));
          throw error;
        }
      }
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
      for (;;) {
        if (stopped || !newest) return;
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
      for (;;) {
        const pending = running;
        if (!pending) return;
        await pending;
      }
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
  options: SseDeliveryOptions = {},
): Promise<Response> {
  let lastSent = after;
  let bootstrapping = true;
  let newestBuffered: SessionEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let delivery: LatestWinsDelivery<SessionEvent> | null = null;
  const stopUpstream = () => {
    delivery?.stop();
    const release = unsubscribe;
    unsubscribe = null;
    release?.();
  };
  const channel = createByteBoundedSseStream({
    maxQueuedBytes: options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    onObservation: sseObservationReporter("session", options),
    onStop: stopUpstream,
  });

  const fail = (error: unknown) => {
    channel.fail(retryableSseFailure("session event stream delivery failed", error));
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
    const release = await bus.subscribe(workspaceId, sessionId, (events) => {
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
    if (channel.stopped()) {
      release();
      return;
    }
    unsubscribe = release;

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
  options: SseDeliveryOptions = {},
): Promise<Response> {
  let lastSent = after;
  let bootstrapping = true;
  let newestBuffered: WorkspaceControlEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let delivery: LatestWinsDelivery<WorkspaceControlEvent> | null = null;
  const stopUpstream = () => {
    delivery?.stop();
    const release = unsubscribe;
    unsubscribe = null;
    release?.();
  };
  const channel = createByteBoundedSseStream({
    maxQueuedBytes: options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    onObservation: sseObservationReporter("workspace_control", options),
    onStop: stopUpstream,
  });

  const fail = (error: unknown) => {
    channel.fail(retryableSseFailure("workspace control stream delivery failed", error));
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
    const release = await bus.subscribeWorkspaceControl(workspaceId, (event) => {
      if (bootstrapping) {
        if (!newestBuffered || event.sequence > newestBuffered.sequence) newestBuffered = event;
      } else {
        delivery?.publish([event]);
      }
    });
    if (channel.stopped()) {
      release();
      return;
    }
    unsubscribe = release;
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

export type SseDeliveryOptions = {
  maxQueuedBytes?: number;
  stallTimeoutMs?: number;
  observability?: Observability | undefined;
  onObservation?: ((observation: SseDeliveryBoundObservation) => void) | undefined;
};

function sseObservationReporter(
  stream: "session" | "workspace_control",
  options: SseDeliveryOptions,
): (observation: SseDeliveryBoundObservation) => void {
  return (observation) => {
    options.onObservation?.(observation);
    options.observability?.incrementCounter({
      name: "opengeni_sse_delivery_bound_events_total",
      help: "SSE writes that encountered a configured queue, frame, or stall bound.",
      labels: { stream, reason: observation.reason },
    });
    if (observation.reason !== "desired_size_non_positive") {
      options.observability?.warn("SSE delivery terminated at a bounded stream seam", {
        stream,
        reason: observation.reason,
        desiredSize: observation.desiredSize,
        queuedFrames: observation.queuedFrames,
        queuedBytes: observation.queuedBytes,
      });
    }
  };
}

function retryableSseFailure(message: string, error: unknown): TypeError {
  return error instanceof TypeError ? error : new TypeError(message, { cause: error });
}
