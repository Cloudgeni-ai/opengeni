import {
  invalidRequestBodyOfResponse,
  invalidRequestMessage,
  invalidRequestSignature,
} from "./provider-invalid-request";
import { isProviderToolName, providerToolNameAlias } from "./provider-tool-names";

/**
 * The outbound tool-name guard (docs/model-providers.md, "Tool names on the
 * wire").
 *
 * Every model request passes through it once, as the last step before its
 * body is serialized: Responses (HTTP, the Codex WebSocket `response.create`
 * payload, xAI, Azure and gateways), Chat Completions (OpenRouter, Opper,
 * Gemini and other compatible gateways) and Claude Messages. It visits every
 * position a provider validates as a tool name: the request's tool
 * definitions and namespaces, `tool_choice`, and every history item that
 * names a tool or carries definitions (`function_call`, `custom_tool_call`,
 * `tool_search_output`, `additional_tools`, MCP items, Chat `tool_calls`,
 * Claude `tool_use`).
 *
 * A name every provider accepts (`^[a-zA-Z0-9_-]{1,64}$`) is sent byte for
 * byte, and a request without any other name is returned unchanged, so prompt
 * caches never move. Any other name gets its stable alias
 * (`providerToolNameAlias`): the same in every position of the request, never
 * equal to another name of the request (a numeric suffix settles the
 * vanishingly rare clash), and a definition that comes to repeat an earlier
 * name in the same list is dropped. The aliases are remembered for the
 * request, and the provider's answer is mapped back before anything reads
 * it, so a call to an alias runs, is approved and is shown as the original
 * tool.
 *
 * Strict mode, used once after a provider still rejects a tool name, aliases
 * every name, valid or not, to a name of letters, digits and `_` that starts
 * with a letter. When that resend succeeds, the request's names outside that
 * narrow form are remembered for the client (`RejectedToolNames`), so its
 * later requests alias them straight away instead of paying the rejection
 * again; every other name stays byte for byte.
 */

export type ToolNameWireApi = "responses" | "chat" | "anthropic-messages";
/** Where a repaired name sat: the request's tools, `tool_choice`, or history. */
export type ToolNameField = "tools" | "tool_choice" | "history";

type NameRef =
  | { kind: "flat"; name: string; field: ToolNameField }
  | { kind: "namespace"; name: string; field: ToolNameField }
  | { kind: "leaf"; name: string; namespace: string; field: ToolNameField };
type Visit = (ref: NameRef) => string;
type Walker = (value: Record<string, unknown>, visit: Visit) => Record<string, unknown>;

/** A request's aliases, by the name the provider saw. */
export class ToolNameAliases {
  constructor(
    private readonly flat: ReadonlyMap<string, string> = new Map(),
    private readonly namespaces: ReadonlyMap<string, string> = new Map(),
    private readonly leaves: ReadonlyMap<string, string> = new Map(),
  ) {}

  get size(): number {
    return this.flat.size + this.namespaces.size + this.leaves.size;
  }

  /** The original of a tool name the provider saw (unchanged when it is no alias). */
  restoreFlat(name: string): string {
    return this.flat.get(name) ?? name;
  }

  restoreNamespace(name: string): string {
    return this.namespaces.get(name) ?? name;
  }

  /** The original of a name inside a namespace, given the namespace's original. */
  restoreLeaf(namespace: string, name: string): string {
    return this.leaves.get(leafKey(namespace, name)) ?? name;
  }
}

const NO_ALIASES = new ToolNameAliases();

/** Letters, digits and `_`, starting with a letter: the form strict aliases take. */
const PORTABLE_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const REJECTED_TOOL_NAMES_LIMIT = 1024;

/**
 * The tool names one client's route rejected: after a strict resend
 * succeeded, every name of that request outside the portable form. Later
 * requests through the client alias these names without a failed attempt
 * first. Bounded; the oldest name is forgotten first.
 */
export class RejectedToolNames {
  private readonly names = new Set<string>();

  has(name: string): boolean {
    return this.names.has(name);
  }

  get size(): number {
    return this.names.size;
  }

  /** Remember the names of a request (before the guard) outside the portable form. */
  rememberRequest(api: ToolNameWireApi, body: Record<string, unknown>): void {
    WALKERS[api](body, (ref) => {
      for (const name of ref.kind === "leaf" ? [ref.name, ref.namespace] : [ref.name]) {
        if (PORTABLE_TOOL_NAME.test(name) || this.names.has(name)) continue;
        this.names.add(name);
        if (this.names.size > REJECTED_TOOL_NAMES_LIMIT) {
          const oldest = this.names.values().next().value;
          if (oldest !== undefined) this.names.delete(oldest);
        }
      }
      return ref.name;
    });
  }
}

/** Monitoring-only observations of the guard; they never affect a request. */
export type ToolNameObservers = {
  /** The guard changed a tool name: once per request and field. */
  onToolNameRepair?: (observation: { api: ToolNameWireApi; field: ToolNameField }) => void;
  /** The one strict resend after a provider rejected a tool name. */
  onToolNameRetry?: (observation: {
    api: ToolNameWireApi;
    outcome: "completed" | "failed";
  }) => void;
};

/** Call an observer; a failing one never affects the model call. */
export function observeToolNames<T>(
  observer: ((observation: T) => void) | undefined,
  observation: T,
): void {
  try {
    observer?.(observation);
  } catch {
    // Metrics must never affect a model call.
  }
}

export type GuardedToolNames<T> = {
  /** The request body, the same object when no name changed. */
  body: T;
  aliases: ToolNameAliases;
  /** The fields in which a name changed, for the repair counter. */
  repaired: ToolNameField[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namespaceOf(record: Record<string, unknown>): string | undefined {
  return typeof record.namespace === "string" && record.namespace.length > 0
    ? record.namespace
    : undefined;
}

function leafKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

/** The record with `key` set, the same record when the value is unchanged. */
function withValue(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return record[key] === value ? record : { ...record, [key]: value };
}

function mapList(list: unknown[], map: (entry: unknown) => unknown): unknown[] {
  let changed = false;
  const next = list.map((entry) => {
    const mapped = map(entry);
    if (mapped !== entry) changed = true;
    return mapped;
  });
  return changed ? next : list;
}

/**
 * A definition list with each entry mapped. When a name changed, a
 * definition that repeats an earlier one's name is dropped: providers reject
 * a list that declares one name twice.
 */
function definitionList(
  list: unknown[],
  map: (entry: unknown) => unknown,
  nameOf: (entry: unknown) => string | undefined,
): unknown[] {
  const next = mapList(list, map);
  if (next === list) return list;
  const seen = new Set<string>();
  return next.filter((entry) => {
    const name = nameOf(entry);
    if (name === undefined) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function nameRef(name: string, namespace: string | undefined, field: ToolNameField): NameRef {
  return namespace === undefined
    ? { kind: "flat", name, field }
    : { kind: "leaf", name, namespace, field };
}

/** Hosted MCP tools are named within their server, like a namespace of their own. */
function mcpScope(record: Record<string, unknown>): string {
  return `\u0000mcp:${typeof record.server_label === "string" ? record.server_label : ""}`;
}

// ---------------------------------------------------------------- Responses

/** A definition's name, with namespaces and tools kept apart. */
function responsesDefinitionName(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "tool_reference" || typeof entry.name !== "string") return undefined;
  return `${entry.type === "namespace" ? "namespace" : "tool"}\u0000${entry.name}`;
}

/**
 * One Responses tool definition: a function or custom tool, a namespace and
 * the tools inside it, or a tool search `tool_reference`. Hosted tools carry
 * no name of ours.
 */
function responsesDefinition(
  entry: unknown,
  visit: Visit,
  field: ToolNameField,
  inNamespace?: string,
): unknown {
  if (!isRecord(entry)) return entry;
  if (entry.type === "namespace" && inNamespace === undefined && typeof entry.name === "string") {
    const namespace = entry.name;
    let next = withValue(entry, "name", visit({ kind: "namespace", name: namespace, field }));
    if (Array.isArray(entry.tools)) {
      next = withValue(
        next,
        "tools",
        definitionList(
          entry.tools,
          (tool) => responsesDefinition(tool, visit, field, namespace),
          responsesDefinitionName,
        ),
      );
    }
    return next;
  }
  const nameKey =
    entry.type === "tool_reference"
      ? "function_name"
      : entry.type === "function" || entry.type === "custom"
        ? "name"
        : null;
  if (nameKey === null || typeof entry[nameKey] !== "string") return entry;
  const own = inNamespace === undefined ? namespaceOf(entry) : undefined;
  const namespace = inNamespace ?? own;
  let next = withValue(entry, nameKey, visit(nameRef(entry[nameKey], namespace, field)));
  if (own !== undefined) {
    next = withValue(next, "namespace", visit({ kind: "namespace", name: own, field }));
  }
  return next;
}

/** A call (or forced choice) that names a tool by `name` and an optional `namespace`. */
function responsesNamedCall(
  record: Record<string, unknown>,
  visit: Visit,
  field: ToolNameField,
): Record<string, unknown> {
  if (typeof record.name !== "string") return record;
  const namespace = namespaceOf(record);
  let next = withValue(record, "name", visit(nameRef(record.name, namespace, field)));
  if (namespace !== undefined) {
    next = withValue(next, "namespace", visit({ kind: "namespace", name: namespace, field }));
  }
  return next;
}

function responsesMcpItem(
  record: Record<string, unknown>,
  visit: Visit,
  field: ToolNameField,
): Record<string, unknown> {
  const scope = mcpScope(record);
  if (record.type === "mcp_list_tools") {
    if (!Array.isArray(record.tools)) return record;
    return withValue(
      record,
      "tools",
      definitionList(
        record.tools,
        (tool) =>
          isRecord(tool) && typeof tool.name === "string"
            ? withValue(tool, "name", visit(nameRef(tool.name, scope, field)))
            : tool,
        responsesDefinitionName,
      ),
    );
  }
  return typeof record.name === "string"
    ? withValue(record, "name", visit(nameRef(record.name, scope, field)))
    : record;
}

/** One Responses input or output item. */
function responsesItem(item: unknown, visit: Visit, field: ToolNameField): unknown {
  if (!isRecord(item)) return item;
  switch (item.type) {
    case "function_call":
    case "custom_tool_call":
      return responsesNamedCall(item, visit, field);
    case "tool_search_output":
    case "additional_tools":
      return Array.isArray(item.tools)
        ? withValue(
            item,
            "tools",
            definitionList(
              item.tools,
              (tool) => responsesDefinition(tool, visit, field),
              responsesDefinitionName,
            ),
          )
        : item;
    case "mcp_call":
    case "mcp_approval_request":
    case "mcp_list_tools":
      return responsesMcpItem(item, visit, field);
    default:
      return item;
  }
}

/** The namespaces declared by a request's tools, for qualified forced choices. */
function declaredNamespaces(tools: unknown): Map<string, Set<string>> {
  const namespaces = new Map<string, Set<string>>();
  if (!Array.isArray(tools)) return namespaces;
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "namespace" || typeof tool.name !== "string") continue;
    const leaves = new Set<string>();
    for (const entry of Array.isArray(tool.tools) ? tool.tools : []) {
      if (isRecord(entry) && typeof entry.name === "string") leaves.add(entry.name);
    }
    namespaces.set(tool.name, leaves);
  }
  return namespaces;
}

/**
 * A forced function choice. The SDK names a tool inside a namespace as
 * `namespace.name`; each part is mapped as the definitions map it.
 */
function responsesChoiceEntry(
  entry: unknown,
  visit: Visit,
  namespaces: Map<string, Set<string>>,
): unknown {
  if (!isRecord(entry)) return entry;
  if (entry.type === "mcp") return responsesMcpItem(entry, visit, "tool_choice");
  if (entry.type !== "function" && entry.type !== "custom") return entry;
  if (typeof entry.name !== "string") return entry;
  if (namespaceOf(entry) === undefined) {
    const name = entry.name;
    for (let dot = name.indexOf("."); dot > 0; dot = name.indexOf(".", dot + 1)) {
      const namespace = name.slice(0, dot);
      const leaf = name.slice(dot + 1);
      if (!namespaces.get(namespace)?.has(leaf)) continue;
      const qualifiedNamespace = visit({
        kind: "namespace",
        name: namespace,
        field: "tool_choice",
      });
      const qualifiedLeaf = visit({ kind: "leaf", name: leaf, namespace, field: "tool_choice" });
      return withValue(entry, "name", `${qualifiedNamespace}.${qualifiedLeaf}`);
    }
  }
  return responsesNamedCall(entry, visit, "tool_choice");
}

function responsesToolChoice(
  choice: unknown,
  visit: Visit,
  namespaces: Map<string, Set<string>>,
): unknown {
  if (!isRecord(choice)) return choice;
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    return withValue(
      choice,
      "tools",
      mapList(choice.tools, (entry) => responsesChoiceEntry(entry, visit, namespaces)),
    );
  }
  return responsesChoiceEntry(choice, visit, namespaces);
}

const responsesBody: Walker = (body, visit) => {
  let next = body;
  if (Array.isArray(body.tools)) {
    next = withValue(
      next,
      "tools",
      definitionList(
        body.tools,
        (tool) => responsesDefinition(tool, visit, "tools"),
        responsesDefinitionName,
      ),
    );
  }
  if (isRecord(body.tool_choice)) {
    next = withValue(
      next,
      "tool_choice",
      responsesToolChoice(body.tool_choice, visit, declaredNamespaces(body.tools)),
    );
  }
  if (Array.isArray(body.input)) {
    next = withValue(
      next,
      "input",
      mapList(body.input, (item) => responsesItem(item, visit, "history")),
    );
  }
  return next;
};

// -------------------------------------------------------- Chat Completions

/** `{type, function: {name}}` or `{type: "custom", custom: {name}}`, as Chat nests names. */
function chatNamed(entry: unknown, visit: Visit, field: ToolNameField): unknown {
  if (!isRecord(entry)) return entry;
  const key = entry.type === "custom" ? "custom" : "function";
  const inner = entry[key];
  if (!isRecord(inner) || typeof inner.name !== "string") return entry;
  return withValue(
    entry,
    key,
    withValue(inner, "name", visit(nameRef(inner.name, undefined, field))),
  );
}

function chatDefinitionName(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const inner = entry[entry.type === "custom" ? "custom" : "function"];
  return isRecord(inner) && typeof inner.name === "string" ? inner.name : undefined;
}

function chatToolChoice(choice: unknown, visit: Visit): unknown {
  if (!isRecord(choice)) return choice;
  if (choice.type === "allowed_tools" && isRecord(choice.allowed_tools)) {
    const allowed = choice.allowed_tools;
    if (!Array.isArray(allowed.tools)) return choice;
    return withValue(
      choice,
      "allowed_tools",
      withValue(
        allowed,
        "tools",
        mapList(allowed.tools, (entry) => chatNamed(entry, visit, "tool_choice")),
      ),
    );
  }
  return chatNamed(choice, visit, "tool_choice");
}

function chatMessage(message: unknown, visit: Visit): unknown {
  if (!isRecord(message)) return message;
  let next = message;
  if (Array.isArray(message.tool_calls)) {
    next = withValue(
      next,
      "tool_calls",
      mapList(message.tool_calls, (call) => chatNamed(call, visit, "history")),
    );
  }
  if (isRecord(message.function_call) && typeof message.function_call.name === "string") {
    next = withValue(
      next,
      "function_call",
      withValue(
        message.function_call,
        "name",
        visit(nameRef(message.function_call.name, undefined, "history")),
      ),
    );
  }
  if (message.role === "function" && typeof message.name === "string") {
    next = withValue(next, "name", visit(nameRef(message.name, undefined, "history")));
  }
  return next;
}

const chatBody: Walker = (body, visit) => {
  let next = body;
  if (Array.isArray(body.tools)) {
    next = withValue(
      next,
      "tools",
      definitionList(body.tools, (tool) => chatNamed(tool, visit, "tools"), chatDefinitionName),
    );
  }
  if (Array.isArray(body.functions)) {
    next = withValue(
      next,
      "functions",
      definitionList(
        body.functions,
        (fn) =>
          isRecord(fn) && typeof fn.name === "string"
            ? withValue(fn, "name", visit(nameRef(fn.name, undefined, "tools")))
            : fn,
        (fn) => (isRecord(fn) && typeof fn.name === "string" ? fn.name : undefined),
      ),
    );
  }
  if (isRecord(body.tool_choice)) {
    next = withValue(next, "tool_choice", chatToolChoice(body.tool_choice, visit));
  }
  if (isRecord(body.function_call) && typeof body.function_call.name === "string") {
    next = withValue(
      next,
      "function_call",
      withValue(
        body.function_call,
        "name",
        visit(nameRef(body.function_call.name, undefined, "tool_choice")),
      ),
    );
  }
  if (Array.isArray(body.messages)) {
    next = withValue(
      next,
      "messages",
      mapList(body.messages, (message) => chatMessage(message, visit)),
    );
  }
  return next;
};

// ----------------------------------------------------------- Claude Messages

/** Claude's own server tools (web search and the like) keep their fixed names. */
function isClaudeClientTool(tool: Record<string, unknown>): boolean {
  return tool.type === undefined || tool.type === "custom";
}

function claudeDefinitionName(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.name === "string" ? entry.name : undefined;
}

function claudeBlock(block: unknown, visit: Visit): unknown {
  if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") return block;
  return withValue(block, "name", visit(nameRef(block.name, undefined, "history")));
}

const claudeBody: Walker = (body, visit) => {
  let next = body;
  if (Array.isArray(body.tools)) {
    next = withValue(
      next,
      "tools",
      definitionList(
        body.tools,
        (tool) =>
          isRecord(tool) && isClaudeClientTool(tool) && typeof tool.name === "string"
            ? withValue(tool, "name", visit(nameRef(tool.name, undefined, "tools")))
            : tool,
        claudeDefinitionName,
      ),
    );
  }
  if (
    isRecord(body.tool_choice) &&
    body.tool_choice.type === "tool" &&
    typeof body.tool_choice.name === "string"
  ) {
    next = withValue(
      next,
      "tool_choice",
      withValue(
        body.tool_choice,
        "name",
        visit(nameRef(body.tool_choice.name, undefined, "tool_choice")),
      ),
    );
  }
  if (Array.isArray(body.messages)) {
    next = withValue(
      next,
      "messages",
      mapList(body.messages, (message) =>
        isRecord(message) && Array.isArray(message.content)
          ? withValue(
              message,
              "content",
              mapList(message.content, (block) => claudeBlock(block, visit)),
            )
          : message,
      ),
    );
  }
  return next;
};

const WALKERS: Record<ToolNameWireApi, Walker> = {
  responses: responsesBody,
  chat: chatBody,
  "anthropic-messages": claudeBody,
};

// -------------------------------------------------------------------- Guard

function identityKey(ref: NameRef): string {
  return ref.kind === "leaf"
    ? `l\u0000${leafKey(ref.namespace, ref.name)}`
    : `${ref.kind === "flat" ? "f" : "n"}\u0000${ref.name}`;
}

/** Flat tools and namespaces share the request's top level; each namespace is its own scope. */
function scopeKey(ref: NameRef): string {
  return ref.kind === "leaf" ? `l\u0000${ref.namespace}` : "top";
}

export type ToolNameGuardOptions = {
  /** Alias every name, valid or not (the one retry after a rejected name). */
  strict?: boolean;
  /** Names the client's route rejected before; they are aliased too. */
  rejected?: RejectedToolNames;
};

/**
 * The request body with every tool name a provider could reject replaced by
 * its alias, consistently across the request, and the aliases to map the
 * answer back with (see the module comment).
 */
export function guardRequestToolNames<T extends Record<string, unknown>>(
  api: ToolNameWireApi,
  body: T,
  options: ToolNameGuardOptions = {},
): GuardedToolNames<T> {
  const walk = WALKERS[api];
  const strict = options.strict === true;
  const rejected = options.rejected;
  const refs: NameRef[] = [];
  walk(body, (ref) => {
    refs.push(ref);
    return ref.name;
  });
  const renames = (ref: NameRef) =>
    strict || !isProviderToolName(ref.name) || rejected?.has(ref.name) === true;
  if (!refs.some(renames)) return { body, aliases: NO_ALIASES, repaired: [] };

  // Names that stay as they are, per scope; an alias never takes one.
  const taken = new Map<string, Set<string>>();
  const takenIn = (scope: string) => {
    let names = taken.get(scope);
    if (!names) taken.set(scope, (names = new Set()));
    return names;
  };
  const pending = new Map<string, NameRef>();
  const repaired = new Set<ToolNameField>();
  for (const ref of refs) {
    if (!renames(ref)) {
      takenIn(scopeKey(ref)).add(ref.name);
      continue;
    }
    repaired.add(ref.field);
    const key = identityKey(ref);
    if (!pending.has(key)) pending.set(key, ref);
  }

  const forward = new Map<string, string>();
  const flat = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const leaves = new Map<string, string>();
  for (const key of [...pending.keys()].sort()) {
    const ref = pending.get(key)!;
    const names = takenIn(scopeKey(ref));
    const base = providerToolNameAlias(ref.name);
    let alias = base;
    for (let suffix = 2; names.has(alias); suffix += 1) alias = `${base}_${suffix}`;
    names.add(alias);
    forward.set(key, alias);
    if (ref.kind === "flat") flat.set(alias, ref.name);
    else if (ref.kind === "namespace") namespaces.set(alias, ref.name);
    else leaves.set(leafKey(ref.namespace, alias), ref.name);
  }
  const guarded = walk(body, (ref) => forward.get(identityKey(ref)) ?? ref.name) as T;
  return {
    body: guarded,
    aliases: new ToolNameAliases(flat, namespaces, leaves),
    repaired: [...repaired].sort(),
  };
}

/**
 * The visitor that maps the names a provider saw back to their originals. A
 * name inside a namespace is looked up under the namespace's original.
 */
function restoring(aliases: ToolNameAliases): Visit {
  return (ref) =>
    ref.kind === "flat"
      ? aliases.restoreFlat(ref.name)
      : ref.kind === "namespace"
        ? aliases.restoreNamespace(ref.name)
        : aliases.restoreLeaf(aliases.restoreNamespace(ref.namespace), ref.name);
}

/**
 * A Responses answer with its tool names restored: a response (`output`),
 * or a stream event (`item`, `response`, or a call event's `name`).
 */
export function restoreResponsesToolNames<T>(payload: T, aliases: ToolNameAliases): T {
  if (aliases.size === 0 || !isRecord(payload)) return payload;
  const visit = restoring(aliases);
  let next: Record<string, unknown> = payload;
  if (Array.isArray(payload.output)) {
    next = withValue(
      next,
      "output",
      mapList(payload.output, (item) => responsesItem(item, visit, "history")),
    );
  }
  if (isRecord(payload.item)) {
    next = withValue(next, "item", responsesItem(payload.item, visit, "history"));
  }
  if (isRecord(payload.response)) {
    next = withValue(next, "response", restoreResponsesToolNames(payload.response, aliases));
  }
  if (
    typeof payload.type === "string" &&
    payload.type.startsWith("response.") &&
    typeof payload.name === "string"
  ) {
    if (typeof payload.namespace === "string") {
      const namespace = aliases.restoreNamespace(payload.namespace);
      next = withValue(next, "namespace", namespace);
      next = withValue(next, "name", aliases.restoreLeaf(namespace, payload.name));
    } else {
      next = withValue(next, "name", aliases.restoreFlat(payload.name));
    }
  }
  return next as T;
}

/** A Chat completion or stream chunk with its tool call names restored. */
export function restoreChatToolNames<T>(payload: T, aliases: ToolNameAliases): T {
  if (aliases.size === 0 || !isRecord(payload) || !Array.isArray(payload.choices)) return payload;
  const visit = restoring(aliases);
  return withValue(
    payload,
    "choices",
    mapList(payload.choices, (choice) => {
      if (!isRecord(choice)) return choice;
      let next = choice;
      for (const key of ["message", "delta"]) {
        if (isRecord(choice[key])) next = withValue(next, key, chatMessage(choice[key], visit));
      }
      return next;
    }),
  ) as T;
}

/** A Claude message (`content`) or stream event (`content_block`) with tool names restored. */
export function restoreClaudeToolNames<T>(payload: T, aliases: ToolNameAliases): T {
  if (aliases.size === 0 || !isRecord(payload)) return payload;
  const visit = restoring(aliases);
  let next: Record<string, unknown> = payload;
  if (Array.isArray(payload.content)) {
    next = withValue(
      next,
      "content",
      mapList(payload.content, (block) => claudeBlock(block, visit)),
    );
  }
  if (isRecord(payload.content_block)) {
    next = withValue(next, "content_block", claudeBlock(payload.content_block, visit));
  }
  return next as T;
}

/** The tool names an answer of this API carries, restored. */
export function restoreToolNames<T>(api: ToolNameWireApi, payload: T, aliases: ToolNameAliases): T {
  return api === "responses"
    ? restoreResponsesToolNames(payload, aliases)
    : api === "chat"
      ? restoreChatToolNames(payload, aliases)
      : restoreClaudeToolNames(payload, aliases);
}

// ------------------------------------------------------- Rejected-name retry

const NAME_FIELD_PATH = /(?:^|\.)(?:name|namespace|function_name|tool_name)$/;
const STRING_CONSTRAINT =
  /pattern|invalid_string|invalid string|maximum length|too long|string_above_max_length|invalid (?:tool|function) name/i;

/**
 * Whether a provider's 400 says a tool name (a `…name` or `…namespace` field,
 * or `tool_choice`) breaks its string constraints: the one rejection the
 * strict retry can fix. Its path is read as the invalid-request counter reads
 * it (`invalidRequestSignature`).
 */
export function isToolNameRejection(
  signature: { path: string; code: string },
  message: string,
): boolean {
  if (signature.path === "unknown") return false;
  const path = signature.path.replace(/\[\]$/, "");
  const namePath = NAME_FIELD_PATH.test(path) || /^tool_choice\b/.test(path);
  return namePath && (STRING_CONSTRAINT.test(signature.code) || STRING_CONSTRAINT.test(message));
}

/** Whether a provider error body rejects a tool name (see isToolNameRejection). */
export function rejectsToolName(body: unknown): boolean {
  return isToolNameRejection(invalidRequestSignature(body), invalidRequestMessage(body));
}

/** Whether a 400 response rejects a tool name; its body is read from a clone. */
export async function responseRejectsToolName(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const body = await invalidRequestBodyOfResponse(response);
  return body !== null && rejectsToolName(body);
}
