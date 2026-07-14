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

import { randomUUID } from "node:crypto";
import { CODEX_ORIGINATOR } from "./constants";
import { normalizeCodexRequestBody } from "./normalize";
import {
  codexRequestStorage,
  type CodexModelRequestEvent,
  type CodexRequestContext,
  type CodexResponseTimeoutPolicy,
  type CodexTokenSnapshot,
  type CodexUsageHeaderSnapshot,
} from "./request-context";
import {
  CODEX_RESPONSE_TIMEOUT_ERROR_TYPE,
  CodexResponseTimeoutError,
  classifyCodexResponseTimeoutError,
  isPreHeadersTimeoutError,
  resolveCodexResponseTimeoutPolicy,
} from "./response-timeout";

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

type RequestAudit = {
  ctx: CodexRequestContext;
  requestId: string;
  transportAttempt: number;
  model?: string;
  logicalStartedAt: number;
  attemptStartedAt: number;
  policy: CodexResponseTimeoutPolicy;
};

async function emitRequestEvent(
  audit: RequestAudit,
  event: Omit<
    CodexModelRequestEvent,
    "requestId" | "transportAttempt" | "model" | "durationMs" | "timeoutPolicy"
  >,
): Promise<void> {
  await audit.ctx.onModelRequestEvent?.({
    requestId: audit.requestId,
    transportAttempt: audit.transportAttempt,
    ...(audit.model ? { model: audit.model } : {}),
    durationMs: Math.max(0, Date.now() - audit.attemptStartedAt),
    timeoutPolicy: audit.policy,
    ...event,
  });
}

function providerRequestId(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

async function delayBeforeRetry(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchBeforeHeaders(
  base: FetchLike,
  input: string,
  init: RequestInit,
  audit: RequestAudit,
): Promise<Response> {
  const elapsed = Date.now() - audit.logicalStartedAt;
  const wholeRemainingMs = audit.policy.wholeRequestTimeoutMs - elapsed;
  const timeoutClass =
    wholeRemainingMs <= audit.policy.headersTimeoutMs ? "whole_request" : "headers";
  const deadlineMs = Math.max(1, Math.min(audit.policy.headersTimeoutMs, wholeRemainingMs));
  if (wholeRemainingMs <= 0) {
    throw new CodexResponseTimeoutError("whole_request", audit.requestId, false);
  }

  const externalSignal = init.signal;
  if (externalSignal?.aborted) throw externalSignal.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const basePromise = base(input, { ...init, signal: controller.signal });
  let deadlineError: CodexResponseTimeoutError | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadlineError = new CodexResponseTimeoutError(timeoutClass, audit.requestId, false);
      reject(deadlineError);
    }, deadlineMs);
  });
  try {
    return await Promise.race([basePromise, deadline]);
  } catch (error) {
    if (deadlineError) {
      controller.abort(deadlineError);
      void basePromise
        .then((late) => late.body?.cancel(deadlineError ?? undefined))
        .catch(() => undefined);
      throw deadlineError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function observedResponse(
  res: Response,
  audit: RequestAudit,
  externalSignal: AbortSignal | null | undefined,
): Promise<Response> {
  const requestId = providerRequestId(res.headers);
  if (!res.body) {
    await emitRequestEvent(audit, {
      phase: res.ok ? "completed" : "failed",
      responseObserved: true,
      status: res.status,
      ...(requestId ? { providerRequestId: requestId } : {}),
    });
    return res;
  }

  const reader = res.body.getReader();
  let terminal = false;
  let firstByte = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let wholeTimer: ReturnType<typeof setTimeout> | undefined;
  let armIdle: () => void = () => undefined;
  let abortFromOutside: (() => void) | undefined;

  const clearTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (wholeTimer) clearTimeout(wholeTimer);
    if (abortFromOutside) externalSignal?.removeEventListener("abort", abortFromOutside);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const timeOut = (klass: "idle_stream" | "whole_request") => {
        if (terminal) return;
        terminal = true;
        clearTimers();
        const error = new CodexResponseTimeoutError(klass, audit.requestId, true);
        void reader.cancel(error).catch(() => undefined);
        void emitRequestEvent(audit, {
          phase: "timed_out",
          responseObserved: true,
          timeoutClass: klass,
          status: res.status,
          ...(requestId ? { providerRequestId: requestId } : {}),
        }).then(
          () => controller.error(error),
          (auditError) => controller.error(auditError),
        );
      };
      armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => timeOut("idle_stream"), audit.policy.streamIdleTimeoutMs);
      };
      armIdle();
      const wholeRemaining = Math.max(
        1,
        audit.policy.wholeRequestTimeoutMs - (Date.now() - audit.logicalStartedAt),
      );
      wholeTimer = setTimeout(() => timeOut("whole_request"), wholeRemaining);
      abortFromOutside = () => {
        if (terminal) return;
        terminal = true;
        clearTimers();
        const reason = externalSignal?.reason ?? new DOMException("Aborted", "AbortError");
        void reader.cancel(reason).catch(() => undefined);
        void emitRequestEvent(audit, {
          phase: "failed",
          responseObserved: true,
          status: res.status,
          ...(requestId ? { providerRequestId: requestId } : {}),
        }).then(
          () => controller.error(reason),
          (auditError) => controller.error(auditError),
        );
      };
      if (externalSignal?.aborted) {
        abortFromOutside();
      } else {
        externalSignal?.addEventListener("abort", abortFromOutside, { once: true });
      }
    },
    async pull(controller) {
      if (terminal) return;
      try {
        const chunk = await reader.read();
        if (terminal) return;
        if (chunk.done) {
          terminal = true;
          clearTimers();
          await emitRequestEvent(audit, {
            phase: res.ok ? "completed" : "failed",
            responseObserved: true,
            status: res.status,
            ...(requestId ? { providerRequestId: requestId } : {}),
          });
          controller.close();
          return;
        }
        armIdle();
        if (!firstByte) {
          firstByte = true;
          await emitRequestEvent(audit, {
            phase: "first_byte",
            responseObserved: true,
            status: res.status,
            ...(requestId ? { providerRequestId: requestId } : {}),
          });
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (terminal) return;
        terminal = true;
        clearTimers();
        await emitRequestEvent(audit, {
          phase: "failed",
          responseObserved: true,
          status: res.status,
          ...(requestId ? { providerRequestId: requestId } : {}),
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!terminal) {
        terminal = true;
        clearTimers();
        await emitRequestEvent(audit, {
          phase: "failed",
          responseObserved: true,
          status: res.status,
          ...(requestId ? { providerRequestId: requestId } : {}),
        }).catch(() => undefined);
      }
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

function timeoutErrorResponse(info: {
  timeoutClass: "connect" | "headers" | "idle_stream" | "whole_request";
  requestId: string;
  responseObserved: boolean;
  message: string;
}): Response {
  return new Response(
    JSON.stringify({
      error: {
        type: CODEX_RESPONSE_TIMEOUT_ERROR_TYPE,
        code: CODEX_RESPONSE_TIMEOUT_ERROR_TYPE,
        message: info.message,
        timeout_class: info.timeoutClass,
        response_observed: info.responseObserved,
        request_id: info.requestId,
      },
    }),
    {
      status: 504,
      headers: {
        "content-type": "application/json",
        "x-should-retry": "false",
        [CODEX_TRANSPORT_ERROR_HEADER]: "1",
      },
    },
  );
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

    const policy = resolveCodexResponseTimeoutPolicy(ctx.responseTimeoutPolicy);
    const requestId = ctx.nextRequestId?.() ?? randomUUID();
    const logicalStartedAt = Date.now();
    let transportAttempt = 0;
    let noByteRetriesUsed = 0;

    const attempt = async (
      auth: CodexTokenSnapshot,
      authenticationAttempt: number,
    ): Promise<Response> => {
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
      let model: string | undefined;
      const nextInit: RequestInit = { ...init, headers };
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as Record<string, unknown>;
          callerWantsStream = parsed.stream === true;
          const normalized = normalizeCodexRequestBody(parsed, ctx.resolveModel);
          model = typeof normalized.model === "string" ? normalized.model : undefined;
          nextInit.body = JSON.stringify(normalized);
        } catch {
          /* leave unparseable bodies untouched (already copied from init) */
        }
      }
      headers.set(
        "Idempotency-Key",
        authenticationAttempt === 0 ? requestId : `${requestId}:auth-${authenticationAttempt}`,
      );
      if (process.env.CODEX_DEBUG) {
        let keys: string[] = [];
        if (typeof nextInit.body === "string") {
          try {
            keys = Object.keys(JSON.parse(nextInit.body) as Record<string, unknown>);
          } catch {
            /* an unparseable body is already passed through unchanged above */
          }
        }
        console.error(
          `[codex-debug] POST ${rewritten} stream=${callerWantsStream} bodyKeys=[${keys.join(",")}]`,
        );
      }
      let res: Response;
      for (;;) {
        transportAttempt += 1;
        const audit: RequestAudit = {
          ctx,
          requestId,
          transportAttempt,
          ...(model ? { model } : {}),
          logicalStartedAt,
          attemptStartedAt: Date.now(),
          policy,
        };
        await emitRequestEvent(audit, {
          phase: "started",
          responseObserved: false,
        });
        try {
          res = await fetchBeforeHeaders(base, rewritten, nextInit, audit);
          const upstreamRequestId = providerRequestId(res.headers);
          await emitRequestEvent(audit, {
            phase: "headers",
            responseObserved: true,
            status: res.status,
            ...(upstreamRequestId ? { providerRequestId: upstreamRequestId } : {}),
          });
          const observed = await observedResponse(res, audit, nextInit.signal);
          res = observed;
          break;
        } catch (error) {
          if (nextInit.signal?.aborted) {
            await emitRequestEvent(audit, {
              phase: "failed",
              responseObserved: false,
            }).catch(() => undefined);
            throw error;
          }
          const klass = isPreHeadersTimeoutError(error);
          if (!klass) {
            await emitRequestEvent(audit, {
              phase: "failed",
              responseObserved: false,
            });
            throw error;
          }
          const canRetry =
            noByteRetriesUsed < policy.noByteRetries &&
            Date.now() - logicalStartedAt + policy.retryBackoffMs < policy.wholeRequestTimeoutMs;
          await emitRequestEvent(audit, {
            phase: "timed_out",
            responseObserved: false,
            timeoutClass: klass,
            willRetry: canRetry,
          });
          if (!canRetry) {
            throw new CodexResponseTimeoutError(klass, requestId, false);
          }
          noByteRetriesUsed += 1;
          await delayBeforeRetry(policy.retryBackoffMs, nextInit.signal);
        }
      }
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

    try {
      let res = await attempt(await ctx.getToken(), 0);
      if (res.status === 401) {
        res = await attempt(await ctx.refresh(), 1); // single refresh-on-401 retry (spec §1.9)
      }
      return res;
    } catch (error) {
      const timeout = classifyCodexResponseTimeoutError(error);
      if (!timeout) throw error;
      return timeoutErrorResponse({
        timeoutClass: timeout.timeoutClass,
        requestId: timeout.requestId ?? requestId,
        responseObserved: timeout.responseObserved,
        message: timeout.message,
      });
    }
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
  return new Response(bodyText, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Collapse a Responses SSE stream into the single JSON Response object a
 * non-streaming `responses.create` caller expects: the terminal response.*
 * event carries the full `response` payload.
 */
async function sseToJsonResponse(res: Response): Promise<Response> {
  const text = await res.text();
  let final: Record<string, unknown> | null = null;
  const items: unknown[] = []; // assembled from output_item.done (the codex backend
  // leaves response.completed.response.output empty and emits the items separately).
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const ev = JSON.parse(data) as {
        type?: string;
        response?: Record<string, unknown>;
        item?: unknown;
      };
      if (ev.type === "response.output_item.done" && ev.item !== undefined) {
        items.push(ev.item);
      } else if (
        ev.type === "response.completed" ||
        ev.type === "response.done" ||
        ev.type === "response.incomplete"
      ) {
        final = ev.response ?? null;
      }
    } catch {
      /* ignore non-JSON keepalive lines */
    }
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
  return new Response(JSON.stringify(final ?? {}), { status: 200, headers });
}

/**
 * Repair a live Responses SSE stream for the @openai/agents streaming parser: pass
 * every event through unchanged, collect the output_item.done items, and inject
 * them into the terminal event's empty `output` so the parser sees the message.
 */
function repairCodexStream(res: Response): Response {
  if (!res.body) {
    return res;
  }
  const items: unknown[] = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        controller.enqueue(encoder.encode(`${patchSseBlock(block, items)}\n\n`));
        idx = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(patchSseBlock(buffer, items)));
      }
    },
  });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(res.body.pipeThrough(transform), { status: res.status, headers });
}

/** Collect output_item.done items (mutating `items`); rewrite the terminal event's empty output. */
function patchSseBlock(block: string, items: unknown[]): string {
  const lines = block.split("\n");
  const dataStr = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!dataStr || dataStr === "[DONE]") {
    return block;
  }
  let ev: { type?: string; item?: unknown; response?: Record<string, unknown> };
  try {
    ev = JSON.parse(dataStr);
  } catch {
    return block;
  }
  if (ev.type === "response.output_item.done" && ev.item !== undefined) {
    items.push(ev.item);
    return block;
  }
  if (
    (ev.type === "response.completed" ||
      ev.type === "response.done" ||
      ev.type === "response.incomplete") &&
    ev.response
  ) {
    const out = ev.response.output;
    if ((!Array.isArray(out) || out.length === 0) && items.length > 0) {
      ev.response = { ...ev.response, output: items };
      const nonData = lines.filter((l) => !l.startsWith("data:"));
      return [...nonData, `data: ${JSON.stringify(ev)}`].join("\n");
    }
  }
  return block;
}
