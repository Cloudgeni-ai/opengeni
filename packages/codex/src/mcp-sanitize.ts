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

import { CODEX_APPS_MCP_SERVER_ID } from "./constants";
import type { FetchLike } from "./fetch";

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

// The Responses API rejects a function-tool name longer than 64 chars (it 400s
// the WHOLE turn). Some namespaced connector tool names exceed this, and the
// collision-disambiguation suffix only lengthens names, so the mapper must cap
// length too — not just charset.
const MAX_TOOL_NAME_LEN = 64;

// CRITICAL: this sanitizer runs on the codex_apps tools/list wire BEFORE OpenGeni's
// PrefixedMcpServer (packages/runtime) prepends `<serverId>__` to every tool name
// (prefixedMcpToolName). The 64-char limit applies to that FINAL prefixed name the
// model sees, so a name we cap at 64 here becomes 64 + 12 = 76 after prefixing and
// 400s the whole turn. Reserve the runtime prefix so `codex_apps__<sanitized>` is
// always <= 64. The sanitizer owns the server id, so the reservation is exact and
// stays self-contained (no runtime import). The reverse mapping is unaffected: the
// mapper is keyed on the pre-prefix sanitized name, which is what tools/call carries
// back after PrefixedMcpServer strips its prefix.
const RUNTIME_TOOL_NAME_PREFIX_LEN = CODEX_APPS_MCP_SERVER_ID.length + "__".length; // `codex_apps__` = 12
const EFFECTIVE_MAX_TOOL_NAME_LEN = MAX_TOOL_NAME_LEN - RUNTIME_TOOL_NAME_PREFIX_LEN; // 52

/** Short, stable, charset-legal hash of a string (djb2 → base36). Deterministic. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0; // h * 33 + c, kept unsigned
  }
  return h.toString(36);
}

/** Truncate to <= EFFECTIVE_MAX_TOOL_NAME_LEN (reserving the runtime prefix), appending `_<hash(original)>` so the result stays unique + deterministic. */
function capLength(candidate: string, original: string): string {
  if (candidate.length <= EFFECTIVE_MAX_TOOL_NAME_LEN) {
    return candidate;
  }
  const suffix = `_${shortHash(original)}`;
  return candidate.slice(0, Math.max(0, EFFECTIVE_MAX_TOOL_NAME_LEN - suffix.length)) + suffix;
}

/**
 * Maps connector tool names to a Responses-API-legal charset and back. One
 * instance per codex_apps transport (i.e. per turn): tools/list populates it,
 * tools/call reads it. Idempotent across repeat listings.
 */
export class ToolNameMapper {
  private readonly sanitizedToOriginal = new Map<string, string>();
  private readonly used = new Set<string>();

  /** Return a legal, unique name (<= EFFECTIVE_MAX_TOOL_NAME_LEN, so `<prefix>__name` <= 64) for `original`, recording the reverse mapping. */
  sanitize(original: string): string {
    let candidate = VALID_TOOL_NAME.test(original)
      ? original
      : original.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
    // Enforce the Responses-API 64-char cap (stable hash suffix keyed on the
    // ORIGINAL → deterministic across repeat listings, distinct originals don't
    // collide after truncation).
    candidate = capLength(candidate, original);
    // Disambiguate a genuine collision with a DIFFERENT original (never with
    // the same original — that keeps repeat listings stable/idempotent). Re-cap
    // after each suffix so disambiguation never re-breaches the effective limit.
    if (this.used.has(candidate) && this.sanitizedToOriginal.get(candidate) !== original) {
      const base = candidate;
      let n = 2;
      do {
        const suffix = `_${n++}`;
        candidate = (base.length + suffix.length > EFFECTIVE_MAX_TOOL_NAME_LEN
          ? base.slice(0, EFFECTIVE_MAX_TOOL_NAME_LEN - suffix.length)
          : base) + suffix;
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

/**
 * Drop bad outputSchemas + sanitize tool names on a JSON-RPC tools/list result, in place.
 *
 * P4 (Part B.1): when `namespaceSink` is provided, accumulate each tool's ORIGINAL
 * connector namespace (the segment BEFORE the first dot, e.g. `github` from
 * `github.create_issue`) into it — captured HERE because this pass sees the original
 * dotted name BEFORE mapper.sanitize rewrites the dot away. Only dotted names carry a
 * connector namespace; un-dotted (already-legal) names are not connectors and are skipped.
 */
function sanitizeToolsInRpcMessage(message: unknown, mapper: ToolNameMapper, namespaceSink?: Set<string>): void {
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
      // Drop EVERY outputSchema, not just malformed/empty ones. The MCP SDK client
      // caches a validator for any tool that declares an outputSchema and validates
      // each tool CALL's `structuredContent` against it — and the codex_apps
      // connectors return results that do NOT match their own declared schemas
      // (e.g. the schema requires a `result` property the response omits), so the
      // SDK throws `McpError -32602: Structured content does not match the tool's
      // output schema` and EVERY such connector tool call fails (observed live:
      // gmail_search_emails / gmail_get_profile / gmail_list_labels all -32602ed).
      // outputSchema is advisory — the agent reads the text `content` regardless —
      // so dropping it makes the connector tools usable. This also subsumes the
      // empty-`{}` case the strict Tool schema rejected at tools/list time.
      delete record.outputSchema;
    }
    if (typeof record.name === "string") {
      if (namespaceSink && record.name.includes(".")) {
        const namespace = record.name.slice(0, record.name.indexOf("."));
        if (namespace) {
          namespaceSink.add(namespace);
        }
      }
      record.name = mapper.sanitize(record.name);
    }
  }
}

/** Sanitize a single JSON body (application/json MCP response). */
export function sanitizeMcpJsonBody(text: string, mapper: ToolNameMapper = new ToolNameMapper(), namespaceSink?: Set<string>): string {
  try {
    const parsed = JSON.parse(text);
    sanitizeToolsInRpcMessage(parsed, mapper, namespaceSink);
    return JSON.stringify(parsed);
  } catch {
    return text; // not JSON we understand — leave untouched
  }
}

/** Sanitize an SSE body: each JSON-RPC message rides on a `data:` line. */
export function sanitizeMcpSseBody(text: string, mapper: ToolNameMapper = new ToolNameMapper(), namespaceSink?: Set<string>): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const payload = line.slice("data:".length).trimStart();
      try {
        const parsed = JSON.parse(payload);
        sanitizeToolsInRpcMessage(parsed, mapper, namespaceSink);
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
 *
 * P4 (Part B.1): an optional `namespaceSink` Set accumulates the ORIGINAL-dotted
 * connector namespaces seen across every tools/list this turn (captured before the
 * dot is sanitized away). The worker reads the (live, by-reference) Set after the
 * turn to cache the serving account's connector set — packages/codex stays db-free.
 */
export function codexAppsSanitizingFetch(base: FetchLike = globalThis.fetch, namespaceSink?: Set<string>): FetchLike {
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
    const sanitized = isJson
      ? sanitizeMcpJsonBody(originalBody, mapper, namespaceSink)
      : sanitizeMcpSseBody(originalBody, mapper, namespaceSink);
    const headers = new Headers(res.headers);
    headers.delete("content-length"); // body length changed
    headers.delete("content-encoding");
    return new Response(sanitized, { status: res.status, statusText: res.statusText, headers });
  };
}
