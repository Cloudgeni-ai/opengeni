// codexSubscriptionFetch — the transport installed on the OpenAI client for the
// "codex-subscription" provider. Mirrors the runtime's computerCallNormalizingFetch
// pattern: wraps a base fetch and returns a (input, init) => Promise<Response>.
//
// It reads the per-request Codex context from AsyncLocalStorage at CALL time, so a
// single process-cached client serves every workspace with the correct token. It:
//   - rewrites /responses -> /codex/responses
//   - injects the subscription auth headers (omits OpenAI-Beta on SSE; spec §1.2)
//   - normalizes the request body (spec §0 verdict)
//   - retries once on 401 after a forced token refresh (spec §1.9)
// Stream parsing is delegated to the SDK (SSE passthrough; spec §0(d)).

import { CODEX_ORIGINATOR } from "./constants";
import { normalizeCodexRequestBody } from "./normalize";
import {
  codexRequestStorage,
  type CodexTokenSnapshot,
  type CodexUsageHeaderSnapshot,
} from "./request-context";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Internal provenance marker copied onto buffered non-OK Codex responses.
 * OpenAI's APIError preserves response headers, which lets the worker
 * distinguish a model-provider refusal from an unrelated sandbox/MCP HTTP
 * error that happened during the same Codex turn.
 */
export const CODEX_TRANSPORT_ERROR_HEADER = "x-opengeni-codex-transport-error";

function headersCarryCodexTransportMarker(headers: unknown): boolean {
  if (!headers || typeof headers !== "object") return false;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    return getter.call(headers, CODEX_TRANSPORT_ERROR_HEADER) === "1";
  }
  const record = headers as Record<string, unknown>;
  return (
    record[CODEX_TRANSPORT_ERROR_HEADER] === "1" ||
    record[CODEX_TRANSPORT_ERROR_HEADER.toLowerCase()] === "1"
  );
}

/** True only for an error produced from this Codex transport's non-OK response. */
export function isCodexTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    if (headersCarryCodexTransportMarker(value.headers)) return true;
    current = value.cause;
  }
  return false;
}

/** Parse an integer header value; null when absent or not a finite integer. */
function parseIntHeader(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a window reset instant from the response headers: prefer the absolute
 * `*-reset-at` (epoch SECONDS → ms, mirroring codex-token-resolver's usage parse),
 * else the relative `*-reset-after-seconds` from now, else now (a missing reset
 * reads as "already cleared" — availableAt treats an elapsed reset as a bounded
 * default cooldown, so the ranker never strands on it).
 */
function resolveResetAt(headers: Headers, atKey: string, afterKey: string, nowMs: number): Date {
  const at = parseIntHeader(headers.get(atKey));
  if (at !== null) {
    return new Date(at * 1000);
  }
  const after = parseIntHeader(headers.get(afterKey));
  if (after !== null) {
    return new Date(nowMs + after * 1000);
  }
  return new Date(nowMs);
}

/**
 * Multi-account P4 (Part A): scrape the full usage snapshot the codex backend
 * stamps on every `/codex/responses` response in `x-codex-primary-*` /
 * `x-codex-secondary-*` headers (integer-identical to GET /wham/usage, for free).
 *
 * CRITICAL clobber-fix: return null unless BOTH windows expose a valid used-percent
 * integer. recordCodexAccountUsage writes all five columns unconditionally, so a
 * primary-only snapshot would null the weekly column. Both windows are always
 * emitted together on `/codex/responses`; gating on both makes every write a full
 * 5-column snapshot byte-identical to the poll path, and a malformed/absent header
 * set simply no-ops (the /wham/usage poll fallback still covers it).
 */
export function parseCodexUsageHeaders(headers: Headers): CodexUsageHeaderSnapshot | null {
  const primaryUsedPercent = parseIntHeader(headers.get("x-codex-primary-used-percent"));
  const secondaryUsedPercent = parseIntHeader(headers.get("x-codex-secondary-used-percent"));
  if (primaryUsedPercent === null || secondaryUsedPercent === null) {
    return null; // not a full both-windows snapshot — no-op (never a partial clobber)
  }
  const nowMs = Date.now();
  return {
    primaryUsedPercent,
    primaryResetAt: resolveResetAt(
      headers,
      "x-codex-primary-reset-at",
      "x-codex-primary-reset-after-seconds",
      nowMs,
    ),
    secondaryUsedPercent,
    secondaryResetAt: resolveResetAt(
      headers,
      "x-codex-secondary-reset-at",
      "x-codex-secondary-reset-after-seconds",
      nowMs,
    ),
    checkedAt: new Date(nowMs),
  };
}

export function codexSubscriptionFetch(base: FetchLike = globalThis.fetch): FetchLike {
  return async (input, init) => {
    const ctx = codexRequestStorage.getStore();
    if (!ctx) {
      return base(input, init); // not a codex turn — passthrough, untouched
    }

    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // /responses -> /codex/responses, idempotent: the negative lookbehind skips
    // URLs whose base already includes /codex (avoids /codex/codex/responses).
    const rewritten = rawUrl.replace(/(?<!\/codex)\/responses(\b|$)/, "/codex/responses$1");

    const attempt = async (auth: CodexTokenSnapshot): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${auth.accessToken}`);
      if (auth.chatgptAccountId) {
        headers.set("ChatGPT-Account-ID", auth.chatgptAccountId);
      }
      headers.set("originator", CODEX_ORIGINATOR);
      headers.set("User-Agent", `${CODEX_ORIGINATOR}/${ctx.clientVersion}`);
      headers.set("version", ctx.clientVersion);
      headers.set("accept", "text/event-stream");
      headers.set("content-type", "application/json");
      if (ctx.sessionId) {
        // Backend sticky cache-routing key (see CodexRequestContext.sessionId):
        // without it, byte-identical resends miss the prompt cache ~half the
        // time; with it they pin to a warm shard and hit at the ceiling.
        headers.set("session_id", ctx.sessionId);
      }
      if (auth.isFedramp) {
        headers.set("X-OpenAI-Fedramp", "true");
      }
      headers.delete("OpenAI-Beta"); // omit on SSE (spec §1.2); fallback: "responses=experimental" if backend 400s
      headers.delete("x-api-key");

      // The backend is streaming-only; force stream=true on the wire but remember
      // the caller's intent so a non-streaming caller (e.g. the compaction
      // summarizer) still gets a single JSON Response back.
      let callerWantsStream = true;
      const nextInit: RequestInit = { ...init, headers };
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as Record<string, unknown>;
          callerWantsStream = parsed.stream === true;
          nextInit.body = JSON.stringify(normalizeCodexRequestBody(parsed, ctx.resolveModel));
        } catch {
          /* leave unparseable bodies untouched (already copied from init) */
        }
      }
      if (process.env.CODEX_DEBUG) {
        const keys =
          typeof nextInit.body === "string"
            ? Object.keys(JSON.parse(nextInit.body) as Record<string, unknown>)
            : [];
        console.error(
          `[codex-debug] POST ${rewritten} stream=${callerWantsStream} bodyKeys=[${keys.join(",")}]`,
        );
      }
      const res = await base(rewritten, nextInit);
      // Multi-account P4 (Part A): scrape the usage headers ONCE, before the
      // OK/!res.ok branch, so the same fire-and-forget read also covers the 429
      // hard-cap path (an exhausted serving account stamps its own fresh
      // used_percent with no extra fetch). Sync + non-throwing + never awaited;
      // `if (usage)` makes an absent/malformed header set a safe no-op. We read
      // res.headers only — the SSE body is never touched here.
      const usage = parseCodexUsageHeaders(res.headers);
      if (usage) {
        ctx.onUsageHeaders?.(usage);
      }
      if (process.env.CODEX_DEBUG && !res.ok) {
        // Never log provider bodies: they can contain request-derived content or
        // account details. Status + request id is sufficient to correlate with
        // the structured worker failure telemetry.
        console.error(
          `[codex-debug] <- ${res.status} requestId=${res.headers.get("x-request-id") ?? "unknown"}`,
        );
      }
      // The codex backend leaves the terminal event's response.output empty and
      // delivers the assistant items via output_item.done events instead. The
      // @openai/agents parser (streaming AND non-streaming) reads response.output,
      // so we must reconstruct it: collapse to one JSON Response for a non-streaming
      // caller, or repair the live stream's terminal event for a streaming caller.
      if (!res.ok) {
        // Buffer the error body once and re-emit it as a concrete JSON Response.
        // A streaming responses request whose error body is left as the raw
        // (possibly SSE / already-streamed) Response makes the SDK throw
        // "<status> status code (no body)" — the JSON error (type/message/
        // resets_in_seconds) is lost, so a 429 usage cap surfaces as a generic,
        // wrongly-retryable rate-limit. Re-emitting a clean application/json
        // Response lets the SDK reconstruct error.error for EVERY codex error
        // (401/400/5xx too). For a hard usage cap we also pin x-should-retry:false
        // so the SDK does not burn its retry budget on a limit that won't lift.
        return await bufferCodexErrorResponse(res);
      }
      return callerWantsStream ? repairCodexStream(res) : await sseToJsonResponse(res);
    };

    let res = await attempt(await ctx.getToken());
    if (res.status === 401) {
      res = await attempt(await ctx.refresh()); // single refresh-on-401 retry (spec §1.9)
    }
    return res;
  };
}

/** The codex backend's hard-cap error type (ChatGPT/Codex usage limit reached). */
export const CODEX_USAGE_LIMIT_ERROR_TYPE = "usage_limit_reached";

export type CodexUsageLimitInfo = {
  /** Seconds until the usage cap resets, when the backend reported it. */
  resetsInSeconds: number | null;
};

/**
 * Classify a thrown error as a ChatGPT/Codex usage-cap (429 usage_limit_reached)
 * and extract the reset window. The SDK surfaces the codex backend's 429 as an
 * OpenAI APIError whose `.type` (and `.error.type`) is `usage_limit_reached` and
 * whose `.error.resets_in_seconds` carries the cap reset. Walks the cause chain
 * and tolerates the message-only shape so it survives any SDK re-wrapping.
 * Returns null for anything that is not a usage cap.
 */
export function classifyCodexUsageLimitError(error: unknown): CodexUsageLimitInfo | null {
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const e = cur as Record<string, unknown>;
    const body = (e.error && typeof e.error === "object" ? e.error : undefined) as
      | Record<string, unknown>
      | undefined;
    const type =
      (typeof e.type === "string" ? e.type : undefined) ??
      (typeof body?.type === "string" ? body.type : undefined);
    const message = typeof e.message === "string" ? e.message : "";
    const status = Number(e.status);
    if (
      type === CODEX_USAGE_LIMIT_ERROR_TYPE ||
      message.includes(CODEX_USAGE_LIMIT_ERROR_TYPE) ||
      (status === 429 && /usage limit/i.test(message))
    ) {
      const resets =
        (typeof body?.resets_in_seconds === "number" ? body.resets_in_seconds : undefined) ??
        (typeof e.resets_in_seconds === "number" ? (e.resets_in_seconds as number) : undefined) ??
        null;
      return { resetsInSeconds: resets };
    }
    cur = e.cause;
  }
  return null;
}

/**
 * Buffer a non-OK codex Response and re-emit it as a clean `application/json`
 * Response so the SDK can reconstruct `error.error` from the body. A 429 usage
 * cap (`error.type === "usage_limit_reached"`) is a HARD limit, not transient
 * backpressure, so we pin `x-should-retry: false` to stop the SDK retrying it.
 * Reading the body here also drains the socket of a discarded 401 (no leak).
 */
async function bufferCodexErrorResponse(res: Response): Promise<Response> {
  const bodyText = await res.text().catch(() => "");
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.set(CODEX_TRANSPORT_ERROR_HEADER, "1");
  headers.delete("content-length"); // body re-serialized
  headers.delete("content-encoding"); // text() already decoded any gzip
  let errorType: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { type?: unknown } };
    errorType = typeof parsed.error?.type === "string" ? parsed.error.type : undefined;
  } catch {
    /* non-JSON error body — leave as-is, no retry-header override */
  }
  if (errorType === CODEX_USAGE_LIMIT_ERROR_TYPE) {
    headers.set("x-should-retry", "false");
  }
  return new Response(bodyText, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Collapse a Responses SSE stream into the single JSON Response object a
 * non-streaming `responses.create` caller expects: the terminal response.*
 * event carries the full `response` payload.
 */
async function sseToJsonResponse(res: Response): Promise<Response> {
  const text = await res.text();
  let final: Record<string, unknown> | null = null;
  let terminalError: Response | null = null;
  const items: unknown[] = []; // assembled from output_item.done (the codex backend
  // leaves response.completed.response.output empty and emits the items separately).
  for (const data of sseDataPayloads(text)) {
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const ev = JSON.parse(data) as {
        type?: string;
        response?: Record<string, unknown>;
        error?: unknown;
        code?: unknown;
        message?: unknown;
        param?: unknown;
        item?: unknown;
      };
      if (ev.type === "response.output_item.done" && ev.item !== undefined) {
        items.push(ev.item);
      } else if (ev.type === "response.failed") {
        terminalError = codexSseFailureResponse(
          res,
          ev.response?.error,
          "response_failed",
          "The Codex response failed",
          {
            eventType: ev.type,
            responseId: ev.response?.id,
            responseStatus: ev.response?.status,
          },
        );
      } else if (ev.type === "error" || ev.type === "response.error") {
        terminalError = codexSseFailureResponse(
          res,
          ev.error ?? ev.response?.error ?? ev,
          "response_error",
          "The Codex response stream reported an error",
          {
            eventType: ev.type,
            responseId: ev.response?.id,
            responseStatus: ev.response?.status,
          },
        );
      } else if (ev.type === "response.incomplete") {
        const details = ev.response?.incomplete_details;
        const reason =
          details && typeof details === "object"
            ? (details as Record<string, unknown>).reason
            : undefined;
        terminalError = codexSseFailureResponse(
          res,
          {
            code: "response_incomplete",
            message:
              typeof reason === "string" && reason.length > 0
                ? `The Codex response was incomplete (${reason})`
                : "The Codex response was incomplete",
          },
          "response_incomplete",
          "The Codex response was incomplete",
          {
            eventType: ev.type,
            responseId: ev.response?.id,
            responseStatus: ev.response?.status,
          },
        );
      } else if (ev.type === "response.completed" || ev.type === "response.done") {
        final = ev.response ?? null;
      }
    } catch {
      /* ignore non-JSON keepalive lines */
    }
  }
  if (terminalError) {
    return terminalError;
  }
  if (!final) {
    return codexSseFailureResponse(
      res,
      null,
      "invalid_sse_terminal",
      "The Codex response stream ended without a terminal response",
    );
  }
  if (final && items.length > 0) {
    final = { ...final, output: items }; // prefer the assembled items over an empty output array
  }
  if (process.env.CODEX_DEBUG) {
    console.error(
      `[codex-debug] sse->json items=${items.length} outputLen=${Array.isArray(final?.output) ? (final.output as unknown[]).length : "?"}`,
    );
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(final), { status: 200, headers });
}

const NON_RETRYABLE_SSE_ERROR_CODES = new Set([
  "bio_policy",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "usage_limit_reached",
]);

/**
 * Project the data payloads from a complete SSE body. EventSource accepts LF,
 * CRLF, and bare CR line endings; splitting only on `\n\n` can therefore merge
 * a standards-valid terminal failure into the preceding event and silently
 * turn it into `{}`. Preserve the SSE rule that multiple data lines are joined
 * with `\n`, and tolerate a final event without a trailing blank line as the
 * previous transport parser did.
 */
function sseDataPayloads(text: string): string[] {
  const payloads: string[] = [];
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
    dataLines = [];
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line === "data") {
      dataLines.push("");
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  dispatch();
  return payloads;
}

const CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES = 256;
const CODEX_TERMINAL_ERROR_MESSAGE_MAX_BYTES = 4 * 1024;
const CODEX_TERMINAL_ERROR_TRUNCATION_MARKER = "… [truncated]";

function boundedTerminalErrorField(
  value: unknown,
  maxBytes: number,
): { value?: string; truncated: boolean } {
  if (typeof value !== "string") return { truncated: false };
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };

  const markerBytes = encoder.encode(CODEX_TERMINAL_ERROR_TRUNCATION_MARKER).byteLength;
  let prefixEnd = Math.max(0, maxBytes - markerBytes);
  while (prefixEnd > 0 && (encoded[prefixEnd]! & 0xc0) === 0x80) {
    prefixEnd -= 1;
  }
  return {
    value: `${new TextDecoder().decode(encoded.subarray(0, prefixEnd))}${CODEX_TERMINAL_ERROR_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

/**
 * Convert a terminal error carried inside an HTTP-200 SSE stream into the
 * ordinary non-2xx JSON error contract expected by the OpenAI SDK. Codex CLI
 * treats the same events as provider failures; returning a successful `{}`
 * loses the actual cause and makes compaction look semantically empty.
 */
function codexSseFailureResponse(
  source: Response,
  rawError: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  metadata: {
    eventType?: unknown;
    responseId?: unknown;
    responseStatus?: unknown;
  } = {},
): Response {
  const projection = codexSseFailureProjection(
    source,
    rawError,
    fallbackCode,
    fallbackMessage,
    metadata,
  );
  return new Response(JSON.stringify({ error: projection.error }), {
    status: projection.status,
    headers: projection.headers,
  });
}

export type CodexSseFailureProjection = {
  status: number;
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    event_type?: string;
    response_id?: string;
    response_status?: string;
    diagnostic_truncated?: true;
  };
  headers: Headers;
};

function codexSseFailureProjection(
  source: Response,
  rawError: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  metadata: {
    eventType?: unknown;
    responseId?: unknown;
    responseStatus?: unknown;
  } = {},
): CodexSseFailureProjection {
  const record =
    rawError && typeof rawError === "object" && !Array.isArray(rawError)
      ? (rawError as Record<string, unknown>)
      : {};
  const typeField = boundedTerminalErrorField(record.type, CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES);
  const codeField = boundedTerminalErrorField(record.code, CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES);
  const messageField = boundedTerminalErrorField(
    record.message ?? (typeof rawError === "string" ? rawError : undefined),
    CODEX_TERMINAL_ERROR_MESSAGE_MAX_BYTES,
  );
  const paramField = boundedTerminalErrorField(record.param, CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES);
  const eventTypeField = boundedTerminalErrorField(
    metadata.eventType,
    CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES,
  );
  const responseIdField = boundedTerminalErrorField(
    metadata.responseId,
    CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES,
  );
  const responseStatusField = boundedTerminalErrorField(
    metadata.responseStatus,
    CODEX_TERMINAL_ERROR_FIELD_MAX_BYTES,
  );
  const providerType =
    typeField.value === "error" ||
    typeField.value === "response.error" ||
    typeField.value === "response.failed"
      ? undefined
      : typeField.value;
  const code =
    (codeField.value?.length ? codeField.value : undefined) ??
    (providerType?.length ? providerType : undefined) ??
    fallbackCode;
  const diagnosticTruncated =
    typeField.truncated ||
    codeField.truncated ||
    messageField.truncated ||
    paramField.truncated ||
    eventTypeField.truncated ||
    responseIdField.truncated ||
    responseStatusField.truncated ||
    Object.keys(record).some((key) => !["type", "code", "message", "param"].includes(key)) ||
    (rawError !== null &&
      rawError !== undefined &&
      typeof rawError !== "string" &&
      (typeof rawError !== "object" || Array.isArray(rawError)));
  const error: CodexSseFailureProjection["error"] = {
    type: providerType?.length ? providerType : code,
    code,
    message: messageField.value?.length ? messageField.value : fallbackMessage,
    ...(paramField.value?.length ? { param: paramField.value } : {}),
    ...(eventTypeField.value?.length ? { event_type: eventTypeField.value } : {}),
    ...(responseIdField.value?.length ? { response_id: responseIdField.value } : {}),
    ...(responseStatusField.value?.length ? { response_status: responseStatusField.value } : {}),
    ...(diagnosticTruncated ? { diagnostic_truncated: true } : {}),
  };
  const status =
    code === "rate_limit_exceeded" ||
    code === "usage_limit_reached" ||
    code === "insufficient_quota"
      ? 429
      : NON_RETRYABLE_SSE_ERROR_CODES.has(code)
        ? 400
        : 502;
  const headers = new Headers(source.headers);
  headers.set("content-type", "application/json");
  headers.set(CODEX_TRANSPORT_ERROR_HEADER, "1");
  // A terminal event means the provider already accepted and completed this
  // request. Never let the OpenAI SDK replay it merely because we synthesized
  // a non-2xx response to preserve the terminal failure.
  headers.set("x-should-retry", "false");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return { status, error, headers };
}

/**
 * A provider terminal carried inside an accepted HTTP-200 stream. The OpenAI
 * SDK cannot turn that late terminal into a non-2xx APIError because headers
 * have already been accepted, so the body transform throws this equivalent
 * bounded shape. Provider-supplied message/param text is intentionally absent:
 * the worker may persist Error.message, while identifiers/classifications are
 * sufficient for retry, compaction, and incident diagnostics.
 */
export class CodexStreamingTerminalError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly eventType?: string;
  readonly responseId?: string;
  readonly responseStatus?: string;
  readonly headers: Headers;
  readonly error: Record<string, unknown>;

  constructor(projection: CodexSseFailureProjection, publicMessage: string) {
    super(publicMessage);
    this.name = "CodexStreamingTerminalError";
    this.status = projection.status;
    this.code = projection.error.code;
    this.type = projection.error.type;
    if (projection.error.event_type !== undefined) {
      this.eventType = projection.error.event_type;
    }
    if (projection.error.response_id !== undefined) {
      this.responseId = projection.error.response_id;
    }
    if (projection.error.response_status !== undefined) {
      this.responseStatus = projection.error.response_status;
    }
    this.headers = projection.headers;
    this.error = {
      type: projection.error.type,
      code: projection.error.code,
      ...(projection.error.event_type ? { event_type: projection.error.event_type } : {}),
      ...(projection.error.response_id ? { response_id: projection.error.response_id } : {}),
      ...(projection.error.response_status
        ? { response_status: projection.error.response_status }
        : {}),
      ...(projection.error.diagnostic_truncated ? { diagnostic_truncated: true } : {}),
    };
  }
}

function codexSseFailureError(
  source: Response,
  rawError: unknown,
  fallbackCode: string,
  publicMessage: string,
  metadata: {
    eventType?: unknown;
    responseId?: unknown;
    responseStatus?: unknown;
  } = {},
): CodexStreamingTerminalError {
  return new CodexStreamingTerminalError(
    codexSseFailureProjection(source, rawError, fallbackCode, publicMessage, metadata),
    publicMessage,
  );
}

/**
 * Repair a live Responses SSE stream for the @openai/agents streaming parser: pass
 * every event through unchanged, collect the output_item.done items, and inject
 * them into the terminal event's empty `output` so the parser sees the message.
 */
function repairCodexStream(res: Response): Response {
  if (!res.body) {
    const error = codexSseFailureError(
      res,
      null,
      "invalid_sse_terminal",
      "The Codex response stream ended without a terminal response",
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
  const items: unknown[] = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let successfulTerminalSeen = false;
  const emitCompleteBlocks = (
    controller: TransformStreamDefaultController<Uint8Array>,
    final: boolean,
  ) => {
    let boundary = findSseBlockBoundary(buffer, final);
    while (boundary) {
      const block = buffer.slice(0, boundary.start);
      const separator = buffer.slice(boundary.start, boundary.end);
      buffer = buffer.slice(boundary.end);
      const patched = patchSseBlock(block, items, res);
      successfulTerminalSeen ||= patched.successfulTerminal;
      controller.enqueue(encoder.encode(`${patched.block}${separator}`));
      boundary = findSseBlockBoundary(buffer, final);
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      emitCompleteBlocks(controller, false);
    },
    flush(controller) {
      buffer += decoder.decode();
      emitCompleteBlocks(controller, true);
      if (buffer.length > 0) {
        const patched = patchSseBlock(buffer, items, res);
        successfulTerminalSeen ||= patched.successfulTerminal;
        controller.enqueue(encoder.encode(patched.block));
        buffer = "";
      }
      if (!successfulTerminalSeen) {
        throw codexSseFailureError(
          res,
          null,
          "invalid_sse_terminal",
          "The Codex response stream ended without a terminal response",
        );
      }
    },
  });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(res.body.pipeThrough(transform), {
    status: res.status,
    headers,
  });
}

type SseBlockBoundary = { start: number; end: number };

/**
 * Find two consecutive SSE line endings without misreading one CRLF as a bare
 * CR followed by a bare LF. A trailing CR is intentionally held until the next
 * chunk (or final flush), because only then can it be distinguished from the
 * first byte of CRLF.
 */
function findSseBlockBoundary(value: string, final: boolean): SseBlockBoundary | null {
  for (let index = 0; index < value.length; index += 1) {
    const firstEnd = sseLineEndingEnd(value, index, final);
    if (firstEnd === null) continue;
    const secondEnd = sseLineEndingEnd(value, firstEnd, final);
    if (secondEnd !== null) {
      return { start: index, end: secondEnd };
    }
    index = firstEnd - 1;
  }
  return null;
}

function sseLineEndingEnd(value: string, index: number, final: boolean): number | null {
  const current = value[index];
  if (current === "\n") return index + 1;
  if (current !== "\r") return null;
  if (index + 1 < value.length) {
    return value[index + 1] === "\n" ? index + 2 : index + 1;
  }
  return final ? index + 1 : null;
}

type PatchedSseBlock = { block: string; successfulTerminal: boolean };

/**
 * Collect output_item.done items and rewrite only a successful terminal event.
 * Failed/error/incomplete terminals throw before their provider message can be
 * exposed to Agents as an ordinary response_done event.
 */
function patchSseBlock(block: string, items: unknown[], source: Response): PatchedSseBlock {
  const lines = block.split(/\r\n|\r|\n/);
  const dataStr = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!dataStr || dataStr === "[DONE]") {
    return { block, successfulTerminal: false };
  }
  let ev: {
    type?: string;
    item?: unknown;
    response?: Record<string, unknown>;
    error?: unknown;
    code?: unknown;
    message?: unknown;
    param?: unknown;
  };
  try {
    ev = JSON.parse(dataStr);
  } catch {
    return { block, successfulTerminal: false };
  }
  if (ev.type === "response.output_item.done" && ev.item !== undefined) {
    items.push(ev.item);
    return { block, successfulTerminal: false };
  }
  if (ev.type === "response.failed") {
    throw codexSseFailureError(
      source,
      ev.response?.error,
      "response_failed",
      "The Codex response failed",
      {
        eventType: ev.type,
        responseId: ev.response?.id,
        responseStatus: ev.response?.status,
      },
    );
  }
  if (ev.type === "error" || ev.type === "response.error") {
    throw codexSseFailureError(
      source,
      ev.error ?? ev.response?.error ?? ev,
      "response_error",
      "The Codex response stream reported an error",
      {
        eventType: ev.type,
        responseId: ev.response?.id,
        responseStatus: ev.response?.status,
      },
    );
  }
  if (ev.type === "response.incomplete") {
    const details = ev.response?.incomplete_details;
    const reason =
      details && typeof details === "object"
        ? (details as Record<string, unknown>).reason
        : undefined;
    throw codexSseFailureError(
      source,
      {
        code: "response_incomplete",
        message:
          typeof reason === "string" && reason.length > 0
            ? `The Codex response was incomplete (${reason})`
            : "The Codex response was incomplete",
      },
      "response_incomplete",
      "The Codex response was incomplete",
      {
        eventType: ev.type,
        responseId: ev.response?.id,
        responseStatus: ev.response?.status,
      },
    );
  }
  if ((ev.type === "response.completed" || ev.type === "response.done") && ev.response) {
    if (
      ev.response.status === "failed" ||
      ev.response.status === "incomplete" ||
      (ev.response.error !== null && ev.response.error !== undefined)
    ) {
      throw codexSseFailureError(
        source,
        ev.response.error,
        ev.response.status === "incomplete" ? "response_incomplete" : "response_failed",
        ev.response.status === "incomplete"
          ? "The Codex response was incomplete"
          : "The Codex response failed",
        {
          eventType: ev.type,
          responseId: ev.response.id,
          responseStatus: ev.response.status,
        },
      );
    }
    const out = ev.response.output;
    if ((!Array.isArray(out) || out.length === 0) && items.length > 0) {
      ev.response = { ...ev.response, output: items };
      const nonData = lines.filter((l) => !l.startsWith("data:"));
      const lineEnding = block.match(/\r\n|\r|\n/)?.[0] ?? "\n";
      return {
        block: [...nonData, `data: ${JSON.stringify(ev)}`].join(lineEnding),
        successfulTerminal: true,
      };
    }
    return { block, successfulTerminal: true };
  }
  return { block, successfulTerminal: false };
}
