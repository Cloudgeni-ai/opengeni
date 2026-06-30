// The codex_apps connector MCP is incompatible with the Responses API tool
// contract in two ways that each fail the whole turn:
//
//  1. NAMES. Connector tools are named like "vercel.deploy_to_vercel" (dots).
//     The Responses API requires every function-tool name to match
//     ^[A-Za-z0-9_-]+$, so the request 400s ("Invalid 'tools[0].name': string
//     does not match pattern"). We cannot just rename them in tools/list — the
//     model would then call a name the MCP server does not know. So we remap
//     BIDIRECTIONALLY at the transport: sanitize the name (and remember the
//     mapping) on the tools/list RESPONSE, and reverse it back to the original on
//     the tools/call REQUEST.
//
//  2. OUTPUT SCHEMAS. 122 of 217 tools return an empty `outputSchema: {}` (no
//     `type`). @modelcontextprotocol/sdk validates every tool's outputSchema as a
//     strict `{ type: "object", ... }` and ZodErrors the WHOLE tools/list. Since
//     codex_apps runs with cacheToolsList:false it re-lists per turn, so that
//     error (thrown during tool enumeration, outside the best-effort connect
//     wrapper) fails the turn. We drop any non-object outputSchema before the
//     validator sees it — safe, as outputSchema is an advisory hint only.

import type { FetchLike } from "./fetch";

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Maps connector tool names to a Responses-API-legal charset and back. One
 * instance per codex_apps transport (i.e. per turn): tools/list populates it,
 * tools/call reads it. Idempotent across repeat listings.
 */
export class ToolNameMapper {
  private readonly sanitizedToOriginal = new Map<string, string>();
  private readonly used = new Set<string>();

  /** Return a legal, unique name for `original`, recording the reverse mapping. */
  sanitize(original: string): string {
    let candidate = VALID_TOOL_NAME.test(original)
      ? original
      : original.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
    // Disambiguate a genuine collision with a DIFFERENT original (never with
    // the same original — that keeps repeat listings stable/idempotent).
    if (this.used.has(candidate) && this.sanitizedToOriginal.get(candidate) !== original) {
      const base = candidate;
      let n = 2;
      do {
        candidate = `${base}_${n++}`;
      } while (this.used.has(candidate));
    }
    this.used.add(candidate);
    this.sanitizedToOriginal.set(candidate, original);
    return candidate;
  }

  /** Reverse a sanitized name back to the MCP server's original, if known. */
  toOriginal(sanitized: string): string | undefined {
    return this.sanitizedToOriginal.get(sanitized);
  }
}

/** Drop bad outputSchemas + sanitize tool names on a JSON-RPC tools/list result, in place. */
function sanitizeToolsInRpcMessage(message: unknown, mapper: ToolNameMapper): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const tools = (message as { result?: { tools?: unknown } }).result?.tools;
  if (!Array.isArray(tools)) {
    return;
  }
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const record = tool as Record<string, unknown>;
    if ("outputSchema" in record) {
      const outputSchema = record.outputSchema as { type?: unknown } | null | undefined;
      if (!outputSchema || typeof outputSchema !== "object" || outputSchema.type !== "object") {
        delete record.outputSchema;
      }
    }
    if (typeof record.name === "string") {
      record.name = mapper.sanitize(record.name);
    }
  }
}

/** Sanitize a single JSON body (application/json MCP response). */
export function sanitizeMcpJsonBody(text: string, mapper: ToolNameMapper = new ToolNameMapper()): string {
  try {
    const parsed = JSON.parse(text);
    sanitizeToolsInRpcMessage(parsed, mapper);
    return JSON.stringify(parsed);
  } catch {
    return text; // not JSON we understand — leave untouched
  }
}

/** Sanitize an SSE body: each JSON-RPC message rides on a `data:` line. */
export function sanitizeMcpSseBody(text: string, mapper: ToolNameMapper = new ToolNameMapper()): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const payload = line.slice("data:".length).trimStart();
      try {
        const parsed = JSON.parse(payload);
        sanitizeToolsInRpcMessage(parsed, mapper);
        return `data: ${JSON.stringify(parsed)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/** Reverse a sanitized tools/call name back to the original; returns null if no rewrite is needed. */
export function remapToolCallRequestBody(body: string, mapper: ToolNameMapper): string | null {
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } };
    if (message.method !== "tools/call") {
      return null;
    }
    const name = message.params?.name;
    if (typeof name !== "string") {
      return null;
    }
    const original = mapper.toOriginal(name);
    if (original === undefined || original === name) {
      return null;
    }
    message.params!.name = original;
    return JSON.stringify(message);
  } catch {
    return null;
  }
}

/**
 * Wrap a base fetch so the codex_apps MCP transport is Responses-API-compatible:
 * tools/list responses get their names sanitized + bad outputSchemas dropped (and
 * the name mapping recorded), and tools/call requests get their name reversed back
 * to the MCP server's original. Only the POST request/response is buffered; the
 * long-lived GET notification SSE stream is passed through untouched.
 */
export function codexAppsSanitizingFetch(base: FetchLike = globalThis.fetch): FetchLike {
  const mapper = new ToolNameMapper();
  return async (input, init) => {
    // Outgoing: reverse a sanitized tools/call name to the server's original.
    let nextInit = init;
    if (init && typeof init.body === "string" && (init.method ?? "GET").toUpperCase() === "POST") {
      const remapped = remapToolCallRequestBody(init.body, mapper);
      if (remapped !== null) {
        nextInit = { ...init, body: remapped };
      }
    }
    const res = await base(input, nextInit);
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
    const originalBody = await res.text();
    const sanitized = isJson ? sanitizeMcpJsonBody(originalBody, mapper) : sanitizeMcpSseBody(originalBody, mapper);
    const headers = new Headers(res.headers);
    headers.delete("content-length"); // body length changed
    headers.delete("content-encoding");
    return new Response(sanitized, { status: res.status, statusText: res.statusText, headers });
  };
}
