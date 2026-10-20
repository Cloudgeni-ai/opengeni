import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  tool,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { ToolSearchIndex } from "../src/tool-discovery-ranking";
import { rankToolPool } from "../src/codex-tool-search";
import {
  createResolveMissingFunctionTool,
  expandInteractionFamilyDisclosures,
  installLazyToolRuntime,
  LazyToolRuntime,
  LazyToolModelProvider,
  transformGenericDispatchResponse,
} from "../src/lazy-tool-transport";
import { baseModelInputFilterForSettings } from "../src/model-input";
import { projectHistoryForProvider, TOOL_DISCLOSURE_KEY } from "../src/provider-history-adapter";
import {
  createToolDecisionModel,
  parseToolDecision,
  toolDecisionRequest,
  type ToolDecisionModel,
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
const done = {
  type: "message" as const,
  role: "assistant" as const,
  status: "completed" as const,
  content: [{ type: "output_text" as const, text: "done" }],
};

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

function decisionRuntime(decision: ToolDecisionModel) {
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
  test("selects only authorized candidates, returns a compact receipt and freezes selected schemas", async () => {
    let calls = 0;
    const runtime = decisionRuntime(async (input) => {
      calls++;
      expect(input.candidates).toHaveLength(2);
      expect(JSON.stringify(input.candidates)).not.toContain('"parameters"');
      return ["tasks__get"];
    });
    runtime.refresh([candidate("tasks__get", "Get task"), candidate("tasks__list", "List tasks")]);
    const selected = await runtime.prepareSearch({ query: "get task" });
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
    runtime.refresh([candidate("tasks__get", "Get task")]);
    expect((await runtime.prepareSearch({ query: "", names: ["tasks__get"] })).tools).toHaveLength(
      1,
    );
    expect(calls).toBe(0);
    const fallback = await runtime.prepareSearch({ query: "get task" });
    expect(calls).toBe(1);
    expect(JSON.parse(fallback.output)).toMatchObject({
      schemasLoaded: false,
      fallback: "decision_model_unavailable",
    });
    expect(fallback.tools).toEqual([]);
    expect(fallback.output).not.toContain("secret");
    const invalid = decisionRuntime(async () => ["not_authorized"]);
    invalid.refresh([candidate("tasks__get", "Get task")]);
    expect((await invalid.prepareSearch({ query: "get task" })).tools).toEqual([]);
  });
  test("revocation during inference cannot disclose the old tool; cancellation is not a fallback", async () => {
    const runtime = decisionRuntime(async () => {
      runtime.refresh([]);
      return ["tasks__get"];
    });
    runtime.refresh([candidate("tasks__get", "Get task")]);
    const revoked = await runtime.prepareSearch({ query: "get task" });
    expect(revoked.tools).toEqual([]);
    expect(JSON.parse(revoked.output).schemasLoaded).toBe(false);
    const controller = new AbortController();
    const cancelled = decisionRuntime(async () => {
      controller.abort();
      throw new Error("stopped");
    });
    cancelled.refresh([candidate("tasks__get", "Get task")]);
    await expect(
      cancelled.prepareSearch({ query: "get task" }, controller.signal),
    ).rejects.toThrow();
  });
  test("decision format validates whole IDs and leaves the catalog prefix unchanged across queries", () => {
    const candidates = [{ name: "tasks__get", description: "Get task", inputFields: ["id"] }];
    expect(parseToolDecision('{"ids":[0]}', candidates)).toEqual(["tasks__get"]);
    for (const text of ['{"ids":[1]}', '{"ids":[0,0]}', '{"ids":["0"]}', "{}"])
      expect(() => parseToolDecision(text, candidates)).toThrow();
    expect(toolDecisionRequest({ query: "first", candidates }).messages.slice(0, 2)).toEqual(
      toolDecisionRequest({ query: "second", candidates }).messages.slice(0, 2),
    );
  });
  test("the normal single-model implementation settles usage even for an invalid answer", async () => {
    let usageCalls = 0;
    const model = new ScriptedModel([
      [{ ...done, content: [{ type: "output_text", text: '{"ids":[99]}' }] }],
    ]);
    const choose = createToolDecisionModel(
      { model },
      {
        onUsage: async () => {
          usageCalls++;
        },
      },
    );
    await expect(
      choose({
        query: "get task",
        candidates: [{ name: "tasks__get", description: "Get task", inputFields: [] }],
      }),
    ).rejects.toThrow();
    expect(usageCalls).toBe(1);
  });
});

test.each(["codex_native", "openai_native", "generic_dispatch"] as const)(
  "%s: one decision search then execute, exactly one inference, stable prefix",
  async (transport) => {
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
    const agent = new Agent({ name: "discovery", model: "scripted", tools: [target] });
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
        decisions++;
        return ["tasks__read"];
      },
    );
    const model = new ScriptedModel([
      [call("find", "tool_search", { query: "read a task" })],
      [call("invoke", "tool_invoke", { name: "tasks__read", arguments: { id: 7 } })],
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
    expect(decisions).toBe(1);
    expect(executions).toBe(1);
    expect(JSON.stringify(model.requests[1]!.input)).toContain('"required"');
    for (let i = 1; i < model.requests.length; i++) {
      expect(model.requests[i]!.tools).toEqual(model.requests[0]!.tools);
      const previous = model.requests[i - 1]!.input as unknown[];
      expect((model.requests[i]!.input as unknown[]).slice(0, previous.length)).toEqual(previous);
    }
  },
);

test.each(["codex_native", "openai_native", "generic_dispatch"] as const)(
  "%s: compact find, exact load and execute use the real SDK with stable prefixes",
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
    const agent = new Agent({ name: "discovery", model: "scripted", tools: [target] });
    const runtime = installLazyToolRuntime(agent, transport, new Set());
    const model = new ScriptedModel([
      [call("find", "tool_search", { query: "read a task" })],
      [call("load", "tool_search", { query: "", names: ["tasks__read"] })],
      [call("invoke", "tool_invoke", { name: "tasks__read", arguments: { id: 7 } })],
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
    expect(JSON.stringify(model.requests[1]!.input)).not.toContain('"required"');
    expect(JSON.stringify(model.requests[2]!.input)).toContain('"required"');
    for (let i = 1; i < model.requests.length; i++) {
      expect(model.requests[i]!.tools).toEqual(model.requests[0]!.tools);
      const previous = model.requests[i - 1]!.input as unknown[];
      expect((model.requests[i]!.input as unknown[]).slice(0, previous.length)).toEqual(previous);
    }
  },
);
