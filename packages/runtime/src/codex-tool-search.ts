// Shared tool classification and bounded search ranking for lazy-tool-transport.ts.
import { type Tool } from "@openai/agents";
import {
  MCP_MAX_TOOL_DEFINITION_BYTES,
  MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES,
  mcpSerializedSizeBytes,
} from "./mcp-network";

/** The prefix OpenGeni's PrefixedMcpServer stamps on codex_apps connector tools. */
export const CODEX_APPS_TOOL_PREFIX = "codex_apps__";
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

const MCP_TOOL_NAME_SEPARATOR = "__";
const NO_MCP_SERVER_IDS: ReadonlySet<string> = new Set();

/** Return the authorized server id for a runtime MCP function tool name. */
function mcpServerIdForTool(tool: unknown, mcpServerIds: ReadonlySet<string>): string | null {
  if (!tool || typeof tool !== "object") return null;
  if ((tool as { type?: unknown }).type !== "function") return null;
  const name = (tool as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  let match: string | null = null;
  for (const serverId of mcpServerIds) {
    if (
      typeof serverId !== "string" ||
      serverId.length === 0 ||
      !name.startsWith(`${serverId}${MCP_TOOL_NAME_SEPARATOR}`)
    ) {
      continue;
    }
    if (match === null || serverId.length > match.length) {
      match = serverId;
    }
  }
  return match;
}

/**
 * True for an MCP function tool on the effective agent surface. Selecting a
 * server is an authority decision; it does not make every schema from that
 * server eager. Per-turn eager identities are removed from this searchable
 * pool by the runtime before provider projection.
 * The prefix is the same runtime namespace used by PrefixedMcpServer; this
 * intentionally does not inspect the global registry, connection metadata, or
 * credentials, so search cannot widen the already-authorized tool set.
 */
export function isSearchableMcpFunctionTool(
  tool: unknown,
  mcpServerIds: ReadonlySet<string> = NO_MCP_SERVER_IDS,
): tool is Tool & { name: string; deferLoading?: boolean } {
  const serverId = mcpServerIdForTool(tool, mcpServerIds);
  return serverId !== null;
}

// Minimal English stopword set: query phrasings like "send an email to someone"
// should match on capability words, not drown in glue words (parity with
// codex-rs, whose search normalizes tokens server-side).
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "by",
  "at",
  "is",
  "are",
  "be",
  "do",
  "does",
  "my",
  "me",
  "your",
  "you",
  "it",
  "its",
  "this",
  "that",
  "from",
  "as",
  "up",
  "out",
  "all",
  "some",
  "any",
  "can",
  "will",
  "would",
  "should",
  "want",
  "need",
  "please",
  "user",
  "users",
]);

/** Light suffix stemmer so "emails"/"email", "creating"/"create" co-match (min-stem guards, no over-stripping). */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Split snake_case/camelCase/dotted text into stemmed lowercase word tokens (len ≥ 2, stopwords removed). */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** The searchable text of a connector tool: name (weighted ×2) + description + param names. */
function toolSearchText(tool: Tool): string {
  const raw = (tool as { name?: string }).name ?? "";
  const name = raw.startsWith(CODEX_APPS_TOOL_PREFIX)
    ? raw.slice(CODEX_APPS_TOOL_PREFIX.length)
    : raw;
  const description =
    typeof (tool as { description?: unknown }).description === "string"
      ? (tool as { description: string }).description
      : "";
  const params = (tool as { parameters?: { properties?: Record<string, unknown> } }).parameters
    ?.properties;
  const paramNames = params && typeof params === "object" ? Object.keys(params).join(" ") : "";
  return `${name} ${name} ${description} ${paramNames}`;
}

/**
 * Rank connector tools against a plain-language query with BM25 (Okapi, k1=1.5,
 * b=0.75) over tokenized name+description+params. Returns the top `limit` tools
 * with a positive score, most-relevant first. An empty or no-match query returns
 * [] — matching codex-rs, whose search returns empty rather than arbitrary tools;
 * disclosing unrelated (and thereby CALLABLE) tools on a miss feeds the model
 * noise. The SDK normalizes an empty executor result into an empty
 * tool_search_output, which the model reads as "nothing matched — rephrase".
 */
export function bm25RankTools(tools: Tool[], query: string, limit: number): Tool[] {
  const qTokens = Array.from(new Set(tokenize(query)));
  if (tools.length === 0 || qTokens.length === 0) return [];

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
  return hits.slice(0, limit).map((s) => s.tool); // no hits ⇒ [] (codex-rs parity; see doc)
}

/** Parse ranked or exact-name discovery arguments (string or object). */
function parseSearchArgs(raw: unknown): { query: string; limit: number; names?: string[] } {
  let obj: Record<string, unknown> = {};
  try {
    obj =
      typeof raw === "string"
        ? raw.length
          ? JSON.parse(raw)
          : {}
        : raw && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : {};
  } catch {
    obj = {};
  }
  const query = typeof obj.query === "string" ? obj.query : "";
  const limitRaw =
    typeof obj.limit === "number" && Number.isFinite(obj.limit) ? obj.limit : DEFAULT_SEARCH_LIMIT;
  const names = Array.isArray(obj.names)
    ? obj.names
        .filter((name): name is string => typeof name === "string")
        .slice(0, MAX_SEARCH_LIMIT)
    : undefined;
  return {
    query,
    limit: Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.round(limitRaw))),
    ...(names === undefined ? {} : { names }),
  };
}

/**
 * Rank and byte-bound an already-authorized tool pool.
 * Callers classify the pool first: production native and generic search pass
 * the origin-classified lazy set (deferred MCP plus every non-MCP function
 * tool outside the always-visible base names).
 */
export function searchToolPool(availableTools: Tool[], rawArguments: unknown): Tool[] {
  // The Agents SDK can present the same configured tool reference more than once
  // while resolving multiple client tool_search calls from one model response.
  // Collapse only referential duplicates here: distinct objects with the same
  // routed identity must still reach the SDK's conflict checks and fail closed.
  const searchable = [...new Set(availableTools)].filter(
    (tool): tool is Tool & { name: string } =>
      tool.type === "function" && typeof (tool as { name?: unknown }).name === "string",
  );
  if (searchable.length === 0) return [];
  const { query, limit, names } = parseSearchArgs(rawArguments);
  // Exact disclosure is a lookup in this already-authorized pool, not a fuzzy
  // search or another executor registry. Keep the SDK's original references.
  const ranked = names
    ? searchable.filter((tool) => names.includes(tool.name))
    : bm25RankTools(searchable, query, searchable.length);
  const bounded: Tool[] = [];
  let disclosedBytes = 0;
  for (const tool of ranked) {
    const toolBytes = mcpSerializedSizeBytes(tool);
    if (toolBytes > MCP_MAX_TOOL_DEFINITION_BYTES) {
      continue;
    }
    if (disclosedBytes + toolBytes > MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES) {
      continue;
    }
    disclosedBytes += toolBytes;
    bounded.push(tool);
    if (bounded.length >= limit) break;
  }
  return bounded;
}
