import { randomUUID } from "node:crypto";

import {
  XAI_CLIENT_MODE,
  XAI_CLIENT_VERSION,
  XAI_RESPONSE_STREAM_IDLE_TIMEOUT_MS,
  XAI_TOKEN_AUTH_HEADER_VALUE,
} from "./constants";
import { XaiSubscriptionStreamIdleTimeoutError } from "./errors";
import { normalizeXaiResponseEventJson, normalizeXaiSubscriptionRequestBody } from "./normalize";
import {
  type XaiFinalContextUsage,
  type XaiModelRequestEvent,
  type XaiSubscriptionRequestContext,
  xaiSubscriptionRequestStorage,
} from "./request-context";

export type XaiFetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const REPLAYABLE_REQUEST_BODY_FACTORY = Symbol.for("opengeni.replayable-request-body-factory");
type ReplayableRequestInit = RequestInit & {
  [REPLAYABLE_REQUEST_BODY_FACTORY]?: () => ReadableStream<Uint8Array>;
};

export const XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER =
  "x-opengeni-xai-subscription-transport-error";
export const XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER =
  "x-opengeni-xai-subscription-body-normalized";
export const XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER = "x-opengeni-xai-subscription-model";
export const XAI_SUBSCRIPTION_REQUEST_ID_HEADER = "x-opengeni-xai-subscription-request-id";

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_STREAM_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

type RequestAudit = {
  ctx: XaiSubscriptionRequestContext;
  requestId: string;
  transportAttempt: number;
  model: string;
  startedAt: number;
  streamIdleTimeoutMs: number;
  eventCount: number;
  lastEventType: string | null;
  lastProgressAt: number | null;
  terminal: boolean;
  terminalEventEmitted: boolean;
};

type SseProgress = {
  valid: boolean;
  eventType: string | null;
  terminal: "completed" | "failed" | null;
};

export function xaiSubscriptionFetch(base: XaiFetchLike): XaiFetchLike {
  return async (input, init) => {
    const context = xaiSubscriptionRequestStorage.getStore();
    if (!context) throw new Error("SuperGrok subscription request context is unavailable");

    const originalUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(originalUrl);
    if (!url.pathname.endsWith("/responses")) {
      throw new Error("SuperGrok subscription models require the Responses API");
    }
    const originalHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => originalHeaders.set(key, value));
    }
    const normalized = originalHeaders.get(XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER) === "1";
    const requestId =
      originalHeaders.get(XAI_SUBSCRIPTION_REQUEST_ID_HEADER) ??
      context.nextRequestId?.() ??
      randomUUID();
    const handedOffModel = originalHeaders.get(XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER);
    originalHeaders.delete(XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER);
    originalHeaders.delete(XAI_SUBSCRIPTION_REQUEST_ID_HEADER);
    originalHeaders.delete(XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER);

    const replayableBodyFactory = (init as ReplayableRequestInit | undefined)?.[
      REPLAYABLE_REQUEST_BODY_FACTORY
    ];
    const body = await requestBodyText(input, init, replayableBodyFactory);
    const parsed = body ? (JSON.parse(body) as unknown) : {};
    const normalizedBody = normalized
      ? (parsed as Record<string, unknown>)
      : normalizeXaiSubscriptionRequestBody(parsed, context.resolveModel, context.hostedSearch);
    const model =
      handedOffModel ??
      (typeof normalizedBody.model === "string" ? normalizedBody.model : "grok-4.6");

    const streamIdleTimeoutMs = boundedStreamIdleTimeout(
      context.streamIdleTimeoutMs ?? context.hostedToolContinuationTimeoutMs,
    );
    const send = async (
      refresh: boolean,
      transportAttempt: number,
    ): Promise<{ response: Response; audit: RequestAudit }> => {
      const token = refresh ? await context.refresh() : await context.getToken();
      const headers = new Headers(originalHeaders);
      headers.set("authorization", `Bearer ${token.accessToken}`);
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
      headers.set("user-agent", `opengeni/${context.clientVersion || XAI_CLIENT_VERSION}`);
      headers.set("x-grok-client-version", context.clientVersion || XAI_CLIENT_VERSION);
      headers.set("x-grok-client-identifier", "opengeni");
      headers.set("x-grok-client-mode", XAI_CLIENT_MODE);
      headers.set("x-authenticateresponse", "authenticate-response");
      headers.set("x-xai-token-auth", XAI_TOKEN_AUTH_HEADER_VALUE);
      headers.set("x-userid", token.userId);
      headers.set("x-grok-user-id", token.userId);
      headers.set("x-grok-conv-id", context.sessionId);
      headers.set("x-grok-session-id", context.sessionId);
      headers.set("x-grok-req-id", requestId);
      headers.set("x-grok-agent-id", context.turnId);
      headers.set("x-grok-model-override", model);
      const audit: RequestAudit = {
        ctx: context,
        requestId,
        transportAttempt,
        model,
        startedAt: performance.now(),
        streamIdleTimeoutMs,
        eventCount: 0,
        lastEventType: null,
        lastProgressAt: null,
        terminal: false,
        terminalEventEmitted: false,
      };
      let response: Response | undefined;
      try {
        await emitRequestEvent(audit, {
          phase: "started",
          responseObserved: false,
        });
        response = await base(url, {
          ...init,
          method: init?.method ?? (input instanceof Request ? input.method : "POST"),
          headers,
          body: JSON.stringify(normalizedBody),
        });
        await emitRequestEvent(audit, {
          phase: "headers",
          responseObserved: true,
          status: response.status,
          ...providerRequestIdFields(response.headers),
        });
        return { response, audit };
      } catch (error) {
        await response?.body?.cancel(error).catch(() => undefined);
        await emitRequestEvent(audit, {
          phase: "failed",
          responseObserved: response !== undefined,
          ...(response
            ? {
                status: response.status,
                ...providerRequestIdFields(response.headers),
              }
            : {}),
        }).catch(() => undefined);
        throw error;
      }
    };

    let sent = await send(false, 1);
    if (sent.response.status === 401) {
      await sent.response.body?.cancel().catch(() => undefined);
      await emitRequestEvent(sent.audit, {
        phase: "failed",
        responseObserved: true,
        status: sent.response.status,
        willRetry: true,
        ...providerRequestIdFields(sent.response.headers),
      });
      sent = await send(true, 2);
    }
    return await normalizeResponse(sent.response, sent.audit, context.onFinalContextUsage);
  };
}

async function requestBodyText(
  input: string | URL | Request,
  init: RequestInit | undefined,
  replayableBodyFactory: (() => ReadableStream<Uint8Array>) | undefined,
): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return await input.clone().text();
  if (replayableBodyFactory) return await new Response(replayableBodyFactory()).text();
  if (init?.body === undefined || init.body === null) return "";
  throw new Error("SuperGrok subscription request body must be replayable JSON text");
}

async function normalizeResponse(
  response: Response,
  audit: RequestAudit,
  onFinalContextUsage: ((usage: XaiFinalContextUsage) => void) | undefined,
): Promise<Response> {
  if (!response.ok) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const bounded =
      bytes.byteLength > MAX_ERROR_BODY_BYTES ? bytes.slice(0, MAX_ERROR_BODY_BYTES) : bytes;
    const headers = new Headers(response.headers);
    headers.set(XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER, "1");
    await emitRequestEvent(audit, {
      phase: "failed",
      responseObserved: true,
      status: response.status,
      ...providerRequestIdFields(response.headers),
    });
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!response.body) {
    await emitRequestEvent(audit, {
      phase: "completed",
      responseObserved: true,
      status: response.status,
      ...providerRequestIdFields(response.headers),
    });
    return response;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const value = await response.json();
    const normalized = normalizeXaiResponseEventJson({
      type: "response.completed",
      response: value,
    });
    emitContextUsage(normalized.value, normalized.finalContextTokens, onFinalContextUsage);
    const responseValue =
      normalized.value && typeof normalized.value === "object" && !Array.isArray(normalized.value)
        ? (normalized.value as Record<string, unknown>).response
        : value;
    await emitRequestEvent(audit, {
      phase: "completed",
      responseObserved: true,
      status: response.status,
      ...providerRequestIdFields(response.headers),
    });
    return Response.json(responseValue, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let silenceStartedAt = performance.now();
  let streamSettled = false;
  const errorStream = (error: unknown) => {
    if (streamSettled || !controllerRef) return;
    streamSettled = true;
    controllerRef.error(error);
  };
  const closeStream = () => {
    if (streamSettled || !controllerRef) return;
    streamSettled = true;
    controllerRef.close();
  };
  const clearIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (audit.terminal || !controllerRef) return;
      audit.terminal = true;
      clearIdleTimer();
      const now = performance.now();
      const silenceDurationMs = Math.max(0, now - silenceStartedAt);
      const error = new XaiSubscriptionStreamIdleTimeoutError(
        audit.requestId,
        audit.eventCount > 0,
        audit.eventCount,
        audit.lastEventType,
        silenceDurationMs,
      );
      void reader.cancel(error).catch(() => undefined);
      void emitRequestEvent(audit, {
        phase: "timed_out",
        responseObserved: audit.eventCount > 0,
        status: response.status,
        silenceDurationMs,
        ...providerRequestIdFields(response.headers),
      }).then(
        () => errorStream(error),
        () => errorStream(error),
      );
    }, audit.streamIdleTimeoutMs);
    idleTimer.unref?.();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      silenceStartedAt = performance.now();
      armIdleTimer();
    },
    async pull(controller) {
      if (audit.terminal) return;
      try {
        // A provider may split one SSE event across several network chunks. A
        // pull that returns without enqueueing anything can leave the pending
        // downstream read parked indefinitely in Bun, so keep reading until we
        // can satisfy it with at least one complete block (or settle the stream).
        while (!audit.terminal) {
          const chunk = await reader.read();
          if (audit.terminal) return;
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          const parts = pending.split(/\r?\n\r?\n/);
          pending = parts.pop() ?? "";
          if (chunk.done && pending) {
            parts.push(pending);
            pending = "";
          }
          let enqueued = false;
          for (const part of parts) {
            const progress = sseProgress(part);
            controller.enqueue(
              encoder.encode(`${normalizeSseEvent(part, onFinalContextUsage)}\n\n`),
            );
            enqueued = true;
            if (!progress.valid) continue;
            clearIdleTimer();
            const now = performance.now();
            const interEventGapMs = Math.max(0, now - (audit.lastProgressAt ?? audit.startedAt));
            audit.eventCount = Math.min(Number.MAX_SAFE_INTEGER, audit.eventCount + 1);
            audit.lastEventType = progress.eventType;
            audit.lastProgressAt = now;
            silenceStartedAt = now;
            if (audit.eventCount === 1) {
              await emitRequestEvent(audit, {
                phase: "first_event",
                responseObserved: true,
                status: response.status,
                ...providerRequestIdFields(response.headers),
              });
            } else {
              emitDiagnosticEvent(audit, {
                phase: "progress",
                responseObserved: true,
                status: response.status,
                interEventGapMs,
                ...providerRequestIdFields(response.headers),
              });
            }
            if (progress.terminal) {
              audit.terminal = true;
              clearIdleTimer();
              await reader.cancel().catch(() => undefined);
              await emitRequestEvent(audit, {
                phase: progress.terminal,
                responseObserved: true,
                status: response.status,
                ...providerRequestIdFields(response.headers),
              });
              closeStream();
              return;
            }
            armIdleTimer();
          }
          if (chunk.done) {
            audit.terminal = true;
            clearIdleTimer();
            await emitRequestEvent(audit, {
              phase: "failed",
              responseObserved: true,
              status: response.status,
              ...providerRequestIdFields(response.headers),
            });
            closeStream();
            return;
          }
          if (enqueued) return;
        }
      } catch (error) {
        if (audit.terminal) {
          errorStream(error);
          return;
        }
        audit.terminal = true;
        clearIdleTimer();
        await reader.cancel(error).catch(() => undefined);
        await emitRequestEvent(audit, {
          phase: "failed",
          responseObserved: true,
          status: response.status,
          ...providerRequestIdFields(response.headers),
        }).catch(() => undefined);
        errorStream(error);
      }
    },
    async cancel(reason) {
      streamSettled = true;
      if (!audit.terminal) {
        audit.terminal = true;
        clearIdleTimer();
        await emitRequestEvent(audit, {
          phase: "failed",
          responseObserved: true,
          status: response.status,
          ...providerRequestIdFields(response.headers),
        }).catch(() => undefined);
      }
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function sseProgress(block: string): SseProgress {
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      return { valid: true, eventType: "done", terminal: "completed" };
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { valid: false, eventType: null, terminal: null };
      }
      const rawType = (parsed as Record<string, unknown>).type;
      if (typeof rawType !== "string" || !/^[a-z0-9_.-]{1,96}$/i.test(rawType)) {
        return { valid: false, eventType: null, terminal: null };
      }
      const type = rawType;
      if (type === "response.completed") {
        return { valid: true, eventType: type, terminal: "completed" };
      }
      if (
        type === "response.incomplete" ||
        type === "response.failed" ||
        type === "response.error"
      ) {
        return { valid: true, eventType: type, terminal: "failed" };
      }
      return { valid: true, eventType: type, terminal: null };
    } catch {
      return { valid: false, eventType: null, terminal: null };
    }
  }
  return { valid: false, eventType: null, terminal: null };
}

function boundedStreamIdleTimeout(value: number | undefined): number {
  const resolved = value ?? XAI_RESPONSE_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_STREAM_IDLE_TIMEOUT_MS) {
    throw new RangeError("SuperGrok response stream idle timeout is invalid");
  }
  return resolved;
}

function providerRequestId(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

function providerRequestIdFields(headers: Headers): { providerRequestId: string } | object {
  const value = providerRequestId(headers);
  return value ? { providerRequestId: value } : {};
}

function requestEventFor(
  audit: RequestAudit,
  event: Omit<
    XaiModelRequestEvent,
    | "requestId"
    | "transportAttempt"
    | "model"
    | "durationMs"
    | "streamIdleTimeoutMs"
    | "eventCount"
    | "lastEventType"
    | "lastProgressDurationMs"
  >,
): XaiModelRequestEvent {
  const now = performance.now();
  return {
    requestId: audit.requestId,
    transportAttempt: audit.transportAttempt,
    model: audit.model,
    durationMs: Math.max(0, now - audit.startedAt),
    streamIdleTimeoutMs: audit.streamIdleTimeoutMs,
    eventCount: audit.eventCount,
    ...(audit.lastEventType ? { lastEventType: audit.lastEventType } : {}),
    ...(audit.lastProgressAt !== null
      ? {
          lastProgressDurationMs: Math.max(0, audit.lastProgressAt - audit.startedAt),
        }
      : {}),
    ...event,
  };
}

function emitDiagnosticEvent(
  audit: RequestAudit,
  event: Parameters<typeof requestEventFor>[1],
): XaiModelRequestEvent {
  const observed = requestEventFor(audit, event);
  try {
    audit.ctx.onModelRequestDiagnostic?.(observed);
  } catch {
    // Diagnostics are in-memory and must never affect provider transport.
  }
  return observed;
}

async function emitRequestEvent(
  audit: RequestAudit,
  event: Parameters<typeof requestEventFor>[1],
): Promise<void> {
  if (event.phase === "completed" || event.phase === "failed" || event.phase === "timed_out") {
    if (audit.terminalEventEmitted) return;
    audit.terminalEventEmitted = true;
  }
  const observed = emitDiagnosticEvent(audit, event);
  await audit.ctx.onModelRequestEvent?.(observed);
}

function normalizeSseEvent(
  block: string,
  onFinalContextUsage: ((usage: XaiFinalContextUsage) => void) | undefined,
): string {
  const lines = block.split("\n");
  return lines
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return line;
      try {
        const normalized = normalizeXaiResponseEventJson(JSON.parse(data));
        emitContextUsage(normalized.value, normalized.finalContextTokens, onFinalContextUsage);
        return `data: ${JSON.stringify(normalized.value)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function emitContextUsage(
  value: unknown,
  finalContextTokens: number | null,
  sink: ((usage: XaiFinalContextUsage) => void) | undefined,
): void {
  if (finalContextTokens === null || !sink) return;
  const response =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).response
      : null;
  const usage =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>).usage
      : null;
  const context =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>).context_details
      : null;
  if (!context || typeof context !== "object" || Array.isArray(context)) return;
  const inputTokens = Number((context as Record<string, unknown>).input_tokens);
  const outputTokens = Number((context as Record<string, unknown>).output_tokens);
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return;
  try {
    sink({ inputTokens, outputTokens, totalTokens: finalContextTokens });
  } catch {
    // Usage observation must never alter model transport.
  }
}

export function isXaiSubscriptionTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    const headers = value.headers;
    if (
      headers &&
      typeof headers === "object" &&
      typeof (headers as { get?: unknown }).get === "function" &&
      (headers as Headers).get(XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER) === "1"
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}
