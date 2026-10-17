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

export const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";

/**
 * Response header naming how this transport carried a Responses request, so
 * the request audit can report it per request. Read with
 * {@link parseCodexRequestTransport}.
 */
export const CODEX_TRANSPORT_HEADER = "x-opengeni-codex-transport";

/**
 * How one Codex Responses request was carried. A WebSocket request either
 * opened its connection or reused a warm one, and sent either its full input
 * or only the items after the previous response on that connection (see
 * {@link continuationInput}). An HTTP request names why the
 * socket did not carry it: the request was not a streaming Responses POST, the
 * conversation's connection was busy with another request, a recent handshake
 * failed (backoff), this handshake failed, or the conversation's connection
 * dropped mid-response repeatedly (`stream_dropped`, after which the
 * conversation stays on HTTP for a while). `unavailable` means no socket
 * transport was in the path at all (disabled, or a runtime without
 * header-capable WebSockets).
 */
export type CodexRequestTransport =
  | {
      kind: "websocket";
      connection: "new" | "reused";
      input: "full" | "incremental";
      /** Milliseconds this request waited for its new connection's handshake. */
      handshakeMs?: number;
    }
  | {
      kind: "http";
      reason:
        | "not_eligible"
        | "connection_busy"
        | "handshake_backoff"
        | "handshake_failed"
        | "stream_dropped"
        | "unavailable";
    };

const HTTP_REASONS = new Set([
  "not_eligible",
  "connection_busy",
  "handshake_backoff",
  "handshake_failed",
  "stream_dropped",
  "unavailable",
]);

export function formatCodexRequestTransport(transport: CodexRequestTransport): string {
  if (transport.kind === "http") return `http; reason=${transport.reason}`;
  const base = `websocket; connection=${transport.connection}; input=${transport.input}`;
  return transport.handshakeMs === undefined
    ? base
    : `${base}; handshake_ms=${Math.max(0, Math.round(transport.handshakeMs))}`;
}

/** The transport a response was carried over; null when it does not say. */
export function parseCodexRequestTransport(
  value: string | null | undefined,
): CodexRequestTransport | null {
  if (!value) return null;
  const [kind, ...parameters] = value.split(";").map((part) => part.trim());
  const fields = new Map(
    parameters.map((parameter) => {
      const index = parameter.indexOf("=");
      return [parameter.slice(0, index), parameter.slice(index + 1)] as const;
    }),
  );
  if (kind === "websocket") {
    const connection = fields.get("connection");
    const input = fields.get("input") ?? "full";
    if (connection !== "new" && connection !== "reused") return null;
    if (input !== "full" && input !== "incremental") return null;
    const handshakeMs = Number(fields.get("handshake_ms") ?? Number.NaN);
    return Number.isFinite(handshakeMs) && handshakeMs >= 0
      ? { kind: "websocket", connection, input, handshakeMs }
      : { kind: "websocket", connection, input };
  }
  if (kind === "http") {
    const reason = fields.get("reason");
    return reason && HTTP_REASONS.has(reason)
      ? {
          kind: "http",
          reason: reason as Extract<CodexRequestTransport, { kind: "http" }>["reason"],
        }
      : null;
  }
  return null;
}

/** The same response, labelled with how it was carried. */
function withTransport(response: Response, transport: CodexRequestTransport): Response {
  const value = formatCodexRequestTransport(transport);
  try {
    response.headers.set(CODEX_TRANSPORT_HEADER, value);
    return response;
  } catch {
    // A fetch response's headers can be immutable; carry the same body.
    const headers = new Headers(response.headers);
    headers.set(CODEX_TRANSPORT_HEADER, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

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
  /** After repeated mid-response drops, use HTTP for this conversation for this long. */
  dropFallbackMs?: number;
  now?: () => number;
};

const DEFAULT_IDLE_MS = 5 * 60_000;
// The backend retires connections after about an hour; never start a request
// on one that could be closed underneath it.
const DEFAULT_MAX_AGE_MS = 45 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HANDSHAKE_BACKOFF_MS = 5 * 60_000;
// Like the Codex CLI, a conversation whose socket keeps dropping mid-response
// falls back to HTTP: after this many drops close together it uses HTTP for
// DEFAULT_DROP_FALLBACK_MS. A completed response clears the count.
const DROPS_BEFORE_HTTP = 2;
const DROP_WINDOW_MS = 10 * 60_000;
const DEFAULT_DROP_FALLBACK_MS = 30 * 60_000;

// Per-request headers stay off the shared handshake: they would split every
// request onto its own connection, and the WebSocket protocol has no
// per-message equivalent the backend reads. The model SDK's own client
// telemetry headers (x-stainless-*) are not sent either, so a connection opened
// ahead of the first request has the same identity as the request itself.
const PER_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "idempotency-key",
  "openai-beta",
]);

function isPerRequestHeader(name: string): boolean {
  return PER_REQUEST_HEADERS.has(name) || name.startsWith("x-stainless-");
}

const CODEX_RESPONSES_URL = /^https:\/\/[^/]+\/.*\/codex\/responses(?:\?|$)/;

/**
 * A Codex Responses FetchLike that can also open a conversation's connection
 * before its first request. `warm` takes the URL and headers that request will
 * carry; it never throws, and the request reuses the connection (or waits for
 * its handshake to finish) instead of opening its own.
 */
export type CodexResponsesTransport = FetchLike & {
  warm(url: string, headers: HeadersInit): void;
};

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

/**
 * The last completed response on a connection, which the backend keeps so the
 * next request may continue it with `previous_response_id` (even with
 * `store: false`) and send only its new input items.
 */
type ResponseChain = {
  /** Every request field except `input`, canonically encoded. */
  shape: string;
  /** The full input that request carried, one canonical encoding per item. */
  input: string[];
  /** The response's output items, as the model sees them. */
  output: string[];
  responseId: string;
};

const CONTINUATION_EXCLUDED_FIELDS = new Set(["input", "previous_response_id", "type"]);

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function requestShape(payload: Record<string, unknown>): string {
  return canonicalJson(
    Object.fromEntries(
      Object.entries(payload).filter(([key]) => !CONTINUATION_EXCLUDED_FIELDS.has(key)),
    ),
  );
}

/**
 * An output item as the model sees it, so the backend's copy and the one the
 * client sends back compare equal. Item ids, completion status, empty or null
 * fields and output-text annotations and logprobs carry nothing the model
 * reads; every other field (text, arguments, call ids, encrypted reasoning)
 * must match exactly.
 */
function modelVisibleItem(item: unknown): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return canonicalJson(item);
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (key === "id" || key === "status") continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    visible[key] =
      key === "content" && Array.isArray(value)
        ? value.map((part) => {
            if (!part || typeof part !== "object" || Array.isArray(part)) return part;
            const {
              annotations: _annotations,
              logprobs: _logprobs,
              ...rest
            } = part as Record<string, unknown>;
            return rest;
          })
        : value;
  }
  return canonicalJson(visible);
}

/**
 * The input items a request adds after the previous response on its
 * connection, or null when it does not continue that response exactly: the
 * same request fields, the previous input unchanged, then the previous
 * response's output as the model saw it, then at least one new item.
 */
export function continuationInput(
  chain: Pick<ResponseChain, "shape" | "input" | "output">,
  payload: Record<string, unknown>,
  input: readonly string[],
): number | null {
  if (requestShape(payload) !== chain.shape) return null;
  const items = payload.input as unknown[];
  const continued = chain.input.length + chain.output.length;
  if (items.length <= continued) return null;
  for (let index = 0; index < chain.input.length; index += 1) {
    if (input[index] !== chain.input[index]) return null;
  }
  for (let index = 0; index < chain.output.length; index += 1) {
    if (modelVisibleItem(items[chain.input.length + index]) !== chain.output[index]) return null;
  }
  return continued;
}

/** The backend no longer holds the response a continuation named. */
function previousResponseRefused(event: Record<string, unknown>): boolean {
  if (event.status !== 400) return false;
  const error = event.error;
  if (!error || typeof error !== "object") return false;
  const { code, param, message } = error as Record<string, unknown>;
  return (
    param === "previous_response_id" ||
    code === "previous_response_not_found" ||
    (typeof message === "string" && message.includes("previous_response_id"))
  );
}

type Connection = {
  key: string;
  socket: CodexWebSocketLike;
  openedAt: number;
  busy: boolean;
  closed: boolean;
  /** Requests this connection has started carrying. */
  requests: number;
  /** Opened ahead of its first request by {@link CodexResponsesTransport.warm}. */
  warmed: boolean;
  /** The response the next request may continue; null after anything else. */
  chain: ResponseChain | null;
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
/**
 * The request body as text when it is a complete JSON body the socket can
 * carry (a string, bytes, or the client's replayable stream). Anything else,
 * such as form data, stays on HTTP untouched.
 */
async function requestBodyText(body: RequestInit["body"] | undefined): Promise<string | null> {
  if (typeof body === "string") return body;
  if (
    body instanceof ReadableStream ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof Blob
  ) {
    return await new Response(body).text();
  }
  return null;
}

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
): CodexResponsesTransport {
  const createSocket =
    options.createSocket === undefined ? bunWebSocketFactory() : options.createSocket;
  if (!createSocket) {
    return Object.assign((input: string | URL | Request, init?: RequestInit) => http(input, init), {
      warm: () => undefined,
    });
  }
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const handshakeBackoffMs = options.handshakeBackoffMs ?? DEFAULT_HANDSHAKE_BACKOFF_MS;
  const dropFallbackMs = options.dropFallbackMs ?? DEFAULT_DROP_FALLBACK_MS;
  const now = options.now ?? Date.now;
  const pool = new Map<string, Connection>();
  const backoffUntil = new Map<string, number>();
  const recentDrops = new Map<string, { count: number; at: number }>();
  const httpAfterDropsUntil = new Map<string, number>();
  const recordDrop = (key: string) => {
    const previous = recentDrops.get(key);
    const count = previous && now() - previous.at < DROP_WINDOW_MS ? previous.count + 1 : 1;
    if (count >= DROPS_BEFORE_HTTP) {
      recentDrops.delete(key);
      httpAfterDropsUntil.set(key, now() + dropFallbackMs);
    } else {
      recentDrops.set(key, { count, at: now() });
    }
  };
  const droppedRecently = (key: string) => (httpAfterDropsUntil.get(key) ?? 0) > now();
  // Handshakes started by `warm`, keyed like the pool, until they settle.
  const warming = new Map<string, Promise<Connection | null>>();

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
        requests: 0,
        warmed: false,
        chain: null,
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

  const identity = (url: string, headers: HeadersInit | undefined) => {
    const handshake: Record<string, string> = {};
    for (const [name, value] of new Headers(headers).entries()) {
      if (!isPerRequestHeader(name)) handshake[name] = value;
    }
    handshake["openai-beta"] = CODEX_RESPONSES_WEBSOCKET_BETA;
    const wsUrl = url.replace(/^https:/, "wss:");
    return { wsUrl, handshake, key: JSON.stringify([wsUrl, Object.entries(handshake).sort()]) };
  };

  // The pooled connection a request may start on, retiring one that closed or
  // aged out.
  const pooled = (key: string): Connection | undefined => {
    const connection = pool.get(key);
    if (connection && (connection.closed || now() - connection.openedAt > maxAgeMs)) {
      if (!connection.busy) retire(connection);
      return undefined;
    }
    return connection;
  };

  const warm = (url: string, headers: HeadersInit): void => {
    try {
      if (!CODEX_RESPONSES_URL.test(url)) return;
      const { wsUrl, handshake, key } = identity(url, headers);
      if (
        (backoffUntil.get(key) ?? 0) > now() ||
        droppedRecently(key) ||
        pooled(key) ||
        warming.has(key)
      )
        return;
      const opening = connect(wsUrl, key, handshake).then(
        (connection) => {
          const existing = pooled(key);
          if (existing) {
            // A request opened this conversation's connection first.
            retire(connection);
            return existing;
          }
          connection.warmed = true;
          pool.set(key, connection);
          release(connection);
          return connection;
        },
        () => {
          backoffUntil.set(key, now() + handshakeBackoffMs);
          return null;
        },
      );
      warming.set(key, opening);
      void opening.finally(() => {
        if (warming.get(key) === opening) warming.delete(key);
      });
    } catch {
      // Warming is an optimization; the request opens its own connection.
    }
  };

  const send = async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    if (!url || method !== "POST" || !CODEX_RESPONSES_URL.test(url)) {
      return await http(input, init);
    }
    // The model client streams its JSON body so it can be sent again; a socket
    // message needs the whole text, and once read the HTTP fallback sends that
    // same text.
    const text = await requestBodyText(body);
    const httpInit = text === null || typeof body === "string" ? init : { ...init, body: text };
    const viaHttp = async (
      reason: Extract<CodexRequestTransport, { kind: "http" }>["reason"],
    ): Promise<Response> => withTransport(await http(input, httpInit), { kind: "http", reason });
    if (text === null) return await viaHttp("not_eligible");
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      return await viaHttp("not_eligible");
    }
    if (payload.stream !== true) return await viaHttp("not_eligible");

    const { wsUrl, handshake, key } = identity(url, init?.headers);
    let handshakeMs: number | undefined;
    const opening = warming.get(key);
    if (opening && !pool.has(key)) {
      // This conversation's connection is already being opened; wait for it
      // rather than racing a second handshake.
      const waitStartedAt = now();
      const warmed = await opening;
      if (!warmed) return await viaHttp("handshake_failed");
      handshakeMs = now() - waitStartedAt;
    }
    if ((backoffUntil.get(key) ?? 0) > now()) return await viaHttp("handshake_backoff");
    if (droppedRecently(key)) return await viaHttp("stream_dropped");

    const signal = init?.signal ?? null;
    signal?.throwIfAborted();
    let connection = pooled(key);
    if (connection?.busy) return await viaHttp("connection_busy");
    if (connection?.warmed && connection.requests === 0) {
      // The first request on a connection opened ahead of it waited only for
      // whatever of the handshake was still left.
      handshakeMs ??= 0;
    } else if (connection) {
      handshakeMs = undefined;
    }
    if (!connection) {
      const handshakeStartedAt = now();
      try {
        connection = await connect(wsUrl, key, handshake);
        handshakeMs = now() - handshakeStartedAt;
      } catch {
        backoffUntil.set(key, now() + handshakeBackoffMs);
        return await viaHttp("handshake_failed");
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
      if (connection.busy) return await viaHttp("connection_busy");
    }
    const active = connection;
    // Continue the connection's previous response when this request extends
    // it exactly; otherwise send the full request. Either way the chain is
    // consumed here and only a completed response re-establishes it.
    const fullInput = Array.isArray(payload.input) ? (payload.input as unknown[]) : null;
    const inputKeys = fullInput?.map(canonicalJson) ?? null;
    const chain = active.chain;
    active.chain = null;
    const continued =
      chain && fullInput && inputKeys ? continuationInput(chain, payload, inputKeys) : null;
    const transport: Extract<CodexRequestTransport, { kind: "websocket" }> = {
      kind: "websocket",
      connection: active.requests === 0 ? "new" : "reused",
      input: continued === null ? "full" : "incremental",
      // Only the request that waited for this handshake reports it; a request
      // that joined a connection another request opened waited for none.
      ...(handshakeMs !== undefined && connection.requests === 0 ? { handshakeMs } : {}),
    };
    active.requests += 1;
    active.busy = true;
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = null;

    return await new Promise<Response>((resolve, reject) => {
      const headers = new Headers({ "content-type": "text/event-stream" });
      const output: unknown[] = [];
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
        recentDrops.delete(key);
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
        headers.set(CODEX_TRANSPORT_HEADER, formatCodexRequestTransport(transport));
        if (errorBody !== undefined) {
          headers.set("content-type", "application/json");
          resolve(new Response(errorBody, { status, headers }));
          return;
        }
        resolve(new Response(stream, { status, headers }));
      };

      const sendMessage = (message: Record<string, unknown>) => {
        try {
          active.socket.send(JSON.stringify({ ...message, type: "response.create" }));
        } catch (error) {
          finish(error);
        }
      };

      active.onClose = (error) => {
        // The socket closed while this response was still streaming.
        if (!finished) recordDrop(key);
        finish(error);
      };
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
        if (
          !started &&
          type === "error" &&
          transport.input === "incremental" &&
          previousResponseRefused(event)
        ) {
          // The backend no longer holds the previous response; nothing has
          // reached the caller yet, so send the full request on this socket.
          transport.input = "full";
          sendMessage(payload);
          return;
        }
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
        if (type === "response.output_item.done" && event.item !== undefined) {
          output.push(event.item);
        }
        if ((type === "response.completed" || type === "response.done") && fullInput && inputKeys) {
          const response = event.response as Record<string, unknown> | undefined;
          if (response && typeof response.id === "string" && response.id) {
            active.chain = {
              shape: requestShape(payload),
              input: inputKeys,
              output: output.map(modelVisibleItem),
              responseId: response.id,
            };
          }
        }
        const block = sseBlock(event);
        if (controller) controller.enqueue(block);
        else pending.push(block);
        if (TERMINAL_EVENTS.has(type)) finish();
      };

      sendMessage(
        continued === null || !fullInput || !chain
          ? payload
          : {
              ...payload,
              previous_response_id: chain.responseId,
              input: fullInput.slice(continued),
            },
      );
    });
  };
  return Object.assign(send, { warm });
}
