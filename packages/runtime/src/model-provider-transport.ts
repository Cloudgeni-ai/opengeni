import type { ResolvedModelProvider } from "@opengeni/config";

import {
  GATEWAY_REQUEST_BODY_NORMALIZED_HEADER,
  normalizeVercelGatewayRequestBody,
  type GatewayRequestPolicyLookup,
} from "./model-provider-request-policy";

/**
 * Compatibility fallback for callers that did not apply the object-stage
 * request policy. Inject the reviewed route from the serialized body and
 * replace any caller gateway options. Only the ordered, reviewed endpoint
 * providers are allowed; no model fallback list is sent. Unknown models/body
 * shapes fail before I/O.
 */
export function vercelGatewayRoutingFetch(
  kind: Extract<
    ResolvedModelProvider["kind"],
    "vercel-gateway-managed" | "vercel-gateway-workspace"
  >,
  inner: typeof fetch,
  configuredPolicies?: GatewayRequestPolicyLookup,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isModelCallFetch(input)) {
      return await inner(input, init);
    }
    const headers = new Headers(init?.headers);
    const bodyAlreadyNormalized = headers.get(GATEWAY_REQUEST_BODY_NORMALIZED_HEADER) === "1";
    headers.delete(GATEWAY_REQUEST_BODY_NORMALIZED_HEADER);
    let nextInit: RequestInit = { ...init, headers };
    if (!bodyAlreadyNormalized) {
      if (typeof init?.body !== "string") {
        throw new Error("Model request could not be prepared");
      }
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("invalid body");
        }
        const body = parsed as Record<string, unknown>;
        normalizeVercelGatewayRequestBody(body, configuredPolicies);
        nextInit = { ...nextInit, body: JSON.stringify(body) };
      } catch (error) {
        if (error instanceof Error && error.message.includes("approved catalogue")) throw error;
        throw new Error("Model request could not be prepared", { cause: error });
      }
    }
    const response = await inner(input, nextInit);
    if (response.ok) {
      return response;
    }
    // The public error below replaces the upstream response. Cancel its unread
    // body now so buffered bytes and the connection are not retained until GC.
    await response.body?.cancel().catch(() => undefined);
    const message =
      kind === "vercel-gateway-workspace" && (response.status === 401 || response.status === 403)
        ? "Your Gateway connection needs attention. Reconnect it in workspace Settings."
        : "The selected model is temporarily unavailable.";
    return new Response(JSON.stringify({ error: { type: "model_unavailable", message } }), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

export function isModelCallFetch(input: Parameters<typeof fetch>[0]): boolean {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as { url?: unknown }).url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return false;
  }
  try {
    const pathname = new URL(rawUrl, "http://opengeni.local").pathname;
    return (
      pathname.endsWith("/responses") ||
      pathname.endsWith("/chat/completions") ||
      pathname.endsWith("/codex/responses")
    );
  } catch {
    return /\/(?:codex\/)?responses(?:\?|$)|\/chat\/completions(?:\?|$)/.test(rawUrl);
  }
}
