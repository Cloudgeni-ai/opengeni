/**
 * Claude's server-side web search on the native Messages API.
 *
 * Anthropic runs the search inside the request and returns `server_tool_use`
 * and `web_search_tool_result` blocks among the assistant content. Later
 * requests must send those blocks back exactly as received: each result's
 * `encrypted_content` (and each citation's `encrypted_index`) is how the API
 * restores the search results in Claude's context.
 *
 * Canonical history keeps the raw blocks inside an SDK `hosted_tool_call`
 * item shaped like a Responses `web_search_call`, so the timeline, final-reply
 * and analytics paths that already understand hosted search keep working. The
 * Claude transport replays `providerData.anthropic.blocks` verbatim; every
 * other provider receives the portable evidence projection instead.
 */

type Json = Record<string, any>;

/** The basic search version: direct calls only, available on every Claude route. */
export const ANTHROPIC_WEB_SEARCH_TOOL = Object.freeze({
  type: "web_search_20250305",
  name: "web_search",
});
export const ANTHROPIC_WEB_SEARCH_TOOL_NAME = ANTHROPIC_WEB_SEARCH_TOOL.name;

/** Agent hosted-tool descriptors that mean "the provider's own web search". */
export function isHostedWebSearchTool(tool: {
  type?: unknown;
  providerData?: { type?: unknown } | null | undefined;
}): boolean {
  return (
    tool.type === "hosted_tool" &&
    (tool.providerData?.type === "web_search" || tool.providerData?.type === "web_search_preview")
  );
}

export function isAnthropicWebSearchBlock(block: Json): boolean {
  return (
    (block.type === "server_tool_use" && block.name === ANTHROPIC_WEB_SEARCH_TOOL_NAME) ||
    block.type === "web_search_tool_result"
  );
}

/** A Claude search item retained in canonical history. */
export function isAnthropicWebSearchItem(item: Record<string, unknown>): boolean {
  if (item.type !== "hosted_tool_call") return false;
  const blocks = (item.providerData as Json | undefined)?.anthropic?.blocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

/** The exact provider blocks to send back to Claude, in their original order. */
export function anthropicWebSearchBlocks(item: Record<string, unknown>): Json[] {
  const blocks = (item.providerData as Json).anthropic.blocks as unknown[];
  return blocks.map((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block))
      throw new Error("Stored Claude web search block is malformed");
    return structuredClone(block as Json);
  });
}

export type AnthropicWebSearchResultEntry = { url: string; title?: string; pageAge?: string };

/** Readable facts of one stored search: never the encrypted payloads. */
export function anthropicWebSearchFacts(item: Record<string, unknown>): {
  query?: string;
  status: "completed" | "failed" | "requested";
  results?: AnthropicWebSearchResultEntry[];
  resultCount?: number;
  errorCode?: string;
} {
  const blocks = ((item.providerData as Json | undefined)?.anthropic?.blocks ?? []) as Json[];
  const call = blocks.find((block) => block?.type === "server_tool_use");
  const result = blocks.find((block) => block?.type === "web_search_tool_result");
  const storedQuery = (item.providerData as Json | undefined)?.action?.query;
  const query =
    typeof call?.input?.query === "string"
      ? call.input.query
      : typeof storedQuery === "string"
        ? storedQuery
        : undefined;
  const base = query === undefined ? {} : { query };
  if (!result) return { ...base, status: "requested" };
  if (Array.isArray(result.content)) {
    const results: AnthropicWebSearchResultEntry[] = [];
    for (const entry of result.content as Json[]) {
      if (entry?.type !== "web_search_result" || typeof entry.url !== "string") continue;
      results.push({
        url: entry.url,
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        ...(typeof entry.page_age === "string" ? { pageAge: entry.page_age } : {}),
      });
    }
    return { ...base, status: "completed", results, resultCount: result.content.length };
  }
  const code = result.content?.error_code;
  return {
    ...base,
    status: "failed",
    errorCode: typeof code === "string" ? code : "unknown",
  };
}

/**
 * One canonical item for adjacent search blocks: the call and, when Claude
 * already ran it, its result. A result for a call made in an earlier response
 * (a search deferred behind our own tool calls) is its own item and takes the
 * query from that earlier call. The id is unique per response block; the
 * shared call id lets the timeline show one row for the search.
 */
export function anthropicWebSearchItem(input: {
  id: string;
  blocks: Json[];
  queriesByCallId?: ReadonlyMap<string, string>;
}): Record<string, unknown> {
  const call = input.blocks.find((block) => block.type === "server_tool_use");
  const result = input.blocks.find((block) => block.type === "web_search_tool_result");
  const callId: unknown = call?.id ?? result?.tool_use_id;
  if (typeof callId !== "string" || !callId)
    throw new Error("Claude web search block has no tool use id");
  if (call && result && result.tool_use_id !== call.id)
    throw new Error("Claude web search result does not answer its call");
  const query =
    typeof call?.input?.query === "string" ? call.input.query : input.queriesByCallId?.get(callId);
  const draft = { providerData: { anthropic: { blocks: input.blocks }, action: { query } } };
  const facts = anthropicWebSearchFacts(draft);
  return {
    type: "hosted_tool_call",
    id: input.id,
    name: "web_search_call",
    ...(query === undefined ? {} : { arguments: JSON.stringify({ query }) }),
    // Provider-executed: nothing remains for Opengeni to run. A search that
    // Claude deferred behind our tool calls runs at the start of the next
    // request and arrives there as its own result item.
    status: facts.status === "failed" ? "failed" : "completed",
    providerData: {
      type: "web_search_call",
      call_id: callId,
      action: {
        type: "search",
        ...(query === undefined ? {} : { query }),
        ...(facts.results
          ? { sources: facts.results.map((entry) => ({ type: "url", url: entry.url })) }
          : {}),
      },
      ...(facts.errorCode ? { error: { code: facts.errorCode } } : {}),
      anthropic: { blocks: input.blocks.map((block) => structuredClone(block)) },
    },
  };
}

/** Queries of every stored Claude search call, so a deferred result can be labelled. */
export function anthropicWebSearchQueries(input: unknown): Map<string, string> {
  const queries = new Map<string, string>();
  if (!Array.isArray(input)) return queries;
  for (const item of input) {
    if (!item || typeof item !== "object" || !isAnthropicWebSearchItem(item)) continue;
    for (const block of (item as Json).providerData.anthropic.blocks as Json[]) {
      if (block?.type === "server_tool_use" && typeof block.input?.query === "string")
        queries.set(block.id, block.input.query);
    }
  }
  return queries;
}

/**
 * Inert transcript text for a search block Claude can no longer continue (an
 * interrupted search, or a result whose call was compacted away). Contains
 * only readable facts and is a pure function of the block, so the request
 * prefix stays byte-identical on every later request.
 */
export function anthropicWebSearchBlockFact(block: Json): Json {
  const fact =
    block.type === "server_tool_use"
      ? {
          search: "not_completed",
          ...(typeof block.input?.query === "string" ? { query: block.input.query } : {}),
        }
      : (() => {
          const facts = anthropicWebSearchFacts({
            providerData: { anthropic: { blocks: [block] } },
          });
          return {
            search: facts.status,
            ...(facts.errorCode ? { error: facts.errorCode } : {}),
            ...(facts.results
              ? {
                  results: facts.results.map((entry) => ({
                    url: entry.url,
                    ...(entry.title === undefined ? {} : { title: entry.title }),
                  })),
                }
              : {}),
          };
        })();
  return {
    type: "text",
    text: `[Opengeni historical web search fact; the page contents are no longer available]\n${JSON.stringify(fact)}`,
  };
}
