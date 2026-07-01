// Progressive connector disclosure for the ChatGPT/Codex backend — parity with
// how the Codex CLI surfaces its ~217 `codex_apps` connector tools WITHOUT paying
// their schemas in every turn's context.
//
// WHY. OpenGeni connects the codex_apps MCP server as a CLIENT and the SDK
// materializes EVERY connector tool as a `function` tool in request.tools[] on
// every codex turn (~217 tools ≈ tens of thousands of context tokens). The Codex
// CLI instead uses the backend's NATIVE tool-search: the model gets one compact
// search tool + all connector tools flagged `defer_loading:true` (schemas dropped
// from model context), searches by capability, and only the matched tools are
// disclosed back and become callable.
//
// PROVEN LIVE (Phase 0 probe against /codex/responses on gpt-5.5): the backend
// HONORS `defer_loading:true` on function tools — 50 fat tools dropped input_tokens
// 6766 → 108 — AND makes a tool callable purely because a prior `tool_search_output`
// disclosed it (V3). The model emits `tool_search_call` on our slug.
//
// HOW. We wrap the agent's `getAllTools` (codex turns only, flag-gated): tag every
// `codex_apps__*` function tool `deferLoading = true` (converTool then serializes
// `defer_loading:true`, dropping the schema from context) and append one
// client-executed `toolSearchTool`. The SDK routes a `tool_search_call` to our
// executor (ClientToolSearchExecutor), which BM25-ranks the deferred pool and
// returns the matched tools BY REFERENCE — the SDK emits the `tool_search_output`
// that discloses them; the subsequent `function_call` resolves through the normal
// PrefixedMcpServer.callTool path (auth + name-sanitize + structuredContent inline
// all unchanged). Invocation is untouched; only the wire tool-set shrinks.

import { toolSearchTool, type Tool } from "@openai/agents";

/** The prefix OpenGeni's PrefixedMcpServer stamps on codex_apps connector tools. */
export const CODEX_APPS_TOOL_PREFIX = "codex_apps__";
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

/** True for a materialized codex_apps connector function tool. */
export function isCodexAppsFunctionTool(tool: unknown): tool is Tool & { name: string; deferLoading?: boolean } {
  return (
    !!tool
    && typeof tool === "object"
    && (tool as { type?: unknown }).type === "function"
    && typeof (tool as { name?: unknown }).name === "string"
    && (tool as { name: string }).name.startsWith(CODEX_APPS_TOOL_PREFIX)
  );
}

/** Split snake_case/camelCase/dotted text into lowercase word tokens (len ≥ 2). */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** The searchable text of a connector tool: name (weighted ×2) + description + param names. */
function toolSearchText(tool: Tool): string {
  const raw = (tool as { name?: string }).name ?? "";
  const name = raw.startsWith(CODEX_APPS_TOOL_PREFIX) ? raw.slice(CODEX_APPS_TOOL_PREFIX.length) : raw;
  const description = typeof (tool as { description?: unknown }).description === "string" ? (tool as { description: string }).description : "";
  const params = (tool as { parameters?: { properties?: Record<string, unknown> } }).parameters?.properties;
  const paramNames = params && typeof params === "object" ? Object.keys(params).join(" ") : "";
  return `${name} ${name} ${description} ${paramNames}`;
}

/**
 * Rank connector tools against a plain-language query with BM25 (Okapi, k1=1.5,
 * b=0.75) over tokenized name+description+params. Returns the top `limit` tools
 * with a positive score, most-relevant first. An empty/no-match query returns
 * the first `limit` tools (never empty when tools exist) so a search always
 * discloses SOMETHING the model can act on or reject.
 */
export function bm25RankTools(tools: Tool[], query: string, limit: number): Tool[] {
  const qTokens = Array.from(new Set(tokenize(query)));
  if (tools.length === 0) return [];
  if (qTokens.length === 0) return tools.slice(0, limit);

  const docs = tools.map((tool) => {
    const tokens = tokenize(toolSearchText(tool));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tool, len: tokens.length, tf };
  });
  const N = docs.length;
  const avgdl = Math.max(1, docs.reduce((s, d) => s + d.len, 0) / N);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  const k1 = 1.5;
  const b = 0.75;
  const scored = docs.map((d) => {
    let score = 0;
    for (const qt of qTokens) {
      const n = df.get(qt);
      const f = d.tf.get(qt);
      if (!n || !f) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgdl)));
    }
    return { tool: d.tool, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score);
  if (hits.length === 0) return tools.slice(0, limit); // never strand the model with nothing
  return hits.slice(0, limit).map((s) => s.tool);
}

/** Parse `{query, limit}` from a tool_search_call's arguments (string or object). */
function parseSearchArgs(raw: unknown): { query: string; limit: number } {
  let obj: Record<string, unknown> = {};
  try {
    obj = typeof raw === "string" ? (raw.length ? JSON.parse(raw) : {}) : (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  } catch {
    obj = {};
  }
  const query = typeof obj.query === "string" ? obj.query : "";
  const limitRaw = typeof obj.limit === "number" && Number.isFinite(obj.limit) ? obj.limit : DEFAULT_SEARCH_LIMIT;
  return { query, limit: Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.round(limitRaw))) };
}

const SEARCH_TOOL_DESCRIPTION =
  "Search the user's connected app tools (Gmail, GitHub, Google Calendar, Slack, and more) by capability. "
  + "Describe in plain language WHAT you need to do (for example: \"send an email\", \"create a calendar event\", "
  + "\"list GitHub issues\") rather than guessing exact tool names. Returns the matching connector tools, which then become callable.";

const SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Plain-language description of the capability you need." },
    limit: { type: "number", description: "Maximum number of tools to return (default 8)." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/**
 * The client tool-search executor: BM25 over the deferred codex_apps pool from the
 * turn's live `availableTools`, returning matched tools BY REFERENCE (the only legal
 * return — the SDK emits the disclosing `tool_search_output` and flips the loaded
 * gate; returning copies would throw). Stateless — reads the pool per call.
 */
function codexToolSearchExecutor(args: { availableTools?: Tool[]; toolCall?: { arguments?: unknown } }): Tool[] {
  const deferred = (args.availableTools ?? []).filter(isCodexAppsFunctionTool);
  if (deferred.length === 0) return [];
  const { query, limit } = parseSearchArgs(args.toolCall?.arguments);
  return bm25RankTools(deferred, query, limit);
}

/** Build the client-executed tool_search tool that discloses codex_apps connectors on demand. */
export function buildCodexToolSearchTool(): Tool {
  return toolSearchTool({
    execution: "client",
    description: SEARCH_TOOL_DESCRIPTION,
    parameters: SEARCH_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    execute: codexToolSearchExecutor as never,
  }) as unknown as Tool;
}

/** True for the built-in tool_search tool (so we never add a second one). */
function isToolSearchTool(tool: unknown): boolean {
  const t = tool as { name?: unknown; providerData?: { type?: unknown } } | null;
  return !!t && (t.name === "tool_search" || t.providerData?.type === "tool_search");
}

/**
 * The transform applied to a turn's resolved tool list: tag every codex_apps
 * connector function tool `deferLoading = true`, and — only if we tagged at least
 * one and no tool_search tool is already present — append the client tool_search
 * tool. Pure (mutates the passed tools + returns the possibly-extended array); the
 * SDK's `getTools` gate requires a tool_search whenever a deferred tool is present,
 * which appending here satisfies in the same request. No-op (same array, untouched)
 * when the turn has no codex_apps tools.
 */
export function applyCodexToolSearch(tools: Tool[]): Tool[] {
  let tagged = 0;
  for (const tool of tools) {
    if (isCodexAppsFunctionTool(tool) && (tool as { deferLoading?: boolean }).deferLoading !== true) {
      (tool as { deferLoading?: boolean }).deferLoading = true;
      tagged++;
    }
  }
  if (tagged === 0 || tools.some(isToolSearchTool)) {
    return tools;
  }
  return [...tools, buildCodexToolSearchTool()];
}

/**
 * Install progressive connector disclosure on a codex-path agent by wrapping
 * `getAllTools` so every per-model-call tool resolution runs {@link applyCodexToolSearch}.
 * Idempotent-per-call (re-tags each freshly-materialized MCP tool under
 * cacheToolsList:false). Gated by the caller (flag + codex path); does nothing on a
 * turn with no codex_apps tools.
 */
export function installCodexToolSearch(agent: { getAllTools: (runContext: unknown) => Promise<Tool[]> }): void {
  const original = agent.getAllTools.bind(agent);
  agent.getAllTools = (async (runContext: unknown) => applyCodexToolSearch(await original(runContext))) as typeof agent.getAllTools;
}
