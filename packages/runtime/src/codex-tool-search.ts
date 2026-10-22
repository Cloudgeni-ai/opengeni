// Shared tool classification and bounded search ranking for lazy-tool-transport.ts.
import { type Tool } from "@openai/agents";
import type { FirstPartyMcpToolName } from "@opengeni/contracts";
import { ToolSearchIndex } from "./tool-discovery-ranking";
import {
  MCP_MAX_TOOL_DEFINITION_BYTES,
  MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES,
  mcpSerializedSizeBytes,
} from "./mcp-network";

/** The prefix Opengeni's PrefixedMcpServer stamps on codex_apps connector tools. */
export const CODEX_APPS_TOOL_PREFIX = "codex_apps__";
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

const MCP_TOOL_NAME_SEPARATOR = "__";
const NO_MCP_SERVER_IDS: ReadonlySet<string> = new Set();

/** Return the authorized server id for a runtime MCP function tool name. */
function mcpServerIdForTool(
  tool: unknown,
  mcpServerIds: ReadonlySet<string>,
  modelServerIds?: ReadonlyMap<string, string>,
): string | null {
  if (!tool || typeof tool !== "object") return null;
  if ((tool as { type?: unknown }).type !== "function") return null;
  const name = (tool as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const exact = modelServerIds?.get(name);
  if (exact !== undefined) return mcpServerIds.has(exact) ? exact : null;
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
 * Prepared servers supply their exact bounded-model-name map. Prefix lookup is
 * only the legacy embedded-server fallback. Neither path inspects the global
 * registry, connection metadata, or credentials, and both intersect the
 * already-authorized server set.
 */
export function isSearchableMcpFunctionTool(
  tool: unknown,
  mcpServerIds: ReadonlySet<string> = NO_MCP_SERVER_IDS,
  modelServerIds?: ReadonlyMap<string, string>,
): tool is Tool & { name: string; deferLoading?: boolean } {
  const serverId = mcpServerIdForTool(tool, mcpServerIds, modelServerIds);
  return serverId !== null;
}

/** The first-party server that hosts the harness control tools. */
export const HARNESS_CONTROL_MCP_SERVER_ID = "opengeni";

/**
 * First-party tools the harness itself relies on: goal lifecycle, background
 * command polling, and the session-level wait, plus excel_run, the only way to
 * reach a workbook the person has open in Excel, and sandbox_file_publish, the
 * last step of every task that hands the person a file. Hiding any of them
 * behind search spends a model round trip to rediscover the same schema (for
 * Excel, one of every four requests in a typical add-in chat; for a document
 * or spreadsheet the person asked for, one of every six). This is an exact
 * per-tool exception, never the whole `opengeni` catalog, and it never widens
 * authority: only a tool the attempt's prepared server actually listed
 * (selection and permissions already applied) can be visible.
 */
export const HARNESS_CONTROL_FIRST_PARTY_TOOLS = [
  "goal_set",
  "goal_update",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "command_read",
  "command_wait",
  "wait_for_input",
  "excel_run",
  "sandbox_file_publish",
] as const satisfies readonly FirstPartyMcpToolName[];

const HARNESS_CONTROL_MODEL_TOOL_NAMES: ReadonlySet<string> = new Set(
  HARNESS_CONTROL_FIRST_PARTY_TOOLS.map(
    (name) => `${HARNESS_CONTROL_MCP_SERVER_ID}${MCP_TOOL_NAME_SEPARATOR}${name}`,
  ),
);

/** True for an exact harness control tool name on the first-party server. */
export function isHarnessControlMcpToolName(registryId: string, modelName: string): boolean {
  return (
    registryId === HARNESS_CONTROL_MCP_SERVER_ID && HARNESS_CONTROL_MODEL_TOOL_NAMES.has(modelName)
  );
}

/**
 * First-party interaction tools that are only useful together. Disclosing one
 * member through search discloses the whole working set, so an agent that asks
 * for "a browser" gets open, observe, act, screenshot and tab control in one
 * search instead of rediscovering each schema in its own model round trip.
 * Members are matched by their name after the server separator and only ever
 * drawn from the already-authorized searchable pool.
 */
const INTERACTION_MCP_SERVER_ID = "interaction";
const INTERACTION_TOOL_FAMILIES: readonly (readonly string[])[] = [
  ["browser_open", "browser_observe", "browser_act", "browser_screenshot", "browser_tabs"],
  ["computer_open", "computer_observe", "computer_act"],
];

/** The interaction tool's name after its server prefix, or null for any other tool. */
function interactionToolName(name: string): string | null {
  const prefix = `${INTERACTION_MCP_SERVER_ID}${MCP_TOOL_NAME_SEPARATOR}`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

/** The other members of every family a disclosed tool belongs to, in family order. */
function familyCompanions<T extends Tool & { name: string }>(disclosed: T[], pool: T[]): T[] {
  const disclosedShort = new Set(
    disclosed.map((tool) => interactionToolName(tool.name)).filter((name) => name !== null),
  );
  const wanted = INTERACTION_TOOL_FAMILIES.filter((family) =>
    family.some((member) => disclosedShort.has(member)),
  ).flat();
  const companions: T[] = [];
  for (const member of wanted) {
    if (disclosedShort.has(member)) continue;
    const tool = pool.find((candidate) => interactionToolName(candidate.name) === member);
    if (tool && !companions.includes(tool)) companions.push(tool);
  }
  return companions;
}

/**
 * The tool that starts each interaction family. It stays in the first request,
 * so a browser or computer task begins with its first real call instead of a
 * search round trip, and opening discloses the rest of the family right after
 * the open result (see the lazy-tool transport). Only a tool the attempt
 * actually prepared can be visible: a first-party interaction tool, or one the
 * `interaction` server listed, never a same-named tool from another server.
 */
const INTERACTION_ENTRY_TOOLS: ReadonlySet<string> = new Set(["browser_open", "computer_open"]);

/** True when a prepared function tool is an interaction family's entry tool. */
export function isInteractionEntryFunctionTool(
  tool: unknown,
  mcpServerIds: ReadonlySet<string> = NO_MCP_SERVER_IDS,
  modelServerIds?: ReadonlyMap<string, string>,
): boolean {
  if (!tool || typeof tool !== "object" || (tool as { type?: unknown }).type !== "function") {
    return false;
  }
  const name = (tool as { name?: unknown }).name;
  if (typeof name !== "string" || !isInteractionEntryToolName(name)) return false;
  const serverId = mcpServerIdForTool(tool, mcpServerIds, modelServerIds);
  return serverId === null || serverId === INTERACTION_MCP_SERVER_ID;
}

/** True when a model tool name is an interaction family's entry tool. */
export function isInteractionEntryToolName(name: string): boolean {
  const short = interactionToolName(name);
  return short !== null && INTERACTION_ENTRY_TOOLS.has(short);
}

/**
 * The companions an entry tool discloses once it is called: the rest of its
 * family that is still searchable, within the same byte budgets as a search.
 */
export function interactionEntryCompanions(entryName: string, searchable: Tool[]): Tool[] {
  if (!isInteractionEntryToolName(entryName)) return [];
  const pool = searchable.filter(
    (tool): tool is Tool & { name: string } =>
      tool.type === "function" && typeof (tool as { name?: unknown }).name === "string",
  );
  const disclosed: Tool[] = [];
  let disclosedBytes = 0;
  for (const tool of familyCompanions([{ name: entryName } as Tool & { name: string }], pool)) {
    const toolBytes = mcpSerializedSizeBytes(tool);
    if (toolBytes > MCP_MAX_TOOL_DEFINITION_BYTES) continue;
    if (disclosedBytes + toolBytes > MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES) continue;
    disclosedBytes += toolBytes;
    disclosed.push(tool);
  }
  return disclosed;
}

/**
 * True when a prepared MCP function tool is one of the harness control tools
 * served by the authorized first-party `opengeni` server. These stay in the
 * first request on every transport even though the server's other schemas
 * are deferred.
 */
export function isHarnessControlMcpFunctionTool(
  tool: unknown,
  mcpServerIds: ReadonlySet<string> = NO_MCP_SERVER_IDS,
  modelServerIds?: ReadonlyMap<string, string>,
): boolean {
  const serverId = mcpServerIdForTool(tool, mcpServerIds, modelServerIds);
  return (
    serverId !== null && isHarnessControlMcpToolName(serverId, (tool as { name: string }).name)
  );
}

/** Field-aware lexical ranking; an empty or unmatched query returns no tools. */
export function bm25RankTools(tools: Tool[], query: string, limit: number): Tool[] {
  return new ToolSearchIndex(tools).rank(query, limit);
}

/**
 * Tools a free-text query names exactly, in query order. A query token that
 * contains "_" names a tool when it equals the tool's full model name or the
 * part after its last "__" server separator (`goal_complete` and
 * `opengeni__goal_complete` both name `opengeni__goal_complete`). Single words
 * such as "read" are never treated as names. Agents often search by exact name,
 * and BM25 alone ranked a neighbouring tool first for about a fifth of those
 * queries (`goal_complete` returned `goal_set` first).
 */
export function toolsNamedInQuery<T extends Tool & { name: string }>(
  tools: T[],
  query: string,
): T[] {
  const byName = new Map<string, T[]>();
  for (const tool of tools) {
    const full = tool.name.toLowerCase();
    const separator = full.lastIndexOf(MCP_TOOL_NAME_SEPARATOR);
    const short = separator >= 0 ? full.slice(separator + MCP_TOOL_NAME_SEPARATOR.length) : full;
    for (const key of new Set([full, short])) {
      const named = byName.get(key) ?? [];
      named.push(tool);
      byName.set(key, named);
    }
  }
  const named: T[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9_]+/)) {
    const token = raw.replace(/^_+|_+$/g, "");
    if (!token.includes("_")) continue;
    for (const tool of byName.get(token) ?? []) {
      if (!named.includes(tool)) named.push(tool);
    }
  }
  return named;
}

/** Parse ranked or exact-name discovery arguments (string or object). */
export function parseSearchArgs(raw: unknown): { query: string; limit: number; names?: string[] } {
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
export function rankToolPool(
  availableTools: Tool[],
  rawArguments: unknown,
  index?: ToolSearchIndex,
): Tool[] {
  // The Agents SDK can present the same configured tool reference more than once
  // while resolving multiple client tool_search calls from one model response.
  // Collapse only referential duplicates here: distinct objects with the same
  // routed identity must still reach the SDK's conflict checks and fail closed.
  const searchable = [...new Set(availableTools)].filter(
    (tool): tool is Tool & { name: string } =>
      tool.type === "function" && typeof (tool as { name?: unknown }).name === "string",
  );
  if (searchable.length === 0) return [];
  const { query, limit: requestedLimit, names } = parseSearchArgs(rawArguments);
  let ranked: Tool[];
  let limit = requestedLimit;
  if (names) {
    // Exact disclosure is a lookup in this already-authorized pool, not a fuzzy
    // search or another executor registry. Keep the SDK's original references.
    ranked = [...new Set(names)].flatMap((name) => searchable.filter((tool) => tool.name === name));
    limit = names.length;
  } else {
    // Every tool the query names comes first, even beyond the requested limit;
    // BM25 fills any remaining places.
    const named = toolsNamedInQuery(searchable, query);
    ranked = [
      ...named,
      ...(index ?? new ToolSearchIndex(searchable))
        .rank(query, searchable.length)
        .filter(
          (tool) =>
            searchable.includes(tool as Tool & { name: string }) &&
            !named.includes(tool as Tool & { name: string }),
        ),
    ];
    limit = Math.min(MAX_SEARCH_LIMIT, Math.max(requestedLimit, named.length));
  }
  return ranked.slice(0, limit);
}

/** Full-schema disclosure is separate from compact ranking; original SDK objects only. */
export function searchToolPool(availableTools: Tool[], rawArguments: unknown): Tool[] {
  const searchable = [...new Set(availableTools)].filter(
    (tool): tool is Tool & { name: string } =>
      tool.type === "function" && typeof (tool as { name?: unknown }).name === "string",
  );
  const { query, names, limit: requestedLimit } = parseSearchArgs(rawArguments);
  // Rank the entire pool before applying existing schema budgets, so an oversize
  // definition cannot displace later candidates that fit.
  const named = names ? [] : toolsNamedInQuery(searchable, query);
  const ranked = names
    ? [...new Set(names)].flatMap((name) => searchable.filter((tool) => tool.name === name))
    : [
        ...named,
        ...new ToolSearchIndex(searchable)
          .rank(query, searchable.length)
          .filter((tool) => !named.includes(tool as Tool & { name: string })),
      ];
  const limit = names
    ? names.length
    : Math.min(MAX_SEARCH_LIMIT, Math.max(requestedLimit, named.length));
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
  // Complete any interaction family a result belongs to. Companions come after
  // the ranked results, so they never displace them, and they still respect the
  // per-tool and total disclosure byte budgets (but not the result count limit).
  for (const tool of familyCompanions(bounded as (Tool & { name: string })[], searchable)) {
    if (bounded.includes(tool)) continue;
    const toolBytes = mcpSerializedSizeBytes(tool);
    if (toolBytes > MCP_MAX_TOOL_DEFINITION_BYTES) continue;
    if (disclosedBytes + toolBytes > MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES) continue;
    disclosedBytes += toolBytes;
    bounded.push(tool);
  }
  return bounded;
}
