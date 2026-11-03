import { createHash } from "node:crypto";

/**
 * Tool names in replayed history (docs/model-providers.md, "Tool names in
 * history").
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
 * wherever it appears in the request: the authorized tool it denotes when
 * exactly one does (so a later call binds to that tool), otherwise a stable
 * alias. Valid names, and items without an invalid one, are returned
 * unchanged and by identity, so append-only prompt-cache prefixes stay
 * byte-identical.
 */

const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const INVALID_TOOL_NAME_CHARACTER = /[^a-zA-Z0-9_-]/;
const TOOL_NAME_SEPARATOR = "__";
const ALIAS_READABLE_LENGTH = 40;
const ALIAS_DIGEST_LENGTH = 16;
const NAME_KEYS = ["name", "namespace", "function_name", "functionName"] as const;
const TOOL_DISCLOSURE_KEY_PREFIX = "opengeni.tool_disclosure";

/** Whether every provider accepts this tool name. */
export function isProviderToolName(name: string): boolean {
  return PROVIDER_TOOL_NAME.test(name);
}

/**
 * The stable alias of a name no authorized tool answers to: its readable
 * part with every other character replaced, and a digest of the whole name,
 * so two different names never share an alias. At most 57 characters.
 */
export function providerToolNameAlias(name: string): string {
  const readable = name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, ALIAS_READABLE_LENGTH);
  const digest = createHash("sha256").update(name).digest("hex").slice(0, ALIAS_DIGEST_LENGTH);
  return `${readable}_${digest}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The one known tool an invalid name denotes, or null. Its dotted
 * `server.tool` form names `server__tool`, and a name its server publishes
 * (`projects.search`) names the one tool whose part after the last `__` is
 * that name with punctuation as `_`. Otherwise the span from the first to the
 * last invalid character (a stored secret reference or credential marker)
 * stands for the valid characters it replaced, and exactly one known name may
 * fit.
 */
export function knownToolNameFor(name: string, known: readonly string[]): string | null {
  const valid = known.filter(isProviderToolName);
  if (name.includes(".")) {
    const dotted = name.replaceAll(".", TOOL_NAME_SEPARATOR);
    if (valid.includes(dotted)) return dotted;
    const published = name.replace(/[^a-zA-Z0-9_]/g, "_");
    const byShortName = valid.filter((candidate) => {
      const separator = candidate.lastIndexOf(TOOL_NAME_SEPARATOR);
      return (
        separator >= 0 && candidate.slice(separator + TOOL_NAME_SEPARATOR.length) === published
      );
    });
    if (byShortName.length === 1) return byShortName[0]!;
    if (byShortName.length > 1) return null;
  }
  const first = name.search(INVALID_TOOL_NAME_CHARACTER);
  if (first < 0) return null;
  let last = first;
  for (let index = name.length - 1; index > first; index -= 1) {
    if (INVALID_TOOL_NAME_CHARACTER.test(name[index]!)) {
      last = index;
      break;
    }
  }
  const prefix = name.slice(0, first);
  const suffix = name.slice(last + 1);
  if (prefix.length === 0 && suffix.length === 0) return null;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}[a-zA-Z0-9_-]+${escapeRegExp(suffix)}$`);
  let match: string | null = null;
  for (const candidate of valid) {
    if (!pattern.test(candidate)) continue;
    if (match !== null && match !== candidate) return null;
    match = candidate;
  }
  return match;
}

type ToolNameRewrite = (name: string) => string;

/** The model names of a request's function tools, for withProviderValidToolNames. */
export function requestFunctionToolNames(tools: readonly unknown[] | undefined): string[] {
  const names: string[] = [];
  for (const tool of tools ?? []) {
    if (isRecord(tool) && tool.type === "function" && typeof tool.name === "string") {
      names.push(tool.name);
    }
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** History items that name the tool they call or answer. */
const NAMED_CALL_TYPES: ReadonlySet<string> = new Set([
  "function_call",
  "function_call_result",
  "custom_tool_call",
]);

/** A tool definition, call or namespace with every name made valid. */
function rewriteNamed(record: unknown, rewrite: ToolNameRewrite): unknown {
  if (!isRecord(record)) return record;
  let next: Record<string, unknown> | null = null;
  for (const key of NAME_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const valid = rewrite(value);
    if (valid === value) continue;
    next ??= { ...record };
    next[key] = valid;
  }
  if (Array.isArray(record.tools)) {
    const tools = rewriteDefinitions(record.tools, rewrite);
    if (tools !== record.tools) {
      next ??= { ...record };
      next.tools = tools;
    }
  }
  return next ?? record;
}

function rewriteDefinitions(tools: unknown[], rewrite: ToolNameRewrite): unknown[] {
  let changed = false;
  const next = tools.map((tool) => {
    const rewritten = rewriteNamed(tool, rewrite);
    if (rewritten !== tool) changed = true;
    return rewritten;
  });
  return changed ? next : tools;
}

/** The same record with its `tools` definitions rewritten, or the record itself. */
function withRewrittenTools(
  record: Record<string, unknown>,
  rewrite: ToolNameRewrite,
): Record<string, unknown> {
  if (!Array.isArray(record.tools)) return record;
  const tools = rewriteDefinitions(record.tools, rewrite);
  return tools === record.tools ? record : { ...record, tools };
}

/** Whether providerData holds tool definitions under `tools`. */
function declaresTools(providerData: Record<string, unknown>): boolean {
  return providerData.type === "additional_tools" || providerData.type === "tool_search_output";
}

/**
 * Visit every tool-name position of one history item: a call's own name,
 * the definitions of a `tool_search_output`, and definitions carried in
 * providerData (the provider-neutral disclosure, `opengeni.tool_disclosure.v1`,
 * and its Responses `additional_tools` projection).
 */
function rewriteItem(item: unknown, rewrite: ToolNameRewrite): unknown {
  if (!isRecord(item)) return item;
  const type = typeof item.type === "string" ? item.type : "";
  if (NAMED_CALL_TYPES.has(type)) return rewriteNamed(item, rewrite);
  let next = type === "tool_search_output" ? withRewrittenTools(item, rewrite) : item;
  if (isRecord(next.providerData)) {
    const providerData = next.providerData;
    let data = declaresTools(providerData)
      ? withRewrittenTools(providerData, rewrite)
      : providerData;
    for (const [key, value] of Object.entries(providerData)) {
      if (!key.startsWith(TOOL_DISCLOSURE_KEY_PREFIX) || !isRecord(value)) continue;
      const rewritten = withRewrittenTools(value, rewrite);
      if (rewritten !== value) data = { ...data, [key]: rewritten };
    }
    if (data !== providerData) next = { ...next, providerData: data };
  }
  return next;
}

/** Invalid tool names in the positions withProviderValidToolNames rewrites. */
export function invalidHistoryToolNames(items: readonly unknown[]): string[] {
  const names = new Set<string>();
  const collect: ToolNameRewrite = (name) => {
    if (!isProviderToolName(name)) names.add(name);
    return name;
  };
  for (const item of items) rewriteItem(item, collect);
  return [...names];
}

/**
 * History with every tool name a provider would reject replaced by one valid
 * name, the same in every item (see the module comment). `knownToolNames`
 * are the authorized tools' model names; an invalid name that denotes
 * exactly one of them becomes that name, any other a stable alias.
 */
export function withProviderValidToolNames<T>(
  items: T[],
  knownToolNames: readonly string[] = [],
): T[] {
  // A request tool's own name is never rewritten: the history must keep naming it.
  const known = new Set(knownToolNames);
  const invalid = invalidHistoryToolNames(items).filter((name) => !known.has(name));
  if (invalid.length === 0) return items;
  const replacements = new Map<string, string>();
  for (const name of invalid) {
    replacements.set(name, knownToolNameFor(name, knownToolNames) ?? providerToolNameAlias(name));
  }
  const rewrite: ToolNameRewrite = (name) => replacements.get(name) ?? name;
  let changed = false;
  const next = items.map((item) => {
    const rewritten = rewriteItem(item, rewrite);
    if (rewritten !== item) changed = true;
    return rewritten as T;
  });
  return changed ? next : items;
}
