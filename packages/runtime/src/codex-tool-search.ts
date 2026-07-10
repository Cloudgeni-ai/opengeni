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
// PROVEN LIVE (Phase 0 probe against /codex/responses on gpt-5.6-sol): the backend
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
export function isCodexAppsFunctionTool(
  tool: unknown,
): tool is Tool & { name: string; deferLoading?: boolean } {
  return (
    !!tool &&
    typeof tool === "object" &&
    (tool as { type?: unknown }).type === "function" &&
    typeof (tool as { name?: unknown }).name === "string" &&
    (tool as { name: string }).name.startsWith(CODEX_APPS_TOOL_PREFIX)
  );
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

/** Parse `{query, limit}` from a tool_search_call's arguments (string or object). */
function parseSearchArgs(raw: unknown): { query: string; limit: number } {
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
  return { query, limit: Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.round(limitRaw))) };
}

/**
 * Render the search tool's description from the account's ACTUALLY-connected
 * sources — codex-rs parity (its create_tool_search_tool builds "You have access
 * to tools from the following sources:\n- <name>" from the live enabled-source
 * list). With defer_loading stripping every connector schema (and name) from
 * model context, this description is the model's ONLY signal of which apps
 * exist, so a hardcoded list would both advertise absent connectors and hide
 * present ones.
 */
export function renderSearchToolDescription(connectorNamespaces: ReadonlySet<string>): string {
  const base =
    "Search the user's connected app tools by capability. " +
    'Describe in plain language WHAT you need to do (for example: "send an email", "create a calendar event") ' +
    "rather than guessing exact tool names. Returns the matching connector tools, which then become callable.";
  const sources = Array.from(connectorNamespaces)
    .filter((n) => typeof n === "string" && n.length > 0)
    .sort();
  if (sources.length === 0) {
    return `${base}\nConnected sources: none currently available.`;
  }
  return `${base}\nYou have access to tools from the following sources:\n${sources.map((s) => `- ${s}`).join("\n")}`;
}

const SEARCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Plain-language description of the capability you need.",
    },
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
function codexToolSearchExecutor(args: {
  availableTools?: Tool[];
  toolCall?: { arguments?: unknown };
}): Tool[] {
  const deferred = (args.availableTools ?? []).filter(isCodexAppsFunctionTool);
  if (deferred.length === 0) return [];
  const { query, limit } = parseSearchArgs(args.toolCall?.arguments);
  return bm25RankTools(deferred, query, limit);
}

const NO_NAMESPACES: ReadonlySet<string> = new Set();

/** True when the namespace set contains at least one usable (non-empty string) source — mirrors {@link renderSearchToolDescription}'s filter, so it is TRUE exactly when the render produces the "following sources" list and FALSE when it produces "none currently available". */
function hasConnectorSources(connectorNamespaces: ReadonlySet<string>): boolean {
  for (const namespace of connectorNamespaces) {
    if (typeof namespace === "string" && namespace.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * A per-TURN freeze cell for the tool_search description (AM-8). The connector Set
 * `installCodexToolSearch` reads is LIVE and by-reference — it fills as the turn's
 * codex_apps tools/list resolves and can change between a turn's model calls.
 * Re-rendering the description per call from a changed Set flips the tools block,
 * and because tools precede the history in the request prefix, ANY change misses the
 * ENTIRE conversation prefix from that point on — a proven prompt-cache breaker.
 *
 * We therefore freeze the description ONCE, at the first model call whose Set has
 * been populated (connectors discovered), and reuse that frozen string for the rest
 * of the turn — trading a slightly staler connector list for a byte-stable prefix.
 * The freeze is created per {@link installCodexToolSearch} (once per turn) and shared
 * by reference into every clone re-install, so all of a turn's clones agree.
 */
export type CodexToolSearchDescriptionFreeze = { value: string | null };

/**
 * Resolve the tool_search description for this model call, honoring the per-turn
 * freeze (AM-8):
 *  - Already frozen ⇒ return the frozen string (byte-stable for the rest of the turn).
 *  - Not yet frozen + connectors DISCOVERED (non-empty Set) ⇒ render and FREEZE it,
 *    locking the discovered list against a later same-turn Set mutation.
 *  - Not yet frozen + Set still EMPTY ⇒ render live ("none currently available") but
 *    do NOT freeze. This is the load-bearing safety of AM-8: the Set fills lazily and
 *    best-effort, so an empty Set means "not discovered yet", not "no connectors".
 *    Freezing "none" here would silently disable the turn's connectors (capability
 *    loss). Leaving it unfrozen is still byte-stable while the Set stays empty (the
 *    empty render is a constant), and lets a later call freeze the real list once it
 *    resolves — at most ONE prefix transition, versus today's per-call churn.
 * With no freeze cell (the default / direct callers + tests) this is a live render,
 * byte-for-byte the pre-AM-8 behavior.
 */
function resolveSearchToolDescription(
  connectorNamespaces: ReadonlySet<string>,
  freeze?: CodexToolSearchDescriptionFreeze,
): string {
  if (freeze?.value != null) {
    return freeze.value;
  }
  const rendered = renderSearchToolDescription(connectorNamespaces);
  if (freeze && hasConnectorSources(connectorNamespaces)) {
    freeze.value = rendered;
  }
  return rendered;
}

/** Build the client-executed tool_search tool from an already-rendered description. */
function buildCodexToolSearchToolFromDescription(description: string): Tool {
  return toolSearchTool({
    execution: "client",
    description,
    parameters: SEARCH_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    execute: codexToolSearchExecutor as never,
  }) as unknown as Tool;
}

/** Build the client-executed tool_search tool that discloses codex_apps connectors on demand. */
export function buildCodexToolSearchTool(
  connectorNamespaces: ReadonlySet<string> = NO_NAMESPACES,
): Tool {
  return buildCodexToolSearchToolFromDescription(renderSearchToolDescription(connectorNamespaces));
}

/** True for the built-in tool_search tool (so we never add a second one). */
function isToolSearchTool(tool: unknown): boolean {
  const t = tool as { name?: unknown; providerData?: { type?: unknown } } | null;
  return !!t && (t.name === "tool_search" || t.providerData?.type === "tool_search");
}

/**
 * The transform applied to a turn's resolved tool list: tag every codex_apps
 * connector function tool `deferLoading = true`, and — unless one is already
 * present — append the client tool_search tool. Pure (mutates the passed tools +
 * returns the possibly-extended array); the SDK's `getTools` gate requires a
 * tool_search whenever a deferred tool is present, which appending here satisfies
 * in the same request.
 *
 * The search tool is appended UNCONDITIONALLY (even when the turn has no
 * codex_apps tools, e.g. the best-effort codex_apps connect was dropped this
 * turn): a prior turn's history may carry tool_search_call/output items, and
 * replaying those without a tool_search tool in the request risks a backend
 * reject; a search over an empty pool simply discloses nothing. The description
 * reflects the LIVE connector namespaces, so an empty turn reads
 * "none currently available".
 */
export function applyCodexToolSearch(
  tools: Tool[],
  connectorNamespaces: ReadonlySet<string> = NO_NAMESPACES,
  descriptionFreeze?: CodexToolSearchDescriptionFreeze,
): Tool[] {
  for (const tool of tools) {
    if (
      isCodexAppsFunctionTool(tool) &&
      (tool as { deferLoading?: boolean }).deferLoading !== true
    ) {
      (tool as { deferLoading?: boolean }).deferLoading = true;
    }
  }
  if (tools.some(isToolSearchTool)) {
    return tools;
  }
  // AM-8: render through the per-turn freeze so the tools-block prefix stays
  // byte-stable across a turn's model calls once connectors are discovered.
  const description = resolveSearchToolDescription(connectorNamespaces, descriptionFreeze);
  return [...tools, buildCodexToolSearchToolFromDescription(description)];
}

type CloneCapableAgent = {
  getAllTools: (runContext: unknown) => Promise<Tool[]>;
  clone?: (config: unknown) => CloneCapableAgent;
};

/**
 * Install progressive connector disclosure on a codex-path agent by wrapping
 * `getAllTools` so every per-model-call tool resolution runs
 * {@link applyCodexToolSearch}. Idempotent-per-call (re-tags each
 * freshly-materialized MCP tool under cacheToolsList:false). Gated by the caller
 * (flag + codex path).
 *
 * CLONE SURVIVAL (the part that makes this work on the REAL sandbox path): the
 * SDK's sandbox runtime routes EVERY model call through
 * `prepareSandboxAgent → agent.clone(...)` (agentPreparation.js), and
 * `SandboxAgent.clone` constructs a FRESH agent from a fixed field list — an
 * instance-own `getAllTools` override is NOT copied, so patching only this
 * instance would silently no-op the whole feature on sandbox turns (the run
 * loop resolves tools on the CLONE). We therefore also wrap `clone` to
 * RE-INSTALL onto every clone, recursively — covering clone-of-clone and the
 * RunState resume paths. `connectorNamespaces` is the LIVE, by-reference Set the
 * codex_apps sanitizing transport fills during each turn's tools/list
 * (prepareAgentTools), so by the time the wrapper post-processes getAllTools the
 * current turn's connector sources are known.
 */
export function installCodexToolSearch(
  agent: CloneCapableAgent,
  connectorNamespaces: ReadonlySet<string> = NO_NAMESPACES,
): void {
  // ONE freeze cell per install (i.e. per turn), shared BY REFERENCE into every
  // clone re-install below so the whole turn — the built agent and every clone the
  // sandbox runtime resolves tools on — agrees on the same frozen description
  // (AM-8). Created here, at the top-level install, never per clone.
  installCodexToolSearchWithFreeze(agent, connectorNamespaces, { value: null });
}

function installCodexToolSearchWithFreeze(
  agent: CloneCapableAgent,
  connectorNamespaces: ReadonlySet<string>,
  descriptionFreeze: CodexToolSearchDescriptionFreeze,
): void {
  const originalGetAllTools = agent.getAllTools.bind(agent);
  agent.getAllTools = (async (runContext: unknown) =>
    applyCodexToolSearch(
      await originalGetAllTools(runContext),
      connectorNamespaces,
      descriptionFreeze,
    )) as typeof agent.getAllTools;
  const originalClone = agent.clone?.bind(agent);
  if (originalClone) {
    const cloneWithToolSearch: NonNullable<CloneCapableAgent["clone"]> = (config: unknown) => {
      const cloned = originalClone(config);
      installCodexToolSearchWithFreeze(cloned, connectorNamespaces, descriptionFreeze);
      return cloned;
    };
    agent.clone = cloneWithToolSearch;
  }
}
