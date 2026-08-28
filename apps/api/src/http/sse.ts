import {
  WorkspaceInteractionRevisionEvent,
  type SessionEvent,
  type WorkspaceControlEvent,
} from "@opengeni/contracts";
import {
  getWorkspaceInteractionRevisionState,
  listSessionEvents,
  listWorkspaceControlEvents,
  type Database,
} from "@opengeni/db";
import {
  coalesceSessionEventDeltas,
  formatSessionEventSse,
  formatWorkspaceControlEventSse,
  requireSessionEventDurableFanoutCapability,
  SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  sessionEventResumeSequence,
  type EventBus,
} from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { MANAGED_AUTH_ACTOR_EPOCH_HEADER } from "@opengeni/core/managed-auth-session-sets";

const SESSION_REPLAY_PAGE_SIZE = 100;
const WORKSPACE_CONTROL_REPLAY_PAGE_SIZE = 100;
export const SSE_QUEUED_FRAME_MAX_COUNT = 1;
export const SSE_WRITE_STALL_TIMEOUT_MS = 30_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const HTTP1_BROWSER_SSE_LIFETIME_MS = 5_000;
export const HTTP1_BROWSER_SSE_BATCH_MAX_BYTES = 512 * 1024;
type SseStreamKind = "session" | "workspace_control" | "workspace_interaction";
const activeSseStreams: Record<SseStreamKind, number> = {
  session: 0,
  workspace_control: 0,
  workspace_interaction: 0,
};

export type SseDeliveryBoundObservation = {
  reason: "desired_size_non_positive" | "stall_timeout" | "frame_too_large";
  desiredSize: number | null;
  queuedFrames: number;
  queuedBytes: number;
};

export type ByteBoundedSseStreamOptions = {
  connectionLifetimeMs?: number | undefined;
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
  const connectionLifetimeMs = options.connectionLifetimeMs;
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new RangeError("SSE byte high-water mark must be a positive safe integer");
  }
  if (!Number.isSafeInteger(stallTimeoutMs) || stallTimeoutMs <= 0) {
    throw new RangeError("SSE write stall timeout must be a positive safe integer");
  }
  if (
    connectionLifetimeMs !== undefined &&
    (!Number.isSafeInteger(connectionLifetimeMs) || connectionLifetimeMs <= 0)
  ) {
    throw new RangeError("SSE connection lifetime must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  let capacityWake: (() => void) | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (lifetimeTimer !== null) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = null;
    }
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
  if (connectionLifetimeMs !== undefined) {
    lifetimeTimer = setTimeout(() => stop(() => controller.close()), connectionLifetimeMs);
  }

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
  options: SessionSseDeliveryOptions = {},
): Promise<Response> {
  const durableFanout = requireSessionEventDurableFanoutCapability(bus);
  const heartbeatIntervalMs = resolveHeartbeatInterval(options.heartbeatIntervalMs);
  let lastSent = after;
  let bootstrapping = true;
  let newestBuffered: SessionEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let delivery: LatestWinsDelivery<SessionEvent> | null = null;
  let stopReconnectObservation = () => {};
  let stopReauthorization = () => {};
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let detachAbortListener = () => {};
  let closeMetrics = () => {};
  const stopUpstream = () => {
    closeMetrics();
    detachAbortListener();
    stopReconnectObservation();
    stopReconnectObservation = () => {};
    stopReauthorization();
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    delivery?.stop();
    const release = unsubscribe;
    unsubscribe = null;
    release?.();
  };
  const channel = createByteBoundedSseStream({
    connectionLifetimeMs: options.connectionLifetimeMs,
    maxQueuedBytes: options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    onObservation: sseObservationReporter("session", options),
    onStop: stopUpstream,
  });
  closeMetrics = observeSseConnection("session", after, options.observability);

  const fail = (error: unknown) => {
    channel.fail(retryableSseFailure("session event stream delivery failed", error));
  };
  stopReauthorization = startSseReauthorization(options, channel.stopped, channel.close);
  let writeTail = Promise.resolve();
  const writeFrame = (frame: string): Promise<void> => {
    const write = writeTail.then(async () => {
      // A periodic check closes an idle stream, while this exact pre-delivery
      // check prevents a buffered/replayed event from crossing a revocation
      // boundary merely because its timer has not fired yet.
      await reauthorizeSseOrClose(options, channel);
      if (!(await channel.write(frame))) throw new SseStreamStoppedError();
    });
    writeTail = write.catch(() => {});
    return write;
  };
  const deliverDurableThrough = async (targetSequence?: number) => {
    while (true) {
      if (targetSequence !== undefined && lastSent >= targetSequence) return;
      const previousLastSent = lastSent;
      const limit =
        targetSequence === undefined
          ? SESSION_REPLAY_PAGE_SIZE
          : Math.min(SESSION_REPLAY_PAGE_SIZE, targetSequence - lastSent);
      const page = await listSessionEvents(db, workspaceId, sessionId, {
        after: lastSent,
        limit,
      });
      const eligible =
        targetSequence === undefined
          ? page
          : page.filter((event) => event.sequence <= targetSequence);
      if (eligible.length === 0) {
        if (targetSequence === undefined) return;
        throw new Error(
          `Session event replay stalled before sequence ${targetSequence}; last sent ${lastSent}`,
        );
      }
      // The durable audit log remains exact. The browser transport combines
      // adjacent text deltas into bounded frames carrying `coalescedUntil`, so
      // a long answer cannot create thousands of React renders and starve
      // command acknowledgements behind its own token stream.
      for (const projected of coalesceSessionEventDeltas(eligible)) {
        await writeFrame(formatSessionEventSse(projected));
        lastSent = sessionEventResumeSequence(projected);
      }
      if (lastSent <= previousLastSent) {
        throw new Error(`Session event replay made no progress after sequence ${lastSent}`);
      }
      if (targetSequence !== undefined && lastSent >= targetSequence) return;
      if (targetSequence === undefined && page.length < limit) return;
    }
  };
  let durableDeliveryTail = Promise.resolve();
  const reconcileDurableThrough = (targetSequence?: number): Promise<void> => {
    const deliveryRun = durableDeliveryTail.then(() => deliverDurableThrough(targetSequence));
    durableDeliveryTail = deliveryRun.catch(() => {});
    return deliveryRun;
  };
  let newestReconnectGeneration = 0;
  let reconnectReconcilePending = false;
  let reconnectReconcileRunning = false;
  const drainReconnectReconciliation = () => {
    if (
      bootstrapping ||
      reconnectReconcileRunning ||
      !reconnectReconcilePending ||
      channel.stopped()
    ) {
      return;
    }
    reconnectReconcileRunning = true;
    void (async () => {
      while (reconnectReconcilePending && !channel.stopped()) {
        // Multiple reconnects during one durable read collapse into one newest
        // catch-up. Postgres is authoritative, so that later read covers every
        // disconnect window without one query per heartbeat or buffered event.
        reconnectReconcilePending = false;
        await reconcileDurableThrough();
      }
    })()
      .catch((error) => {
        if (!(error instanceof SseStreamStoppedError)) fail(error);
      })
      .finally(() => {
        reconnectReconcileRunning = false;
        drainReconnectReconciliation();
      });
  };
  const scheduleReconnectReconciliation = (generation: number) => {
    if (generation <= newestReconnectGeneration || channel.stopped()) return;
    newestReconnectGeneration = generation;
    reconnectReconcilePending = true;
    drainReconnectReconciliation();
  };
  const send = async (event: SessionEvent) => {
    const targetSequence = sessionEventResumeSequence(event);
    if (targetSequence <= lastSent) return;
    await reconcileDurableThrough(targetSequence);
  };
  const scheduleHeartbeat = () => {
    if (channel.stopped()) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      void writeFrame(": heartbeat\n\n")
        .then(scheduleHeartbeat)
        .catch((error) => {
          if (!(error instanceof SseStreamStoppedError)) fail(error);
        });
    }, heartbeatIntervalMs);
  };
  delivery = createLatestWinsDelivery(send, fail);
  stopReconnectObservation = durableFanout.subscribeRecovery(scheduleReconnectReconciliation);

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

    await reconcileDurableThrough();
    await writeFrame(": connected\n\n");
    scheduleHeartbeat();
    bootstrapping = false;
    drainReconnectReconciliation();
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
  else {
    signal.addEventListener("abort", abort, { once: true });
    detachAbortListener = () => signal.removeEventListener("abort", abort);
  }

  return await sseHttpResponse(channel.stream, options);
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
  const heartbeatIntervalMs = resolveHeartbeatInterval(options.heartbeatIntervalMs);
  let lastSent = after;
  let bootstrapping = true;
  let newestBuffered: WorkspaceControlEvent | null = null;
  let unsubscribe: (() => void) | null = null;
  let delivery: LatestWinsDelivery<WorkspaceControlEvent> | null = null;
  let stopReauthorization = () => {};
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let detachAbortListener = () => {};
  let closeMetrics = () => {};
  const stopUpstream = () => {
    closeMetrics();
    detachAbortListener();
    stopReauthorization();
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    delivery?.stop();
    const release = unsubscribe;
    unsubscribe = null;
    release?.();
  };
  const channel = createByteBoundedSseStream({
    connectionLifetimeMs: options.connectionLifetimeMs,
    maxQueuedBytes: options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    onObservation: sseObservationReporter("workspace_control", options),
    onStop: stopUpstream,
  });
  closeMetrics = observeSseConnection("workspace_control", after, options.observability);

  const fail = (error: unknown) => {
    channel.fail(retryableSseFailure("workspace control stream delivery failed", error));
  };
  stopReauthorization = startSseReauthorization(options, channel.stopped, channel.close);
  let writeTail = Promise.resolve();
  const writeFrame = (frame: string): Promise<void> => {
    const write = writeTail.then(async () => {
      await reauthorizeSseOrClose(options, channel);
      if (!(await channel.write(frame))) throw new SseStreamStoppedError();
    });
    writeTail = write.catch(() => {});
    return write;
  };
  const scheduleHeartbeat = () => {
    if (channel.stopped()) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      void writeFrame(": heartbeat\n\n")
        .then(scheduleHeartbeat)
        .catch((error) => {
          if (!(error instanceof SseStreamStoppedError)) fail(error);
        });
    }, heartbeatIntervalMs);
  };
  const send = async (event: WorkspaceControlEvent) => {
    if (event.sequence <= lastSent) return;
    if (event.sequence > lastSent + 1) {
      while (lastSent < event.sequence) {
        const previousLastSent = lastSent;
        const limit = Math.min(
          WORKSPACE_CONTROL_REPLAY_PAGE_SIZE,
          Math.max(1, event.sequence - lastSent),
        );
        const missing = await listWorkspaceControlEvents(db, workspaceId, lastSent, limit);
        let reachedIncoming = false;
        for (const missed of missing.sort((a, b) => a.sequence - b.sequence)) {
          if (missed.sequence >= event.sequence) {
            reachedIncoming = true;
            break;
          }
          if (missed.sequence > lastSent) {
            await writeFrame(formatWorkspaceControlEventSse(missed));
            lastSent = missed.sequence;
          }
        }
        if (reachedIncoming || missing.length < limit) break;
        if (lastSent === previousLastSent) {
          throw new Error(
            `Workspace control gap fill returned a full stale page before sequence ${event.sequence}; last sent ${lastSent}`,
          );
        }
      }
    }
    await writeFrame(formatWorkspaceControlEventSse(event));
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
    scheduleHeartbeat();
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
  else {
    signal.addEventListener("abort", abort, { once: true });
    detachAbortListener = () => signal.removeEventListener("abort", abort);
  }

  return await sseHttpResponse(channel.stream, options);
}

export type WorkspaceInteractionSseOptions = SseDeliveryOptions & {
  pollIntervalMs?: number | undefined;
};

/**
 * One HTTP connection for the two workspace-wide invalidation domains used by
 * every visible OpenGeni surface. Keeping these as separate HTTP/1 streams
 * consumes all six per-origin browser connections with only two windows and
 * starves ordinary mutations/terminal grants. The durable cursors remain
 * independent; this function only multiplexes their already-bounded SSE frames.
 */
export async function sseWorkspaceLiveStream(
  db: Database,
  bus: EventBus,
  accountId: string,
  workspaceId: string,
  controlAfter: number,
  interactionAfter: number,
  signal: AbortSignal,
  options: WorkspaceInteractionSseOptions = {},
): Promise<Response> {
  const upstream = new AbortController();
  let stopReauthorization = () => {};
  const channel = createByteBoundedSseStream({
    connectionLifetimeMs: options.connectionLifetimeMs,
    maxQueuedBytes: options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    onObservation: sseObservationReporter("workspace_interaction", options),
    onStop: () => {
      stopReauthorization();
      signal.removeEventListener("abort", abort);
      upstream.abort();
    },
  });
  const abort = () => {
    upstream.abort();
    channel.close();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  stopReauthorization = startSseReauthorization(options, channel.stopped, channel.close);

  const upstreamOptions: WorkspaceInteractionSseOptions = {
    ...options,
    connectionLifetimeMs: undefined,
    finiteResponseMaxBytes: undefined,
    reauthorize: undefined,
    reauthorizeAfterMs: undefined,
  };

  let writeTail = Promise.resolve(true);
  const write = (frame: string): Promise<boolean> => {
    const pending = writeTail.then(async () => {
      await reauthorizeSseOrClose(options, channel);
      return await channel.write(frame);
    });
    writeTail = pending.catch(() => false);
    return pending;
  };
  const pump = async (response: Response): Promise<void> => {
    if (!response.body) throw new TypeError("workspace live upstream omitted its body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          const tail = decoder.decode();
          if (tail) await write(tail);
          return;
        }
        const frame = decoder.decode(next.value, { stream: true });
        if (frame && !(await write(frame))) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };

  void (async () => {
    try {
      const [control, interaction] = await Promise.all([
        sseWorkspaceControlStream(
          db,
          bus,
          workspaceId,
          controlAfter,
          upstream.signal,
          upstreamOptions,
        ),
        sseWorkspaceInteractionRevisionStream(
          db,
          accountId,
          workspaceId,
          interactionAfter,
          upstream.signal,
          upstreamOptions,
        ),
      ]);
      const pumps = [pump(control), pump(interaction)];
      let termination: unknown = new TypeError("workspace live upstream ended unexpectedly");
      try {
        await Promise.race(pumps);
      } catch (error) {
        termination = error;
      } finally {
        // Either durable domain ending makes the multiplexed connection stale.
        // Stop its sibling immediately so the SDK reconnects both independent
        // cursors instead of silently losing one domain forever.
        upstream.abort();
        await Promise.allSettled(pumps);
      }
      if (!signal.aborted && !channel.stopped()) channel.fail(termination);
    } catch (error) {
      if (!upstream.signal.aborted && !channel.stopped()) channel.fail(error);
    }
  })();

  return await sseHttpResponse(channel.stream, options);
}

/**
 * Latest-wins interaction invalidation stream. The durable truth is one
 * monotonic workspace row, not an ever-growing event log. Each poll reads only
 * that row; reconnect immediately projects the newest revision after `after`.
 */
export async function sseWorkspaceInteractionRevisionStream(
  db: Database,
  accountId: string,
  workspaceId: string,
  after: number,
  signal: AbortSignal,
  options: WorkspaceInteractionSseOptions = {},
): Promise<Response> {
  const heartbeatIntervalMs = resolveHeartbeatInterval(options.heartbeatIntervalMs);
  const pollIntervalMs = resolveInteractionPollInterval(options.pollIntervalMs);
  let lastSent = after;
  let lastWriteAt = Date.now();
  let stopRequested = false;
  let stopReauthorization = () => {};
  let detachAbortListener = () => {};
  let closeMetrics = () => {};
  const channel = createByteBoundedSseStream({
    connectionLifetimeMs: options.connectionLifetimeMs,
    maxQueuedBytes: options.maxQueuedBytes ?? SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    onObservation: sseObservationReporter("workspace_interaction", options),
    onStop: () => {
      stopRequested = true;
      stopReauthorization();
      closeMetrics();
      detachAbortListener();
    },
  });
  closeMetrics = observeSseConnection("workspace_interaction", after, options.observability);
  stopReauthorization = startSseReauthorization(options, channel.stopped, channel.close);

  const write = async (frame: string): Promise<boolean> => {
    await reauthorizeSseOrClose(options, channel);
    const accepted = await channel.write(frame);
    if (accepted) lastWriteAt = Date.now();
    return accepted;
  };

  void (async () => {
    try {
      if (!(await write(": connected\n\n"))) return;
      for (;;) {
        if (stopRequested || signal.aborted || channel.stopped()) return;
        const state = await getWorkspaceInteractionRevisionState(db, {
          accountId,
          workspaceId,
        });
        if (state.revision > lastSent) {
          const event = WorkspaceInteractionRevisionEvent.parse({
            workspaceId,
            sequence: state.revision,
            revision: state.revision,
            type: "workspace.interaction.changed",
            occurredAt: (state.updatedAt ?? new Date()).toISOString(),
          });
          if (!(await write(formatWorkspaceInteractionRevisionSse(event)))) return;
          lastSent = event.revision;
        } else if (Date.now() - lastWriteAt >= heartbeatIntervalMs) {
          if (!(await write(": heartbeat\n\n"))) return;
        }
        await abortableDelay(pollIntervalMs, signal);
      }
    } catch (error) {
      if (!signal.aborted && !channel.stopped()) {
        channel.fail(retryableSseFailure("workspace interaction stream delivery failed", error));
      }
    }
  })();

  const abort = () => channel.close();
  if (signal.aborted) abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    detachAbortListener = () => signal.removeEventListener("abort", abort);
  }

  return await sseHttpResponse(channel.stream, options);
}

function observeSseConnection(
  stream: SseStreamKind,
  after: number,
  observability: Observability | undefined,
): () => void {
  activeSseStreams[stream] += 1;
  observability?.incrementCounter({
    name: "opengeni_sse_connections_total",
    help: "SSE connections opened at the API boundary.",
    labels: { stream, resume: after > 0 ? "resumed" : "fresh" },
  });
  observability?.setGauge?.({
    name: "opengeni_sse_connections_active",
    help: "Currently active SSE connections at the API boundary.",
    labels: { stream },
    value: activeSseStreams[stream],
  });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    activeSseStreams[stream] = Math.max(0, activeSseStreams[stream] - 1);
    observability?.setGauge?.({
      name: "opengeni_sse_connections_active",
      help: "Currently active SSE connections at the API boundary.",
      labels: { stream },
      value: activeSseStreams[stream],
    });
  };
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

async function reauthorizeSseOrClose(
  options: SseDeliveryOptions,
  channel: ByteBoundedSseStream,
): Promise<void> {
  try {
    await options.reauthorize?.();
  } catch {
    // Authorization loss is an expected fail-closed terminal condition, not a
    // delivery fault. End the HTTP response cleanly so Bun and Chromium retire
    // the HTTP/1 socket even if the initiating document is being replaced.
    // No frame crosses the failed check; a still-live SDK may reconnect and is
    // fenced again at request admission, while a destroyed realm cannot leave
    // an errored response occupying the per-origin connection pool.
    channel.close();
    throw new SseStreamStoppedError();
  }
}

export type SseDeliveryOptions = {
  connectionLifetimeMs?: number | undefined;
  /** Return a known-length batch instead of a chunked response. HTTP/1 only. */
  finiteResponseMaxBytes?: number | undefined;
  maxQueuedBytes?: number;
  stallTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  observability?: Observability | undefined;
  onObservation?: ((observation: SseDeliveryBoundObservation) => void) | undefined;
  /** Current ACL re-check, run even while the event stream is idle. */
  reauthorize?: (() => Promise<void>) | undefined;
  reauthorizeAfterMs?: number | undefined;
  /** Exact selected actor emitted on the stream response for cross-tab fencing. */
  actorEpoch?: string | undefined;
};

export function browserSseDeliveryOptions(
  transport: string | undefined,
): Pick<SseDeliveryOptions, "connectionLifetimeMs" | "finiteResponseMaxBytes"> {
  return transport === "http1-bounded"
    ? {
        connectionLifetimeMs: HTTP1_BROWSER_SSE_LIFETIME_MS,
        finiteResponseMaxBytes: HTTP1_BROWSER_SSE_BATCH_MAX_BYTES,
      }
    : {};
}

async function sseHttpResponse(
  stream: ReadableStream<Uint8Array>,
  options: SseDeliveryOptions,
): Promise<Response> {
  const maxBytes = options.finiteResponseMaxBytes;
  let body: ReadableStream<Uint8Array> | ArrayBuffer = stream;
  let contentLength: number | null = null;
  if (maxBytes !== undefined) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < SESSION_EVENT_SSE_FRAME_MAX_BYTES ||
      maxBytes > HTTP1_BROWSER_SSE_BATCH_MAX_BYTES
    ) {
      throw new RangeError(
        `finite SSE batch limit must be between ${SESSION_EVENT_SSE_FRAME_MAX_BYTES} and ${HTTP1_BROWSER_SSE_BATCH_MAX_BYTES} bytes`,
      );
    }
    body = await collectFiniteSseBatch(stream, maxBytes);
    contentLength = body.byteLength;
  }
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // A clean authorization close must also retire the HTTP/1 transport.
      // Reusing that socket can leave Chromium accounting the ended SSE as an
      // active per-origin connection while a replacement document is already
      // dispatching finite reads. HTTP/2 front doors strip this hop-by-hop
      // header; direct Bun/self-hosted HTTP/1 clients receive an unambiguous
      // connection end after the stream's terminal chunk.
      Connection: "close",
      ...(contentLength === null ? {} : { "Content-Length": String(contentLength) }),
      ...(options.actorEpoch ? { [MANAGED_AUTH_ACTOR_EPOCH_HEADER]: options.actorEpoch } : {}),
    },
  });
}

async function collectFiniteSseBatch(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      // Each source chunk is one complete SSE frame. End before an overflowing
      // frame so reconnect replay starts from the consumer's last whole cursor.
      if (length + next.value.byteLength > maxBytes) {
        await reader.cancel("finite SSE batch reached its byte limit");
        break;
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export type SessionSseDeliveryOptions = SseDeliveryOptions;

function sseObservationReporter(
  stream: SseStreamKind,
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

function resolveHeartbeatInterval(value: number | undefined): number {
  const interval = value ?? SSE_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 60_000) {
    throw new RangeError("SSE heartbeat interval must be between 1000 and 60000ms");
  }
  return interval;
}

function resolveInteractionPollInterval(value: number | undefined): number {
  const interval = value ?? 1_000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) {
    throw new RangeError("interaction revision poll interval must be between 100 and 60000ms");
  }
  return interval;
}

function startSseReauthorization(
  options: SseDeliveryOptions,
  stopped: () => boolean,
  fail: (error: unknown) => void,
): () => void {
  if (!options.reauthorize) return () => {};
  const interval = options.reauthorizeAfterMs ?? 15_000;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 60_000) {
    throw new RangeError("SSE reauthorization must be between 1000 and 60000ms");
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped()) return;
    timer = setTimeout(() => {
      timer = null;
      void options.reauthorize!().then(schedule).catch(fail);
    }, interval);
  };
  schedule();
  return () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
}

function formatWorkspaceInteractionRevisionSse(event: WorkspaceInteractionRevisionEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
