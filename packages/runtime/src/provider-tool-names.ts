import { createHash } from "node:crypto";
import { ALIASED_MCP_TOOL_LEAF_LENGTH, isAliasedMcpToolName } from "./mcp-model-tool-name";

/**
 * Tool names the model writes (docs/model-providers.md, "Tool names in
 * history").
 *
 * Providers validate tool names in the request's tools and in every history
 * item that names a tool, and the one format they all accept, gateways
 * included, is `^[a-zA-Z0-9_-]{1,64}$`. Top-level names are valid by
 * construction (MCP names become `mcp_<digest>__<leaf>` aliases), but a model
 * can call a tool by its published `server.tool` form. One such call kept in
 * history would fail every later request of the chat with a 400, so the call
 * is given a valid name once, when the model's output item is received, and
 * is stored and replayed with that name: the authorized tool it denotes, or a
 * stable alias. Nothing already sent to the model is rewritten later.
 */

const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const DOTTED_NAME = /^[a-zA-Z0-9_.-]+$/;
const TOOL_NAME_SEPARATOR = "__";
const ALIAS_READABLE_LENGTH = 40;
const ALIAS_DIGEST_LENGTH = 16;

/** Whether every provider accepts this tool name. */
export function isProviderToolName(name: string): boolean {
  return PROVIDER_TOOL_NAME.test(name);
}

/**
 * The stable alias of a name no authorized tool answers to: its readable
 * part with every other character replaced, starting with a letter, and a
 * digest of the whole name, so two different names never share an alias.
 * Only letters, digits and `_`, at most 57 characters: narrower than any
 * provider's own format.
 */
export function providerToolNameAlias(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_]+/g, "_");
  const readable = (/^[a-zA-Z]/.test(replaced) ? replaced : `t${replaced}`).slice(
    0,
    ALIAS_READABLE_LENGTH,
  );
  const digest = createHash("sha256").update(name).digest("hex").slice(0, ALIAS_DIGEST_LENGTH);
  return `${readable}_${digest}`;
}

function uniqueMatch(candidates: readonly string[], matches: (name: string) => boolean) {
  let match: string | null = null;
  for (const candidate of candidates) {
    if (!matches(candidate)) continue;
    if (match !== null && match !== candidate) return null;
    match = candidate;
  }
  return match;
}

/**
 * The one known tool a dotted `server.tool` name denotes, or null: it names
 * `server__tool`, and a name its server publishes (`projects.search`) names
 * the one tool whose part after the last `__` is that name with punctuation
 * as `_` (bounded as MCP aliases bound it). Any other invalid name denotes
 * no known tool.
 */
export function knownToolNameFor(name: string, known: readonly string[]): string | null {
  const valid = known.filter(isProviderToolName);
  if (!name.includes(".") || !DOTTED_NAME.test(name)) return null;
  const dotted = name.replaceAll(".", TOOL_NAME_SEPARATOR);
  if (valid.includes(dotted)) return dotted;
  const published = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return uniqueMatch(valid, (candidate) => {
    const separator = candidate.lastIndexOf(TOOL_NAME_SEPARATOR);
    if (separator < 0) return false;
    const leaf = candidate.slice(separator + TOOL_NAME_SEPARATOR.length);
    return (
      leaf === published ||
      (isAliasedMcpToolName(candidate) && leaf === published.slice(0, ALIASED_MCP_TOOL_LEAF_LENGTH))
    );
  });
}

/**
 * The name a model-written tool call is stored and replayed with: its own
 * name when every provider accepts it or a known tool has it, else the one
 * known tool it denotes, else its stable alias (a call no tool answers).
 */
export function providerValidCallName(name: string, known: readonly string[]): string {
  if (isProviderToolName(name) || known.includes(name)) return name;
  return knownToolNameFor(name, known) ?? providerToolNameAlias(name);
}
