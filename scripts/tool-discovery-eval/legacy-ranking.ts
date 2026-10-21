/** Frozen lexical baseline from runtime/codex-tool-search.ts at cbb55f394. */
import type { Tool } from "@openai/agents";
import { parseSearchArgs, toolsNamedInQuery } from "../../packages/runtime/src/codex-tool-search";
import {
  MCP_MAX_TOOL_DEFINITION_BYTES,
  MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES,
  mcpSerializedSizeBytes,
} from "../../packages/runtime/src/mcp-network";

const STOPWORDS = new Set(
  "a an the and or of to in on for with by at is are be do does my me your you it its this that from as up out all some any can will would should want need please user users".split(
    " ",
  ),
);

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export function legacyRankTools(tools: Tool[], query: string, limit: number): Tool[] {
  const qTokens = [...new Set(tokenize(query))];
  if (!tools.length || !qTokens.length) return [];
  const docs = tools.map((tool) => {
    if (tool.type !== "function") throw new Error("Expected a function tool");
    const name = tool.name.replace(/^codex_apps__/, "");
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties;
    const tokens = tokenize(
      `${name} ${name} ${tool.description} ${Object.keys(props ?? {}).join(" ")}`,
    );
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tool, len: tokens.length, tf };
  });
  const N = docs.length;
  const avgdl = Math.max(1, docs.reduce((s, d) => s + d.len, 0) / N);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return docs
    .map((d) => {
      let score = 0;
      for (const qt of qTokens) {
        const n = df.get(qt);
        const f = d.tf.get(qt);
        if (!n || !f) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * 2.5) / (f + 1.5 * (0.25 + (0.75 * d.len) / avgdl)));
      }
      return { tool: d.tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.tool);
}

/** cbb55f394 disclosure: exact-name promotion, original budgets and family expansion. */
export function legacySearchTools(tools: Tool[], arguments_: unknown): Tool[] {
  const pool = [...new Set(tools)].filter(
    (t): t is Tool & { name: string } => t.type === "function",
  );
  const { query, names, limit: requested } = parseSearchArgs(arguments_);
  const named = names ? [] : toolsNamedInQuery(pool, query);
  const ranked = names
    ? pool.filter((t) => names.includes(t.name))
    : [
        ...named,
        ...legacyRankTools(pool, query, pool.length).filter(
          (t) => !named.includes(t as Tool & { name: string }),
        ),
      ];
  const limit = names ? requested : Math.min(20, Math.max(requested, named.length));
  const selected: Tool[] = [];
  let bytes = 0;
  const add = (tool: Tool) => {
    const size = mcpSerializedSizeBytes(tool);
    if (size > MCP_MAX_TOOL_DEFINITION_BYTES || bytes + size > MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES)
      return;
    bytes += size;
    selected.push(tool);
  };
  for (const tool of ranked) {
    add(tool);
    if (selected.length >= limit) break;
  }
  const families = [
    ["browser_open", "browser_observe", "browser_act", "browser_screenshot", "browser_tabs"],
    ["computer_open", "computer_observe", "computer_act"],
  ];
  for (const family of families) {
    if (
      !selected.some(
        (t) => t.type === "function" && family.some((n) => t.name === `interaction__${n}`),
      )
    )
      continue;
    for (const name of family) {
      const tool = pool.find((t) => t.name === `interaction__${name}`);
      if (tool && !selected.includes(tool)) add(tool);
    }
  }
  return selected;
}
