import type { OpenGeniClient } from "./client";
import type { StreamSessionEventsOptions } from "./stream";
import type { SessionEvent } from "./types";

/**
 * Proxy-through-your-own-API helpers.
 *
 * The intended pattern: a customer's server consumes the OpenGeni event
 * stream with its own API key (`client.streamEvents(...)`) and re-emits it to
 * its browser clients over its own authenticated endpoint — the OpenGeni key
 * never reaches the browser. The re-emitted wire format is identical to
 * OpenGeni's own SSE stream (`id: <sequence>`, `event: <type>`,
 * `data: <event JSON>`), so the browser side can consume it with this same
 * SDK's streaming core (or a plain `EventSource`), including resume via
 * `?after=` / `Last-Event-ID`.
 */

/** Format one event exactly as OpenGeni's API emits it over SSE. */
export function formatSseEvent(event: SessionEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export type SseReStreamOptions = {
  /**
   * Emit `: ping` comment lines at this interval, keeping intermediaries from
   * idling the connection out. Disabled when omitted.
   */
  heartbeatMs?: number;
  /**
   * Called when the downstream consumer cancels (e.g. the browser
   * disconnected). Use it to abort the upstream OpenGeni stream — an async
   * iterator that is mid-`await` cannot be interrupted by `return()` alone.
   */
  onCancel?: () => void;
};

/**
 * Re-emit a stream of session events as an SSE byte stream. Pull-based, so
 * upstream consumption follows downstream demand; cancelling the returned
 * stream fires `onCancel` and ends the upstream iterator.
 */
export function sessionEventsToSseStream(
  events: AsyncIterable<SessionEvent>,
  options: SseReStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;

  const stopHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      if (options.heartbeatMs !== undefined) {
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            stopHeartbeat();
          }
        }, options.heartbeatMs);
      }
    },
    pull: async (controller) => {
      let result: IteratorResult<SessionEvent, unknown>;
      try {
        result = await iterator.next();
      } catch (error) {
        stopHeartbeat();
        throw error;
      }
      if (cancelled) {
        return;
      }
      if (result.done) {
        stopHeartbeat();
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(formatSseEvent(result.value)));
    },
    cancel: () => {
      cancelled = true;
      stopHeartbeat();
      options.onCancel?.();
      // Fire-and-forget: if the iterator is suspended mid-await, return()
      // settles only after onCancel unblocks it; cancel must not hang on it.
      void Promise.resolve(iterator.return?.(undefined)).then(
        () => undefined,
        () => undefined,
      );
    },
  });
}

/** Wrap an event stream in a ready-to-return SSE `Response`. */
export function sessionEventsToSseResponse(
  events: AsyncIterable<SessionEvent>,
  options: SseReStreamOptions = {},
): Response {
  return new Response(sessionEventsToSseStream(events, options), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Read the resume cursor a reconnecting SSE client sent: the `after` query
 * parameter, or the standard `Last-Event-ID` header (the re-emitted stream
 * sets `id:` to the sequence). Returns 0 (full replay) when absent.
 */
export function resumeSequenceFromRequest(request: Request): number {
  const url = new URL(request.url);
  const raw = url.searchParams.get("after") ?? request.headers.get("Last-Event-ID");
  const parsed = raw === null ? 0 : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export type ProxySessionEventStreamOptions = Omit<StreamSessionEventsOptions, "after"> & {
  /**
   * Resume cursor. Pass a number, or the incoming browser `Request` to
   * honor its `?after=` / `Last-Event-ID` automatically.
   */
  after?: number | Request;
  /** See {@link SseReStreamOptions.heartbeatMs}. */
  heartbeatMs?: number;
};

/**
 * One-call proxy: consume the OpenGeni stream server-side and return an SSE
 * `Response` for your own browser clients. Works anywhere WHATWG `Response`
 * is the handler return type (Hono, Next.js route handlers, Bun.serve,
 * Cloudflare Workers, ...).
 *
 * The upstream OpenGeni connection is torn down when the downstream client
 * disconnects, and also when `options.signal` (e.g. the incoming request's
 * signal) aborts.
 */
export function proxySessionEventStream(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  options: ProxySessionEventStreamOptions = {},
): Response {
  const { after, heartbeatMs, signal, ...streamOptions } = options;
  const upstream = new AbortController();
  if (signal?.aborted) {
    upstream.abort();
  } else {
    signal?.addEventListener("abort", () => upstream.abort(), { once: true });
  }
  const resolvedAfter = after instanceof Request ? resumeSequenceFromRequest(after) : after ?? 0;
  const events = client.streamEvents(workspaceId, sessionId, {
    ...streamOptions,
    after: resolvedAfter,
    signal: upstream.signal,
  });
  return sessionEventsToSseResponse(events, {
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    onCancel: () => upstream.abort(),
  });
}
