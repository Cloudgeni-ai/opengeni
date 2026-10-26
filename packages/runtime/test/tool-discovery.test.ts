import { describe, expect, test } from "bun:test";
import {
  Agent,
  OpenAIResponsesModel,
  Runner,
  tool,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import OpenAI from "openai";
import { testSettings } from "@opengeni/testing";
import { createHttpDecisionModel } from "@opengeni/decisions";
import { ToolSearchIndex } from "../src/tool-discovery-ranking";
import { rankToolPool } from "../src/codex-tool-search";
import { GMAIL_REST_MCP_TOOLS } from "../src/gmail-rest-mcp";
import {
  catalogConnectableIntegrationLookup,
  connectableIntegrationNotice,
  connectableIntegrationsFromCatalogResult,
  connectableIntegrationsNamedIn,
  connectedAccountsNotice,
  createResolveMissingFunctionTool,
  expandInteractionFamilyDisclosures,
  installLazyToolRuntime,
  LazyToolRuntime,
  LazyToolModelProvider,
  transformGenericDispatchResponse,
  type ConnectableIntegrationLookup,
  type ConnectedToolAccount,
} from "../src/lazy-tool-transport";
import { baseModelInputFilterForSettings } from "../src/model-input";
import { projectHistoryForProvider, TOOL_DISCLOSURE_KEY } from "../src/provider-history-adapter";
import {
  createToolSelector,
  toolSelectionRequest,
  type ToolSelector,
} from "../src/tool-discovery-decision";

function candidate(
  name: string,
  description: string,
  parameters: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
): Tool {
  return tool({
    name,
    description,
    parameters: parameters as never,
    strict: false,
    execute: () => "ok",
  }) as Tool;
}
const names = (tools: Tool[]) => tools.map((t) => (t as Tool & { name: string }).name);
const call = (id: string, name: string, args: unknown) => ({
  type: "function_call" as const,
  callId: id,
  name,
  arguments: JSON.stringify(args),
});
const searchCall = (transport: string, id: string, args: Record<string, unknown>) =>
  transport === "generic_dispatch"
    ? call(id, "tool_search", args)
    : {
        type: "tool_search_call" as const,
        call_id: id,
        execution: "client" as const,
        status: "completed" as const,
        arguments: args,
      };
const invokeCall = (transport: string, id: string, name: string, args: unknown) =>
  transport === "generic_dispatch"
    ? call(id, "tool_invoke", { name, arguments: args })
    : call(id, name, args);
const done = {
  type: "message" as const,
  role: "assistant" as const,
  status: "completed" as const,
  content: [{ type: "output_text" as const, text: "done" }],
};
class ResponsesWireModel extends OpenAIResponsesModel {
  wire(request: ModelRequest) {
    return this._buildResponsesCreateRequest(request, false).requestData;
  }
}
const responsesWire = () =>
  new ResponsesWireModel(
    new OpenAI({ apiKey: "test", baseURL: "https://example.invalid/v1" }),
    "test-model",
  );

describe("tool discovery ranking", () => {
  test("matches inflections without penalizing a long operational description", () => {
    const get = candidate(
      "workspace__scheduled_tasks_get",
      "Get a scheduled task's details. " + "Operational notes about schedules. ".repeat(100),
    );
    const list = candidate("workspace__scheduled_tasks_list", "List scheduled tasks");
    const pause = candidate("workspace__scheduled_tasks_pause", "Pause a scheduled task");
    expect(new ToolSearchIndex([list, pause, get]).rank("get scheduled task details", 1)).toEqual([
      get,
    ]);
    expect(new ToolSearchIndex([list, pause, get]).rank("pause a schedule", 1)).toEqual([pause]);
  });
  test("keeps independent semicolon-delimited capabilities in the first positions", () => {
    const read = candidate("messages__read_message", "Read a message");
    const create = candidate("calendar__create_event", "Create a calendar event");
    const search = candidate("messages__search_messages", "Search message contents");
    expect(
      names(
        rankToolPool([search, read, create], {
          query: "read a message; create a calendar event",
          limit: 2,
        }),
      ),
    ).toEqual(["messages__read_message", "calendar__create_event"]);
  });
  test("retains original references and exact requested name order", () => {
    const first = candidate("tasks__read", "Read task");
    const second = candidate("tasks__create", "Create task");
    expect(
      rankToolPool([first, second], {
        query: "",
        names: ["tasks__create", "missing", "tasks__read"],
      }),
    ).toEqual([second, first]);
  });
  test("empty and unrelated queries disclose nothing; Unicode words are searchable", () => {
    const entry = candidate("faktura__hent", "Hent faktura for kunden");
    const index = new ToolSearchIndex([entry]);
    expect(index.rank("the and of", 8)).toEqual([]);
    expect(index.rank("unmatched qqq", 8)).toEqual([]);
    expect(index.rank("hent faktura", 1)).toEqual([entry]);
  });
});

describe("compact candidates and exact schema loading", () => {
  test("a huge candidate never crowds other matches out or leaks schemas into ranked results", () => {
    const huge = candidate("tasks__get", "Get task details", {
      type: "object",
      properties: { payload: { type: "string", description: "z".repeat(600_000) } },
    });
    const small = candidate("tasks__list", "List task details");
    const runtime = new LazyToolRuntime("codex_native", new Set());
    runtime.refresh([huge, small]);
    const result = runtime.genericSearchOutput({ query: "task details" });
    expect(JSON.parse(result).tools).toHaveLength(2);
    expect(result).not.toContain("parameters");
    expect(result).not.toContain("payload");
    expect(JSON.parse(result).schemasLoaded).toBe(false);
    expect(runtime.searchDisclosure({ query: "task details" })).toEqual([]);
  });
  test("schema snapshots are detached, append-only, and independent of a later catalog", () => {
    const parameters = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    const selected = candidate("tasks__get", "Get task", parameters);
    const runtime = new LazyToolRuntime("codex_native", new Set());
    runtime.refresh([selected]);
    const marked = transformGenericDispatchResponse(
      {
        usage: new Usage(),
        output: [call("load", "tool_search", { query: "", names: ["tasks__get"] })],
      },
      runtime,
    ).output[0]!;
    const result = {
      type: "function_call_result",
      callId: "load",
      name: "tool_search",
      output: runtime.genericSearchOutput({ query: "", names: ["tasks__get"] }),
    };
    const original = [marked, result];
    const first = expandInteractionFamilyDisclosures(original);
    const frozen = JSON.stringify(first);
    parameters.properties.id.type = "number";
    runtime.refresh([candidate("unrelated__delete", "Delete unrelated item")]);
    const later = expandInteractionFamilyDisclosures([...original, done]);
    expect(JSON.stringify(later.slice(0, first.length))).toBe(frozen);
    expect(first.at(-1)).toBe(later[first.length - 1]);
    expect(JSON.stringify(first.at(-1))).toContain('"type":"string"');
    for (const api of ["responses", "chat", "anthropic-messages"] as const) {
      const options =
        api === "responses"
          ? { declaresAdditionalTools: true }
          : api === "chat"
            ? { hoistsSystemMessages: true }
            : {};
      const before = projectHistoryForProvider(first as Record<string, unknown>[], api, options);
      const after = projectHistoryForProvider(later as Record<string, unknown>[], api, options);
      expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    }
  });
  test("compact hits do not suppress a subsequent full disclosure", () => {
    const selected = candidate("tasks__get", "Get task");
    const runtime = new LazyToolRuntime("generic_dispatch", new Set());
    runtime.refresh([selected]);
    const mark = (id: string, args: unknown) =>
      transformGenericDispatchResponse(
        { usage: new Usage(), output: [call(id, "tool_search", args)] },
        runtime,
      ).output[0]!;
    const input = [
      mark("find", { query: "get task" }),
      {
        type: "function_call_result",
        name: "tool_search",
        callId: "find",
        output: runtime.genericSearchOutput({ query: "get task" }),
      },
      mark("load", { query: "", names: ["tasks__get"] }),
      {
        type: "function_call_result",
        name: "tool_search",
        callId: "load",
        output: runtime.genericSearchOutput({ query: "", names: ["tasks__get"] }),
      },
    ];
    const expanded = expandInteractionFamilyDisclosures(input);
    expect(expanded).toHaveLength(5);
    expect(
      (expanded.at(-1) as { providerData?: Record<string, unknown> }).providerData?.[
        TOOL_DISCLOSURE_KEY
      ],
    ).toBeDefined();
  });
  test("a mistyped exact name returns compact recovery suggestions, not schemas", async () => {
    const runtime = new LazyToolRuntime("generic_dispatch", new Set());
    runtime.refresh([candidate("tasks__search", "Search tasks")]);
    const result = await runtime.prepareSearch({ query: "", names: ["tasks.search"] });
    expect(JSON.parse(result.output)).toMatchObject({
      schemasLoaded: false,
      unavailable: ["tasks.search"],
      suggestions: [{ name: "tasks__search" }],
    });
    expect(result.tools).toEqual([]);
  });
});

describe("tool group directory", () => {
  test("opaque connection IDs stay together under compact display keys", async () => {
    const name = "mcp_0123456789abcdef__get_invoice";
    const mapping = new Map([[name, "account-0123456789abcdef0123456789abcdef"]]);
    const runtime = new LazyToolRuntime(
      "generic_dispatch",
      new Set(mapping.values()),
      undefined,
      new Set(mapping.values()),
      new Set(),
      () => mapping,
    );
    runtime.refresh([candidate(name, "Get invoice")]);
    const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list");
    if (!list || list.type !== "function") throw new Error("missing list");
    const output = JSON.parse(String(await list.invoke({} as never, '{"view":"groups"}')));
    expect(output.groups[0].group).toBe("connection/0123456789ab");
    const tools = JSON.parse(
      String(await list.invoke({} as never, '{"group":"connection/0123456789ab"}')),
    );
    expect(tools.tools[0].name).toBe(name);
  });
  test("groups opaque model names by their actual authorized source and filters without new authority", async () => {
    const a = candidate("mcp_a__read", "Read invoice");
    const b = candidate("mcp_b__write", "Write invoice");
    const c = candidate("notes__read", "Read note");
    const mapping = new Map([
      ["mcp_a__read", "billing"],
      ["mcp_b__write", "billing"],
    ]);
    const runtime = new LazyToolRuntime(
      "generic_dispatch",
      new Set(["billing"]),
      undefined,
      new Set(["billing"]),
      new Set(),
      () => mapping,
    );
    runtime.refresh([a, b, c]);
    const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list");
    if (!list || list.type !== "function") throw new Error("missing list");
    const invoke = async (args: unknown) =>
      JSON.parse(String(await list.invoke({} as never, JSON.stringify(args))));
    const first = await invoke({ view: "groups", limit: 1 });
    expect(first.groups[0]).toMatchObject({ group: "billing", count: 2 });
    expect(first.nextCursor).toBe("billing");
    expect(JSON.stringify(first)).not.toContain("parameters");
    const second = await invoke({ view: "groups", limit: 1, cursor: first.nextCursor });
    expect(second.groups[0].group).toBe("notes");
    expect(second.nextCursor).toBeNull();
    expect((await invoke({ group: "billing" })).tools.map((t: { name: string }) => t.name)).toEqual(
      ["mcp_a__read", "mcp_b__write"],
    );
    expect((await invoke({ group: "absent" })).tools).toEqual([]);
    runtime.refresh([c]);
    expect((await invoke({ view: "groups", cursor: first.nextCursor })).error).toBe(
      "invalid_cursor",
    );
    expect((await invoke({ group: "billing" })).tools).toEqual([]);
    expect(first.groups[0].count).toBe(2);
  });
});

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(private outputs: ModelResponse["output"][]) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      usage: new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      output: this.outputs[this.requests.length - 1]!,
    };
  }
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push({
      ...request,
      input: structuredClone(request.input),
      tools: structuredClone(request.tools),
    });
    const output = this.outputs[this.requests.length - 1]!;
    yield {
      type: "response_done",
      response: {
        id: `response-${this.requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      },
    } as StreamEvent;
  }
}

function decisionRuntime(decision: ToolSelector) {
  return new LazyToolRuntime(
    "generic_dispatch",
    new Set(),
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    undefined,
    decision,
  );
}

describe("decision selection", () => {
  test("control descriptions and schemas do not vary with decision-model configuration", () => {
    const plain = new LazyToolRuntime("generic_dispatch", new Set());
    const configured = decisionRuntime(async () => []);
    const controls = (runtime: LazyToolRuntime) =>
      runtime.controlTools
        .filter((t) => t.type === "function")
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    expect(controls(configured)).toEqual(controls(plain));
  });
  test("strong matches load without inference and alternatives remain unloaded", async () => {
    const runtime = decisionRuntime(async () => {
      throw new Error("must bypass inference");
    });
    runtime.refresh([
      candidate("tasks__get", "Get task details"),
      candidate("tasks__delete", "Delete task"),
    ]);
    const result = await runtime.prepareSearch({ query: "get task details" });
    expect(result.tools?.map((t) => t.name)).toEqual(["tasks__get"]);
    expect(JSON.parse(result.output)).toMatchObject({
      schemasLoaded: true,
      suggestions: [{ name: "tasks__delete" }],
    });
  });
  test("the no-model default loads the strongest match but leaves exact ties compact", async () => {
    const runtime = new LazyToolRuntime("generic_dispatch", new Set());
    runtime.refresh([candidate("tasks__get", "Get task"), candidate("tasks__read", "Read task")]);
    expect((await runtime.prepareSearch({ query: "get task" })).tools?.map((t) => t.name)).toEqual([
      "tasks__get",
    ]);
    expect((await runtime.prepareSearch({ query: "task" })).tools).toEqual([]);
  });
  test("selects only authorized candidates, returns a compact receipt and freezes selected schemas", async () => {
    let calls = 0;
    const runtime = decisionRuntime(async (input) => {
      calls++;
      expect(input.candidates).toHaveLength(2);
      expect(JSON.stringify(input.candidates)).not.toContain('"parameters"');
      return ["tasks__get"];
    });
    runtime.refresh([candidate("tasks__get", "Get task"), candidate("tasks__list", "List tasks")]);
    const selected = await runtime.prepareSearch({ query: "task" });
    expect(calls).toBe(1);
    expect(JSON.parse(selected.output)).toMatchObject({
      schemasLoaded: true,
      tools: [{ name: "tasks__get" }],
    });
    expect(selected.tools?.map((t) => t.name)).toEqual(["tasks__get"]);
    const original = JSON.stringify(selected);
    runtime.refresh([]);
    expect(JSON.stringify(selected)).toBe(original);
  });
  test("exact names bypass inference; unavailable or invalid decisions fall back without schemas", async () => {
    let calls = 0;
    const runtime = decisionRuntime(async () => {
      calls++;
      throw new Error("provider secret diagnostic");
    });
    runtime.refresh([candidate("tasks__get", "Get task"), candidate("tasks__read", "Read task")]);
    expect((await runtime.prepareSearch({ query: "", names: ["tasks__get"] })).tools).toHaveLength(
      1,
    );
    expect(calls).toBe(0);
    const fallback = await runtime.prepareSearch({ query: "task" });
    expect(calls).toBe(1);
    expect(JSON.parse(fallback.output)).toMatchObject({
      schemasLoaded: false,
      fallback: "decision_model_unavailable",
    });
    expect(fallback.tools).toEqual([]);
    expect(fallback.output).not.toContain("secret");
    const invalid = decisionRuntime(async () => ["not_authorized"]);
    invalid.refresh([candidate("tasks__get", "Get task"), candidate("tasks__read", "Read task")]);
    expect((await invalid.prepareSearch({ query: "task" })).tools).toEqual([]);
  });
  test("an unavailable selector retains the usable best-match-first fallback", async () => {
    let calls = 0;
    const runtime = decisionRuntime(async () => {
      calls++;
      throw new Error("private provider diagnostic");
    });
    runtime.refresh([
      candidate("tasks__get", "Get task"),
      candidate("tasks__get_details", "Get task"),
    ]);
    const result = await runtime.prepareSearch({ query: "get task" });
    expect(calls).toBe(1);
    expect(result.tools?.map((t) => t.name)).toEqual(["tasks__get"]);
    expect(JSON.parse(result.output)).toMatchObject({
      fallback: "decision_model_unavailable",
      schemasLoaded: true,
    });
    expect(result.output).not.toContain("private");
  });
  test("revocation during inference cannot disclose the old tool; cancellation is not a fallback", async () => {
    const runtime = decisionRuntime(async () => {
      runtime.refresh([]);
      return ["tasks__get"];
    });
    runtime.refresh([candidate("tasks__get", "Get task"), candidate("tasks__read", "Read task")]);
    const revoked = await runtime.prepareSearch({ query: "task" });
    expect(revoked.tools).toEqual([]);
    expect(JSON.parse(revoked.output).schemasLoaded).toBe(false);
    const controller = new AbortController();
    const cancelled = decisionRuntime(async () => {
      controller.abort();
      throw new Error("stopped");
    });
    cancelled.refresh([candidate("tasks__get", "Get task"), candidate("tasks__read", "Read task")]);
    await expect(cancelled.prepareSearch({ query: "task" }, controller.signal)).rejects.toThrow();
  });
  test("typed selection keeps candidate context unchanged across queries", () => {
    const candidates = [{ name: "tasks__get", description: "Get task", inputFields: ["id"] }];
    const first = toolSelectionRequest({ query: "first", candidates });
    const second = toolSelectionRequest({ query: "second", candidates });
    expect(first.input.candidates).toEqual(second.input.candidates);
    expect(first.questions).toEqual(second.questions);
  });
  test("the shared typed implementation records usage even for an invalid answer", async () => {
    let usageCalls = 0;
    const model = createHttpDecisionModel({
      provider: "openrouter",
      model: "test",
      apiKey: "test-only",
      fetch: (async () =>
        Response.json({
          answers: { 99: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 100 },
        })) as typeof fetch,
    });
    const choose = createToolSelector(model, {
      onUsage: async () => {
        usageCalls++;
      },
    });
    await expect(
      choose({
        query: "get task",
        candidates: [{ name: "tasks__get", description: "Get task", inputFields: [] }],
      }),
    ).rejects.toThrow();
    expect(usageCalls).toBe(1);
  });
});

test.each(
  (["codex_native", "openai_native", "generic_dispatch"] as const).flatMap((transport) => [
    { transport, decision: false },
    { transport, decision: true },
  ]),
)(
  "%j: one search then execute, no redundant inference, stable prefix",
  async ({ transport, decision }) => {
    let decisions = 0,
      executions = 0;
    const target = tool({
      name: "tasks__read",
      description: "Read a task",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
      strict: false,
      execute: () => {
        executions++;
        return "read";
      },
    }) as Tool;
    const agent = new Agent({
      name: "discovery",
      model: "scripted",
      tools: [target, candidate("tasks__get", "Read a task")],
    });
    const runtime = installLazyToolRuntime(
      agent,
      transport,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      decision
        ? async () => {
            decisions++;
            return ["tasks__read"];
          }
        : undefined,
    );
    const model = new ScriptedModel([
      [searchCall(transport, "find", { query: decision ? "task" : "read task" })],
      [invokeCall(transport, "invoke", "tasks__read", { id: 7 })],
      [done],
    ]);
    const runner = new Runner({
      modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
    });
    const result = await runner.run(agent, "Read task 7", {
      stream: true,
      historyOwnership: "external",
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
      callModelInputFilter: baseModelInputFilterForSettings(
        testSettings({ sandboxBackend: "none" }),
      ),
    });
    for await (const event of result.toStream()) void event;
    await result.completed;
    expect(decisions).toBe(decision ? 1 : 0);
    expect(executions).toBe(1);
    expect(JSON.stringify(model.requests[1]!.input)).toContain('"required"');
    if (transport !== "generic_dispatch") {
      const wire = responsesWire().wire(model.requests[1]!);
      expect(wire.tools?.some((t) => t.type === "tool_search" && t.execution === "client")).toBe(
        true,
      );
      expect(wire.tools?.some((t) => t.type === "function" && t.name === "tool_invoke")).toBe(
        false,
      );
      expect(wire.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_search_output",
            tools: [expect.objectContaining({ type: "function", name: "tasks__read" })],
          }),
        ]),
      );
      expect(JSON.stringify(wire)).not.toContain("opengeni.lazy_search.v1");
    }
    for (let i = 1; i < model.requests.length; i++) {
      expect(model.requests[i]!.tools).toEqual(model.requests[0]!.tools);
      const previous = model.requests[i - 1]!.input as unknown[];
      expect((model.requests[i]!.input as unknown[]).slice(0, previous.length)).toEqual(previous);
    }
  },
);

test.each(["codex_native", "openai_native", "generic_dispatch"] as const)(
  "%s: ambiguous find, exact load and execute use the real SDK with stable prefixes",
  async (transport) => {
    let approvals = 0;
    let executions = 0;
    const target = tool({
      name: "tasks__read",
      description: "Read a task",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
      strict: false,
      needsApproval: () => {
        approvals++;
        return false;
      },
      execute: (args) => {
        executions++;
        expect((args as { id: number }).id).toBe(7);
        return "read";
      },
    }) as Tool;
    const agent = new Agent({
      name: "discovery",
      model: "scripted",
      tools: [target, candidate("tasks__get", "Read a task")],
    });
    const runtime = installLazyToolRuntime(agent, transport, new Set());
    const model = new ScriptedModel([
      [searchCall(transport, "find", { query: "task" })],
      [searchCall(transport, "load", { query: "", names: ["tasks__read"] })],
      [invokeCall(transport, "invoke", "tasks__read", { id: 7 })],
      [done],
    ]);
    const runner = new Runner({
      modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
    });
    const result = await runner.run(agent, "Read task 7", {
      stream: true,
      historyOwnership: "external",
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
      callModelInputFilter: baseModelInputFilterForSettings(
        testSettings({ sandboxBackend: "none" }),
      ),
    });
    for await (const event of result.toStream()) void event;
    await result.completed;
    expect(result.finalOutput).toBe("done");
    expect(approvals).toBe(1);
    expect(executions).toBe(1);
    if (transport === "generic_dispatch") {
      // The generic result lists the tied tools as compact candidates.
      expect(JSON.stringify(model.requests[1]!.input)).not.toContain('"required"');
    } else {
      // A native result cannot list candidates, so it loads both tied tools.
      expect(model.requests[1]!.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_search_output",
            tools: [
              expect.objectContaining({ name: "tasks__read" }),
              expect.objectContaining({ name: "tasks__get" }),
            ],
          }),
        ]),
      );
    }
    expect(JSON.stringify(model.requests[2]!.input)).toContain('"required"');
    for (let i = 1; i < model.requests.length; i++) {
      expect(model.requests[i]!.tools).toEqual(model.requests[0]!.tools);
      const previous = model.requests[i - 1]!.input as unknown[];
      expect((model.requests[i]!.input as unknown[]).slice(0, previous.length)).toEqual(previous);
    }
  },
);

test.each(["codex_native", "openai_native"] as const)(
  "%s: legacy native history stays native and a previously loaded function remains callable",
  async (transport) => {
    let executions = 0;
    let approvals = 0;
    let selections = 0;
    const target = tool({
      name: "tasks__read",
      description: "Current task reader",
      parameters: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
      strict: false,
      needsApproval: () => {
        approvals++;
        return false;
      },
      execute: () => {
        executions++;
        return "read";
      },
    }) as Tool;
    const agent = new Agent({ name: "legacy-native", model: "scripted", tools: [target] });
    const runtime = installLazyToolRuntime(
      agent,
      transport,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      async () => {
        selections++;
        return [];
      },
    );
    const historical = [
      { type: "message", role: "user", content: "Find a task reader" },
      searchCall(transport, "old-search", { query: "read task" }),
      {
        type: "tool_search_output",
        call_id: "old-search",
        execution: "client",
        status: "completed",
        tools: [
          {
            type: "function",
            name: "tasks__read",
            description: "Old task reader",
            parameters: {
              type: "object",
              properties: { id: { type: "integer" } },
              required: ["id"],
              additionalProperties: false,
            },
            strict: false,
          },
        ],
      },
      done,
      { type: "message", role: "user", content: "Read task 7 with the tool already loaded" },
    ];
    const model = new ScriptedModel([[call("read-again", "tasks__read", { id: 7 })], [done]]);
    const runner = new Runner({
      modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
    });
    const result = await runner.run(agent, historical as never, {
      stream: true,
      historyOwnership: "external",
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
    });
    for await (const event of result.toStream()) void event;
    await result.completed;
    expect(executions).toBe(1);
    expect(approvals).toBe(1);
    expect(selections).toBe(0);
    expect(model.requests[0]!.tools).toEqual(model.requests[1]!.tools);
    expect(
      model.requests[0]!.tools.some(
        (t) => t.type === "hosted_tool" && t.providerData?.type === "tool_search",
      ),
    ).toBe(true);
    expect(model.requests[0]!.tools.some((t) => t.name === "tool_invoke")).toBe(false);
    expect((model.requests[0]!.input as unknown[]).slice(0, historical.length)).toEqual(historical);
    expect((model.requests[1]!.input as unknown[]).slice(0, historical.length)).toEqual(historical);
    expect(JSON.stringify(model.requests)).not.toContain("opengeni.lazy_search.v1");
    const serializer = responsesWire();
    const first = serializer.wire(model.requests[0]!);
    const second = serializer.wire(model.requests[1]!);
    expect(first.tools).toEqual(second.tools);
    expect(first.tools?.some((t) => t.type === "tool_search" && t.execution === "client")).toBe(
      true,
    );
    const initialInput = first.input as unknown[];
    expect((second.input as unknown[]).slice(0, initialInput.length)).toEqual(initialInput);
    expect(JSON.stringify(first.input)).toContain("Old task reader");
    expect(JSON.stringify(first.input)).not.toContain("Current task reader");
  },
);

test("native routes never reinterpret an application function named tool_invoke as the generic router", async () => {
  let invoked = 0;
  const owned = tool({
    name: "tool_invoke",
    description: "Application-owned function",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object" } },
      additionalProperties: false,
    },
    strict: false,
    execute: () => {
      invoked++;
      return "owned";
    },
  }) as Tool;
  const agent = new Agent({
    name: "native-owned-name",
    model: "scripted",
    tools: [owned, candidate("tasks__read", "Read task")],
  });
  const runtime = installLazyToolRuntime(agent, "openai_native", new Set());
  const model = new ScriptedModel([
    [call("owned", "tool_invoke", { name: "tasks__read", arguments: {} })],
    [done],
  ]);
  const result = await new Runner({
    modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
  }).run(agent, "Use application function", {
    stream: true,
    historyOwnership: "external",
    resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
  });
  for await (const event of result.toStream()) void event;
  await result.completed;
  expect(invoked).toBe(1);
});

describe("searches that name an integration the person can connect", () => {
  const CATALOG = "opengeni__capability_catalog_search";
  const CARD = "opengeni__capability_authorization_request";
  const GMAIL = { capabilityId: "api:gmail", name: "Gmail" };
  const CALENDAR = { capabilityId: "api:google-calendar", name: "Google Calendar" };
  // A catalog search ranks loosely (descriptions, spelling): only a whole
  // integration name the query actually contains may be named.
  const CATALOG_ENTRIES = [
    { ...GMAIL, words: ["gmail", "email", "inbox"] },
    { ...CALENDAR, words: ["calendar", "google", "meeting"] },
    { capabilityId: "registry:read-ai", name: "Read AI", words: ["read", "meeting", "summary"] },
    { capabilityId: "api:outlook-mail", name: "Outlook Mail", words: ["outlook", "inbox"] },
  ];
  const fakeLookup = () => {
    const queries: string[] = [];
    const lookup = async (query: string) => {
      queries.push(query);
      const words = query.toLowerCase().split(/\W+/);
      return CATALOG_ENTRIES.filter((entry) => entry.words.some((w) => words.includes(w))).map(
        ({ capabilityId, name }) => ({ capabilityId, name }),
      );
    };
    return { queries, lookup };
  };
  const pool = (withSetup = true) => [
    candidate(
      "opengeni__inbox_tidy",
      "See and look after the inbox of the person this session works for. Lists the open items you may manage.",
    ),
    candidate(
      "opengeni__knowledge_search",
      "Find Knowledge by subject or entity name. Omit scope to search all authorized scopes.",
    ),
    candidate(
      "opengeni__scheduled_tasks_create",
      "Schedule a message in this chat by supplying name, schedule and prompt.",
    ),
    candidate(
      "opengeni__notify_user",
      "Notify the person who owns this session: it goes to their inbox and, when new, to their phone.",
    ),
    ...(withSetup
      ? [
          candidate(
            CATALOG,
            "Find integrations in the reviewed workspace catalog when the user asks to add one or needed access is missing. Search by integration name or task outcome.",
          ),
          candidate(
            CARD,
            "Show a Connect card in this chat for a suitable capability returned by capability_catalog_search with setup.nextAction.",
          ),
        ]
      : []),
  ];
  const runtimeWith = (
    transport: "generic_dispatch" | "openai_native" | "codex_native",
    lookup?: ConnectableIntegrationLookup,
    decision?: ToolSelector,
    withSetup = true,
  ) => {
    const runtime = new LazyToolRuntime(
      transport,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      decision,
      undefined,
      lookup,
    );
    runtime.refresh(pool(withSetup));
    return runtime;
  };
  const loaded = (result: { tools?: { name?: unknown }[] }) =>
    result.tools?.map((t) => t.name) ?? [];
  const GMAIL_NOTICE =
    'Not connected yet: Gmail (capabilityId "api:gmail"). If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card.';

  test("names only whole integration names the query contains", () => {
    const matches = CATALOG_ENTRIES.map(({ capabilityId, name }) => ({ capabilityId, name }));
    expect(connectableIntegrationsNamedIn("check my gmail this week", matches)).toEqual([GMAIL]);
    expect(
      connectableIntegrationsNamedIn("Gmail and google-calendar, then GMAIL again", [
        ...matches,
        GMAIL,
      ]),
    ).toEqual([GMAIL, CALENDAR]);
    expect(connectableIntegrationsNamedIn("read my outlook inbox", matches)).toEqual([]);
    expect(connectableIntegrationsNamedIn("read the meeting summary", matches)).toEqual([]);
    expect(
      connectableIntegrationsNamedIn(
        "a b c d",
        ["a", "b", "c", "d"].map((name) => ({ capabilityId: name, name })),
      ),
    ).toHaveLength(3);
    expect(connectableIntegrationNotice([GMAIL])).toBe(GMAIL_NOTICE);
  });

  test("reads only exact catalog matches whose next step is a Connect card", () => {
    const text = JSON.stringify({
      query: "gmail",
      matches: [
        {
          ...GMAIL,
          approximate: false,
          setup: {
            status: "authorization_required",
            nextAction: { toolName: "capability_authorization_request", capabilityId: "api:gmail" },
          },
        },
        { capabilityId: "api:slack", name: "Slack", setup: { status: "ready", nextAction: null } },
        {
          capabilityId: "registry:gmall",
          name: "Gmall",
          approximate: true,
          setup: { nextAction: { toolName: "capability_authorization_request" } },
        },
      ],
    });
    const content = [{ type: "text", text }];
    expect(connectableIntegrationsFromCatalogResult({ content })).toEqual([GMAIL]);
    expect(connectableIntegrationsFromCatalogResult(content)).toEqual([GMAIL]);
    expect(connectableIntegrationsFromCatalogResult({ content, isError: true })).toEqual([]);
    expect(
      connectableIntegrationsFromCatalogResult({ content: [{ type: "text", text: "no" }] }),
    ).toEqual([]);
  });

  test("the catalog lookup calls the harness catalog search with a bounded query", async () => {
    const calls: { name: string; args: unknown; signal?: AbortSignal }[] = [];
    const lookup = catalogConnectableIntegrationLookup({
      callTool: async () => {
        throw new Error("callToolResult is preferred");
      },
      callToolResult: async (name, args, _meta, options) => {
        calls.push({ name, args, ...(options?.signal ? { signal: options.signal } : {}) });
        return { content: [{ type: "text", text: JSON.stringify({ matches: [] }) }] };
      },
    });
    expect(await lookup("x".repeat(600))).toEqual([]);
    expect(calls[0]!.name).toBe(CATALOG);
    expect(calls[0]!.args).toEqual({ query: "x".repeat(500), limit: 3 });
    expect(calls[0]!.signal).toBeDefined();
  });

  for (const transport of ["generic_dispatch", "openai_native", "codex_native"] as const) {
    test(`${transport}: a search naming an unconnected integration loads the card tool and names it`, async () => {
      const { queries, lookup } = fakeLookup();
      const result = await runtimeWith(transport, lookup).prepareSearch({
        query: "check my gmail and tell me if anything important came this week",
      });
      expect(queries).toHaveLength(1);
      expect(loaded(result)).toContain(CARD);
      expect(loaded(result)).not.toContain(CATALOG);
      expect(loaded(result).at(-1)).toBe(CARD);
      const output = JSON.parse(result.output);
      expect(output.notConnected).toBe(GMAIL_NOTICE);
      expect(output.tools.map((t: { name: string }) => t.name)).toEqual(loaded(result));
      // Native results cannot carry text: the notice rides on the marker.
      expect(result.notice).toBe(transport === "generic_dispatch" ? undefined : GMAIL_NOTICE);
    });

    test(`${transport}: installed-tool searches never look up or change`, async () => {
      const { queries, lookup } = fakeLookup();
      for (const args of [
        { query: "create a scheduled message in this chat" },
        { query: "notify the person on their phone" },
        { query: "Search workspace Knowledge by subject" },
        { query: "inbox_tidy gmail" },
        { query: "", names: ["opengeni__knowledge_search"] },
      ]) {
        const withLookup = await runtimeWith(transport, lookup).prepareSearch(args);
        const without = await runtimeWith(transport).prepareSearch(args);
        expect(withLookup).toEqual(without);
      }
      expect(queries).toEqual([]);
    });

    test(`${transport}: unnamed matches, lookup failures and chats without setup tools change nothing`, async () => {
      const { queries, lookup } = fakeLookup();
      // "read my outlook inbox" strongly matches the installed inbox tool, so it
      // never looks up; "read the meeting summary" looks up and names nothing.
      for (const query of ["read the meeting summary", "read my outlook inbox"]) {
        expect(await runtimeWith(transport, lookup).prepareSearch({ query })).toEqual(
          await runtimeWith(transport).prepareSearch({ query }),
        );
      }
      expect(queries).toEqual(["read the meeting summary"]);
      const failing = async () => {
        throw new Error("catalog offline");
      };
      const query = "check my gmail";
      expect(await runtimeWith(transport, failing).prepareSearch({ query })).toEqual(
        await runtimeWith(transport).prepareSearch({ query }),
      );
      const none = fakeLookup();
      expect(
        await runtimeWith(transport, none.lookup, undefined, false).prepareSearch({ query }),
      ).toEqual(await runtimeWith(transport, undefined, undefined, false).prepareSearch({ query }));
      expect(none.queries).toEqual([]);
    });

    test(`${transport}: cancellation during the lookup belongs to the turn`, async () => {
      const controller = new AbortController();
      const lookup = async () => {
        controller.abort();
        throw new Error("aborted");
      };
      await expect(
        runtimeWith(transport, lookup).prepareSearch(
          { query: "check my gmail" },
          controller.signal,
        ),
      ).rejects.toThrow();
    });

    test(`${transport}: either setup tool brings the other`, async () => {
      const runtime = runtimeWith(transport, fakeLookup().lookup);
      expect(
        loaded(await runtime.prepareSearch({ query: "", names: [CATALOG], limit: 1 })),
      ).toEqual([CATALOG, CARD]);
      expect(loaded(await runtime.prepareSearch({ query: "", names: [CARD] }))).toEqual([
        CARD,
        CATALOG,
      ]);
      expect(
        loaded(await runtime.prepareSearch({ query: "capability_catalog_search gmail", limit: 1 })),
      ).toEqual([CATALOG, CARD]);
    });
  }

  test("one-word names the ranker reads as operations never name an integration", async () => {
    const verbs = [
      { capabilityId: "registry:send", name: "Send" },
      { capabilityId: "registry:make", name: "Make" },
      { capabilityId: "registry:tool", name: "Tool" },
    ];
    for (const query of [
      "send message to another session",
      "send message to another session; read session events",
      "make a new recurring reminder",
      "send an email",
      "find a tool for this",
    ])
      expect(connectableIntegrationsNamedIn(query, verbs)).toEqual([]);
    // Product names and multi-word names that contain an operation still count.
    expect(
      connectableIntegrationsNamedIn("send it with sendgrid, then use make com", [
        { capabilityId: "registry:sendgrid", name: "SendGrid" },
        { capabilityId: "registry:make-com", name: "Make.com" },
      ]).map((m) => m.name),
    ).toEqual(["SendGrid", "Make.com"]);
    for (const transport of ["generic_dispatch", "openai_native"] as const) {
      const runtime = runtimeWith(transport, async () => verbs);
      const result = await runtime.prepareSearch({ query: "make a new recurring reminder" });
      expect(loaded(result)).not.toContain(CARD);
      expect(JSON.parse(result.output).notConnected).toBeUndefined();
    }
  });

  test("accepted residual: an ordinary word that is an integration's whole name still names it", async () => {
    // Only operation words are excluded. Other ordinary words that happen to
    // be a connectable integration's whole name (Box, Close, Front, Notion)
    // still name it when nothing installed matches the search strongly. The
    // notice says "if the task needs it", so the model can ignore it; a word
    // list to filter these out was judged worse than this residual.
    const box = { capabilityId: "registry:box", name: "Box" };
    const close = { capabilityId: "registry:close", name: "Close" };
    expect(connectableIntegrationsNamedIn("check the box", [box])).toEqual([box]);
    expect(connectableIntegrationsNamedIn("close the browser tab", [close])).toEqual([close]);
    for (const transport of ["generic_dispatch", "openai_native"] as const) {
      const runtime = runtimeWith(transport, async () => [box]);
      const result = await runtime.prepareSearch({ query: "check the box" });
      expect(loaded(result)).toContain(CARD);
      expect(JSON.parse(result.output).notConnected).toBe(
        'Not connected yet: Box (capabilityId "registry:box"). If the task needs it, call capability_authorization_request with that capabilityId and a short rationale to show the person its Connect card.',
      );
    }
  });

  test("only Connect cards the person completes are named, with wording for several", () => {
    const match = (capabilityId: string, name: string, action: string) => ({
      capabilityId,
      name,
      approximate: false,
      setup: {
        status: "authorization_required",
        action,
        nextAction: { toolName: "capability_authorization_request", capabilityId },
      },
    });
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          matches: [
            match("api:gmail", "Gmail", "connect"),
            match("registry:weather", "Weather", "add_credentials"),
            match("registry:archive", "Archive", "enable"),
          ],
        }),
      },
    ];
    expect(connectableIntegrationsFromCatalogResult({ content })).toEqual([
      GMAIL,
      { capabilityId: "registry:weather", name: "Weather" },
    ]);
    expect(connectableIntegrationNotice([GMAIL, CALENDAR])).toBe(
      'Not connected yet: Gmail (capabilityId "api:gmail"), Google Calendar (capabilityId "api:google-calendar"). If the task needs one, call capability_authorization_request with its capabilityId and a short rationale to show the person its Connect card.',
    );
  });

  test("the catalog read runs alongside the decision model", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const lookup: ConnectableIntegrationLookup = async (query) => {
      events.push("lookup:start");
      await gate;
      events.push("lookup:end");
      return fakeLookup().lookup(query);
    };
    const runtime = runtimeWith("generic_dispatch", lookup, async () => {
      events.push("decision");
      release();
      return ["opengeni__knowledge_search"];
    });
    const result = await runtime.prepareSearch({ query: "find my gmail stuff" });
    expect(events).toEqual(["lookup:start", "decision", "lookup:end"]);
    expect(loaded(result)).toEqual(["opengeni__knowledge_search", CARD]);
    expect(JSON.parse(result.output).notConnected).toBe(GMAIL_NOTICE);
  });

  test("decision-model selections and their fallback carry the card tool and notice", async () => {
    let consulted = 0;
    const selected = runtimeWith("generic_dispatch", fakeLookup().lookup, async () => {
      consulted++;
      return ["opengeni__knowledge_search"];
    });
    const chosen = await selected.prepareSearch({ query: "find my gmail stuff" });
    expect(loaded(chosen)).toEqual(["opengeni__knowledge_search", CARD]);
    expect(JSON.parse(chosen.output).notConnected).toBe(GMAIL_NOTICE);
    expect(consulted).toBe(1);
    const unavailable = runtimeWith("generic_dispatch", fakeLookup().lookup, async () => {
      throw new Error("offline");
    });
    const fallback = await unavailable.prepareSearch({ query: "find my gmail stuff" });
    expect(loaded(fallback).at(-1)).toBe(CARD);
    expect(JSON.parse(fallback.output)).toMatchObject({
      fallback: "decision_model_unavailable",
      schemasLoaded: true,
      notConnected: GMAIL_NOTICE,
    });
    const strong = runtimeWith("generic_dispatch", fakeLookup().lookup, async () => {
      throw new Error("must bypass inference");
    });
    expect(
      loaded(await strong.prepareSearch({ query: "notify the person on their phone" })),
    ).toEqual(["opengeni__notify_user"]);
  });

  test("a native search's notice follows its result as one stable developer message", async () => {
    const runtime = runtimeWith("openai_native", fakeLookup().lookup);
    const marker = await runtime.prepareSearch({ query: "check my gmail" });
    const searchItem = {
      type: "tool_search_call",
      call_id: "s1",
      execution: "client",
      status: "completed",
      arguments: { query: "check my gmail" },
      providerData: { "opengeni.lazy_search.v1": marker },
    };
    const output = {
      type: "tool_search_output",
      status: "completed",
      tools: marker.tools,
      providerData: { call_id: "s1", execution: "client" },
    };
    const user = { type: "message", role: "user", content: "check my gmail" };
    const first = expandInteractionFamilyDisclosures<Record<string, unknown>>([
      user,
      searchItem,
      output,
    ]);
    expect(first).toHaveLength(4);
    expect(first[3]).toEqual({ type: "message", role: "developer", content: GMAIL_NOTICE });
    const later = expandInteractionFamilyDisclosures<Record<string, unknown>>([
      user,
      searchItem,
      output,
      done,
    ]);
    expect(later[3]).toBe(first[3]);
    expect(later).toHaveLength(5);
    const wire = projectHistoryForProvider(later, "responses", { declaresAdditionalTools: true });
    expect(wire[3]).toEqual({
      type: "unknown",
      providerData: { type: "message", role: "developer", content: GMAIL_NOTICE },
    });
    // A search without a notice adds nothing.
    const plain = await runtimeWith("openai_native").prepareSearch({ query: "check my gmail" });
    expect(
      expandInteractionFamilyDisclosures<Record<string, unknown>>([
        user,
        { ...searchItem, providerData: { "opengeni.lazy_search.v1": plain } },
        output,
      ]),
    ).toHaveLength(3);
  });

  test.each(["codex_native", "openai_native", "generic_dispatch"] as const)(
    "%s: search then the Connect card through the real SDK, with a stable prefix",
    async (transport) => {
      const cards: unknown[] = [];
      const card = tool({
        name: CARD,
        description:
          "Show a Connect card in this chat for a suitable capability returned by capability_catalog_search with setup.nextAction.",
        parameters: {
          type: "object",
          properties: { capabilityId: { type: "string" }, rationale: { type: "string" } },
          required: ["capabilityId", "rationale"],
          additionalProperties: false,
        },
        strict: false,
        execute: (args) => {
          cards.push(args);
          return "card shown";
        },
      }) as Tool;
      const agent = new Agent({
        name: "discovery",
        model: "scripted",
        tools: [...pool().filter((t) => (t as Tool & { name: string }).name !== CARD), card],
      });
      const { queries, lookup } = fakeLookup();
      const runtime = installLazyToolRuntime(
        agent,
        transport,
        new Set(),
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        lookup,
      );
      const args = { capabilityId: "api:gmail", rationale: "Read this week's mail" };
      const model = new ScriptedModel([
        [searchCall(transport, "find", { query: "check my gmail this week" })],
        [invokeCall(transport, "card", CARD, args)],
        [done],
      ]);
      const result = await new Runner({
        modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
      }).run(agent, "check my gmail and tell me if anything important came this week", {
        stream: true,
        historyOwnership: "external",
        resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
        callModelInputFilter: baseModelInputFilterForSettings(
          testSettings({ sandboxBackend: "none" }),
        ),
      });
      for await (const event of result.toStream()) void event;
      await result.completed;
      expect(queries).toHaveLength(1);
      expect(cards).toEqual([args]);
      expect(JSON.stringify(model.requests[1]!.input)).toContain("Not connected yet: Gmail");
      if (transport !== "generic_dispatch") {
        // As the production Responses model does before building the request.
        const request = model.requests[1]!;
        const wire = responsesWire().wire({
          ...request,
          input: projectHistoryForProvider(
            request.input as Record<string, unknown>[],
            "responses",
            { declaresAdditionalTools: true },
          ) as ModelRequest["input"],
        });
        expect(wire.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "message", role: "developer", content: GMAIL_NOTICE }),
          ]),
        );
        expect(JSON.stringify(wire)).not.toContain("opengeni.lazy_search.v1");
      }
      for (let i = 1; i < model.requests.length; i++) {
        expect(model.requests[i]!.tools).toEqual(model.requests[0]!.tools);
        const previous = model.requests[i - 1]!.input as unknown[];
        expect((model.requests[i]!.input as unknown[]).slice(0, previous.length)).toEqual(previous);
      }
    },
  );
});

describe("searches that reach one of several connected accounts", () => {
  const GMAIL_SEARCH = "mcp__gmail__search_messages";
  const GMAIL_SEND = "mcp__gmail__send_message";
  const OUTLOOK = "mcp__outlook__me_messages_list";
  const LINEAR = "mcp__linear__list_issues";
  const SLACK = "mcp__slack__post_message";
  const pool = () => [
    candidate(GMAIL_SEARCH, "Search the Gmail mailbox for new or matching email messages."),
    candidate(GMAIL_SEND, "Send an email message from the Gmail mailbox."),
    candidate(OUTLOOK, "Get me messages: list the messages in the signed-in user's mailbox."),
    candidate(LINEAR, "List Linear issues in the workspace's projects and cycles."),
    candidate(SLACK, "Post a message to a Slack channel or thread."),
    candidate(
      "opengeni__knowledge_search",
      "Find Knowledge by subject or entity name. Omit scope to search all authorized scopes.",
    ),
    candidate(
      "opengeni__notify_user",
      "Notify the person who owns this session: it goes to their inbox and, when new, to their phone.",
    ),
  ];
  const gmail = { source: "gmail", label: "Gmail", connector: "Gmail", kind: "communication" };
  const outlook = {
    source: "outlook",
    label: "Outlook Mail",
    connector: "Outlook Mail",
    kind: "communication",
  };
  const linear = {
    source: "linear",
    label: "Linear",
    connector: "Linear",
    kind: "project-management",
  };
  const BOTH: ReadonlyMap<string, ConnectedToolAccount> = new Map([
    [GMAIL_SEARCH, gmail],
    [GMAIL_SEND, gmail],
    [OUTLOOK, outlook],
  ]);
  const ONLY_GMAIL: ReadonlyMap<string, ConnectedToolAccount> = new Map([
    [GMAIL_SEARCH, gmail],
    [GMAIL_SEND, gmail],
  ]);
  const NOTICE =
    "These tools reach Gmail. Also connected: Outlook Mail. If the request could mean those accounts too (the person's email, calendar or files), check each that fits, or say which account you checked and offer the others.";
  const runtimeWith = (
    transport: "generic_dispatch" | "openai_native" | "codex_native",
    accounts?: ReadonlyMap<string, ConnectedToolAccount>,
    lookup?: ConnectableIntegrationLookup,
  ) => {
    const runtime = new LazyToolRuntime(
      transport,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lookup,
      accounts ? () => accounts : undefined,
    );
    runtime.refresh(pool());
    return runtime;
  };
  const loaded = (result: { tools?: { name?: unknown }[] }) =>
    result.tools?.map((t) => t.name) ?? [];

  test("names the reached and the other accounts, capped with a count", () => {
    expect(connectedAccountsNotice(["Gmail"], ["Outlook Mail"])).toBe(NOTICE);
    const others = Array.from({ length: 12 }, (_, i) => `Account ${i + 1}`);
    const capped = connectedAccountsNotice(
      ["Gmail (a@example.com)", "Gmail (b@example.com)"],
      others,
    );
    expect(capped).toStartWith(
      "These tools reach Gmail (a@example.com), Gmail (b@example.com). Also connected: Account 1,",
    );
    expect(capped).toContain("Account 10, and 2 more.");
    expect(capped).not.toContain("Account 11");
  });

  for (const transport of ["generic_dispatch", "openai_native", "codex_native"] as const) {
    test(`${transport}: the first search reaching one account names the others, once per run`, async () => {
      const runtime = runtimeWith(transport, BOTH);
      const first = await runtime.prepareSearch({ query: "search gmail for new email", limit: 2 });
      expect(loaded(first)).toContain(GMAIL_SEARCH);
      expect(loaded(first)).not.toContain(OUTLOOK);
      const output = JSON.parse(first.output);
      expect(output.connectedAccounts).toBe(NOTICE);
      expect(output.tools.map((t: { name: string }) => t.name)).toEqual(loaded(first));
      expect(first.notice).toBe(transport === "generic_dispatch" ? undefined : NOTICE);
      const second = await runtime.prepareSearch({ query: "search gmail for new email", limit: 2 });
      expect(JSON.parse(second.output).connectedAccounts).toBeUndefined();
      expect(second.notice).toBeUndefined();
    });

    test(`${transport}: one connected account and first-party tools change nothing`, async () => {
      for (const [accounts, args] of [
        [ONLY_GMAIL, { query: "search gmail for new email", limit: 2 }],
        [ONLY_GMAIL, { query: "", names: [GMAIL_SEARCH] }],
        [BOTH, { query: "notify the person on their phone" }],
        [BOTH, { query: "", names: ["opengeni__notify_user"] }],
      ] as const) {
        const runtime = runtimeWith(transport, accounts);
        expect(await runtime.prepareSearch(args)).toEqual(
          await runtimeWith(transport).prepareSearch(args),
        );
        // Neither search spends the turn's one notice.
        if (accounts === BOTH) {
          const later = await runtime.prepareSearch({ query: "search gmail for new email" });
          expect(JSON.parse(later.output).connectedAccounts).toBe(NOTICE);
        }
      }
    });

    test(`${transport}: loading one account's tools by exact name names the others`, async () => {
      // Browsing a group and loading exact names reaches an account the same
      // way a ranked search does.
      const runtime = runtimeWith(transport, BOTH);
      const load = await runtime.prepareSearch({ query: "", names: [GMAIL_SEARCH, GMAIL_SEND] });
      expect(loaded(load)).toEqual([GMAIL_SEARCH, GMAIL_SEND]);
      const output = JSON.parse(load.output);
      expect(output.schemasLoaded).toBe(true);
      expect(output.connectedAccounts).toBe(NOTICE);
      expect(load.notice).toBe(transport === "generic_dispatch" ? undefined : NOTICE);
      const again = await runtime.prepareSearch({ query: "", names: [GMAIL_SEARCH] });
      expect(JSON.parse(again.output).connectedAccounts).toBeUndefined();
      expect(again.notice).toBeUndefined();
    });

    test(`${transport}: a search reaching every connected account names none`, async () => {
      const result = await runtimeWith(transport, BOTH).prepareSearch({
        query: "",
        names: [GMAIL_SEARCH, OUTLOOK],
      });
      expect(JSON.parse(result.output).connectedAccounts).toBeUndefined();
      const both = await runtimeWith(transport, BOTH).prepareSearch({
        query: "search gmail email; get me messages in the mailbox",
      });
      expect(loaded(both)).toEqual(expect.arrayContaining([GMAIL_SEARCH, OUTLOOK]));
      expect(JSON.parse(both.output).connectedAccounts).toBeUndefined();
      expect(both.notice).toBeUndefined();
    });
  }

  test("only accounts that serve the same need are named", async () => {
    const slack = { source: "slack", label: "Slack", connector: "Slack", kind: "communication" };
    const github = { source: "github", label: "GitHub", connector: "GitHub" };
    const linearWork = { ...linear, source: "linear-work", label: "Linear (work@example.com)" };
    const GITHUB = "mcp__github__list_repositories";
    const notice = async (
      accounts: ReadonlyArray<readonly [string, ConnectedToolAccount]>,
      query: string,
    ) => {
      const runtime = runtimeWith("generic_dispatch", new Map(accounts));
      runtime.refresh([
        ...pool(),
        candidate("mcp__linear_work__list_issues", "List Linear issues in the workspace."),
        candidate(GITHUB, "List GitHub repositories the person can reach."),
      ]);
      const result = await runtime.prepareSearch({ query, limit: 1 });
      return JSON.parse(result.output).connectedAccounts as string | undefined;
    };
    // Linear, Slack, Gmail and GitHub connected: a Linear search names none of them.
    const team = [
      [LINEAR, linear],
      [SLACK, slack],
      [GMAIL_SEARCH, gmail],
      [GITHUB, github],
    ] as const;
    expect(await notice(team, "list linear issues in the projects and cycles")).toBeUndefined();
    expect(
      await notice(team.slice(0, 2), "list linear issues in the projects and cycles"),
    ).toBeUndefined();
    // Another account of the same connector always counts, kind or not.
    expect(
      await notice(
        [
          [LINEAR, linear],
          ["mcp__linear_work__list_issues", linearWork],
          [SLACK, slack],
        ],
        "list linear issues in the projects and cycles",
      ),
    ).toStartWith("These tools reach Linear. Also connected: Linear (work@example.com). If");
    // Accounts of one kind are named together; an unknown kind never matches.
    expect(
      await notice(
        [
          [GMAIL_SEARCH, gmail],
          [OUTLOOK, outlook],
          [LINEAR, linear],
          [GITHUB, github],
        ],
        "search gmail for new email",
      ),
    ).toBe(NOTICE);
    expect(
      await notice(
        [
          [GMAIL_SEARCH, { ...gmail, kind: undefined }],
          [OUTLOOK, { ...outlook, kind: undefined }],
        ],
        "search gmail for new email",
      ),
    ).toBeUndefined();
    // Custom servers have no kind: two unrelated ones say nothing, while two
    // accounts of the same custom server still name each other.
    const home = { source: "home", label: "Home Hub", connector: "Home Hub" };
    const company = { source: "company", label: "Company Wiki", connector: "Company Wiki" };
    expect(
      await notice(
        [
          [LINEAR, { ...linear, kind: undefined }],
          [GITHUB, home],
          [SLACK, company],
        ],
        "list linear issues in the projects and cycles",
      ),
    ).toBeUndefined();
    expect(
      await notice(
        [
          [LINEAR, { ...home, label: "Home Hub (a@example.com)" }],
          [
            "mcp__linear_work__list_issues",
            { ...home, source: "home-2", label: "Home Hub (b@example.com)" },
          ],
          [SLACK, company],
        ],
        "list linear issues in the projects and cycles",
      ),
    ).toStartWith(
      "These tools reach Home Hub (a@example.com). Also connected: Home Hub (b@example.com). If",
    );
  });

  test("tied tools of two accounts: generic lists candidates, native loads them", async () => {
    // Two accounts' identical tools tie. The generic result loads nothing and
    // lists compact candidates; a native result, which cannot show those,
    // loads the tied tools within the limit.
    const SECOND = "mcp__gmail_work__search_messages";
    const accounts: ReadonlyMap<string, ConnectedToolAccount> = new Map([
      ...BOTH,
      [SECOND, { source: "gmail-work", label: "Gmail (work@example.com)", connector: "Gmail" }],
    ]);
    const tied = (transport: "generic_dispatch" | "openai_native") => {
      const runtime = runtimeWith(transport, accounts);
      runtime.refresh([
        ...pool(),
        candidate(SECOND, "Search the Gmail mailbox for new or matching email messages."),
      ]);
      return runtime;
    };
    const args = { query: "search the gmail mailbox for matching email messages", limit: 1 };
    const generic = await tied("generic_dispatch").prepareSearch(args);
    expect(loaded(generic)).toEqual([]);
    const output = JSON.parse(generic.output);
    expect(output.schemasLoaded).toBe(false);
    expect(output.tools.map((t: { name: string }) => t.name)).toEqual([GMAIL_SEARCH]);
    expect(output.connectedAccounts).toStartWith("These tools reach Gmail");
    expect(output.connectedAccounts).toContain("Outlook Mail");
    const one = await tied("openai_native").prepareSearch(args);
    expect(loaded(one)).toEqual([GMAIL_SEARCH]);
    expect(one.notice).toStartWith(
      "These tools reach Gmail. Also connected: Outlook Mail, Gmail (work@example.com). If",
    );
    const two = await tied("openai_native").prepareSearch({ ...args, limit: 2 });
    expect(loaded(two)).toEqual([GMAIL_SEARCH, SECOND]);
    expect(two.notice).toStartWith(
      "These tools reach Gmail, Gmail (work@example.com). Also connected: Outlook Mail. If",
    );
  });

  test("a native search with both notices carries them as one joined notice", async () => {
    const lookup: ConnectableIntegrationLookup = async () => [
      { capabilityId: "api:google-calendar", name: "Google Calendar" },
    ];
    const runtime = runtimeWith("openai_native", BOTH, lookup);
    runtime.refresh([
      ...pool(),
      candidate(
        "opengeni__capability_catalog_search",
        "Find integrations in the reviewed workspace catalog when the user asks to add one or needed access is missing.",
      ),
      candidate(
        "opengeni__capability_authorization_request",
        "Show a Connect card in this chat for a suitable capability returned by capability_catalog_search.",
      ),
    ]);
    const result = await runtime.prepareSearch({
      query: "compare my google calendar with gmail invites",
    });
    const output = JSON.parse(result.output);
    expect(output.notConnected).toStartWith("Not connected yet: Google Calendar");
    expect(output.connectedAccounts).toBe(NOTICE);
    expect(result.notice).toBe(`${output.notConnected}\n${NOTICE}`);
  });

  describe("a vague email search with Gmail and Outlook Mail connected", () => {
    // The real Gmail tools, and Outlook Mail tools in the shape the OpenAPI
    // compiler gives Microsoft Graph operations: the operationId as the name,
    // then the operation's description, method, path and safety.
    const gmailTools = GMAIL_REST_MCP_TOOLS.map((t) =>
      candidate(`mcp__gmail__${t.name}`, t.description ?? "", t.inputSchema as never),
    );
    const outlookTools = [
      [
        "me_listmessages",
        "Get the messages in the signed-in user's mailbox (including the Deleted Items and Clutter folders). GET /me/messages. Read-only.",
      ],
      [
        "me_getmessages",
        "Retrieve the properties and relationships of a message object. GET /me/messages/{message-id}. Read-only.",
      ],
      [
        "me_mailfolders_listmessages",
        "Get all the messages in the specified user's mailbox, or those messages in a specified folder in the mailbox. GET /me/mailFolders/{mailFolder-id}/messages. Read-only.",
      ],
      [
        "me_sendmail",
        "Send the message specified in the request body using either JSON or MIME format. POST /me/sendMail. Changes external state. Your tool permissions determine whether review is needed.",
      ],
    ].map(([name, description]) => candidate(`mcp__outlook__${name}`, description!));
    const accounts: ReadonlyMap<string, ConnectedToolAccount> = new Map([
      ...gmailTools.map((t) => [(t as { name: string }).name, gmail] as const),
      ...outlookTools.map((t) => [(t as { name: string }).name, outlook] as const),
    ]);
    const mailRuntime = (transport: "generic_dispatch" | "openai_native" | "codex_native") => {
      const runtime = runtimeWith(transport, accounts);
      runtime.refresh([...pool().slice(3), ...gmailTools, ...outlookTools]);
      return runtime;
    };
    // The exact first search of a turn that asked "Have I got any new emails?".
    const STAGING = { query: "Search and read user's email inbox recent unread emails", limit: 2 };

    for (const transport of ["openai_native", "codex_native"] as const) {
      test(`${transport}: loads the strongest relevant tool and names the other mailbox`, async () => {
        // No tool's name or capability sentence has "email" or "inbox", so
        // there is no clear best match; the result still loads Gmail search.
        const result = await mailRuntime(transport).prepareSearch(STAGING);
        expect(loaded(result)).toEqual(["mcp__gmail__search_messages"]);
        expect(result.notice).toBe(NOTICE);
        expect(JSON.parse(result.output).connectedAccounts).toBe(NOTICE);
      });

      test(`${transport}: an unrelated query or a synonym-only match still loads nothing`, async () => {
        for (const query of ["book a flight to Paris", "show the weather forecast"]) {
          const runtime = mailRuntime(transport);
          const result = await runtime.prepareSearch({ query, limit: 2 });
          expect(loaded(result)).toEqual([]);
          expect(result.notice).toBeUndefined();
          // Nothing shown, so the turn's notice is still unspent.
          expect((await runtime.prepareSearch(STAGING)).notice).toBe(NOTICE);
        }
      });
    }

    test("generic_dispatch: keeps listing compact candidates", async () => {
      const result = await mailRuntime("generic_dispatch").prepareSearch(STAGING);
      expect(loaded(result)).toEqual([]);
      const output = JSON.parse(result.output);
      expect(output.schemasLoaded).toBe(false);
      expect(output.tools.map((t: { name: string }) => t.name)).toEqual([
        "mcp__gmail__search_messages",
        "mcp__gmail__search_threads",
      ]);
      expect(output.connectedAccounts).toBe(NOTICE);
    });

    test.each(["openai_native", "codex_native"] as const)(
      "%s: through the real SDK the first search loads Gmail and names Outlook Mail, once",
      async (transport) => {
        const agent = new Agent({
          name: "mail",
          model: "scripted",
          tools: [...pool().slice(3), ...gmailTools, ...outlookTools],
        });
        const runtime = installLazyToolRuntime(
          agent,
          transport,
          new Set(),
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () => accounts,
        );
        const model = new ScriptedModel([
          [searchCall(transport, "find", STAGING)],
          [searchCall(transport, "load", { query: "", names: ["mcp__outlook__me_listmessages"] })],
          [done],
        ]);
        const result = await new Runner({
          modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
        }).run(agent, "Have I got any new emails?", {
          stream: true,
          historyOwnership: "external",
          resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
          callModelInputFilter: baseModelInputFilterForSettings(
            testSettings({ sandboxBackend: "none" }),
          ),
        });
        for await (const event of result.toStream()) void event;
        await result.completed;
        const wire = (index: number) =>
          responsesWire().wire({
            ...model.requests[index]!,
            input: projectHistoryForProvider(
              model.requests[index]!.input as Record<string, unknown>[],
              "responses",
              { declaresAdditionalTools: true },
            ) as ModelRequest["input"],
          });
        const outputs = (index: number) =>
          (wire(index).input as Record<string, unknown>[]).filter(
            (item) => item.type === "tool_search_output",
          );
        const notices = (index: number) =>
          (wire(index).input as Record<string, unknown>[]).filter(
            (item) => item.type === "message" && item.role === "developer",
          );
        expect(outputs(1)).toEqual([
          expect.objectContaining({
            tools: [expect.objectContaining({ name: "mcp__gmail__search_messages" })],
          }),
        ]);
        expect(notices(1)).toEqual([expect.objectContaining({ content: NOTICE })]);
        // The exact-name load reaches Outlook Mail too; the turn's notice is spent.
        expect(outputs(2)[1]).toEqual(
          expect.objectContaining({
            tools: [expect.objectContaining({ name: "mcp__outlook__me_listmessages" })],
          }),
        );
        expect(notices(2)).toEqual(notices(1));
        for (let i = 1; i < model.requests.length; i++) {
          expect(model.requests[i]!.tools).toEqual(model.requests[0]!.tools);
          const previous = model.requests[i - 1]!.input as unknown[];
          expect((model.requests[i]!.input as unknown[]).slice(0, previous.length)).toEqual(
            previous,
          );
        }
      },
    );
  });
});
