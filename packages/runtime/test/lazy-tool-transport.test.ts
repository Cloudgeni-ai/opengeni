import { describe, expect, test } from "bun:test";
import {
  Agent,
  MemorySession,
  RunState,
  Runner,
  Usage,
  tool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import {
  LazyToolModelProvider,
  installLazyToolRuntime,
  restoreGenericDispatchHistory,
  restoreGenericDispatchHistoryItems,
} from "../src/lazy-tool-transport";
import { boundModelToolOutputItem } from "@opengeni/codex";

const SERVER_ID = "connected_tools";
const WEATHER_TOOL = `${SERVER_ID}__weather_lookup`;

function responseDone(id: string, output: ModelResponse["output"]): StreamEvent {
  return {
    type: "response_done",
    response: {
      id,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as StreamEvent;
}

function finalMessage(text: string): ModelResponse["output"][number] {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

class ScriptedStreamingModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly outputs: ModelResponse["output"][]) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error("test model must be called through the streaming path");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(snapshotRequest(request));
    const output = this.outputs[this.requests.length - 1];
    if (!output) throw new Error("script exhausted");
    yield responseDone(`response-${this.requests.length}`, output);
  }
}

class CapturingModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(snapshotRequest(request));
    return { usage: new Usage(), output: [finalMessage("ok")] };
  }

  getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error("not used");
  }
}

function snapshotRequest(request: ModelRequest): ModelRequest {
  const { signal: _signal, ...withoutSignal } = request;
  return {
    ...withoutSignal,
    input: structuredClone(request.input),
    tools: structuredClone(request.tools),
    handoffs: structuredClone(request.handoffs),
    modelSettings: structuredClone(request.modelSettings),
  };
}

function providerFor(model: Model): ModelProvider {
  return { getModel: () => model };
}

function weatherTool(
  options: {
    execute?: (input: { city: string }) => string;
    needsApproval?: () => boolean | Promise<boolean>;
  } = {},
): Tool {
  return tool({
    name: WEATHER_TOOL,
    description: "Look up the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    strict: false,
    needsApproval: options.needsApproval ?? false,
    execute: options.execute ?? ((input) => `weather:${input.city}`),
  }) as unknown as Tool;
}

function agentWith(toolValue: Tool): Agent<any, any> {
  return new Agent({
    name: "lazy-test",
    instructions: "Use tools.",
    model: "scripted",
    tools: [toolValue],
  });
}

async function runStreamed(
  agent: Agent<any, any>,
  model: ScriptedStreamingModel,
  runtime: ReturnType<typeof installLazyToolRuntime>,
) {
  const runner = new Runner({
    modelProvider: new LazyToolModelProvider(providerFor(model), runtime),
  });
  const result = await runner.run(agent, "What is the weather?", {
    stream: true,
    historyOwnership: "external",
    maxTurns: 8,
    toolNotFoundBehavior: "return_error_to_model",
  });
  for await (const _event of result.toStream()) void _event;
  await result.completed;
  return result;
}

describe("application-owned Agents SDK history", () => {
  test("keeps projected model views separate while borrowing durable input unchanged", async () => {
    const model = new CapturingModel();
    const agent = new Agent({
      name: "external-history-test",
      instructions: "Answer briefly.",
      model: "scripted",
    });
    const runner = new Runner({ modelProvider: providerFor(model) });
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "durable-original" }],
      },
    ] as any;

    const result = await runner.run(agent, input, {
      historyOwnership: "external",
      callModelInputFilter: ({ modelData }) => ({
        ...modelData,
        input: modelData.input.map((item, index) =>
          index === 0
            ? {
                ...(item as any),
                content: [{ type: "input_text", text: "wire-only-view" }],
              }
            : item,
        ),
      }),
    });

    expect(input[0].content[0].text).toBe("durable-original");
    expect((model.requests[0]!.input[0] as any).content[0].text).toBe("wire-only-view");
    expect(((result.state as any)._originalInput[0] as any).content[0].text).toBe(
      "durable-original",
    );
    expect((result.state as any)._currentTurnSessionHistoryTransactionInputItems).toBeUndefined();
  });

  test("fails closed when mixed with SDK or server-owned conversation state", async () => {
    const model = new CapturingModel();
    const agent = new Agent({
      name: "external-history-conflict-test",
      instructions: "Answer briefly.",
      model: "scripted",
    });
    const runner = new Runner({ modelProvider: providerFor(model) });

    await expect(
      runner.run(agent, "hello", {
        historyOwnership: "external",
        session: new MemorySession(),
      }),
    ).rejects.toThrow("External history ownership cannot be combined");
    await expect(
      runner.run(agent, "hello", {
        historyOwnership: "external",
        previousResponseId: "response-1",
      }),
    ).rejects.toThrow("External history ownership cannot be combined");
    expect(model.requests).toHaveLength(0);
  });

  test("leaves default SDK Session behavior intact", async () => {
    const model = new CapturingModel();
    const agent = new Agent({
      name: "sdk-history-default-test",
      instructions: "Answer briefly.",
      model: "scripted",
    });
    const runner = new Runner({ modelProvider: providerFor(model) });
    const session = new MemorySession();

    await runner.run(agent, "session-owned", { session });

    expect(JSON.stringify(await session.getItems())).toContain("session-owned");
    expect(model.requests).toHaveLength(1);
  });

  test("can retain only the latest raw response without losing history or usage", async () => {
    let executions = 0;
    const agent = agentWith(
      weatherTool({
        execute: ({ city }) => {
          executions += 1;
          return `sunny:${city}`;
        },
      }),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "retained-response-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo" }),
        },
      ],
      [finalMessage("complete")],
    ]);
    const result = await new Runner({ modelProvider: providerFor(model) }).run(
      agent,
      "Check Oslo",
      {
        stream: true,
        historyOwnership: "external",
        modelResponseRetention: "last",
        maxTurns: 4,
      },
    );
    for await (const _event of result.toStream()) void _event;
    await result.completed;

    expect(executions).toBe(1);
    expect(result.rawResponses).toHaveLength(1);
    expect(result.rawResponses[0]!.output).toEqual([finalMessage("complete")]);
    expect((result.state as any)._modelResponseCount).toBe(2);
    expect(result.state.usage.requests).toBe(2);
    expect(result.history.some((item) => item.type === "function_call")).toBe(true);
    expect(result.history.some((item) => item.type === "function_call_result")).toBe(true);
    expect(JSON.parse(result.state.toString()).modelResponses).toHaveLength(1);
  });

  test("rejects an unknown raw-response retention policy", async () => {
    const runner = new Runner({ modelProvider: providerFor(new CapturingModel()) });
    await expect(
      runner.run(new Agent({ name: "invalid-retention", instructions: "Answer." }), "hello", {
        modelResponseRetention: "invalid" as never,
      }),
    ).rejects.toThrow("modelResponseRetention must be either 'all' or 'last'");
  });
});

function serializedFunction(toolValue: Tool) {
  if (toolValue.type !== "function") throw new Error("expected function tool");
  return {
    type: "function" as const,
    name: toolValue.name,
    description: toolValue.description,
    parameters: toolValue.parameters,
    strict: toolValue.strict,
    deferLoading: toolValue.deferLoading,
  };
}

function baseRequest(tools: ModelRequest["tools"]): ModelRequest {
  return {
    input: [{ type: "message", role: "user", content: "hello" }],
    modelSettings: {},
    tools,
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

describe("generic lazy tool dispatch", () => {
  test("searches, restores provider history, and executes the real tool pipeline", async () => {
    let approvalChecks = 0;
    let executions = 0;
    const realTool = weatherTool({
      needsApproval: async () => {
        approvalChecks += 1;
        return false;
      },
      execute: ({ city }) => {
        executions += 1;
        return `sunny:${city}`;
      },
    });
    const agent = agentWith(realTool);
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "search-1",
          name: "tool_search",
          arguments: JSON.stringify({ query: "weather city" }),
        },
      ],
      [
        {
          type: "function_call",
          callId: "invoke-1",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Oslo" } }),
          providerData: { providerCall: "kept" },
        },
      ],
      [finalMessage("done")],
    ]);

    const result = await runStreamed(agent, model, runtime);

    expect(result.finalOutput).toBe("done");
    expect(approvalChecks).toBe(1);
    expect(executions).toBe(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
    expect(JSON.stringify(model.requests[1]!.input)).toContain(WEATHER_TOOL);

    const thirdInput = model.requests[2]!.input as Array<Record<string, unknown>>;
    const replayedCall = thirdInput.find(
      (item) => item.type === "function_call" && item.callId === "invoke-1",
    );
    expect(replayedCall).toMatchObject({
      name: "tool_invoke",
      providerData: { providerCall: "kept" },
    });
    expect(JSON.parse(String(replayedCall?.arguments))).toEqual({
      name: WEATHER_TOOL,
      arguments: { city: "Oslo" },
    });

    const internalCall = result.rawResponses[1]!.output[0] as Record<string, unknown>;
    expect(internalCall.name).toBe(WEATHER_TOOL);
    expect(JSON.parse(String(internalCall.arguments))).toEqual({ city: "Oslo" });
  });

  test("accepts a valid dispatcher call after compacted history without a disclosure ledger", async () => {
    let executions = 0;
    const agent = agentWith(
      weatherTool({
        execute: ({ city }) => {
          executions += 1;
          return `clear:${city}`;
        },
      }),
    );
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "remembered-after-compaction",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Paris" } }),
        },
      ],
      [finalMessage("continued")],
    ]);

    await runStreamed(agent, model, runtime);
    expect(executions).toBe(1);
    expect((model.requests[1]!.input as Array<Record<string, unknown>>)[1]).toMatchObject({
      type: "function_call",
      name: "tool_invoke",
    });
  });

  test("survives a durable approval interruption without exposing the real tool name", async () => {
    let executions = 0;
    const agent = agentWith(
      weatherTool({
        needsApproval: () => true,
        execute: ({ city }) => {
          executions += 1;
          return `approved:${city}`;
        },
      }),
    );
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "approval-call",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Berlin" } }),
        },
      ],
      [finalMessage("approved-done")],
    ]);
    const modelProvider = new LazyToolModelProvider(providerFor(model), runtime);
    const firstRunner = new Runner({ modelProvider });
    const first = await firstRunner.run(agent, "Check Berlin", {
      stream: true,
      historyOwnership: "external",
      modelResponseRetention: "last",
      maxTurns: 8,
      toolNotFoundBehavior: "return_error_to_model",
    });
    for await (const _event of first.toStream()) void _event;
    await first.completed;

    expect(executions).toBe(0);
    expect(first.interruptions).toHaveLength(1);
    expect(first.interruptions[0]!.rawItem).toMatchObject({
      type: "function_call",
      name: WEATHER_TOOL,
    });

    const resumedState = await RunState.fromString(agent, first.state.toString());
    const [approval] = resumedState.getInterruptions();
    expect(approval).toBeDefined();
    resumedState.approve(approval!);
    const resumedRunner = new Runner({ modelProvider });
    const resumed = await resumedRunner.run(agent, resumedState, {
      stream: true,
      historyOwnership: "external",
      modelResponseRetention: "last",
      maxTurns: 8,
      toolNotFoundBehavior: "return_error_to_model",
    });
    for await (const _event of resumed.toStream()) void _event;
    await resumed.completed;

    expect(resumed.finalOutput).toBe("approved-done");
    expect(executions).toBe(1);
    const providerInput = model.requests[1]!.input as Array<Record<string, unknown>>;
    expect(
      providerInput.find(
        (item) => item.type === "function_call" && item.callId === "approval-call",
      ),
    ).toMatchObject({ name: "tool_invoke" });
  });

  test("returns a typed model-visible error for a stale or revoked tool", async () => {
    const agent = agentWith(weatherTool());
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "stale-1",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: `${SERVER_ID}__removed`, arguments: {} }),
        },
      ],
      [finalMessage("recovered")],
    ]);

    await runStreamed(agent, model, runtime);
    const followUp = JSON.stringify(model.requests[1]!.input);
    expect(followUp).toContain("tool_unavailable");
    expect(followUp).toContain("Search again");
  });

  test("keeps the provider tool block byte-identical when the lazy catalogue changes", async () => {
    let current = weatherTool();
    const fakeAgent = {
      async getAllTools() {
        return [current];
      },
    };
    const runtime = installLazyToolRuntime(fakeAgent, "generic_dispatch", new Set([SERVER_ID]));
    const inner = new CapturingModel();
    const wrapped = await new LazyToolModelProvider(providerFor(inner), runtime).getModel("test");

    let visible = await fakeAgent.getAllTools(undefined);
    await wrapped.getResponse(baseRequest(visible.map(serializedFunction)));

    current = tool({
      name: `${SERVER_ID}__forecast_v2`,
      description: "A changed and much larger forecast schema",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          days: { type: "number" },
          units: { type: "string" },
        },
        required: ["city"],
        additionalProperties: false,
      },
      strict: false,
      execute: () => "unused",
    }) as unknown as Tool;
    visible = await fakeAgent.getAllTools(undefined);
    await wrapped.getResponse(baseRequest(visible.map(serializedFunction)));

    expect(JSON.stringify(inner.requests[0]!.tools)).toBe(JSON.stringify(inner.requests[1]!.tools));
    expect(inner.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
  });

  test("history restoration is pure and removes only OpenGeni's internal marker", () => {
    const original = JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Rome" } });
    const input = [
      {
        type: "function_call",
        callId: "call-1",
        name: WEATHER_TOOL,
        arguments: JSON.stringify({ city: "Rome" }),
        providerData: {
          providerCall: "kept",
          "opengeni.lazy_dispatch.v1": { version: 1, arguments: original },
        },
      },
    ] as ModelRequest["input"];
    const restored = restoreGenericDispatchHistory(input) as Array<Record<string, unknown>>;
    expect(restored[0]).toEqual({
      type: "function_call",
      callId: "call-1",
      name: "tool_invoke",
      arguments: original,
      providerData: { providerCall: "kept" },
    });
    expect(input).not.toBe(restored);
    expect((input as Array<Record<string, unknown>>)[0]!.name).toBe(WEATHER_TOOL);
  });

  test("projects the dispatcher transcript before provider compaction", () => {
    const original = JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Rome" } });
    const canonical = [
      {
        type: "function_call",
        callId: "call-1",
        name: WEATHER_TOOL,
        arguments: JSON.stringify({ city: "Rome" }),
        providerData: {
          "opengeni.lazy_dispatch.v1": { version: 1, arguments: original },
        },
      },
    ];

    const projected = restoreGenericDispatchHistoryItems(canonical);
    expect(projected).not.toBe(canonical);
    expect(projected[0]).toEqual({
      type: "function_call",
      callId: "call-1",
      name: "tool_invoke",
      arguments: original,
    });
    expect(JSON.stringify(projected)).not.toContain("opengeni.lazy_dispatch.v1");
  });

  test("bounds generic search disclosure before output truncation", async () => {
    const tools = Array.from({ length: 8 }, (_, index) =>
      tool({
        name: `${SERVER_ID}__weather_${index}`,
        description: `weather capability ${"x".repeat(2_500)}`,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        strict: false,
        execute: () => "unused",
      }),
    ) as unknown as Tool[];
    const runtime = installLazyToolRuntime(
      {
        async getAllTools() {
          return tools;
        },
      },
      "generic_dispatch",
      new Set([SERVER_ID]),
      1_000,
    );
    runtime.refresh(tools);
    const searchTool = runtime.controlTools.find(
      (candidate) => candidate.type === "function" && candidate.name === "tool_search",
    );
    if (!searchTool || searchTool.type !== "function") throw new Error("missing tool_search");

    const output = await searchTool.invoke(
      {} as never,
      JSON.stringify({ query: "weather capability", limit: 20 }),
      undefined as never,
    );
    const parsed = JSON.parse(String(output)) as { tools: unknown[] };
    expect(parsed.tools.length).toBeGreaterThan(0);
    expect(parsed.tools.length).toBeLessThan(tools.length);

    const item = { type: "function_call_result", callId: "search-1", output };
    expect(boundModelToolOutputItem(item, 1_000)).toBe(item);

    const tinyRuntime = installLazyToolRuntime(
      {
        async getAllTools() {
          return tools;
        },
      },
      "generic_dispatch",
      new Set([SERVER_ID]),
      1,
    );
    tinyRuntime.refresh(tools);
    const tinySearch = tinyRuntime.controlTools.find(
      (candidate) => candidate.type === "function" && candidate.name === "tool_search",
    );
    if (!tinySearch || tinySearch.type !== "function") throw new Error("missing tiny tool_search");
    const tinyOutput = await tinySearch.invoke(
      {} as never,
      JSON.stringify({ query: "weather capability" }),
      undefined as never,
    );
    expect(tinyOutput).toBe("{}");
    const tinyItem = { type: "function_call_result", callId: "search-tiny", output: tinyOutput };
    expect(boundModelToolOutputItem(tinyItem, 1)).toBe(tinyItem);

    // Planted negative: the previous unbounded disclosure is mutated by the
    // ordinary output truncator, corrupting at least one returned schema.
    const unbounded = JSON.stringify({
      tools: runtime.search({ query: "weather capability", limit: 20 }).map(serializedFunction),
    });
    const truncated = boundModelToolOutputItem(
      { ...item, output: unbounded },
      1_000,
    ) as typeof item;
    expect(truncated.output).not.toBe(unbounded);
    expect(String(truncated.output)).toContain("tokens truncated");
  });

  test("reserves only the control names installed by each transport", () => {
    const invokeNamedTool = tool({
      name: "tool_invoke",
      description: "An existing eager tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: () => "ok",
    }) as unknown as Tool;

    const native = installLazyToolRuntime(
      {
        async getAllTools() {
          return [invokeNamedTool];
        },
      },
      "openai_native",
      new Set(),
    );
    expect(() => native.refresh([invokeNamedTool])).not.toThrow();

    const generic = installLazyToolRuntime(
      {
        async getAllTools() {
          return [invokeNamedTool];
        },
      },
      "generic_dispatch",
      new Set(),
    );
    expect(() => generic.refresh([invokeNamedTool])).toThrow(/reserved/);
  });

  test("does not wrap an already-wrapped concrete model again on clone", () => {
    const model = new CapturingModel();
    const fakeAgent = {
      model: model as Model,
      async getAllTools() {
        return [] as Tool[];
      },
      clone() {
        return { model: this.model, getAllTools: this.getAllTools };
      },
    };
    installLazyToolRuntime(fakeAgent, "generic_dispatch", new Set());
    const wrapped = fakeAgent.model;
    const cloned = fakeAgent.clone();
    expect(cloned.model).toBe(wrapped);
  });
});

describe("OpenAI/Azure native client tool search", () => {
  test("omits lazy schemas on the wire, discloses real tool objects, and executes normally", async () => {
    let approvalChecks = 0;
    let executions = 0;
    const realTool = weatherTool({
      needsApproval: () => {
        approvalChecks += 1;
        return false;
      },
      execute: ({ city }) => {
        executions += 1;
        return `native:${city}`;
      },
    });
    const agent = agentWith(realTool);
    const runtime = installLazyToolRuntime(agent, "openai_native", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "tool_search_call",
          call_id: "native-search-1",
          execution: "client",
          status: "completed",
          arguments: { query: "weather city" },
        },
      ],
      [
        {
          type: "function_call",
          callId: "native-call-1",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Tokyo" }),
        },
      ],
      [finalMessage("native-done")],
    ]);

    const result = await runStreamed(agent, model, runtime);

    expect(result.finalOutput).toBe("native-done");
    expect(approvalChecks).toBe(1);
    expect(executions).toBe(1);
    expect((realTool as { deferLoading?: boolean }).deferLoading).not.toBe(true);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual(["tool_search"]);
    expect(JSON.stringify(model.requests[1]!.input)).toContain("tool_search_output");
    expect(JSON.stringify(model.requests[1]!.input)).toContain(WEATHER_TOOL);
    expect(model.requests[1]!.tools.map((candidate) => candidate.name)).toEqual(["tool_search"]);
  });

  test("adds no SDK disclosure ledger when a native real-tool call reaches Runner", async () => {
    let executions = 0;
    const realTool = weatherTool({
      execute: ({ city }) => {
        executions += 1;
        return `remembered:${city}`;
      },
    });
    const agent = agentWith(realTool);
    const runtime = installLazyToolRuntime(agent, "openai_native", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "remembered-native-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Helsinki" }),
        },
      ],
      [finalMessage("remembered-done")],
    ]);

    const result = await runStreamed(agent, model, runtime);

    expect(result.finalOutput).toBe("remembered-done");
    expect(executions).toBe(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual(["tool_search"]);
  });

  test("keeps the native provider tool block byte-identical across lazy catalogues", async () => {
    const capture = async (realTool: Tool): Promise<ModelRequest["tools"]> => {
      const agent = agentWith(realTool);
      const runtime = installLazyToolRuntime(agent, "openai_native", new Set([SERVER_ID]));
      const model = new ScriptedStreamingModel([[finalMessage("done")]]);
      await runStreamed(agent, model, runtime);
      return model.requests[0]!.tools;
    };

    const first = await capture(weatherTool());
    const second = await capture(
      tool({
        name: `${SERVER_ID}__forecast_v2`,
        description: "A changed and much larger forecast schema",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" },
            units: { type: "string" },
          },
          required: ["city"],
          additionalProperties: false,
        },
        strict: false,
        execute: () => "unused",
      }) as unknown as Tool,
    );

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((candidate) => candidate.name)).toEqual(["tool_search"]);
  });

  test("clears the SDK deferred gate; planted raw negative proves why", async () => {
    let executions = 0;
    const realTool = weatherTool({
      execute: () => {
        executions += 1;
        return "ran";
      },
    });
    (realTool as { deferLoading?: boolean }).deferLoading = true;
    const agent = agentWith(realTool);
    const runtime = installLazyToolRuntime(agent, "openai_native", new Set([SERVER_ID]));
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "unsearched-native-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo" }),
        },
      ],
      [finalMessage("done")],
    ]);

    const result = await runStreamed(agent, model, runtime);
    expect(result.finalOutput).toBe("done");
    expect(executions).toBe(1);
    expect((realTool as { deferLoading?: boolean }).deferLoading).toBe(false);

    const rawTool = weatherTool();
    (rawTool as { deferLoading?: boolean }).deferLoading = true;
    const rawAgent = agentWith(rawTool);
    const rawModel = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "raw-deferred-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo" }),
        },
      ],
    ]);
    const rawRunner = new Runner({ modelProvider: providerFor(rawModel) });
    const rawResult = await rawRunner.run(rawAgent, "weather", {
      stream: true,
      maxTurns: 2,
    });
    await expect(
      (async () => {
        for await (const _event of rawResult.toStream()) void _event;
        await rawResult.completed;
      })(),
    ).rejects.toThrow(/tool_search|not loaded/i);
  });
});
