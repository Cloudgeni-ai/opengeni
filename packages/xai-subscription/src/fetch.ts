import { randomUUID } from "node:crypto";

import {
  XAI_CLIENT_MODE,
  XAI_CLIENT_VERSION,
  XAI_TOKEN_AUTH_HEADER_VALUE,
} from "./constants";
import { normalizeXaiResponseEventJson, normalizeXaiSubscriptionRequestBody } from "./normalize";
import {
  type XaiFinalContextUsage,
  xaiSubscriptionRequestStorage,
} from "./request-context";

export type XaiFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER =
  "x-opengeni-xai-subscription-transport-error";
export const XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER =
  "x-opengeni-xai-subscription-body-normalized";
export const XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER = "x-opengeni-xai-subscription-model";
export const XAI_SUBSCRIPTION_REQUEST_ID_HEADER = "x-opengeni-xai-subscription-request-id";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

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
    const requestId = originalHeaders.get(XAI_SUBSCRIPTION_REQUEST_ID_HEADER) ?? randomUUID();
    const handedOffModel = originalHeaders.get(XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER);
    originalHeaders.delete(XAI_SUBSCRIPTION_REQUEST_BODY_NORMALIZED_HEADER);
    originalHeaders.delete(XAI_SUBSCRIPTION_REQUEST_ID_HEADER);
    originalHeaders.delete(XAI_SUBSCRIPTION_REQUEST_MODEL_HEADER);

    const body = await requestBodyText(input, init);
    const parsed = body ? (JSON.parse(body) as unknown) : {};
    const normalizedBody = normalized
      ? (parsed as Record<string, unknown>)
      : normalizeXaiSubscriptionRequestBody(parsed, context.resolveModel, context.hostedSearch);
    const model =
      handedOffModel ??
      (typeof normalizedBody.model === "string" ? normalizedBody.model : "grok-4.5");

    const send = async (refresh: boolean): Promise<Response> => {
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
      return await base(url, {
        ...init,
        method: init?.method ?? (input instanceof Request ? input.method : "POST"),
        headers,
        body: JSON.stringify(normalizedBody),
      });
    };

    let response = await send(false);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await send(true);
    }
    return await normalizeResponse(response, context.onFinalContextUsage);
  };
}

async function requestBodyText(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return await input.clone().text();
  if (init?.body === undefined || init.body === null) return "";
  throw new Error("SuperGrok subscription request body must be replayable JSON text");
}

async function normalizeResponse(
  response: Response,
  onFinalContextUsage: ((usage: XaiFinalContextUsage) => void) | undefined,
): Promise<Response> {
  if (!response.ok) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const bounded = bytes.byteLength > MAX_ERROR_BODY_BYTES ? bytes.slice(0, MAX_ERROR_BODY_BYTES) : bytes;
    const headers = new Headers(response.headers);
    headers.set(XAI_SUBSCRIPTION_TRANSPORT_ERROR_HEADER, "1");
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!response.body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const value = await response.json();
    const normalized = normalizeXaiResponseEventJson({ type: "response.completed", response: value });
    emitContextUsage(normalized.value, normalized.finalContextTokens, onFinalContextUsage);
    const responseValue =
      normalized.value && typeof normalized.value === "object" && !Array.isArray(normalized.value)
        ? (normalized.value as Record<string, unknown>).response
        : value;
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
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const parts = pending.split("\n\n");
      pending = parts.pop() ?? "";
      for (const part of parts) controller.enqueue(encoder.encode(`${normalizeSseEvent(part, onFinalContextUsage)}\n\n`));
      if (chunk.done) {
        if (pending) controller.enqueue(encoder.encode(normalizeSseEvent(pending, onFinalContextUsage)));
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeSseEvent(
  block: string,
  onFinalContextUsage: ((usage: XaiFinalContextUsage) => void) | undefined,
): string {
  const lines = block.split("\n");
  return lines
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trimStart();
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