import { describe, expect, test } from "bun:test";
import { projectHistoryForProvider, toolDisclosureItem } from "../src/provider-history-adapter";
import {
  invalidHistoryToolNames,
  knownToolNameFor,
  providerToolNameAlias,
  withProviderValidToolNames,
} from "../src/provider-tool-names";

// References are assembled so no tool on the way resolves them.
const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;
const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

const QUERY = "mcp_0123456789abcdef01234567__query_pelicans";
const GOAL_SET = "opengeni__goal_set";
const SLACK_SEND = "opengeni__slack_bot_send_prepared_message";
// The forms stored before tool identities were exempt from masking: a known
// value inside the name replaced by its reference or credential marker.
const MASKED_QUERY = `mcp_0123456789abcdef01234567__query_${ref("Vault/db/password")}`;
const MASKED_SLACK_SEND = `${ref("id:00000000-0000-4000-8000-000000000001/password")}__slack_bot_send_prepared_message`;
const DOTTED_GOAL_SET = "opengeni.goal_set";
const KNOWN = [GOAL_SET, SLACK_SEND, QUERY, "opengeni__goal_complete"];

const definition = (name: string) => ({
  type: "function",
  name,
  description: `The ${name} tool`,
  parameters: { type: "object", properties: {} },
  strict: false,
});

/** Every tool name a Responses request carries in its input. */
function inputToolNames(items: unknown[]): string[] {
  const names: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, depth + 1));
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.type === "string") names.push(record.name);
    for (const key of ["tools", "providerData"]) visit(record[key], depth + 1);
  };
  visit(items, 0);
  return names;
}

const CATALOG = { names: KNOWN, denote: true };

describe("tool names in replayed history", () => {
  test("an invalid name maps to the one authorized tool it denotes", () => {
    expect(knownToolNameFor(MASKED_QUERY, KNOWN)).toBe(QUERY);
    expect(knownToolNameFor(MASKED_SLACK_SEND, KNOWN)).toBe(SLACK_SEND);
    expect(knownToolNameFor(DOTTED_GOAL_SET, KNOWN)).toBe(GOAL_SET);
    // The published name of an aliased MCP tool.
    expect(knownToolNameFor("query.pelicans", KNOWN)).toBe(QUERY);
    // A masked value has at least 8 characters: `set` does not fit.
    expect(knownToolNameFor(`opengeni__goal_${ref("Vault/x/password")}`, KNOWN)).toBe(
      "opengeni__goal_complete",
    );
    // Several tools fit the masked span: none is guessed.
    expect(knownToolNameFor(`opengeni__${ref("Vault/x/password")}`, KNOWN)).toBeNull();
    expect(knownToolNameFor("other.unknown_tool", KNOWN)).toBeNull();
    // Punctuation is not a masked span.
    expect(knownToolNameFor("github.create_issue", ["github_enterprise__create_issue"])).toBeNull();
    expect(knownToolNameFor("opengeni goal_set", KNOWN)).toBeNull();
  });

  test("a stored tool_search_output and its call replay with the authorized names", () => {
    const history = storedHistory();
    expect(invalidHistoryToolNames(history).sort()).toEqual(
      [DOTTED_GOAL_SET, MASKED_QUERY, MASKED_SLACK_SEND].sort(),
    );
    const replayed = withProviderValidToolNames(history, CATALOG);
    // The dotted definition now repeats GOAL_SET and is dropped.
    expect(inputToolNames(replayed)).toEqual([GOAL_SET, SLACK_SEND, QUERY, SLACK_SEND, SLACK_SEND]);
    // Only the affected items change; the rest keep their identity.
    expect(replayed[0]).toBe(history[0]);
    expect(replayed[1]).toBe(history[1]);
    expect(history[2]!.tools).toEqual(storedHistory()[2]!.tools);
    expect(withProviderValidToolNames(replayed, CATALOG)).toBe(replayed);
    // A replayed item keeps its rewritten identity while the mapping holds.
    const again = withProviderValidToolNames(history, CATALOG);
    expect(again[2]).toBe(replayed[2]);
    expect(again[3]).toBe(replayed[3]);
  });

  test("a name no authorized tool answers to gets one stable valid alias everywhere", () => {
    const history = storedHistory();
    const replayed = withProviderValidToolNames(history);
    const names = inputToolNames(replayed);
    for (const name of names) expect(name).toMatch(PROVIDER_TOOL_NAME);
    const alias = providerToolNameAlias(MASKED_SLACK_SEND);
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(names.filter((name) => name === alias)).toHaveLength(3);
    expect(providerToolNameAlias(MASKED_QUERY)).not.toBe(alias);
    expect(withProviderValidToolNames(storedHistory())).toEqual(replayed);
    // Without denote, a known tool is never guessed.
    const aliased = withProviderValidToolNames(storedHistory(), { names: KNOWN });
    expect(aliased[3]!.name).toBe(alias);
  });

  test("a stored definition with other parameters is another tool and keeps its alias", () => {
    const stored = { ...definition(MASKED_QUERY), parameters: { type: "object", required: ["q"] } };
    const history = [
      { type: "tool_search_output", tools: [stored] },
      { type: "function_call", callId: "c", name: MASKED_QUERY, arguments: "{}" },
    ];
    const parametersOf = (name: string) =>
      name === QUERY ? { type: "object", properties: {} } : undefined;
    const replayed = withProviderValidToolNames(history, { ...CATALOG, parametersOf });
    expect(inputToolNames(replayed)).toEqual([
      providerToolNameAlias(MASKED_QUERY),
      providerToolNameAlias(MASKED_QUERY),
    ]);
    // The same parameters, in any key order, are the same tool.
    const same = withProviderValidToolNames(history, {
      ...CATALOG,
      parametersOf: () => ({ required: ["q"], type: "object" }),
    });
    expect(inputToolNames(same)).toEqual([QUERY, QUERY]);
  });

  test("namespaces and the names inside one never bind to a flat tool", () => {
    const masked = `opengeni__goal_${ref("Vault/x/password")}`;
    const history = [
      {
        type: "tool_search_output",
        tools: [{ type: "namespace", name: masked, tools: [definition(masked)] }],
      },
      { type: "function_call", callId: "c", namespace: masked, name: masked, arguments: "{}" },
    ];
    const replayed = withProviderValidToolNames(history, CATALOG);
    const alias = providerToolNameAlias(masked);
    expect(inputToolNames(replayed)).toEqual([alias, alias, alias]);
    expect(replayed[1]!.namespace).toBe(alias);
  });

  test("history whose names are all valid is returned by identity", () => {
    const history = [
      { type: "tool_search_output", tools: [definition(GOAL_SET)] },
      { type: "function_call", callId: "c", name: GOAL_SET, arguments: "{}" },
    ];
    expect(withProviderValidToolNames(history, CATALOG)).toBe(history);
    expect(projectHistoryForProvider(history, "responses")).toBe(history);
  });

  test("a request tool's own name is kept even beyond the portable format", () => {
    const long = `opengeni__${"x".repeat(70)}`;
    const history = [{ type: "function_call", callId: "c", name: long, arguments: "{}" }];
    expect(withProviderValidToolNames(history, { names: [long] })).toBe(history);
    expect(withProviderValidToolNames(history)[0]!.name).toMatch(PROVIDER_TOOL_NAME);
  });

  test("a repeated name is declared once whichever definition was rewritten", () => {
    const history = [
      { type: "tool_search_output", tools: [definition(MASKED_QUERY), definition(QUERY)] },
    ];
    const replayed = withProviderValidToolNames(history, CATALOG);
    expect(inputToolNames(replayed)).toEqual([QUERY]);
    const reversed = [
      { type: "tool_search_output", tools: [definition(QUERY), definition(MASKED_QUERY)] },
    ];
    expect(inputToolNames(withProviderValidToolNames(reversed, CATALOG))).toEqual([QUERY]);
  });

  test("without aliasUnbound only bound names change; the rest stay for the projection", () => {
    const unknown = "other.unknown_tool";
    const history = [
      { type: "function_call", callId: "a", name: MASKED_QUERY, arguments: "{}" },
      { type: "function_call", callId: "b", name: unknown, arguments: "{}" },
      {
        type: "tool_search_output",
        tools: [{ type: "namespace", name: unknown, tools: [definition(unknown)] }],
      },
    ];
    const catalog = { ...CATALOG, aliasUnbound: false };
    const replayed = withProviderValidToolNames(history, catalog);
    expect(replayed[0]!.name).toBe(QUERY);
    expect(replayed[1]).toBe(history[1]);
    expect(replayed[2]).toBe(history[2]);
    // The memo never serves an item rewritten under the other setting.
    expect(withProviderValidToolNames(history, CATALOG)[1]!.name).toBe(
      providerToolNameAlias(unknown),
    );
    expect(withProviderValidToolNames(history, catalog)[1]).toBe(history[1]);
  });
});

describe("provider projection", () => {
  test("a replayed tool_search_output with masked and dotted names reaches the wire valid", () => {
    const projected = projectHistoryForProvider(storedHistory(), "responses", {
      knownToolNames: [GOAL_SET],
    });
    const names = inputToolNames(projected);
    for (const name of names) expect(name).toMatch(PROVIDER_TOOL_NAME);
    const tools = projected[2]!.tools as Array<{ name: string }>;
    // With only the request's tools, nothing is guessed: the dotted name is aliased.
    expect(tools[3]!.name).toBe(providerToolNameAlias(DOTTED_GOAL_SET));
    // The call keeps the same name as the definition that declared it.
    expect(tools[1]!.name).toBe(projected[3]!.name);
  });

  test("an additional_tools declaration on the Codex route carries valid names", () => {
    const disclosure = toolDisclosureItem([definition(MASKED_QUERY), definition(GOAL_SET)], {
      viaToolInvoke: true,
    });
    const projected = projectHistoryForProvider(
      [{ type: "message", role: "user", content: "hi" }, disclosure],
      "responses",
      { declaresAdditionalTools: true, knownToolNames: [QUERY, GOAL_SET] },
    );
    expect(projected[1]).toEqual({
      type: "unknown",
      providerData: {
        type: "additional_tools",
        role: "developer",
        tools: [
          { ...definition(MASKED_QUERY), name: providerToolNameAlias(MASKED_QUERY) },
          definition(GOAL_SET),
        ],
      },
    });
  });

  test("Claude replays a valid alias; Chat replays an invalid call as a historical fact", () => {
    const history = storedHistory();
    const alias = providerToolNameAlias(MASKED_SLACK_SEND);
    const chat = projectHistoryForProvider(history, "chat", { knownToolNames: KNOWN });
    // Chat has no tool search item: it replays as a historical fact.
    expect(chat.some((item) => item.type === "tool_search_output")).toBe(false);
    // No native call to a tool the request never declares.
    expect(chat.some((item) => item.type === "function_call")).toBe(false);
    expect(chat.some((item) => item.type === "function_call_result")).toBe(false);
    const claude = projectHistoryForProvider(history, "anthropic-messages", {
      knownToolNames: KNOWN,
    });
    expect(claude.find((item) => item.type === "function_call")?.name).toBe(alias);
  });
});
/** The failed chat's history: a client tool search that loaded a masked tool, then its call. */
function storedHistory(): Array<Record<string, unknown>> {
  return [
    { type: "message", role: "user", content: "Post the daily update" },
    {
      type: "tool_search_call",
      call_id: "call_search",
      execution: "client",
      status: "completed",
      arguments: { query: "slack post; analytics query" },
    },
    {
      type: "tool_search_output",
      call_id: "call_search",
      execution: "client",
      status: "completed",
      tools: [
        definition(GOAL_SET),
        definition(MASKED_SLACK_SEND),
        definition(MASKED_QUERY),
        definition(DOTTED_GOAL_SET),
      ],
    },
    {
      type: "function_call",
      callId: "call_send",
      name: MASKED_SLACK_SEND,
      arguments: "{}",
      status: "completed",
    },
    { type: "function_call_result", callId: "call_send", name: MASKED_SLACK_SEND, output: "sent" },
  ];
}
