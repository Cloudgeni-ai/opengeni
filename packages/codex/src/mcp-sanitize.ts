// OpenAI's `codex_apps` connector MCP returns many tools with an empty
// `outputSchema: {}` (no `type`) — 122 of 217 in practice. The MCP client SDK
// (@modelcontextprotocol/sdk) validates every tool's `outputSchema` as a strict
// `{ type: "object", ... }` and throws a ZodError ("Invalid input: expected
// \"object\"" at tools[N].outputSchema.type) on the WHOLE tools/list response.
// Because we register codex_apps with cacheToolsList:false, that listing runs on
// every turn, so the error fails the entire turn (it is thrown during tool
// enumeration, outside the best-effort *connect* wrapper).
//
// We can't relax the SDK's schema, so we sanitize the tools/list response on the
// wire — before the validator sees it — by dropping any `outputSchema` that is
// not a valid object-typed schema. Dropping it is safe: outputSchema is an
// advisory hint for structured tool results, never required for a tool to run.

import type { FetchLike } from "./fetch";

/** Strip non-`{type:"object"}` outputSchemas from a JSON-RPC tools/list result, in place. */
function sanitizeToolsInRpcMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const tools = (message as { result?: { tools?: unknown } }).result?.tools;
  if (!Array.isArray(tools)) {
    return;
  }
  for (const tool of tools) {
    if (tool && typeof tool === "object" && "outputSchema" in tool) {
      const outputSchema = (tool as Record<string, unknown>).outputSchema as { type?: unknown } | null | undefined;
      if (!outputSchema || typeof outputSchema !== "object" || outputSchema.type !== "object") {
        delete (tool as Record<string, unknown>).outputSchema;
      }
    }
  }
}

/** Sanitize a single JSON body (application/json MCP response). */
export function sanitizeMcpJsonBody(text: string): string {
  try {
    const parsed = JSON.parse(text);
    sanitizeToolsInRpcMessage(parsed);
    return JSON.stringify(parsed);
  } catch {
    return text; // not JSON we understand — leave untouched
  }
}

/** Sanitize an SSE body: each JSON-RPC message rides on a `data:` line. */
export function sanitizeMcpSseBody(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const payload = line.slice("data:".length).trimStart();
      try {
        const parsed = JSON.parse(payload);
        sanitizeToolsInRpcMessage(parsed);
        return `data: ${JSON.stringify(parsed)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/**
 * Wrap a base fetch so the codex_apps MCP transport's tools/list response is
 * sanitized before @modelcontextprotocol/sdk validates it. Only the POST
 * request/response is buffered+rewritten; the long-lived GET notification SSE
 * stream is passed through untouched (never buffered).
 */
export function codexAppsSanitizingFetch(base: FetchLike = globalThis.fetch): FetchLike {
  return async (input, init) => {
    const res = await base(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || !res.ok || !res.body) {
      return res;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");
    const isSse = contentType.includes("text/event-stream");
    if (!isJson && !isSse) {
      return res;
    }
    const original = await res.text();
    const sanitized = isJson ? sanitizeMcpJsonBody(original) : sanitizeMcpSseBody(original);
    const headers = new Headers(res.headers);
    headers.delete("content-length"); // body length changed
    headers.delete("content-encoding");
    return new Response(sanitized, { status: res.status, statusText: res.statusText, headers });
  };
}
