// Responses WebSocket transport for the Codex subscription backend.
//
// The backend accepts the same Responses request over a persistent WebSocket
// (`response.create` messages) and streams the same events back. Keeping one
// warm connection per conversation removes the per-request HTTP setup from
// every agent step (about 0.6 s of time-to-first-event measured against the
// SSE endpoint). This module is a drop-in FetchLike: it turns a streaming POST
// to /codex/responses into a `response.create` message and synthesizes the
// SSE Response the rest of the Codex transport already validates, audits and
// times out. Anything it cannot carry (busy connection, failed handshake,
// non-streaming or unexpected requests, runtimes without header-capable
// WebSockets) goes over HTTP unchanged.

import type { FetchLike } from "./fetch";
import { CODEX_PHYSICAL_REQUEST, type CodexPhysicalRequestInit } from "./request-context";

export const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";

/** The subset of the WHATWG/Bun WebSocket this transport uses. */
export type CodexWebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

export type CodexWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => CodexWebSocketLike;

export type CodexResponsesTransportOptions = {
  /** Opens a WebSocket with handshake headers; absent means HTTP only. */
  createSocket?: CodexWebSocketFactory | null;
  /** Close a connection that has carried no request for this long. */
  idleMs?: number;
  /** Never start a request on a connection older than this. */
  maxAgeMs?: number;
  connectTimeoutMs?: number;
  /** After a failed handshake, use HTTP for this conversation for this long. */
  handshakeBackoffMs?: number;
  now?: () => number;
};

const DEFAULT_IDLE_MS = 5 * 60_000;
// The backend retires connections after about an hour; never start a request
// on one that could be closed underneath it.
const DEFAULT_MAX_AGE_MS = 45 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HANDSHAKE_BACKOFF_MS = 5 * 60_000;

// Per-request headers stay off the shared handshake: they would split every
// request onto its own connection, and the WebSocket protocol has no
// per-message equivalent the backend reads.
const PER_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "idempotency-key",
  "openai-beta",
]);

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "response.incomplete",
  "response.error",
  "error",
]);

// Connection-level events that the SSE endpoint conveys as response headers.
const RATE_LIMITS_EVENT = "codex.rate_limits";
const METADATA_EVENT = "codex.response.metadata";
const TIMING_EVENT = "responsesapi.websocket_timing";

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type Connection = {
  key: string;
  socket: CodexWebSocketLike;
  openedAt: number;
  busy: boolean;
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Receives every message while a request is in flight. */
  onEvent: ((event: Record<string, unknown>) => void) | null;
  /** Receives the close of the socket while a request is in flight. */
  onClose: ((reason: Error) => void) | null;
};

function bunWebSocketFactory(): CodexWebSocketFactory | null {
  const runtime = globalThis as { Bun?: unknown; WebSocket?: unknown };
  // Only Bun's WebSocket accepts handshake headers, which carry the bearer.
  if (!runtime.Bun || typeof runtime.WebSocket !== "function") return null;
  const Socket = runtime.WebSocket as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => CodexWebSocketLike;
  return (url, headers) => new Socket(url, { headers });
}

function eventData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

/** Translate the WebSocket rate-limit event into the SSE endpoint's headers. */
export function codexRateLimitHeaders(event: Record<string, unknown>): Array<[string, string]> {
  const limits = event.rate_limits;
  if (!limits || typeof limits !== "object") return [];
  const headers: Array<[string, string]> = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = (limits as Record<string, unknown>)[slot];
    if (!window || typeof window !== "object") continue;
    const value = window as Record<string, unknown>;
    const number = (field: string) =>
      typeof value[field] === "number" && Number.isFinite(value[field])
        ? Math.round(value[field] as number)
        : null;
    const used = number("used_percent");
    const minutes = number("window_minutes");
    const resetAfter = number("reset_after_seconds");
    const resetAt = number("reset_at");
    if (used !== null) headers.push([`x-codex-${slot}-used-percent`, String(used)]);
    if (minutes !== null) {
      headers.push([`x-codex-${slot}-window-minutes`, String(minutes)]);
      headers.push([`x-codex-${slot}-limit-window-seconds`, String(minutes * 60)]);
    }
    if (resetAfter !== null)
      headers.push([`x-codex-${slot}-reset-after-seconds`, String(resetAfter)]);
    if (resetAt !== null) headers.push([`x-codex-${slot}-reset-at`, String(resetAt)]);
  }
  return headers;
}

function metadataHeaders(event: Record<string, unknown>): Array<[string, string]> {
  const headers = event.headers;
  if (!headers || typeof headers !== "object") return [];
  return Object.entries(headers as Record<string, unknown>).flatMap(([name, value]) =>
    HEADER_NAME.test(name) && typeof value === "string" && !/[\r\n]/.test(value)
      ? [[name.toLowerCase(), value] as [string, string]]
      : [],
  );
}

function sseBlock(event: Record<string, unknown>): Uint8Array {
  const type = typeof event.type === "string" ? event.type : "message";
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function requestUrl(input: string | URL | Request): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return null;
}

export function codexResponsesTransport(
  http: FetchLike,
  options: CodexResponsesTransportOptions = {},
): FetchLike {
  const createSocket =
    options.createSocket === undefined ? bunWebSocketFactory() : options.createSocket;
  if (!createSocket) return http;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const handshakeBackoffMs = options.handshakeBackoffMs ?? DEFAULT_HANDSHAKE_BACKOFF_MS;
  const now = options.now ?? Date.now;
  const pool = new Map<string, Connection>();
  const backoffUntil = new Map<string, number>();

  const retire = (connection: Connection) => {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    if (pool.get(connection.key) === connection) pool.delete(connection.key);
    if (!connection.closed) {
      connection.closed = true;
      try {
        connection.socket.close(1000, "done");
      } catch {
        // Already closing.
      }
    }
  };

  const release = (connection: Connection) => {
    connection.busy = false;
    connection.onEvent = null;
    connection.onClose = null;
    if (connection.closed) return;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => retire(connection), idleMs);
    (connection.idleTimer as { unref?: () => void }).unref?.();
  };

  const connect = (url: string, key: string, headers: Record<string, string>) =>
    new Promise<Connection>((resolve, reject) => {
      let socket: CodexWebSocketLike;
      try {
        socket = createSocket(url, headers);
      } catch (error) {
        reject(error);
        return;
      }
      const connection: Connection = {
        key,
        socket,
        openedAt: now(),
        busy: false,
        closed: false,
        idleTimer: null,
        onEvent: null,
        onClose: null,
      };
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        connection.closed = true;
        try {
          socket.close();
        } catch {
          // Never opened.
        }
        reject(new Error("Codex response WebSocket handshake timed out"));
      }, connectTimeoutMs);
      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve(connection);
      };
      socket.onerror = () => {
        // A close event always follows and settles the state.
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        connection.closed = true;
        if (pool.get(key) === connection) pool.delete(key);
        if (connection.idleTimer) clearTimeout(connection.idleTimer);
        if (!opened) {
          reject(
            new Error(`Codex response WebSocket handshake failed (${event?.code ?? "closed"})`),
          );
          return;
        }
        connection.onClose?.(
          new Error(
            `Codex response WebSocket closed before the response finished (${event?.code ?? "closed"})`,
          ),
        );
      };
      socket.onmessage = (message) => {
        const text = eventData(message.data);
        if (text === null) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          connection.onEvent?.(parsed as Record<string, unknown>);
        }
      };
    });

  return async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    if (
      !url ||
      method !== "POST" ||
      typeof body !== "string" ||
      !/^https:\/\/[^/]+\/.*\/codex\/responses(?:\?|$)/.test(url)
    ) {
      return await http(input, init);
    }
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      return await http(input, init);
    }
    if (payload.stream !== true) return await http(input, init);

    const handshake: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers).entries()) {
      if (!PER_REQUEST_HEADERS.has(name)) handshake[name] = value;
    }
    handshake["openai-beta"] = CODEX_RESPONSES_WEBSOCKET_BETA;
    const wsUrl = url.replace(/^https:/, "wss:");
    const key = JSON.stringify([wsUrl, Object.entries(handshake).sort()]);
    if ((backoffUntil.get(key) ?? 0) > now()) return await http(input, init);

    const signal = init?.signal ?? null;
    signal?.throwIfAborted();
    let connection = pool.get(key);
    if (connection && (connection.closed || now() - connection.openedAt > maxAgeMs)) {
      if (!connection.busy) retire(connection);
      connection = undefined;
    }
    if (connection?.busy) return await http(input, init);
    if (!connection) {
      try {
        connection = await connect(wsUrl, key, handshake);
      } catch {
        backoffUntil.set(key, now() + handshakeBackoffMs);
        return await http(input, init);
      }
      if (pool.has(key)) {
        // A concurrent request of the same conversation opened one first.
        const existing = pool.get(key)!;
        if (!existing.busy && !existing.closed) {
          retire(connection);
          connection = existing;
        } else {
          pool.set(key, connection);
        }
      } else {
        pool.set(key, connection);
      }
      if (connection.busy) return await http(input, init);
    }
    const active = connection;
    active.busy = true;
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = null;

    return await new Promise<Response>((resolve, reject) => {
      const headers = new Headers({ "content-type": "text/event-stream" });
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let started = false;
      let finished = false;
      const pending: Uint8Array[] = [];

      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) {
          // The provider may still be working on a request we can no longer
          // follow; that socket is never reused.
          retire(active);
          active.busy = false;
          if (started) controller?.error(error);
          else reject(error);
          return;
        }
        release(active);
        try {
          controller?.close();
        } catch {
          // The reader already cancelled.
        }
      };
      const onAbort = () => finish(signal?.reason ?? new Error("Model request aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });

      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          for (const block of pending.splice(0)) streamController.enqueue(block);
          if (finished) streamController.close();
        },
        cancel() {
          if (!finished) finish(new Error("Model response stream cancelled"));
        },
      });

      const begin = (status = 200, errorBody?: string) => {
        started = true;
        if (errorBody !== undefined) {
          headers.set("content-type", "application/json");
          resolve(new Response(errorBody, { status, headers }));
          return;
        }
        resolve(new Response(stream, { status, headers }));
      };

      active.onClose = (error) => finish(error);
      active.onEvent = (event) => {
        if (finished) return;
        const type = typeof event.type === "string" ? event.type : "";
        if (type === RATE_LIMITS_EVENT) {
          if (!started)
            for (const [name, value] of codexRateLimitHeaders(event)) headers.set(name, value);
          return;
        }
        if (type === METADATA_EVENT) {
          if (!started)
            for (const [name, value] of metadataHeaders(event)) headers.set(name, value);
          return;
        }
        if (type === TIMING_EVENT) return;
        if (!started && type === "error" && typeof event.status === "number") {
          // The SSE endpoint answers a refused request with an HTTP error and a
          // JSON body; keep that shape so limits and auth stay classified.
          for (const [name, value] of metadataHeaders(event)) headers.set(name, value);
          const status = event.status >= 400 && event.status < 600 ? event.status : 500;
          begin(status, JSON.stringify({ error: event.error ?? null }));
          // The connection stays usable after a refused request.
          finished = true;
          signal?.removeEventListener("abort", onAbort);
          release(active);
          return;
        }
        if (!started) begin();
        const block = sseBlock(event);
        if (controller) controller.enqueue(block);
        else pending.push(block);
        if (TERMINAL_EVENTS.has(type)) finish();
      };

      try {
        const packet = JSON.stringify({ ...payload, type: "response.create" });
        // Observe the actual packet, not the HTTP-shaped input before type is added.
        // Diagnostic failures never change dispatch, retry or cancellation.
        try {
          (init as CodexPhysicalRequestInit | undefined)?.[
            CODEX_PHYSICAL_REQUEST
          ]?.onWebSocketPacket?.(packet);
        } catch {
          /* observational */
        }
        active.socket.send(packet);
      } catch (error) {
        finish(error);
      }
    });
  };
}
