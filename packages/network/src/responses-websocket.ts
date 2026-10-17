// Shared persistent Responses transport. Provider adapters supply endpoint,
// authentication headers and metadata framing; pooling, continuation, lifecycle,
// failure evidence and diagnostics are identical for every adapter.
// HTTP keeps its existing connection reuse when a socket cannot carry a call.

import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FetchLike } from "./index";

// Capture the module's bootstrap context, not a chat request. Socket I/O and
// idle timers outlive turns and must not pin the opener's execution context.
const inConnectionScope = AsyncResource.bind(<T>(operation: () => T): T => operation());

/**
 * Response header naming how this transport carried a Responses request, so
 * the request audit can report it per request. Read with
 * {@link parseModelRequestTransport}.
 */
export const MODEL_TRANSPORT_HEADER = "x-opengeni-model-transport";
export const MODEL_SOCKET_FAILURE_HEADER = "x-opengeni-model-socket-failure";

/**
 * How one Responses request was carried. A WebSocket request either
 * opened its connection or reused a warm one, and sent either its full input
 * or only the items after the previous response on that connection (see
 * {@link continuationInput}). An HTTP request names why the
 * socket did not carry it: the request was not a streaming Responses POST, the
 * conversation's connection was busy, the server refused the handshake, or
 * the durable step owner selected HTTP for the rest of this turn. There are
 * no fallback cooldowns. `stream_dropped` remains readable for older receipts.
 * `unavailable` means no socket transport was installed.
 */
export type ModelRequestTransport =
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
        | "turn_fallback"
        | "handshake_failed"
        | "stream_dropped"
        | "unavailable";
    };

const HTTP_REASONS = new Set([
  "not_eligible",
  "connection_busy",
  "turn_fallback",
  "handshake_failed",
  "stream_dropped",
  "unavailable",
]);

export function formatModelRequestTransport(transport: ModelRequestTransport): string {
  if (transport.kind === "http") return `http; reason=${transport.reason}`;
  const base = `websocket; connection=${transport.connection}; input=${transport.input}`;
  return transport.handshakeMs === undefined
    ? base
    : `${base}; handshake_ms=${Math.max(0, Math.round(transport.handshakeMs))}`;
}

/** The transport a response was carried over; null when it does not say. */
export function parseModelRequestTransport(
  value: string | null | undefined,
): ModelRequestTransport | null {
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
          reason: reason as Extract<ModelRequestTransport, { kind: "http" }>["reason"],
        }
      : null;
  }
  return null;
}

/** The same response, labelled with how it was carried. */
function withTransport(response: Response, transport: ModelRequestTransport): Response {
  const value = formatModelRequestTransport(transport);
  try {
    response.headers.set(MODEL_TRANSPORT_HEADER, value);
    return response;
  } catch {
    // A fetch response's headers can be immutable; carry the same body.
    const headers = new Headers(response.headers);
    headers.set(MODEL_TRANSPORT_HEADER, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** The subset of the WHATWG/Bun WebSocket this transport uses. */
export type ModelWebSocketLike = {
  readonly readyState: number;
  readonly handshakeStatus?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

export type ModelWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => ModelWebSocketLike;

export type ResponsesTransportOptions = {
  /** Opens a WebSocket with handshake headers; absent means HTTP only. */
  createSocket?: ModelWebSocketFactory | null;
  /** Close a connection that has carried no request for this long. */
  idleMs?: number;
  /** Never start a request on a connection older than this. */
  maxAgeMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  /** Provider framing and endpoint identity; lifecycle policy is shared. */
  endpoint: ResponsesWebSocketEndpoint;
};

const DEFAULT_IDLE_MS = 5 * 60_000;
// The backend retires connections after about an hour; never start a request
// on one that could be closed underneath it.
const DEFAULT_MAX_AGE_MS = 45 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

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

/**
 * A Responses endpoint that also accepts WebSocket mode, and what its
 * handshake and `response.create` messages need.
 */
export type ResponsesWebSocketEndpoint = {
  /** Names the provider in transport errors, for example "Codex". */
  label: string;
  /** Streaming POSTs to matching URLs may be carried over the socket. */
  url: RegExp;
  /** `OpenAI-Beta` value the handshake carries, when the endpoint needs one. */
  beta?: string;
  /** HTTP-only body fields left out of `response.create` (WebSocket mode always streams). */
  httpOnlyFields?: readonly string[];
  /**
   * Give each conversation (see {@link withResponsesConversation}) its own
   * connection, and leave requests outside a conversation on HTTP. Needed
   * where nothing in the request headers already tells conversations apart;
   * the Codex backend's headers carry the session id.
   */
  conversationScoped?: boolean;
  /** Connection-level framing that projects provider metadata into HTTP headers. */
  eventHeaders?: (event: Record<string, unknown>) => Array<[string, string]> | null;
};

/**
 * The OpenAI API (`/v1/responses`) and Azure OpenAI's v1 API
 * (`/openai/v1/responses`). Other OpenAI-compatible hosts (gateways, local
 * servers) are not assumed to support WebSocket mode and stay on HTTP.
 */
export const OPENAI_RESPONSES_WEBSOCKET_ENDPOINT: ResponsesWebSocketEndpoint = {
  label: "OpenAI",
  url: /^https:\/\/(?:api\.openai\.com\/v1|[a-z0-9-]+\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)\/openai\/v1)\/responses(?:\?|$)/i,
  httpOnlyFields: ["stream", "background"],
  conversationScoped: true,
};

export type ResponsesTransportDiagnostic = {
  phase: "prefix_ready_to_send" | "send" | "handshake" | "headers" | "terminal";
  position: "first" | "later";
  transport: ModelRequestTransport;
  durationMs: number;
  outcome?: "completed" | "failed";
  inputBytes?: number;
  fullInputBytes?: number;
  promptTokens?: number;
  cachedTokens?: number;
};
type ResponsesTurn = {
  conversationId: string;
  requests: number;
  readyAt?: number;
  observe?: (event: ResponsesTransportDiagnostic) => void;
  httpOnly: boolean;
  onFallback?: () => void | Promise<void>;
  fallbackWrite?: Promise<void>;
};
const responsesConversation = new AsyncLocalStorage<ResponsesTurn>();
export function hasResponsesTurn(): boolean {
  return responsesConversation.getStore() !== undefined;
}
const continuationAdmission = new AsyncLocalStorage<(signal: AbortSignal) => Promise<void>>();
const dispatchObservation = new AsyncLocalStorage<(transport: ModelRequestTransport) => void>();

export function withModelTransportObservation<T>(
  observe: (transport: ModelRequestTransport) => void,
  fn: () => T,
): T {
  return dispatchObservation.run(observe, fn);
}

/** Preserve timeout classification while retaining the selected socket route. */
export function markModelSocketFailure(error: Error): void {
  if (isModelSocketTransportError(error)) return;
  const cause = new ModelSocketTransportError(
    "Persistent model socket did not complete",
    "response",
  );
  cause.cause = error.cause;
  error.cause = cause;
}

/** The custody owner settles a definitive continuation refusal and admits the
 * replacement physical request. No second request bypasses that boundary. */
export function withResponsesContinuationAdmission<T>(
  admit: (signal: AbortSignal) => Promise<void>,
  fn: () => T,
): T {
  // A provider custody owner outside the generic checkpoint wrapper remains
  // responsible for settlement and re-admission of the physical request.
  if (continuationAdmission.getStore()) return fn();
  return continuationAdmission.run(admit, fn);
}

/** One object per accepted turn, reused across all its model calls. */
export function createResponsesTurn(
  conversationId: string,
  observe?: ResponsesTurn["observe"],
  policy: { httpOnly?: boolean; onFallback?: () => void | Promise<void> } = {},
): ResponsesTurn {
  return {
    conversationId,
    requests: 0,
    httpOnly: policy.httpOnly ?? false,
    ...(policy.onFallback ? { onFallback: policy.onFallback } : {}),
    ...(observe ? { observe } : {}),
  };
}

/** A dropped transport, not a provider terminal. The durable model-step owner
 * decides whether to replay it; this layer never concatenates partial responses. */
export class ModelSocketTransportError extends Error {
  readonly status = 503;
  constructor(
    message: string,
    readonly phase: "handshake" | "response",
    readonly refused = false,
  ) {
    super(message);
    this.name = "ModelSocketTransportError";
  }
}

export function isModelSocketTransportError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    if (error instanceof ModelSocketTransportError) return true;
    const headers = (error as { headers?: Headers }).headers;
    if (headers instanceof Headers && headers.get(MODEL_SOCKET_FAILURE_HEADER) === "1") return true;
    seen.add(error);
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

/** Instructions/tools have their final provider-normalized shape at this point. */
export function markResponsesPrefixReady(): void {
  const turn = responsesConversation.getStore();
  if (turn) turn.readyAt = performance.now();
}

/**
 * Run `fn` as part of one conversation, so its Responses requests share that
 * conversation's WebSocket connection (and can continue its previous response)
 * without sharing it with other conversations.
 */
export function withResponsesConversation<T>(
  conversation: string | ResponsesTurn | undefined,
  fn: () => T,
): T {
  return conversation
    ? responsesConversation.run(
        typeof conversation === "string" ? createResponsesTurn(conversation) : conversation,
        fn,
      )
    : fn();
}

/**
 * A Responses FetchLike that can also open a conversation's connection before
 * its first request. `warm` takes the URL and headers that request will carry;
 * it never throws, and the request reuses the connection (or waits for its
 * handshake to finish) instead of opening its own.
 */
export type ResponsesTransport = FetchLike & {
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
const TIMING_EVENT = "responsesapi.websocket_timing";

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The last completed response on a connection, which the backend keeps so the
 * next request may continue it with `previous_response_id` (even with
 * `store: false`) and send only its new input items.
 */
type ResponseChain = {
  /** SHA-256 of every request field except `input`. */
  shape: string;
  /** One SHA-256 per input item; never retain prompt bodies on idle sockets. */
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
  return fingerprint(
    Object.fromEntries(
      Object.entries(payload).filter(([key]) => !CONTINUATION_EXCLUDED_FIELDS.has(key)),
    ),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64");
}

/**
 * Recognize only demonstrated SDK round-trip equivalences. Unknown item types
 * and fields compare exactly; a missed optimization is preferable to changing
 * model context. In particular phase and hosted-call status remain significant.
 */
function modelVisibleItem(item: unknown): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return fingerprint(item);
  const type = (item as Record<string, unknown>).type;
  if (type !== "message" && type !== "function_call" && type !== "reasoning")
    return fingerprint(item);
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (key === "id") continue;
    if (key === "status" && value === "completed") continue;
    if (key === "summary" && type === "reasoning" && Array.isArray(value) && value.length === 0)
      continue;
    visible[key] =
      key === "content" && Array.isArray(value)
        ? value.map((part) => {
            if (!part || typeof part !== "object" || Array.isArray(part)) return part;
            const rest = { ...part } as Record<string, unknown>;
            if (rest.type !== "output_text") return part;
            for (const field of ["annotations", "logprobs"]) {
              if (Array.isArray(rest[field]) && rest[field].length === 0) delete rest[field];
            }
            return rest;
          })
        : value;
  }
  return fingerprint(visible);
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
  if (payload.previous_response_id != null || payload.conversation != null) return null;
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
  slot: string;
  socket: ModelWebSocketLike;
  openedAt: number;
  busy: boolean;
  closed: boolean;
  /** Requests this connection has started carrying. */
  requests: number;
  /** Opened ahead of its first request by {@link ResponsesTransport.warm}. */
  warmed: boolean;
  /** The response the next request may continue; null after anything else. */
  chain: ResponseChain | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Receives every message while a request is in flight. */
  onEvent: ((event: Record<string, unknown>) => void) | null;
  /** Receives the close of the socket while a request is in flight. */
  onClose: ((reason: Error) => void) | null;
};

export function nodeWebSocketFactory(): ModelWebSocketFactory {
  // An explicit package file bypasses Bun's built-in `ws` shim. Its native
  // socket retains the largest sent frame for the lifetime of the connection.
  // The JS implementation releases sent frames after the TCP write drains.
  const require = createRequire(import.meta.url);
  const Socket = require(
    join(dirname(require.resolve("ws/package.json")), "index.js"),
  ) as typeof import("ws").WebSocket;
  return (url, headers) => {
    const socket = new Socket(url, { headers, perMessageDeflate: false });
    socket.on("unexpected-response", (_request, response) => {
      Object.defineProperty(socket, "handshakeStatus", { value: response.statusCode });
      response.resume();
      socket.terminate();
    });
    return socket as unknown as ModelWebSocketLike;
  };
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

export function metadataHeaders(event: Record<string, unknown>): Array<[string, string]> {
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

async function waitForConnection<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function responsesTransport(
  http: FetchLike,
  options: ResponsesTransportOptions,
): ResponsesTransport {
  const createSocket =
    options.createSocket === undefined ? nodeWebSocketFactory() : options.createSocket;
  if (!createSocket) {
    return Object.assign((input: string | URL | Request, init?: RequestInit) => http(input, init), {
      warm: () => undefined,
    });
  }
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const endpoint = options.endpoint;
  const pool = new Map<string, Connection>();
  const slots = new Map<string, string>();
  // Every opener joins the same handshake, including simultaneous cold calls.
  const warming = new Map<string, Promise<Connection>>();

  const retire = (connection: Connection) => {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    connection.chain = null;
    connection.onEvent = null;
    connection.onClose = null;
    if (pool.get(connection.key) === connection) {
      pool.delete(connection.key);
      if (slots.get(connection.slot) === connection.key) slots.delete(connection.slot);
    }
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
    connection.idleTimer = inConnectionScope(() => setTimeout(() => retire(connection), idleMs));
    (connection.idleTimer as { unref?: () => void }).unref?.();
  };

  const connect = (url: string, key: string, slot: string, headers: Record<string, string>) =>
    inConnectionScope(
      () =>
        new Promise<Connection>((resolve, reject) => {
          let socket: ModelWebSocketLike;
          try {
            socket = createSocket(url, headers);
          } catch {
            reject(
              new ModelSocketTransportError(
                `${endpoint.label} response WebSocket could not open`,
                "handshake",
              ),
            );
            return;
          }
          const connection: Connection = {
            key,
            slot,
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
            reject(
              new ModelSocketTransportError(
                `${endpoint.label} response WebSocket handshake timed out`,
                "handshake",
              ),
            );
          }, connectTimeoutMs);
          socket.onopen = () => {
            if (connection.closed) {
              socket.close();
              return;
            }
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
            if (pool.get(key) === connection) {
              pool.delete(key);
              if (slots.get(slot) === key) slots.delete(slot);
            }
            if (connection.idleTimer) clearTimeout(connection.idleTimer);
            if (!opened) {
              reject(
                new ModelSocketTransportError(
                  `${endpoint.label} response WebSocket handshake failed (${event?.code ?? "closed"})`,
                  "handshake",
                  socket.handshakeStatus !== undefined &&
                    socket.handshakeStatus >= 400 &&
                    socket.handshakeStatus < 500 &&
                    socket.handshakeStatus !== 429,
                ),
              );
              return;
            }
            const onClose = connection.onClose;
            connection.chain = null;
            connection.onEvent = null;
            connection.onClose = null;
            onClose?.(
              new ModelSocketTransportError(
                `${endpoint.label} response WebSocket closed before the response finished (${event?.code ?? "closed"})`,
                "response",
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
        }),
    );

  const identity = (url: string, headers: HeadersInit | undefined) => {
    const handshake: Record<string, string> = {};
    for (const [name, value] of new Headers(headers).entries()) {
      if (!isPerRequestHeader(name)) handshake[name] = value;
    }
    if (endpoint.beta) handshake["openai-beta"] = endpoint.beta;
    const wsUrl = url.replace(/^https:/, "wss:");
    const conversation = responsesConversation.getStore()?.conversationId ?? handshake.session_id;
    if (endpoint.conversationScoped && !conversation) return null;
    return {
      wsUrl,
      handshake,
      slot: fingerprint([wsUrl, conversation ?? Object.entries(handshake).sort()]),
      key: fingerprint([
        wsUrl,
        Object.entries(handshake).sort(),
        ...(conversation ? [conversation] : []),
      ]),
    };
  };

  // The pooled connection a request may start on, retiring one that closed or
  // aged out.
  const pooled = (key: string): Connection | undefined => {
    const connection = pool.get(key);
    if (connection?.busy) return connection;
    if (connection && (connection.closed || now() - connection.openedAt > maxAgeMs)) {
      if (!connection.busy) retire(connection);
      return undefined;
    }
    return connection;
  };

  const open = (target: NonNullable<ReturnType<typeof identity>>, warmed: boolean) => {
    const { wsUrl, key, slot, handshake } = target;
    const pending = warming.get(key);
    if (pending) return pending;
    slots.set(slot, key);
    const turn = responsesConversation.getStore();
    const opening = connect(wsUrl, key, slot, handshake).then(
      (connection) => {
        if (connection.closed) {
          if (slots.get(slot) === key) slots.delete(slot);
          throw new ModelSocketTransportError(
            `${endpoint.label} response WebSocket closed during handshake`,
            "handshake",
          );
        }
        connection.warmed = warmed;
        pool.set(key, connection);
        release(connection);
        return connection;
      },
      async (error) => {
        if (slots.get(slot) === key) slots.delete(slot);
        if (error instanceof ModelSocketTransportError && error.refused && turn) {
          turn.httpOnly = true;
          turn.fallbackWrite ??= Promise.resolve().then(() => turn.onFallback?.());
          await turn.fallbackWrite;
        }
        throw error;
      },
    );
    warming.set(key, opening);
    void opening
      .finally(() => {
        if (warming.get(key) === opening) warming.delete(key);
      })
      .catch(() => undefined);
    return opening;
  };

  const prepareSlot = (target: NonNullable<ReturnType<typeof identity>>) => {
    const previous = slots.get(target.slot);
    if (previous && previous !== target.key) {
      const connection = pool.get(previous);
      if (connection?.busy || warming.has(previous)) return false;
      if (connection) retire(connection);
    }
    return true;
  };

  const warm = (url: string, headers: HeadersInit): void => {
    try {
      if (!endpoint.url.test(url)) return;
      const target = identity(url, headers);
      if (!target) return;
      if (!prepareSlot(target)) return;
      const { key } = target;
      if (responsesConversation.getStore()?.httpOnly || pooled(key) || warming.has(key)) return;
      void open(target, true).catch(() => undefined);
    } catch {
      // Warming is an optimization; the request opens its own connection.
    }
  };

  const send = async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    signal?.throwIfAborted();
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    if (!url || method !== "POST" || !endpoint.url.test(url)) {
      return await http(input, init);
    }
    const turn = responsesConversation.getStore();
    const position = turn && turn.requests++ === 0 ? "first" : "later";
    const startedAt = performance.now();
    const observe = (event: Omit<ResponsesTransportDiagnostic, "position">) => {
      try {
        turn?.observe?.({ ...event, position });
      } catch {
        /* Observation never gates dispatch. */
      }
    };
    // The model client streams its JSON body so it can be sent again; a socket
    // message needs the whole text, and once read the HTTP fallback sends that
    // same text.
    const text = await requestBodyText(body);
    const httpInit = text === null || typeof body === "string" ? init : { ...init, body: text };
    const viaHttp = async (
      reason: Extract<ModelRequestTransport, { kind: "http" }>["reason"],
    ): Promise<Response> => {
      const transport = { kind: "http", reason } as const;
      await turn?.fallbackWrite;
      dispatchObservation.getStore()?.(transport);
      let response: Response;
      try {
        response = withTransport(await http(input, httpInit), transport);
      } catch (error) {
        observe({
          phase: "terminal",
          transport,
          durationMs: performance.now() - startedAt,
          outcome: "failed",
        });
        throw error;
      }
      observe({ phase: "headers", transport, durationMs: performance.now() - startedAt });
      if (!turn?.observe || !response.body) return response;
      const reader = response.body.getReader();
      let settled = false;
      const settle = (outcome: "completed" | "failed") => {
        if (settled) return;
        settled = true;
        observe({
          phase: "terminal",
          transport,
          durationMs: performance.now() - startedAt,
          outcome,
        });
      };
      return new Response(
        new ReadableStream({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                settle(response.ok ? "completed" : "failed");
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) {
              settle("failed");
              reader.releaseLock();
              controller.error(error);
            }
          },
          async cancel(cancelReason) {
            settle("failed");
            try {
              await reader.cancel(cancelReason);
            } finally {
              reader.releaseLock();
            }
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    };
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

    const target = identity(url, init?.headers);
    if (!target) return await viaHttp("not_eligible");
    if (turn?.httpOnly) return await viaHttp("turn_fallback");
    if (!prepareSlot(target)) return await viaHttp("connection_busy");
    const { key } = target;
    let handshakeMs: number | undefined;
    const opening = warming.get(key);
    if (opening && !pool.has(key)) {
      // This conversation's connection is already being opened; wait for it
      // rather than racing a second handshake.
      const waitStartedAt = now();
      try {
        await waitForConnection(opening, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ModelSocketTransportError && error.refused)
          return await viaHttp("handshake_failed");
        throw error;
      }
      handshakeMs = now() - waitStartedAt;
    }
    if (turn?.httpOnly) return await viaHttp("turn_fallback");

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
      let opened: Connection;
      try {
        opened = await waitForConnection(open(target, false), signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ModelSocketTransportError && error.refused)
          return await viaHttp("handshake_failed");
        throw error;
      }
      signal?.throwIfAborted();
      connection = opened;
      handshakeMs = now() - handshakeStartedAt;
      if (connection.busy) return await viaHttp("connection_busy");
    }
    const active = connection;
    // Continue the connection's previous response when this request extends
    // it exactly; otherwise send the full request. Either way the chain is
    // consumed here and only a completed response re-establishes it.
    const fullInput = Array.isArray(payload.input) ? (payload.input as unknown[]) : null;
    const inputKeys = fullInput?.map(fingerprint) ?? null;
    const chain = active.chain;
    active.chain = null;
    const continued =
      chain && fullInput && inputKeys ? continuationInput(chain, payload, inputKeys) : null;
    const transport: Extract<ModelRequestTransport, { kind: "websocket" }> = {
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
    if (handshakeMs !== undefined)
      observe({ phase: "handshake", transport, durationMs: handshakeMs });

    return await new Promise<Response>((resolve, reject) => {
      const admitContinuation = continuationAdmission.getStore();
      const headers = new Headers({ "content-type": "text/event-stream" });
      const output = new Map<number, unknown>();
      let validOutput = true;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let started = false;
      let finished = false;
      let continuationPending: Promise<void> | null = null;
      const continuationAbort = new AbortController();
      let cacheUsage: Pick<ResponsesTransportDiagnostic, "promptTokens" | "cachedTokens"> = {};
      const pending: Uint8Array[] = [];

      const finish = (error?: unknown, successful = error === undefined) => {
        if (finished) return;
        if (continuationPending) {
          // Closing cannot outrun an in-flight custody reservation. The owner
          // joins admission and settles a newly admitted, unsent request first.
          if (error !== undefined) continuationAbort.abort(error);
          void continuationPending.then(
            () => finish(error, successful),
            (admissionError) => finish(admissionError, false),
          );
          return;
        }
        finished = true;
        observe({
          phase: "terminal",
          transport,
          durationMs: performance.now() - startedAt,
          outcome: successful ? "completed" : "failed",
          ...cacheUsage,
        });
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
      const onAbort = AsyncResource.bind(() =>
        finish(signal?.reason ?? new Error("Model request aborted")),
      );
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
        observe({ phase: "headers", transport, durationMs: performance.now() - startedAt });
        headers.set(MODEL_TRANSPORT_HEADER, formatModelRequestTransport(transport));
        if (errorBody !== undefined) {
          headers.set("content-type", "application/json");
          resolve(new Response(errorBody, { status, headers }));
          return;
        }
        resolve(new Response(stream, { status, headers }));
      };

      const sendMessage = (message: Record<string, unknown>) => {
        if (finished) return;
        try {
          const fields = { ...message };
          for (const field of endpoint.httpOnlyFields ?? []) delete fields[field];
          const encoded = JSON.stringify({ ...fields, type: "response.create" });
          if (turn?.readyAt !== undefined) {
            observe({
              phase: "prefix_ready_to_send",
              transport,
              durationMs: performance.now() - turn.readyAt,
            });
            delete turn.readyAt;
          }
          observe({
            phase: "send",
            transport,
            durationMs: 0,
            inputBytes: Buffer.byteLength(encoded),
            fullInputBytes: Buffer.byteLength(text),
          });
          dispatchObservation.getStore()?.(transport);
          active.socket.send(encoded);
        } catch {
          finish(
            new ModelSocketTransportError(
              `${endpoint.label} response WebSocket send failed`,
              "response",
            ),
          );
        }
      };

      active.onClose = AsyncResource.bind((error: Error) => {
        // The socket closed while this response was still streaming.
        finish(error);
      });
      // A socket outlives turns. Its emitter's context belongs to the opener,
      // never to a later request's custody, cancellation or dispatch checkpoint.
      active.onEvent = AsyncResource.bind((event: Record<string, unknown>) => {
        if (finished) return;
        const type = typeof event.type === "string" ? event.type : "";
        const eventHeaders = endpoint.eventHeaders?.(event);
        if (eventHeaders) {
          if (!started) for (const [name, value] of eventHeaders) headers.set(name, value);
          return;
        }
        if (type === TIMING_EVENT) return;
        if (
          !started &&
          type === "error" &&
          transport.input === "incremental" &&
          previousResponseRefused(event)
        ) {
          // A definitive refusal before any event reaches the caller permits
          // full input, but it is a new physical request: settle/re-admit first.
          transport.input = "full";
          const resumeEvents = active.onEvent;
          active.onEvent = null;
          const pendingAdmission = (async () => {
            await admitContinuation?.(continuationAbort.signal);
            continuationAbort.signal.throwIfAborted();
            if (finished) return;
            signal?.throwIfAborted();
            active.onEvent = resumeEvents;
            sendMessage(payload);
          })();
          continuationPending = pendingAdmission;
          void pendingAdmission.then(
            () => {
              continuationPending = null;
            },
            (error) => {
              continuationPending = null;
              finish(error);
            },
          );
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
          observe({
            phase: "terminal",
            transport,
            durationMs: performance.now() - startedAt,
            outcome: "failed",
          });
          signal?.removeEventListener("abort", onAbort);
          release(active);
          return;
        }
        if (!started) begin();
        if (type === "response.output_item.done" && event.item !== undefined) {
          const index = event.output_index;
          if (
            typeof index !== "number" ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            output.has(index)
          )
            validOutput = false;
          else output.set(index, event.item);
        }
        if (type === "response.completed" || type === "response.done") {
          const response = event.response as Record<string, unknown> | undefined;
          const usage = response?.usage as
            | { input_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
            | undefined;
          if (
            Number.isSafeInteger(usage?.input_tokens) &&
            usage!.input_tokens! > 0 &&
            Number.isSafeInteger(usage?.input_tokens_details?.cached_tokens) &&
            usage!.input_tokens_details!.cached_tokens! >= 0
          ) {
            cacheUsage = {
              promptTokens: usage!.input_tokens!,
              cachedTokens: usage!.input_tokens_details!.cached_tokens!,
            };
          }
          if (
            fullInput &&
            inputKeys &&
            validOutput &&
            payload.previous_response_id == null &&
            payload.conversation == null &&
            response &&
            typeof response.id === "string" &&
            response.id &&
            (response.status === undefined || response.status === "completed") &&
            response.error == null
          ) {
            active.chain = {
              shape: requestShape(payload),
              input: inputKeys,
              output: (Array.isArray(response.output) && response.output.length > 0
                ? response.output
                : [...output.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, item]) => item)
              ).map(modelVisibleItem),
              responseId: response.id,
            };
          }
        }
        const block = sseBlock(event);
        if (controller) controller.enqueue(block);
        else pending.push(block);
        if (TERMINAL_EVENTS.has(type)) {
          const response = event.response as Record<string, unknown> | undefined;
          finish(
            undefined,
            (type === "response.completed" || type === "response.done") &&
              !!response &&
              (response.status === undefined || response.status === "completed") &&
              response.error == null,
          );
        }
      });

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
