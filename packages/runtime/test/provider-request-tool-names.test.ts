import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { getOrCreateTrace } from "@openai/agents-core";
import type { ResolvedModelProvider } from "@opengeni/config";
import { codexResponsesTransport, type CodexWebSocketLike } from "@opengeni/codex";
import { withResponsesConversation } from "@opengeni/network/responses-websocket";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";
import {
  OpenGeniChatCompletionsModel,
  OpenGeniResponsesModel,
} from "../src/model-provider-routing";
import {
  guardRequestToolNames,
  isToolNameRejection,
  RejectedToolNames,
  responseRejectsToolName,
  restoreChatToolNames,
  restoreClaudeToolNames,
  restoreResponsesToolNames,
  type ToolNameAliases,
  type ToolNameWireApi,
} from "../src/provider-request-tool-names";
import { invalidRequestSignature } from "../src/provider-invalid-request";
import { isProviderToolName, providerToolNameAlias } from "../src/provider-tool-names";
import {
  ReplayableJsonOpenAI,
  requestBodyText,
  type ReplayableJsonOpenAIHooks,
} from "../src/replayable-json-body";

// The one format every provider and gateway accepts, and each provider's own.
const PORTABLE = /^[a-zA-Z0-9_-]{1,64}$/;
const PROVIDER_PATTERNS: Record<string, RegExp> = {
  "OpenAI Responses": /^[a-zA-Z0-9_-]+$/,
  "Codex response.create": /^[a-zA-Z0-9_.-]+$/,
  "Chat Completions": /^[a-zA-Z0-9_-]{1,64}$/,
  Claude: /^[a-zA-Z0-9_-]{1,128}$/,
};
// Gemini also wants a leading letter or `_`; every alias starts with a letter.
const GEMINI = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/;
const STRICT = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
// References are assembled so no tool on the way resolves them.
const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;

// ------------------------------------------------------------------ fixtures

/** A small seeded generator, so a failure names the seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a",
  "Z",
  "7",
  "_",
  "-",
  ".",
  "/",
  ":",
  " ",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "ü",
  "名",
  "🙂",
  "\t",
  '"',
  "\\",
  "server",
  "tool",
  "mcp_",
  "__",
  ref("Vault/db/password"),
  "[masked github token]",
  "[opengeni credential: deploy]",
  "[redacted: secret:abc]",
];
const VALID_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

/** An arbitrary tool name: empty, valid, or 1–300 characters of anything. */
function arbitraryName(next: () => number): string {
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const kind = next();
  if (kind < 0.04) return "";
  if (kind < 0.3) {
    const length = 1 + Math.floor(next() * 64);
    return Array.from({ length }, () => pick([...VALID_CHARACTERS])).join("");
  }
  const target = 1 + Math.floor(next() * next() * 300);
  let name = "";
  while (name.length < target) name += pick(PIECES);
  return [...name].slice(0, 300).join("");
}

/** Distinct names with near-collisions: separators swapped, truncations and stolen aliases. */
function arbitraryNames(next: () => number, count: number): string[] {
  const names = new Set<string>();
  while (names.size < count) {
    const name = arbitraryName(next);
    names.add(name);
    const variant = next();
    if (variant < 0.15) names.add(name.replaceAll(".", "_"));
    else if (variant < 0.25) names.add(`${name} `);
    else if (variant < 0.35) names.add(name.slice(0, 64));
    // A valid name that is another name's alias forces the guard to pick another.
    else if (variant < 0.5) names.add(providerToolNameAlias(name));
  }
  return [...names].slice(0, count);
}

type Position = { kind: "flat" | "namespace" | "leaf"; scope: string; name: string };

/**
 * Every tool-name position of a body of the fixture's shape, in order. It
 * is written independently of the guard, so a position the guard missed
 * shows up as an invalid name.
 */
function positions(api: ToolNameWireApi, body: any): Position[] {
  const found: Position[] = [];
  const flat = (name: string) => found.push({ kind: "flat", scope: "top", name });
  const ns = (name: string) => found.push({ kind: "namespace", scope: "top", name });
  const leaf = (scope: string, name: string) => found.push({ kind: "leaf", scope, name });
  if (api === "responses") {
    const definitions = (list: any[]) => {
      for (const def of list) {
        if (def.type === "namespace") {
          ns(def.name);
          for (const inner of def.tools) leaf(`ns:${def.name}`, inner.name);
        } else if (def.type === "tool_reference") flat(def.function_name);
        else flat(def.name);
      }
    };
    definitions(body.tools);
    for (const entry of body.tool_choice.tools) flat(entry.name);
    for (const item of body.input) {
      if (item.type === "function_call" && item.namespace) {
        ns(item.namespace);
        leaf(`ns:${item.namespace}`, item.name);
      } else if (item.type === "function_call" || item.type === "custom_tool_call") flat(item.name);
      else if (item.type === "tool_search_output" || item.type === "additional_tools")
        definitions(item.tools);
      else if (item.type === "mcp_list_tools")
        for (const tool of item.tools) leaf(`mcp:${item.server_label}`, tool.name);
      else if (item.type === "mcp_call") leaf(`mcp:${item.server_label}`, item.name);
    }
  } else if (api === "chat") {
    for (const tool of body.tools) flat(tool.function.name);
    flat(body.tool_choice.function.name);
    for (const message of body.messages)
      for (const call of message.tool_calls ?? []) flat(call.function.name);
  } else {
    for (const tool of body.tools) if (tool.type === undefined) flat(tool.name);
    flat(body.tool_choice.name);
    for (const message of body.messages)
      for (const block of message.content) if (block.type === "tool_use") flat(block.name);
  }
  return found;
}

const responsesDefinition = (name: string) => ({
  type: "function",
  name,
  description: "A tool",
  parameters: { type: "object", properties: {} },
  strict: false,
});

/** A request body of each wire API with the names in every position the guard knows. */
function hostileBody(
  api: ToolNameWireApi,
  flat: string[],
  namespace: string,
  leaves: string[],
  mcp: string[],
): Record<string, unknown> {
  if (api === "responses") {
    const definitions = () => [
      ...flat.map(responsesDefinition),
      {
        type: "namespace",
        name: namespace,
        description: "A namespace",
        tools: leaves.map(responsesDefinition),
      },
    ];
    return {
      model: "fixture",
      tools: definitions(),
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: flat.slice(0, 2).map((name) => ({ type: "function", name })),
      },
      input: [
        { type: "message", role: "user", content: "hi" },
        ...flat.map((name, index) => ({
          type: "function_call",
          call_id: `call_${index}`,
          name,
          arguments: "{}",
        })),
        ...flat.map((_, index) => ({
          type: "function_call_output",
          call_id: `call_${index}`,
          output: "ok",
        })),
        { type: "custom_tool_call", call_id: "custom", name: flat[0], input: "x" },
        ...leaves.map((name, index) => ({
          type: "function_call",
          call_id: `leaf_${index}`,
          namespace,
          name,
          arguments: "{}",
        })),
        {
          type: "tool_search_output",
          call_id: "search",
          execution: "client",
          status: "completed",
          tools: [
            ...definitions(),
            ...flat.map((name) => ({ type: "tool_reference", function_name: name })),
          ],
        },
        { type: "additional_tools", role: "developer", tools: flat.map(responsesDefinition) },
        {
          type: "mcp_list_tools",
          id: "list",
          server_label: "server",
          tools: mcp.map((name) => ({ name, input_schema: {} })),
        },
        ...mcp.map((name, index) => ({
          type: "mcp_call",
          id: `mcp_${index}`,
          server_label: "server",
          name,
          arguments: "{}",
        })),
      ],
    };
  }
  if (api === "chat") {
    return {
      model: "fixture",
      tools: flat.map((name) => ({
        type: "function",
        function: { name, description: "A tool", parameters: { type: "object" } },
      })),
      tool_choice: { type: "function", function: { name: flat[0] } },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: flat.map((name, index) => ({
            id: `call_${index}`,
            type: "function",
            function: { name, arguments: "{}" },
          })),
        },
        ...flat.map((_, index) => ({ role: "tool", tool_call_id: `call_${index}`, content: "ok" })),
      ],
    };
  }
  return {
    model: "fixture",
    max_tokens: 10,
    tools: [
      ...flat.map((name) => ({ name, description: "A tool", input_schema: { type: "object" } })),
      { type: "web_search_20250305", name: "web_search" },
    ],
    tool_choice: { type: "tool", name: flat[0] },
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: flat.map((name, index) => ({
          type: "tool_use",
          id: `t${index}`,
          name,
          input: {},
        })),
      },
      {
        role: "user",
        content: flat.map((_, index) => ({
          type: "tool_result",
          tool_use_id: `t${index}`,
          content: "ok",
        })),
      },
    ],
  };
}

function restoredFlat(api: ToolNameWireApi, aliases: ToolNameAliases, name: string): string {
  if (api === "responses") {
    return restoreResponsesToolNames(
      { output: [{ type: "function_call", call_id: "c", name, arguments: "{}" }] },
      aliases,
    ).output[0]!.name;
  }
  if (api === "chat") {
    return restoreChatToolNames(
      {
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [{ id: "c", type: "function", function: { name, arguments: "{}" } }],
            },
          },
        ],
      },
      aliases,
    ).choices[0]!.message.tool_calls[0]!.function.name;
  }
  return restoreClaudeToolNames(
    { content: [{ type: "tool_use", id: "t", name, input: {} }] },
    aliases,
  ).content[0]!.name;
}

/** The properties every guarded request must have (see the module comment of the guard). */
function expectGuarded(api: ToolNameWireApi, original: any, strict: boolean): void {
  const guarded = guardRequestToolNames(api, original, { strict });
  const before = positions(api, original);
  const after = positions(api, guarded.body);
  expect(after).toHaveLength(before.length);
  const finals = new Map<string, string>();
  const owners = new Map<string, string>();
  before.forEach((position, index) => {
    const final = after[index]!.name;
    for (const [provider, pattern] of Object.entries(PROVIDER_PATTERNS)) {
      if (!pattern.test(final)) throw new Error(`${provider} rejects ${JSON.stringify(final)}`);
    }
    expect(final).toMatch(PORTABLE);
    if (strict) expect(final).toMatch(STRICT);
    else if (isProviderToolName(position.name)) expect(final).toBe(position.name);
    else expect(final).toMatch(GEMINI);
    // One name per tool, the same in every position.
    const identity = `${position.kind}\u0000${position.scope}\u0000${position.name}`;
    expect(finals.get(identity) ?? final).toBe(final);
    finals.set(identity, final);
    // Two tools never share a name in one scope.
    const owner = `${position.kind === "leaf" ? position.scope : "top"}\u0000${final}`;
    const kindAndName = `${position.kind}\u0000${position.name}`;
    expect(owners.get(owner) ?? kindAndName).toBe(kindAndName);
    owners.set(owner, kindAndName);
    // A call to the name the provider saw runs the original tool.
    if (position.kind === "flat")
      expect(restoredFlat(api, guarded.aliases, final)).toBe(position.name);
    if (position.kind === "namespace")
      expect(guarded.aliases.restoreNamespace(final)).toBe(position.name);
    if (position.kind === "leaf") {
      const scope = position.scope.startsWith("ns:")
        ? position.scope.slice(3)
        : `\u0000mcp:${position.scope.slice(4)}`;
      expect(guarded.aliases.restoreLeaf(scope, final)).toBe(position.name);
    }
  });
  // Deterministic: the same request is sent byte for byte.
  expect(JSON.stringify(guardRequestToolNames(api, original, { strict }).body)).toBe(
    JSON.stringify(guarded.body),
  );
  if (api === "anthropic-messages") {
    // Claude's own server tool keeps its fixed name.
    expect((guarded.body.tools as any[]).at(-1)).toEqual({
      type: "web_search_20250305",
      name: "web_search",
    });
  }
}

// --------------------------------------------------------------- the guard

describe("outbound tool-name guard", () => {
  const apis: ToolNameWireApi[] = ["responses", "chat", "anthropic-messages"];

  test("arbitrary names in every position reach every provider valid and route back (seeded)", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const flat = arbitraryNames(next, 1 + Math.floor(next() * 6));
      const leaves = arbitraryNames(next, 1 + Math.floor(next() * 3));
      const mcp = arbitraryNames(next, 1 + Math.floor(next() * 3));
      const namespace = arbitraryName(next);
      for (const api of apis) {
        for (const strict of [false, true]) {
          try {
            expectGuarded(api, hostileBody(api, flat, namespace, leaves, mcp), strict);
          } catch (error) {
            throw new Error(`seed ${seed}, ${api}, strict ${strict}: ${String(error)}`, {
              cause: error,
            });
          }
        }
      }
    }
  });

  test("a request whose names are all valid is sent unchanged, by identity", () => {
    for (const api of apis) {
      const body = hostileBody(api, ["lookup", "exec_command"], "github", ["search"], ["query"]);
      const guarded = guardRequestToolNames(api, body);
      expect(guarded.body).toBe(body);
      expect(guarded.aliases.size).toBe(0);
      expect(guarded.repaired).toEqual([]);
    }
  });

  test("only the items with an invalid name are copied", () => {
    const body = hostileBody("responses", ["lookup", "server.lookup"], "github", ["search"], ["q"]);
    const guarded = guardRequestToolNames("responses", body);
    const before = body.input as unknown[];
    const after = guarded.body.input as unknown[];
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(guarded.repaired).toEqual(["history", "tool_choice", "tools"]);
  });

  test("an alias never takes a name the request already uses", () => {
    const invalid = "server.lookup";
    const body = hostileBody("chat", [invalid, providerToolNameAlias(invalid)], "n", ["l"], ["m"]);
    const names = (guardRequestToolNames("chat", body).body.tools as any[]).map(
      (tool) => tool.function.name,
    );
    expect(names).toEqual([`${providerToolNameAlias(invalid)}_2`, providerToolNameAlias(invalid)]);
  });

  test("a name repeated in one definition list is declared once", () => {
    const { body } = guardRequestToolNames("responses", {
      input: [
        {
          type: "tool_search_output",
          tools: [responsesDefinition("a.b"), responsesDefinition("a.b"), responsesDefinition("c")],
        },
      ],
    });
    const tools = (body.input as any[])[0].tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual([providerToolNameAlias("a.b"), "c"]);
  });

  test("a forced choice of a tool inside a namespace keeps its qualified form", () => {
    const { body, aliases } = guardRequestToolNames("responses", {
      tools: [{ type: "namespace", name: "git hub", tools: [responsesDefinition("open.pr")] }],
      tool_choice: { type: "function", name: "git hub.open.pr" },
    });
    const namespace = providerToolNameAlias("git hub");
    const leaf = providerToolNameAlias("open.pr");
    expect((body.tool_choice as any).name).toBe(`${namespace}.${leaf}`);
    const restored = restoreResponsesToolNames(
      { output: [{ type: "function_call", namespace, name: leaf, call_id: "c", arguments: "{}" }] },
      aliases,
    );
    expect(restored.output[0]).toMatchObject({ namespace: "git hub", name: "open.pr" });
  });

  test("a streamed call event inside a namespace gets its original names back", () => {
    const { aliases } = guardRequestToolNames("responses", {
      tools: [{ type: "namespace", name: "git hub", tools: [responsesDefinition("open.pr")] }],
    });
    const restored = restoreResponsesToolNames(
      {
        type: "response.function_call_arguments.done",
        namespace: providerToolNameAlias("git hub"),
        name: providerToolNameAlias("open.pr"),
        arguments: "{}",
      },
      aliases,
    );
    expect(restored).toMatchObject({ namespace: "git hub", name: "open.pr" });
  });

  test("names a route rejected before are aliased; every other name stays", () => {
    const rejected = new RejectedToolNames();
    rejected.rememberRequest("responses", {
      tools: [responsesDefinition("web-search"), responsesDefinition("exec_command")],
    });
    // Only names outside the portable form are remembered.
    expect(rejected.has("web-search")).toBe(true);
    expect(rejected.has("exec_command")).toBe(false);
    const { body } = guardRequestToolNames(
      "responses",
      { tools: [responsesDefinition("web-search"), responsesDefinition("exec_command")] },
      { rejected },
    );
    expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      providerToolNameAlias("web-search"),
      "exec_command",
    ]);
  });
});

describe("which provider rejections the strict resend answers", () => {
  const rejects = (body: unknown) =>
    isToolNameRejection(invalidRequestSignature(body), String((body as any).error?.message ?? ""));

  test("tool-name pattern and length errors from every provider", () => {
    // The production failures: a Responses history item and a Codex WebSocket call.
    expect(
      rejects({
        error: {
          message:
            "Invalid 'input[26].tools[1].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.",
          type: "invalid_request_error",
          param: "input[26].tools[1].name",
          code: "invalid_string",
        },
      }),
    ).toBe(true);
    expect(
      rejects({
        error: {
          message:
            "Invalid 'input[5].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_.-]+\\z'.",
          type: "invalid_request_error",
        },
      }),
    ).toBe(true);
    expect(
      rejects({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "messages.1.content.0.tool_use.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'",
        },
      }),
    ).toBe(true);
    expect(
      rejects({
        error: {
          message:
            "Invalid 'tools[3].function.name': string too long. Expected a string with maximum length 64.",
          param: "tools[3].function.name",
          code: "string_above_max_length",
        },
      }),
    ).toBe(true);
    expect(
      rejects({
        error: { message: "bad tool_choice", param: "tool_choice.name", code: "invalid_string" },
      }),
    ).toBe(true);
  });

  test("any other 400 is left alone", () => {
    expect(
      rejects({
        error: {
          message: "Invalid value for 'content'.",
          param: "input[3].content",
          code: "invalid_value",
        },
      }),
    ).toBe(false);
    expect(
      rejects({ error: { message: "context_length_exceeded", code: "context_length_exceeded" } }),
    ).toBe(false);
    expect(
      rejects({
        error: { message: "Invalid 'input[2].name': unknown tool", param: "input[2].name" },
      }),
    ).toBe(false);
    expect(rejects({})).toBe(false);
  });
});

// --------------------------------------------------------------- adapters

const provider: ResolvedModelProvider = {
  id: "fixture",
  label: "Fixture",
  kind: "api-key",
  api: "responses",
  builtin: false,
  baseUrl: "https://example.test/v1",
  apiKey: "fixture-key",
};

function functionTool(name: string) {
  return {
    type: "function" as const,
    name,
    description: `The ${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: false,
  };
}

function modelRequest(tools: string[], history: string[] = [], toolChoice?: string): ModelRequest {
  const input: Array<Record<string, unknown>> = [{ type: "message", role: "user", content: "Go" }];
  history.forEach((name, index) => {
    input.push(
      {
        type: "function_call",
        callId: `call_${index}`,
        name,
        arguments: "{}",
        status: "completed",
      },
      {
        type: "function_call_result",
        callId: `call_${index}`,
        name,
        status: "completed",
        output: "ok",
      },
    );
  });
  return {
    input: input as ModelRequest["input"],
    modelSettings: toolChoice ? { toolChoice } : {},
    tools: tools.map(functionTool),
    handoffs: [],
    outputType: "text",
    tracing: false,
  };
}

type Reply = (body: any, attempt: number) => Response;

function openAIClient(
  routed: ResolvedModelProvider,
  reply: Reply,
  hooks: ReplayableJsonOpenAIHooks = {},
  policy = modelRequestPolicyForProvider(routed),
) {
  const bodies: any[] = [];
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "fixture-key",
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const body = JSON.parse(await requestBodyText(init?.body));
        bodies.push(body);
        return reply(body, bodies.length);
      },
    },
    { ...hooks, modelRequestPolicy: policy },
  );
  return { client, bodies };
}

const responsesCall = (name: string) =>
  Response.json({
    id: "response-fixture",
    object: "response",
    status: "completed",
    output: [
      {
        id: "call-item",
        type: "function_call",
        call_id: "call_new",
        name,
        arguments: "{}",
        status: "completed",
      },
    ],
  });

const chatCall = (name: string) =>
  Response.json({
    id: "reply-fixture",
    object: "chat.completion",
    created: 1,
    model: "fixture-model",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_new", type: "function", function: { name, arguments: "{}" } }],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const nameRejection = (path: string) =>
  Response.json(
    {
      error: {
        message: `Invalid '${path}': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`,
        type: "invalid_request_error",
        param: path,
        code: "invalid_string",
      },
    },
    { status: 400 },
  );

function calledName(output: ModelRequest["input"] | readonly unknown[]): string | undefined {
  return (output as Array<Record<string, unknown>>).find((item) => item.type === "function_call")
    ?.name as string | undefined;
}

function expectWireNames(api: ToolNameWireApi, body: any): void {
  const names: string[] = [];
  if (api === "responses") {
    for (const tool of body.tools ?? []) if (typeof tool.name === "string") names.push(tool.name);
    for (const item of body.input ?? []) if (typeof item.name === "string") names.push(item.name);
    if (body.tool_choice?.name) names.push(body.tool_choice.name);
  } else {
    for (const tool of body.tools ?? []) names.push(tool.function.name);
    for (const message of body.messages ?? [])
      for (const call of message.tool_calls ?? []) names.push(call.function.name);
    if (body.tool_choice?.function) names.push(body.tool_choice.function.name);
  }
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(name).toMatch(PORTABLE);
}

const HOSTILE_TOOLS = [
  "server.lookup",
  "server/lookup/v2",
  "ns:tool",
  "has space",
  "ünïcode_tööl",
  `long_${"x".repeat(80)}`,
  "dup.name",
  "dup:name",
  `server__${ref("Vault/db/password")}`,
  "exec_command",
];

describe("every adapter sends valid names and routes calls back to the original tool", () => {
  test("Responses HTTP: tools[M].name, input[N].name and tool_choice", async () => {
    for (const [index, original] of HOSTILE_TOOLS.entries()) {
      let sentName = "";
      const { client, bodies } = openAIClient(provider, (body) => {
        sentName = body.tools[index].name;
        return responsesCall(sentName);
      });
      const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
      const response = await getOrCreateTrace(() =>
        model.getResponse(modelRequest(HOSTILE_TOOLS, HOSTILE_TOOLS, original)),
      );
      expectWireNames("responses", bodies[0]);
      // The request's tool, its history calls and the forced choice share one name.
      const calls = bodies[0].input.filter((item: any) => item.type === "function_call");
      expect(calls[index].name).toBe(sentName);
      expect(bodies[0].tool_choice.name).toBe(sentName);
      expect(calledName(response.output)).toBe(original);
    }
  });

  test("Responses streaming: the call's events carry the original name", async () => {
    const original = "server.lookup";
    const alias = providerToolNameAlias(original);
    const item = {
      id: "call-item",
      type: "function_call",
      call_id: "call_new",
      name: alias,
      arguments: "{}",
      status: "completed",
    };
    const events = [
      { type: "response.created", response: { id: "r", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress" },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: { id: "r", object: "response", status: "completed", output: [item] },
      },
    ];
    const { client } = openAIClient(
      provider,
      () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    const names: string[] = [];
    let done: any;
    await getOrCreateTrace(async () => {
      for await (const event of model.getStreamedResponse(modelRequest([original]))) {
        if (event.type === "model" && (event.event as any).item?.name)
          names.push((event.event as any).item.name);
        if (event.type === "response_done") done = event.response;
      }
    });
    expect(names).toEqual([original, original]);
    expect(calledName(done.output)).toBe(original);
  });

  test("Chat Completions: hostile tools and a forced choice; invalid history replays as facts", async () => {
    const chatProvider: ResolvedModelProvider = { ...provider, api: "chat" };
    for (const [index, original] of HOSTILE_TOOLS.entries()) {
      const { client, bodies } = openAIClient(chatProvider, (body) =>
        chatCall(body.tools[index].function.name),
      );
      const model = new OpenGeniChatCompletionsModel(client, "google/gemini-fixture");
      const response = await getOrCreateTrace(() =>
        model.getResponse(modelRequest(HOSTILE_TOOLS, ["exec_command", "server.lookup"], original)),
      );
      expectWireNames("chat", bodies[0]);
      expect(bodies[0].tool_choice.function.name).toBe(bodies[0].tools[index].function.name);
      expect(calledName(response.output)).toBe(original);
    }
  });

  test("a gateway route (Vercel AI Gateway) gets the same guard after its own policy", async () => {
    const gateway: ResolvedModelProvider = {
      ...provider,
      kind: "vercel-gateway-managed",
      api: "chat",
    };
    const policies = new Map([["fixture/model", undefined]]);
    const { client, bodies } = openAIClient(
      gateway,
      (body) => chatCall(body.tools[0].function.name),
      {},
      modelRequestPolicyForProvider(gateway, policies),
    );
    const model = new OpenGeniChatCompletionsModel(client, "fixture/model");
    const response = await getOrCreateTrace(() =>
      model.getResponse(modelRequest(["server.lookup", "exec_command"])),
    );
    expectWireNames("chat", bodies[0]);
    expect(bodies[0].tools[0].function.name).toBe(providerToolNameAlias("server.lookup"));
    expect(calledName(response.output)).toBe("server.lookup");
  });

  test("Claude Messages: every name valid, and a call routes back", async () => {
    const bodies: any[] = [];
    const model = new AnthropicMessagesModel(
      { ...provider, api: "anthropic-messages" },
      "claude-fixture",
      (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(await requestBodyText(init?.body));
        bodies.push(body);
        return Response.json({
          id: "message-fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }) as typeof fetch,
    );
    const response = await getOrCreateTrace(() =>
      model.getResponse(modelRequest(HOSTILE_TOOLS, HOSTILE_TOOLS)),
    );
    for (const tool of bodies[0].tools) expect(tool.name).toMatch(PORTABLE);
    for (const message of bodies[0].messages)
      for (const block of message.content)
        if (block.type === "tool_use") expect(block.name).toMatch(PORTABLE);
    expect(calledName(response.output)).toBe(HOSTILE_TOOLS[0]);
  });
});

class FakeSocket implements CodexWebSocketLike {
  readyState = 0;
  sent: Array<Record<string, any>> = [];
  onopen: CodexWebSocketLike["onopen"] = null;
  onmessage: CodexWebSocketLike["onmessage"] = null;
  onerror: CodexWebSocketLike["onerror"] = null;
  onclose: CodexWebSocketLike["onclose"] = null;
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

async function sentCount(socket: () => FakeSocket | undefined, count: number) {
  for (let i = 0; i < 200 && (socket()?.sent.length ?? 0) < count; i++) await Bun.sleep(1);
  expect(socket()?.sent.length).toBe(count);
}

function codexClient(retries: Array<{ outcome: string }> = []) {
  let socket: FakeSocket | undefined;
  const transport = codexResponsesTransport(
    async () => new Response("unexpected", { status: 500 }),
    {
      createSocket: () => {
        socket = new FakeSocket();
        const opened = socket;
        queueMicrotask(() => opened.open());
        return opened;
      },
      connectTimeoutMs: 1_000,
    },
  );
  const client = new ReplayableJsonOpenAI(
    {
      apiKey: "token",
      baseURL: "https://chatgpt.example/backend-api/codex",
      maxRetries: 0,
      fetch: transport as typeof globalThis.fetch,
    },
    { onToolNameRetry: (observation) => retries.push(observation) },
  );
  return { client, socket: () => socket };
}

/** A wire body with a history call by a hostile name, as the SDK sends it. */
function codexBody(name: string) {
  return {
    model: "m",
    stream: true as const,
    tools: [responsesDefinition(name), responsesDefinition("exec_command")],
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name, arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
  } as any;
}

describe("the Codex WebSocket response.create payload", () => {
  test("carries valid names, and the streamed call routes back", async () => {
    const original = `server__${ref("Vault/db/password")}`;
    const { client, socket } = codexClient();
    const pending = withResponsesConversation("tool-names", () =>
      client.responses.create(codexBody(original)).withResponse(),
    );
    await sentCount(socket, 1);
    const payload = socket()!.sent[0]!;
    expect(payload.type).toBe("response.create");
    const alias = providerToolNameAlias(original);
    expect(payload.tools.map((tool: { name: string }) => tool.name)).toEqual([
      alias,
      "exec_command",
    ]);
    expect(payload.input[1].name).toBe(alias);
    const item = { type: "function_call", id: "i", call_id: "c2", name: alias, arguments: "{}" };
    socket()!.emit({ type: "response.created", response: { id: "r1" } });
    socket()!.emit({ type: "response.output_item.done", output_index: 0, item });
    socket()!.emit({ type: "response.completed", response: { id: "r1", output: [item] } });
    const { data: stream } = await pending;
    const names: string[] = [];
    for await (const event of stream as AsyncIterable<any>) {
      if (event.item) names.push(event.item.name);
      if (event.type === "response.completed") names.push(event.response.output[0].name);
    }
    expect(names).toEqual([original, original]);
    socket()!.close();
  });

  test("a refused name is resent once, strictly, on the same connection", async () => {
    const retries: Array<{ outcome: string }> = [];
    const { client, socket } = codexClient(retries);
    const pending = withResponsesConversation("tool-names-retry", () =>
      client.responses.create(codexBody("lookup")).withResponse(),
    );
    await sentCount(socket, 1);
    expect(socket()!.sent[0]!.input[1].name).toBe("lookup");
    socket()!.emit({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message:
          "Invalid 'input[1].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_.-]+\\z'.",
      },
    });
    await sentCount(socket, 2);
    const strict = socket()!.sent[1]!;
    const alias = providerToolNameAlias("lookup");
    expect(strict.input[1].name).toBe(alias);
    expect(strict.tools.map((tool: { name: string }) => tool.name)).toEqual([
      alias,
      providerToolNameAlias("exec_command"),
    ]);
    // Nothing else of the request changes.
    expect(strict.input[2]).toEqual(socket()!.sent[0]!.input[2]);
    const item = { type: "function_call", id: "i", call_id: "c2", name: alias, arguments: "{}" };
    socket()!.emit({ type: "response.created", response: { id: "r2" } });
    socket()!.emit({ type: "response.completed", response: { id: "r2", output: [item] } });
    const { data: stream } = await pending;
    const names: string[] = [];
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === "response.completed") names.push(event.response.output[0].name);
    }
    expect(names).toEqual(["lookup"]);
    expect(retries).toEqual([{ api: "responses", outcome: "completed" } as any]);
    socket()!.close();
  });
});

describe("the strict resend after a rejected tool name", () => {
  test("Responses: resent once with every name aliased; the call routes back", async () => {
    const repairs: unknown[] = [];
    const retries: unknown[] = [];
    const { client, bodies } = openAIClient(
      provider,
      (body, attempt) =>
        attempt === 1 ? nameRejection("input[1].name") : responsesCall(body.tools[1].name),
      {
        onToolNameRepair: (observation) => repairs.push(observation),
        onToolNameRetry: (observation) => retries.push(observation),
      },
    );
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    const response = await getOrCreateTrace(() =>
      model.getResponse(modelRequest(["server.lookup", "exec_command"], ["exec_command"])),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools[1].name).toBe("exec_command");
    expect(bodies[1].tools.map((tool: { name: string }) => tool.name)).toEqual([
      providerToolNameAlias("server.lookup"),
      providerToolNameAlias("exec_command"),
    ]);
    expect(bodies[1].input[1].name).toBe(providerToolNameAlias("exec_command"));
    // Only names change.
    expect({ ...bodies[1], tools: null, input: null }).toEqual({
      ...bodies[0],
      tools: null,
      input: null,
    });
    expect(calledName(response.output)).toBe("exec_command");
    expect(repairs).toEqual([{ api: "responses", field: "tools" }]);
    expect(retries).toEqual([{ api: "responses", outcome: "completed" }]);
  });

  test("a second rejection fails the turn with the provider's message; nothing loops", async () => {
    const retries: unknown[] = [];
    const { client, bodies } = openAIClient(provider, () => nameRejection("input[1].name"), {
      onToolNameRetry: (observation) => retries.push(observation),
    });
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    const failure = await getOrCreateTrace(() =>
      model.getResponse(modelRequest(["exec_command"], ["exec_command"])),
    ).catch((error: unknown) => error);
    expect(String((failure as Error).message)).toContain("does not match pattern");
    expect(bodies).toHaveLength(2);
    expect(retries).toEqual([{ api: "responses", outcome: "failed" }]);
  });

  test("any other 400 is returned as it is, without a resend", async () => {
    const { client, bodies } = openAIClient(provider, () =>
      Response.json(
        {
          error: {
            message: "Invalid value for 'content'.",
            type: "invalid_request_error",
            param: "input[0].content",
            code: "invalid_value",
          },
        },
        { status: 400 },
      ),
    );
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    await getOrCreateTrace(() => model.getResponse(modelRequest(["exec_command"]))).catch(
      () => undefined,
    );
    expect(bodies).toHaveLength(1);
  });

  test("the route's rejected names are aliased on later requests, without another rejection", async () => {
    const retries: unknown[] = [];
    const { client, bodies } = openAIClient(
      provider,
      (body, attempt) =>
        attempt === 1 ? nameRejection("tools[0].name") : responsesCall(body.tools[0].name),
      { onToolNameRetry: (observation) => retries.push(observation) },
    );
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    await getOrCreateTrace(() => model.getResponse(modelRequest(["web-search", "exec_command"])));
    const later = await getOrCreateTrace(() =>
      model.getResponse(modelRequest(["web-search", "exec_command"], ["web-search"])),
    );
    expect(bodies).toHaveLength(3);
    expect(bodies[0].tools[0].name).toBe("web-search");
    expect(bodies[2].tools.map((tool: { name: string }) => tool.name)).toEqual([
      providerToolNameAlias("web-search"),
      "exec_command",
    ]);
    expect(bodies[2].input[1].name).toBe(providerToolNameAlias("web-search"));
    expect(calledName(later.output)).toBe("web-search");
    expect(retries).toEqual([{ api: "responses", outcome: "completed" }]);
  });

  test("the resend carries its own request identity", async () => {
    const sent: Array<{ requestId: string | null; idempotencyKey: string | null }> = [];
    const client = new ReplayableJsonOpenAI(
      {
        apiKey: "fixture-key",
        baseURL: "https://example.test/v1",
        maxRetries: 0,
        fetch: async (_url, init) => {
          const body = JSON.parse(await requestBodyText(init?.body));
          const headers = new Headers(init?.headers);
          sent.push({
            requestId: headers.get("x-opengeni-request-id"),
            idempotencyKey: headers.get("idempotency-key"),
          });
          return sent.length === 1
            ? nameRejection("tools[0].name")
            : responsesCall(body.tools[0].name);
        },
      },
      {
        modelRequestPolicy: () => ({
          headers: { "x-opengeni-request-id": "request-1", "idempotency-key": "request-1" },
        }),
      },
    );
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    await getOrCreateTrace(() => model.getResponse(modelRequest(["lookup"])));
    expect(sent).toEqual([
      { requestId: "request-1", idempotencyKey: "request-1" },
      { requestId: "request-1:tool-names", idempotencyKey: "request-1:tool-names" },
    ]);
  });

  test("a rejection with no tool name to alias is returned without a resend", async () => {
    const { client, bodies } = openAIClient(provider, () => nameRejection("input[0].name"));
    const model = new OpenGeniResponsesModel(client, "fixture-responses", provider);
    const failure = await getOrCreateTrace(() => model.getResponse(modelRequest([]))).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(bodies).toHaveLength(1);
  });

  test("an oversized error body is never read as a tool-name rejection", async () => {
    const oversized = Response.json(
      {
        error: {
          message: `Invalid 'tools[0].name': string does not match pattern. ${"x".repeat(70_000)}`,
          param: "tools[0].name",
          code: "invalid_string",
        },
      },
      { status: 400 },
    );
    expect(await responseRejectsToolName(oversized)).toBe(false);
    expect(await responseRejectsToolName(nameRejection("tools[0].name"))).toBe(true);
  });

  test("Chat Completions: resent once with every name aliased", async () => {
    const chatProvider: ResolvedModelProvider = { ...provider, api: "chat" };
    const { client, bodies } = openAIClient(chatProvider, (body, attempt) =>
      attempt === 1
        ? nameRejection("tools[0].function.name")
        : chatCall(body.tools[0].function.name),
    );
    const model = new OpenGeniChatCompletionsModel(client, "fixture-model");
    const response = await getOrCreateTrace(() => model.getResponse(modelRequest(["lookup"])));
    expect(bodies).toHaveLength(2);
    expect(bodies[1].tools[0].function.name).toBe(providerToolNameAlias("lookup"));
    expect(calledName(response.output)).toBe("lookup");
  });

  test("Claude Messages: resent once with every name aliased; then the provider's error", async () => {
    for (const secondOk of [true, false]) {
      const bodies: any[] = [];
      const retries: unknown[] = [];
      const model = new AnthropicMessagesModel(
        { ...provider, api: "anthropic-messages" },
        "claude-fixture",
        (async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(await requestBodyText(init?.body));
          bodies.push(body);
          if (bodies.length === 1 || !secondOk)
            return Response.json(
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message:
                    "tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'",
                },
              },
              { status: 400 },
            );
          return Response.json({
            id: "message-fixture",
            type: "message",
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: {} }],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }) as typeof fetch,
        { onToolNameRetry: (observation) => retries.push(observation) },
      );
      const result = await getOrCreateTrace(() =>
        model.getResponse(modelRequest(["lookup"], ["lookup"])),
      ).catch((error: unknown) => error);
      expect(bodies).toHaveLength(2);
      expect(bodies[1].tools[0].name).toBe(providerToolNameAlias("lookup"));
      if (secondOk) {
        expect(calledName((result as { output: unknown[] }).output)).toBe("lookup");
        expect(retries).toEqual([{ api: "anthropic-messages", outcome: "completed" }]);
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(retries).toEqual([{ api: "anthropic-messages", outcome: "failed" }]);
      }
    }
  });

  test("Claude Messages: the rejected names are aliased on the next request without a rejection", async () => {
    const bodies: any[] = [];
    const model = new AnthropicMessagesModel(
      { ...provider, api: "anthropic-messages" },
      "claude-fixture",
      (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(await requestBodyText(init?.body));
        bodies.push(body);
        if (bodies.length === 1)
          return Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "tools.0.custom.name: String should match pattern '^[a-zA-Z_]{1,64}$'",
              },
            },
            { status: 400 },
          );
        return Response.json({
          id: "message-fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }) as typeof fetch,
    );
    await getOrCreateTrace(() => model.getResponse(modelRequest(["web-search", "lookup"])));
    const later = await getOrCreateTrace(() =>
      model.getResponse(modelRequest(["web-search", "lookup"])),
    );
    expect(bodies).toHaveLength(3);
    expect(bodies[0].tools[0].name).toBe("web-search");
    expect(bodies[2].tools.map((tool: { name: string }) => tool.name)).toEqual([
      providerToolNameAlias("web-search"),
      "lookup",
    ]);
    expect(calledName(later.output)).toBe("web-search");
  });
});
