import { isAbortError, isRetryableStreamError, OpenGeniStreamError } from "./errors";
import { parseSseStream } from "./sse";
import type { SessionEvent } from "./types";

/**
 * Transport boundary for the streaming core. The client implements it with
 * `fetch`; unit tests script it directly.
 */
export type SessionEventStreamTransport = {
  /** Open the SSE stream, replaying durable events after `after` first. */
  openStream: (
    after: number,
    signal: AbortSignal | undefined,
  ) => Promise<ReadableStream<Uint8Array>>;
  /** Replay durable events by sequence (`GET .../events?after=&limit=`). */
  listEvents: (after: number, limit: number) => Promise<SessionEvent[]>;
};

export type StreamConnectionState = "connecting" | "live" | "reconnecting";

export type StreamSessionEventsOptions = {
  /** Resume after this sequence number (exclusive). Defaults to 0 (full replay). */
  after?: number;
  /** Aborting ends the stream gracefully (the generator returns). */
  signal?: AbortSignal;
  /** Reconnect on transient drops. Defaults to true. */
  reconnect?: boolean;
  /** Initial reconnect backoff. Defaults to 500ms. */
  reconnectDelayMs?: number;
  /** Backoff ceiling. Defaults to 10s. */
  maxReconnectDelayMs?: number;
  /**
   * Give up after this many consecutive failed reconnect attempts (i.e. N
   * reconnects = N+1 total open-stream calls). Defaults to unlimited.
   */
  maxReconnectAttempts?: number;
  onStateChange?: (state: StreamConnectionState) => void;
};

/**
 * Stream a session's events with exactly-once, in-order delivery.
 *
 * Guarantees, anchored on the per-session contiguous `sequence`:
 * - **No duplicates**: events at or below the cursor are dropped, so server
 *   replay overlap and reconnect overlap never re-yield.
 * - **No gaps**: each reconnect resumes from the last seen sequence, and a
 *   gap observed inside one connection is backfilled from the durable replay
 *   endpoint before the newer event is yielded (events are durable before
 *   they are published live, so the backfill always finds them).
 * - **Ordered**: sequences are yielded strictly ascending.
 *
 * The generator ends when `signal` aborts, when the server closes and
 * `reconnect` is false, or with an error for non-retryable failures.
 */
export async function* streamSessionEvents(
  transport: SessionEventStreamTransport,
  options: StreamSessionEventsOptions = {},
): AsyncGenerator<SessionEvent, void, void> {
  const signal = options.signal;
  const reconnect = options.reconnect ?? true;
  const baseDelayMs = options.reconnectDelayMs ?? 500;
  const maxDelayMs = options.maxReconnectDelayMs ?? 10_000;
  const maxAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
  let cursor = options.after ?? 0;
  let failedAttempts = 0;
  let delayMs = baseDelayMs;
  let everConnected = false;

  while (!signal?.aborted) {
    options.onStateChange?.(everConnected || failedAttempts > 0 ? "reconnecting" : "connecting");
    const cursorAtOpen = cursor;
    try {
      const body = await transport.openStream(cursor, signal);
      everConnected = true;
      failedAttempts = 0;
      delayMs = baseDelayMs;
      options.onStateChange?.("live");
      for await (const message of parseSseStream(body)) {
        // Re-check after every yield resumption: an abort from the consumer
        // must not let already-buffered events keep flowing.
        if (signal?.aborted) {
          return;
        }
        const event = parseSessionEvent(message.data);
        if (!event || event.sequence <= cursor) {
          continue;
        }
        if (event.sequence > cursor + 1) {
          for await (const missed of backfillEvents(transport, cursor, event.sequence - 1)) {
            cursor = missed.sequence;
            yield missed;
            if (signal?.aborted) {
              return;
            }
          }
        }
        cursor = event.sequence;
        yield event;
      }
      if (!reconnect) {
        return;
      }
      // Clean server close: reconnect immediately when the connection made
      // progress (servers legitimately cycle long SSE connections); pace
      // empty closes so a misbehaving server is not hammered in a hot loop.
      if (cursor === cursorAtOpen) {
        await sleep(baseDelayMs, signal);
      }
      continue;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }
      if (!reconnect || !isRetryableStreamError(error)) {
        throw error;
      }
      failedAttempts += 1;
      if (failedAttempts > maxAttempts) {
        throw new OpenGeniStreamError(
          `event stream gave up after ${maxAttempts} consecutive failed reconnect attempts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await sleep(delayMs, signal);
    delayMs = Math.min(Math.max(delayMs * 2, baseDelayMs), maxDelayMs);
  }
}

/**
 * Yield the durable events with `fromExclusive < sequence <= toInclusive`,
 * in order. Sequences are contiguous, so every one of them must exist in the
 * replay endpoint; if any is missing the function throws instead of skipping
 * it — continuing would silently break the gap-free delivery guarantee.
 */
async function* backfillEvents(
  transport: SessionEventStreamTransport,
  fromExclusive: number,
  toInclusive: number,
): AsyncGenerator<SessionEvent, void, void> {
  let cursor = fromExclusive;
  while (cursor < toInclusive) {
    const page = await transport.listEvents(cursor, Math.min(500, toInclusive - cursor));
    const advancing = page
      .filter((event) => event.sequence > cursor && event.sequence <= toInclusive)
      .sort((a, b) => a.sequence - b.sequence);
    if (advancing.length === 0) {
      throw new OpenGeniStreamError(
        `event replay backfill stalled: expected sequences ${cursor + 1}..${toInclusive} but the replay endpoint returned none of them`,
      );
    }
    for (const event of advancing) {
      if (event.sequence !== cursor + 1) {
        throw new OpenGeniStreamError(
          `event replay backfill is missing sequence ${cursor + 1} (replay endpoint skipped to ${event.sequence}); refusing to deliver with a gap`,
        );
      }
      cursor = event.sequence;
      yield event;
    }
  }
}

function parseSessionEvent(data: string): SessionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { sequence?: unknown }).sequence !== "number" ||
    typeof (parsed as { type?: unknown }).type !== "string" ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  return parsed as SessionEvent;
}

async function sleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted || delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
