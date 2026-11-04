import { createHash } from "node:crypto";
import { SECRET_VALUE_MASK_MIN_CHARS } from "@opengeni/contracts";
import { ALIASED_MCP_TOOL_LEAF_LENGTH, isAliasedMcpToolName } from "./mcp-model-tool-name";

/**
 * Tool names in replayed history (docs/model-providers.md, "Tool names on
 * the wire").
 *
 * Providers validate tool names in the request's tools and in every history
 * item that carries tool definitions (`tool_search_output`, `additional_tools`)
 * or names a tool (`function_call`, a Chat tool call, a Claude `tool_use`).
 * The one format they all accept, gateways included, is
 * `^[a-zA-Z0-9_-]{1,64}$`. Top-level names are valid by construction (MCP
 * names become `mcp_<digest>__<leaf>` aliases), but stored history can hold a
 * name that is not: before tool identities were exempt from secret masking, a
 * known secret value inside a tool name was stored as its secret reference
 * or credential marker, and an agent can name a tool in its published
 * `server.tool` form. One such item fails every later request of the chat
 * with a 400.
 *
 * `withProviderValidToolNames` gives each such name one valid name, the same
 * wherever it appears in the request. With the authorized catalog (the lazy
 * tool transport) a flat name becomes the one tool it denotes, so a later call
 * binds to it, and every other name is left as it is: a Chat call replays as a
 * historical fact, and the outbound guard (`provider-request-tool-names.ts`)
 * gives every name still invalid on the wire its stable alias. A request
 * tool's own name is never rewritten. Valid names, and items without an
 * invalid one, are returned unchanged and by identity, and a rewritten item
 * keeps its identity across requests while the mapping is the same, so
 * append-only prompt-cache prefixes stay byte-identical.
 */

const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_NAME_PART = /^[a-zA-Z0-9_-]*$/;
const DOTTED_NAME = /^[a-zA-Z0-9_.-]+$/;
const TOOL_NAME_SEPARATOR = "__";
const ALIAS_READABLE_LENGTH = 40;
const ALIAS_DIGEST_LENGTH = 16;
const TOOL_DISCLOSURE_KEY_PREFIX = "opengeni.tool_disclosure";
/** The labels secret masking and redaction write in place of a value. */
const MASKING_LABEL =
  /\{\{secret:[^{}]*\}\}|\[opengeni credential:[^\]]*\]|\[masked [^\]]*\]|\[redacted:[^\]]*\]|\[secret\]/g;

/** Whether every provider accepts this tool name. */
export function isProviderToolName(name: string): boolean {
  return PROVIDER_TOOL_NAME.test(name);
}

/**
 * The stable alias of a tool name: its readable part with every other
 * character replaced, starting with a letter, and a digest of the whole
 * name, so two different names never share an alias. Only letters, digits
 * and `_`, at most 57 characters: narrower than any provider's own format.
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * The one known tool an invalid flat name denotes, or null:
 * - a dotted `server.tool` names `server__tool`, and a name its server
 *   publishes (`projects.search`) names the one tool whose part after the
 *   last `__` is that name with punctuation as `_` (bounded as MCP aliases
 *   bound it);
 * - a name with masking labels (a secret reference, credential, masked or
 *   redacted marker) names the one tool whose name is the rest with each
 *   label standing for at least as many valid characters as a masked value
 *   has.
 * Any other invalid character means no known tool is guessed.
 */
export function knownToolNameFor(name: string, known: readonly string[]): string | null {
  const valid = known.filter(isProviderToolName);
  if (name.includes(".") && DOTTED_NAME.test(name)) {
    const dotted = name.replaceAll(".", TOOL_NAME_SEPARATOR);
    if (valid.includes(dotted)) return dotted;
    const published = name.replace(/[^a-zA-Z0-9_]/g, "_");
    return uniqueMatch(valid, (candidate) => {
      const separator = candidate.lastIndexOf(TOOL_NAME_SEPARATOR);
      if (separator < 0) return false;
      const leaf = candidate.slice(separator + TOOL_NAME_SEPARATOR.length);
      return (
        leaf === published ||
        (isAliasedMcpToolName(candidate) &&
          leaf === published.slice(0, ALIASED_MCP_TOOL_LEAF_LENGTH))
      );
    });
  }
  if (!name.match(MASKING_LABEL)) return null;
  const parts = name.split(MASKING_LABEL);
  if (!parts.every((part) => VALID_NAME_PART.test(part))) return null;
  if (parts.every((part) => part.length === 0)) return null;
  const pattern = new RegExp(
    `^${parts.map(escapeRegExp).join(`[a-zA-Z0-9_-]{${SECRET_VALUE_MASK_MIN_CHARS},}`)}$`,
  );
  return uniqueMatch(valid, (candidate) => pattern.test(candidate));
}

/** The tools history names are checked against. */
export type ToolNameCatalog = {
  /** Model names of the tools; a history name equal to one is never rewritten. */
  names: readonly string[];
  /**
   * Bind an invalid flat name to the one tool it denotes. Only with the
   * complete authorized catalog: a partial list would make a wrong unique fit
   * likely. Otherwise every invalid name gets its alias.
   */
  denote?: boolean;
  /**
   * A tool's parameters schema. A stored definition of the invalid name
   * whose parameters differ is another tool, so the name keeps its alias.
   */
  parametersOf?: (name: string) => unknown;
  /**
   * Give a name no tool is bound to its stable alias. Default true. False
   * replaces only bound names and leaves the rest for the provider
   * projection, which knows the route: an alias on Responses and Claude, a
   * historical fact on Chat (a call to an undeclared tool is not replayed as
   * a native call).
   */
  aliasUnbound?: boolean;
};

/**
 * Where a tool name sits: `flat` for a call's or definition's own name, as
 * the request's tools carry it; `scoped` for a namespace and for the leaf
 * names inside one, which never denote a flat tool.
 */
type NamePosition = "flat" | "scoped";
type ToolNameVisitor = (name: string, position: NamePosition, definition?: unknown) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** History items that name the tool they call or answer. */
const NAMED_CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "function_call_result",
  "custom_tool_call",
]);

function hasNamespace(record: Record<string, unknown>): boolean {
  return typeof record.namespace === "string" && record.namespace.length > 0;
}

/** A call or definition with its name, namespace and nested definitions made valid. */
function rewriteNamed(record: unknown, visit: ToolNameVisitor, scoped: boolean): unknown {
  if (!isRecord(record)) return record;
  const isNamespace = record.type === "namespace";
  const nameScoped = scoped || isNamespace || hasNamespace(record);
  let next: Record<string, unknown> | null = null;
  if (typeof record.name === "string") {
    const definition = record.type === "function" ? record : undefined;
    const valid = visit(record.name, nameScoped ? "scoped" : "flat", definition);
    if (valid !== record.name) next = { ...record, name: valid };
  }
  if (typeof record.namespace === "string") {
    const valid = visit(record.namespace, "scoped");
    if (valid !== record.namespace) next = { ...(next ?? record), namespace: valid };
  }
  if (Array.isArray(record.tools)) {
    const tools = rewriteDefinitions(record.tools, visit, scoped || isNamespace);
    if (tools !== record.tools) next = { ...(next ?? record), tools };
  }
  return next ?? record;
}

/**
 * A list of definitions made valid. When a name changed, a definition that
 * repeats an earlier one's name denotes the same tool and is dropped,
 * whichever of the two was rewritten: providers reject a list that declares
 * one name twice.
 */
function rewriteDefinitions(tools: unknown[], visit: ToolNameVisitor, scoped: boolean): unknown[] {
  let changed = false;
  const rewritten = tools.map((tool) => {
    const next = rewriteNamed(tool, visit, scoped);
    if (next !== tool) changed = true;
    return next;
  });
  if (!changed) return tools;
  const seen = new Set<string>();
  return rewritten.filter((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return true;
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

/** The same record with its `tools` definitions rewritten, or the record itself. */
function withRewrittenTools(
  record: Record<string, unknown>,
  visit: ToolNameVisitor,
): Record<string, unknown> {
  if (!Array.isArray(record.tools)) return record;
  const tools = rewriteDefinitions(record.tools, visit, false);
  return tools === record.tools ? record : { ...record, tools };
}

/** Whether providerData holds tool definitions under `tools`. */
function declaresTools(providerData: Record<string, unknown>): boolean {
  return providerData.type === "additional_tools" || providerData.type === "tool_search_output";
}

/**
 * Visit every tool-name position of one history item: a call's own name and
 * namespace, the definitions of a `tool_search_output`, and definitions
 * carried in providerData (the provider-neutral disclosure,
 * `opengeni.tool_disclosure.v1`, and its Responses `additional_tools`
 * projection).
 */
function rewriteItem(item: unknown, visit: ToolNameVisitor): unknown {
  if (!isRecord(item)) return item;
  const type = typeof item.type === "string" ? item.type : "";
  if (NAMED_CALL_TYPES.has(type)) return rewriteNamed(item, visit, false);
  let next = type === "tool_search_output" ? withRewrittenTools(item, visit) : item;
  if (isRecord(next.providerData)) {
    const providerData = next.providerData;
    let data = declaresTools(providerData) ? withRewrittenTools(providerData, visit) : providerData;
    for (const [key, value] of Object.entries(providerData)) {
      if (!key.startsWith(TOOL_DISCLOSURE_KEY_PREFIX) || !isRecord(value)) continue;
      const rewritten = withRewrittenTools(value, visit);
      if (rewritten !== value) data = { ...data, [key]: rewritten };
    }
    if (data !== providerData) next = { ...next, providerData: data };
  }
  return next;
}

/** Invalid tool names in the positions withProviderValidToolNames rewrites. */
export function invalidHistoryToolNames(items: readonly unknown[]): string[] {
  const names = new Set<string>();
  const collect: ToolNameVisitor = (name) => {
    if (!isProviderToolName(name)) names.add(name);
    return name;
  };
  for (const item of items) rewriteItem(item, collect);
  return [...names];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Rewritten items by original item and mapping, so a replayed item keeps its identity. */
const rewrittenItems = new WeakMap<object, { mapping: string; item: unknown }>();

/**
 * History with every tool name a provider would reject replaced by one valid
 * name, the same in every item (see the module comment).
 */
export function withProviderValidToolNames<T>(
  items: T[],
  catalog: ToolNameCatalog = { names: [] },
): T[] {
  const known = new Set(catalog.names);
  const flat = new Set<string>();
  const scoped = new Set<string>();
  const storedParameters = new Map<string, Set<string>>();
  const collect: ToolNameVisitor = (name, position, definition) => {
    if (isProviderToolName(name) || known.has(name)) return name;
    (position === "flat" ? flat : scoped).add(name);
    if (position === "flat" && isRecord(definition) && definition.parameters !== undefined) {
      const stored = storedParameters.get(name) ?? new Set<string>();
      stored.add(stableJson(definition.parameters));
      storedParameters.set(name, stored);
    }
    return name;
  };
  for (const item of items) rewriteItem(item, collect);
  if (flat.size === 0 && scoped.size === 0) return items;

  const aliasUnbound = catalog.aliasUnbound !== false;
  const flatNames = new Map<string, string>();
  for (const name of flat) {
    let denoted = catalog.denote ? knownToolNameFor(name, catalog.names) : null;
    const stored = storedParameters.get(name);
    if (denoted !== null && stored && catalog.parametersOf) {
      const parameters = catalog.parametersOf(denoted);
      if (parameters !== undefined && [...stored].some((json) => json !== stableJson(parameters)))
        denoted = null;
    }
    flatNames.set(name, denoted ?? (aliasUnbound ? providerToolNameAlias(name) : name));
  }
  const rewrite: ToolNameVisitor = (name, position) => {
    if (isProviderToolName(name) || known.has(name)) return name;
    if (position === "flat") return flatNames.get(name) ?? providerToolNameAlias(name);
    return aliasUnbound ? providerToolNameAlias(name) : name;
  };
  const mapping = JSON.stringify([[...flatNames], [...scoped], aliasUnbound]);
  let changed = false;
  const next = items.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const cached = rewrittenItems.get(item);
    let rewritten: unknown;
    if (cached?.mapping === mapping) {
      rewritten = cached.item;
    } else {
      rewritten = rewriteItem(item, rewrite);
      if (rewritten !== item) rewrittenItems.set(item, { mapping, item: rewritten });
    }
    if (rewritten !== item) changed = true;
    return rewritten as T;
  });
  return changed ? next : items;
}
