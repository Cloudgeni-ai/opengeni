// Codex contributes only endpoint identity and connection metadata framing.
import {
  responsesTransport,
  metadataHeaders,
  type ResponsesTransportOptions,
} from "@opengeni/network/responses-websocket";
import type { FetchLike } from "./fetch";

export {
  MODEL_TRANSPORT_HEADER as CODEX_TRANSPORT_HEADER,
  formatModelRequestTransport as formatCodexRequestTransport,
  parseModelRequestTransport as parseCodexRequestTransport,
  OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
  withResponsesConversation,
  createResponsesTurn,
  continuationInput,
  type ModelRequestTransport as CodexRequestTransport,
  type ModelWebSocketLike as CodexWebSocketLike,
  type ModelWebSocketFactory as CodexWebSocketFactory,
  type ResponsesTransport as CodexResponsesTransport,
  type ResponsesWebSocketEndpoint,
} from "@opengeni/network/responses-websocket";

export const CODEX_RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
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
      headers.push([`x-codex-${slot}-limit-window-seconds`, String(minutes * 60)]);
      headers.push([`x-codex-${slot}-window-minutes`, String(minutes)]);
    }
    if (resetAfter !== null)
      headers.push([`x-codex-${slot}-reset-after-seconds`, String(resetAfter)]);
    if (resetAt !== null) headers.push([`x-codex-${slot}-reset-at`, String(resetAt)]);
  }
  return headers;
}
export const CODEX_RESPONSES_WEBSOCKET_ENDPOINT = {
  label: "Codex",
  conversationScoped: true,
  url: /^https:\/\/[^/]+\/.*\/codex\/responses(?:\?|$)/,
  beta: CODEX_RESPONSES_WEBSOCKET_BETA,
  eventHeaders: (event: Record<string, unknown>) =>
    event.type === "codex.rate_limits"
      ? codexRateLimitHeaders(event)
      : event.type === "codex.response.metadata"
        ? metadataHeaders(event)
        : null,
};
export type CodexResponsesTransportOptions = Omit<ResponsesTransportOptions, "endpoint"> & {
  endpoint?: ResponsesTransportOptions["endpoint"];
};
export function codexResponsesTransport(
  http: FetchLike,
  options: CodexResponsesTransportOptions = {},
) {
  return responsesTransport(http, {
    ...options,
    endpoint: options.endpoint ?? CODEX_RESPONSES_WEBSOCKET_ENDPOINT,
  });
}
