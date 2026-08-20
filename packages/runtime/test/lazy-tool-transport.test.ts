import { describe, expect, test } from "bun:test";
import {
  Agent,
  MemorySession,
  RunState,
  Runner,
  Usage,
  tool,
  toolSearchTool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import { SandboxAgent } from "@openai/agents/sandbox";
import {
  LazyToolModelProvider,
  createResolveMissingFunctionTool,
  installLazyToolRuntime,
  restoreGenericDispatchHistory,
  restoreGenericDispatchHistoryItems,
  transformGenericDispatchResponse,
} from "../src/lazy-tool-transport";
import { boundModelToolOutputItem } from "@opengeni/codex";
import { MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES } from "../src/mcp-network";
import { normalizeSdkEvent } from "../src/run-events";
import { restoreInterruptedRunState } from "../src/index";

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

function firstPartyTool(name: string, description: string): Tool {
  return tool({
    name,
    description,
    parameters: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
    strict: false,
    execute: () => "unused",
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

/** MCP-shaped: catalog tool lives on getAllTools, not agent.tools. */
function sandboxAgentWithCatalogTool(toolValue: Tool): Agent<any, any> {
  const agent = new SandboxAgent({
    name: "lazy-test",
    model: "gpt-5.6-sol",
    tools: [],
  } as never) as unknown as Agent<any, any>;
  const original = agent.getAllTools.bind(agent);
  agent.getAllTools = (async (runContext: unknown) => [
    ...(await original(runContext)),
    toolValue,
  ]) as typeof agent.getAllTools;
  return agent;
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
    resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
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
  if (toolValue.type === "hosted_tool") {
    return {
      type: "hosted_tool" as const,
      name: toolValue.name,
      providerData: toolValue.providerData,
    };
  }
  if (toolValue.type !== "function") throw new Error("expected function or hosted tool");
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
  test("late-registers and executes a deferred dispatcher call in the same model response", async () => {
    let releasePreparation!: () => void;
    let preparationSettled = false;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = () => {
        preparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const deferredTool = weatherTool({
      execute: ({ city }) => {
        executions += 1;
        return `clear:${city}`;
      },
    });
    const agent = agentWith(deferredTool);
    const baseGetAllTools = agent.getAllTools.bind(agent);
    agent.getAllTools = async (runContext) =>
      preparationSettled ? await baseGetAllTools(runContext) : [];
    const runtime = installLazyToolRuntime(
      agent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      preparation,
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "deferred-direct-invoke",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Oslo" } }),
        },
      ],
      [finalMessage("done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    await Bun.sleep(0);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
    expect(executions).toBe(0);

    releasePreparation();
    const result = await running;

    expect(result.finalOutput).toBe("done");
    expect(executions).toBe(1);
    const providerFollowUp = JSON.stringify(model.requests[1]!.input);
    expect(providerFollowUp).toContain("deferred-direct-invoke");
    expect(providerFollowUp).toContain(WEATHER_TOOL);
    expect(providerFollowUp).not.toContain("not found");
    expect(providerFollowUp).not.toContain("opengeni:lazy-dispatch:register:");
    expect(providerFollowUp).not.toContain("tool_search_call");
    expect(providerFollowUp).not.toContain("tool_search_output");
  });

  test("late-registers multiple deferred dispatcher calls from one model response", async () => {
    let releasePreparation!: () => void;
    let preparationSettled = false;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = () => {
        preparationSettled = true;
        resolve();
      };
    });
    const executions: string[] = [];
    const secondToolName = `${SERVER_ID}__forecast_lookup`;
    const tools = [
      weatherTool({ execute: ({ city }) => (executions.push(`weather:${city}`), "clear") }),
      tool({
        name: secondToolName,
        description: "Look up a forecast",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
        strict: false,
        execute: ({ city }) => (executions.push(`forecast:${city}`), "dry"),
      }) as unknown as Tool,
    ];
    const agent = new Agent({
      name: "multi-lazy-test",
      instructions: "Use tools.",
      model: "scripted",
      tools,
    });
    const baseGetAllTools = agent.getAllTools.bind(agent);
    agent.getAllTools = async (runContext) =>
      preparationSettled ? await baseGetAllTools(runContext) : [];
    const runtime = installLazyToolRuntime(
      agent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      preparation,
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "multi-weather",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Oslo" } }),
        },
        {
          type: "function_call",
          callId: "multi-forecast",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: secondToolName, arguments: { city: "Bergen" } }),
        },
      ],
      [finalMessage("done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    await Bun.sleep(0);
    releasePreparation();
    await running;

    expect(executions).toEqual(["weather:Oslo", "forecast:Bergen"]);
    expect(JSON.stringify(model.requests[1]!.input)).not.toContain(
      "opengeni:lazy-dispatch:register:",
    );
  });

  test("does not surface internal late-registration items as user-visible tool steps", () => {
    const callId = "opengeni:lazy-dispatch:register:invoke-1";
    expect(
      normalizeSdkEvent({
        type: "run_item_stream_event",
        item: {
          type: "tool_search_call_item",
          rawItem: { type: "tool_search_call", callId, arguments: { name: WEATHER_TOOL } },
        },
      } as never),
    ).toEqual([]);
    expect(
      normalizeSdkEvent({
        type: "run_item_stream_event",
        item: {
          type: "tool_search_output_item",
          rawItem: {
            type: "tool_search_output",
            tools: [],
            providerData: { call_id: callId, execution: "client" },
          },
        },
      } as never),
    ).toEqual([]);
  });

  test("overlaps deferred preparation with the first generic-provider request", async () => {
    let releasePreparation!: () => void;
    let preparationSettled = false;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = () => {
        preparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const deferredTool = weatherTool({
      execute: ({ city }) => {
        executions += 1;
        return `clear:${city}`;
      },
    });
    const agent = agentWith(deferredTool);
    const baseGetAllTools = agent.getAllTools.bind(agent);
    agent.getAllTools = async (runContext) =>
      preparationSettled ? await baseGetAllTools(runContext) : [];
    const runtime = installLazyToolRuntime(
      agent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      preparation,
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "deferred-generic-search",
          name: "tool_search",
          arguments: JSON.stringify({ query: "weather city" }),
        },
      ],
      [
        {
          type: "function_call",
          callId: "deferred-generic-invoke",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Oslo" } }),
        },
      ],
      [finalMessage("done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    await Bun.sleep(0);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
    expect(executions).toBe(0);

    releasePreparation();
    const result = await running;

    expect(result.finalOutput).toBe("done");
    expect(executions).toBe(1);
    expect(JSON.stringify(model.requests[1]!.input)).toContain(WEATHER_TOOL);
  });

  test("recovers a direct remembered tool call after deferred preparation", async () => {
    let releasePreparation!: () => void;
    let preparationSettled = false;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = () => {
        preparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const deferredTool = weatherTool({
      execute: ({ city }) => {
        executions += 1;
        return `clear:${city}`;
      },
    });
    const agent = agentWith(deferredTool);
    const baseGetAllTools = agent.getAllTools.bind(agent);
    agent.getAllTools = async (runContext) =>
      preparationSettled ? await baseGetAllTools(runContext) : [];
    const runtime = installLazyToolRuntime(
      agent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      preparation,
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "remembered-direct-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo" }),
        },
      ],
      [finalMessage("done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    await Bun.sleep(0);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
    expect(executions).toBe(0);

    releasePreparation();
    const result = await running;

    expect(result.finalOutput).toBe("done");
    expect(executions).toBe(1);
    expect(JSON.stringify(model.requests[1]!.input)).not.toContain("not found");
    expect(model.requests[1]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
  });

  test("does not join deferred preparation for an eager direct tool call", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let executions = 0;
    const agent = agentWith(
      weatherTool({
        execute: ({ city }) => {
          executions += 1;
          return `clear:${city}`;
        },
      }),
    );
    const runtime = installLazyToolRuntime(
      agent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      preparation,
      new Set(),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "eager-direct-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo" }),
        },
      ],
      [finalMessage("done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    const outcome = await Promise.race([
      running.then(() => "completed" as const),
      Bun.sleep(500).then(() => "timed_out" as const),
    ]);
    releasePreparation();

    expect(outcome).toBe("completed");
    expect(executions).toBe(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      WEATHER_TOOL,
      "tool_search",
      "tool_invoke",
    ]);
    await running;
  });

  test("hides and searches first-party function tools without an MCP registry id", async () => {
    const firstParty = firstPartyTool(
      "interaction__browser_act",
      "Click, type, and interact with the current browser page",
    );
    const agent = agentWith(firstParty);
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set());
    const visible = await agent.getAllTools(undefined as never);
    const inner = new CapturingModel();
    const wrapped = await new LazyToolModelProvider(providerFor(inner), runtime).getModel("test");

    await wrapped.getResponse(baseRequest(visible.map(serializedFunction)));

    expect(inner.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "tool_search",
      "tool_invoke",
    ]);
    expect(
      runtime.search({ query: "interact with browser" }).map((candidate) => candidate.name),
    ).toEqual(["interaction__browser_act"]);
  });

  test("keeps the always-visible base set in the first request and out of search", async () => {
    const exec = firstPartyTool("exec_command", "Run a shell command in the sandbox");
    const stdin = firstPartyTool("write_stdin", "Write to a running command's stdin");
    const image = firstPartyTool("view_image", "Return an image from a sandbox path");
    const patch = firstPartyTool("apply_patch", "Apply a create, update, or delete file patch");
    const skill = firstPartyTool("load_skill", "Load a lazily configured skill into the sandbox");
    const human = firstPartyTool(
      "request_human_input",
      "Pause this turn and request structured human input",
    );
    const browser = firstPartyTool(
      "interaction__browser_act",
      "Click, type, and interact with the current browser page",
    );
    const agent = new Agent({
      name: "lazy-test",
      instructions: "Use tools.",
      model: "scripted",
      tools: [exec, stdin, image, patch, skill, human, browser],
    });
    const runtime = installLazyToolRuntime(agent, "generic_dispatch", new Set());
    const visible = await agent.getAllTools(undefined as never);
    const inner = new CapturingModel();
    const wrapped = await new LazyToolModelProvider(providerFor(inner), runtime).getModel("test");

    await wrapped.getResponse(baseRequest(visible.map(serializedFunction)));

    expect(inner.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      "exec_command",
      "write_stdin",
      "view_image",
      "apply_patch",
      "load_skill",
      "request_human_input",
      "tool_search",
      "tool_invoke",
    ]);
    for (const name of [
      "exec_command",
      "write_stdin",
      "view_image",
      "apply_patch",
      "load_skill",
      "request_human_input",
    ]) {
      expect(
        runtime.search({ query: name.replaceAll("_", " ") }).map((candidate) => candidate.name),
      ).not.toContain(name);
    }
    expect(
      runtime.search({ query: "interact with browser" }).map((candidate) => candidate.name),
    ).toEqual(["interaction__browser_act"]);
  });

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

    const internalCall = result.rawResponses[1]!.output.find(
      (item) => item.type === "function_call" && item.name === WEATHER_TOOL,
    ) as Record<string, unknown>;
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
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
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
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
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

  test("resumes an approved deferred dispatcher call with a fresh agent runtime", async () => {
    let firstPreparationSettled = false;
    let releaseFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => {
      releaseFirstPreparation = () => {
        firstPreparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const firstAgent = agentWith(
      weatherTool({
        needsApproval: () => true,
        execute: () => {
          executions += 1;
          return "first-runtime-must-not-execute";
        },
      }),
    );
    const firstLoader = firstAgent.getAllTools.bind(firstAgent);
    firstAgent.getAllTools = async (runContext) =>
      firstPreparationSettled ? await firstLoader(runContext) : [];
    const firstRuntime = installLazyToolRuntime(
      firstAgent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      firstPreparation,
      new Set([SERVER_ID]),
    );
    const firstModel = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "fresh-runtime-approval",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Tromso" } }),
        },
      ],
    ]);
    const firstRunPromise = runStreamed(firstAgent, firstModel, firstRuntime);
    await Bun.sleep(0);
    releaseFirstPreparation();
    const interrupted = await firstRunPromise;
    expect(interrupted.interruptions).toHaveLength(1);
    expect(executions).toBe(0);

    const resumedAgent = agentWith(
      weatherTool({
        needsApproval: () => true,
        execute: ({ city }) => {
          executions += 1;
          return `fresh-runtime:${city}`;
        },
      }),
    );
    let resumedPreparationSettled = false;
    let releaseResumedPreparation!: () => void;
    const resumedPreparation = new Promise<void>((resolve) => {
      releaseResumedPreparation = () => {
        resumedPreparationSettled = true;
        resolve();
      };
    });
    const resumedLoader = resumedAgent.getAllTools.bind(resumedAgent);
    resumedAgent.getAllTools = async (runContext) =>
      resumedPreparationSettled ? await resumedLoader(runContext) : [];
    const resumedRuntime = installLazyToolRuntime(
      resumedAgent,
      "generic_dispatch",
      new Set([SERVER_ID]),
      resumedPreparation,
      new Set([SERVER_ID]),
    );
    const resumedStatePromise = restoreInterruptedRunState(
      resumedAgent,
      interrupted.state.toString(),
    );
    await Bun.sleep(0);
    releaseResumedPreparation();
    const resumedState = await resumedStatePromise;
    const [approval] = resumedState.getInterruptions();
    expect(approval).toBeDefined();
    resumedState.approve(approval!);
    const resumedModel = new ScriptedStreamingModel([[finalMessage("fresh-runtime-done")]]);
    const resumedPromise = new Runner({
      modelProvider: new LazyToolModelProvider(providerFor(resumedModel), resumedRuntime),
    }).run(resumedAgent, resumedState, {
      stream: true,
      historyOwnership: "external",
      maxTurns: 8,
      toolNotFoundBehavior: "return_error_to_model",
      resolveMissingFunctionTool: createResolveMissingFunctionTool(resumedRuntime),
    });
    const resumed = await resumedPromise;
    for await (const _event of resumed.toStream()) void _event;
    await resumed.completed;

    expect(resumed.finalOutput).toBe("fresh-runtime-done");
    expect(executions).toBe(1);
    expect(JSON.stringify(resumedModel.requests[0]!.input)).not.toContain(
      "opengeni:lazy-dispatch:register:",
    );
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

  test("strips leftover internal late-registration items from provider replay", () => {
    const input = [
      {
        type: "tool_search_call",
        callId: "opengeni:lazy-dispatch:register:call-1",
        execution: "client",
        status: "completed",
        arguments: { name: WEATHER_TOOL },
      },
      {
        type: "tool_search_output",
        callId: "opengeni:lazy-dispatch:register:call-1",
        execution: "client",
        status: "completed",
        tools: [{ type: "function", name: WEATHER_TOOL }],
      },
      {
        type: "function_call",
        callId: "call-1",
        name: WEATHER_TOOL,
        arguments: JSON.stringify({ city: "Rome" }),
        providerData: {
          "opengeni.lazy_dispatch.v1": {
            version: 1,
            arguments: JSON.stringify({ name: WEATHER_TOOL, arguments: { city: "Rome" } }),
          },
        },
      },
    ] as ModelRequest["input"];
    const restored = restoreGenericDispatchHistory(input) as Array<Record<string, unknown>>;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      type: "function_call",
      callId: "call-1",
      name: "tool_invoke",
    });
    expect(JSON.stringify(restored)).not.toContain("opengeni:lazy-dispatch:register:");
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

  test("preserves large generic search schemas across ordinary output truncation", async () => {
    const tools = Array.from({ length: 8 }, (_, index) =>
      tool({
        name: `${SERVER_ID}__weather_${index}`,
        description: `weather capability ${index} ${"x".repeat(50_000)}`,
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
    const fakeAgent = {
      async getAllTools() {
        return tools;
      },
    };
    const runtime = installLazyToolRuntime(fakeAgent, "generic_dispatch", new Set([SERVER_ID]));
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
    expect(Buffer.byteLength(String(output))).toBeGreaterThan(48_000);
    expect(Buffer.byteLength(String(output))).toBeLessThanOrEqual(
      MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES,
    );

    const item = { type: "function_call_result", callId: "search-1", output };
    const truncated = boundModelToolOutputItem(item, 10_000) as typeof item;
    expect(truncated.output).not.toBe(output);
    expect(String(truncated.output)).toContain("tokens truncated");

    const args = JSON.stringify({ query: "weather capability", limit: 20 });
    const marked = transformGenericDispatchResponse(
      {
        usage: new Usage(),
        output: [
          {
            type: "function_call",
            callId: "search-1",
            name: "tool_search",
            arguments: args,
          },
        ],
      },
      runtime,
    ).output[0]!;
    const inner = new CapturingModel();
    const wrapped = await new LazyToolModelProvider(providerFor(inner), runtime).getModel("test");
    const visible = await fakeAgent.getAllTools(undefined);
    await wrapped.getResponse({
      ...baseRequest(visible.map(serializedFunction)),
      input: [marked, truncated] as ModelRequest["input"],
    });

    const providerInput = inner.requests[0]!.input as Array<Record<string, unknown>>;
    const providerCall = providerInput.find((candidate) => candidate.type === "function_call");
    const providerResult = providerInput.find(
      (candidate) => candidate.type === "function_call_result",
    );
    expect(providerCall?.providerData).toBeUndefined();
    expect(providerResult?.output).toBe(output);
    expect(() => JSON.parse(String(providerResult?.output))).not.toThrow();
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

  test("does not install an internal hosted registration search", () => {
    const runtime = installLazyToolRuntime(
      {
        async getAllTools() {
          return [] as Tool[];
        },
      },
      "generic_dispatch",
      new Set(),
    );
    const unrelatedSearch = toolSearchTool({
      execution: "client",
      description: "Application-owned client tool search",
      execute: async () => [],
    }) as unknown as Tool;

    expect(runtime.controlTools.every((candidate) => candidate.type !== "hosted_tool")).toBe(true);
    expect(
      runtime.shouldHideSerializedTool({
        type: "hosted_tool",
        name: "tool_search",
        providerData: {
          type: "tool_search",
          "opengeni.internal_lazy_registration.v1": true,
        },
      }),
    ).toBe(true);
    expect(runtime.shouldHideSerializedTool(serializedFunction(unrelatedSearch))).toBe(false);
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
  test("plain model output never waits for non-eager MCP preparation", async () => {
    for (const transport of ["openai_native", "generic_dispatch"] as const) {
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      const model = new CapturingModel();
      const agent = agentWith(weatherTool());
      const runtime = installLazyToolRuntime(
        agent,
        transport,
        new Set([SERVER_ID]),
        preparation,
        new Set([SERVER_ID]),
      );
      const result = new Runner({
        modelProvider: new LazyToolModelProvider(providerFor(model), runtime),
      }).run(agent, "Say hello without tools", { maxTurns: 2 });
      const outcome = await Promise.race([
        result.then(() => "completed" as const),
        Bun.sleep(500).then(() => "timed_out" as const),
      ]);
      releasePreparation();
      expect(outcome).toBe("completed");
      await result;
      expect(model.requests).toHaveLength(1);
    }
  });

  test("survives the real SandboxAgent clone path", async () => {
    const agent = new SandboxAgent({
      name: "sandbox-lazy-test",
      model: "gpt-5.6-sol",
      tools: [weatherTool()],
    } as never);
    installLazyToolRuntime(agent as never, "codex_native", new Set([SERVER_ID]));

    const cloned = (agent as unknown as { clone: (config: unknown) => Agent<any, any> }).clone({});
    const tools = await cloned.getAllTools(undefined as never);

    expect(tools.map((candidate) => candidate.name)).toEqual([WEATHER_TOOL, "tool_search"]);
  });

  test("hides first-party Browser/Computer schemas behind native search", async () => {
    for (const transport of ["codex_native", "openai_native"] as const) {
      const screenshot = firstPartyTool(
        "computer_screenshot",
        "Capture the current desktop and return it as an image",
      );
      const browser = firstPartyTool(
        "interaction__browser_act",
        "Click, type, and interact with the current browser page",
      );
      const exec = firstPartyTool("exec_command", "Run a shell command in the sandbox");
      const agent = new Agent({
        name: "lazy-test",
        instructions: "Use tools.",
        model: "scripted",
        tools: [screenshot, browser, exec],
      });
      const runtime = installLazyToolRuntime(agent, transport, new Set());
      const visible = await agent.getAllTools(undefined as never);
      const inner = new CapturingModel();
      const wrapped = await new LazyToolModelProvider(providerFor(inner), runtime).getModel("test");

      await wrapped.getResponse(baseRequest(visible.map(serializedFunction)));

      expect(inner.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
        "exec_command",
        "tool_search",
      ]);
      expect(
        runtime.search({ query: "screenshot the desktop" }).map((candidate) => candidate.name),
      ).toContain("computer_screenshot");
      expect(
        runtime.search({ query: "interact with browser" }).map((candidate) => candidate.name),
      ).toContain("interaction__browser_act");
      expect(
        runtime.search({ query: "run a shell command" }).map((candidate) => candidate.name),
      ).not.toContain("exec_command");
    }
  });

  test("hides image and video adapter schemas behind search on every transport", async () => {
    for (const transport of ["codex_native", "openai_native", "generic_dispatch"] as const) {
      const image = firstPartyTool("generate_image", "Generate or edit exactly one image");
      const video = firstPartyTool(
        "generate_video",
        "Start one durable asynchronous video generation",
      );
      const capabilities = firstPartyTool(
        "get_video_generation_capabilities",
        "Return the video-generation models currently enabled",
      );
      const exec = firstPartyTool("exec_command", "Run a shell command in the sandbox");
      const agent = new Agent({
        name: "lazy-test",
        instructions: "Use tools.",
        model: "scripted",
        tools: [image, video, capabilities, exec],
      });
      const runtime = installLazyToolRuntime(agent, transport, new Set());
      const visible = await agent.getAllTools(undefined as never);
      const inner = new CapturingModel();
      const wrapped = await new LazyToolModelProvider(providerFor(inner), runtime).getModel("test");

      await wrapped.getResponse(baseRequest(visible.map(serializedFunction)));

      expect(inner.requests[0]!.tools.map((candidate) => candidate.name)).toEqual(
        transport === "generic_dispatch"
          ? ["exec_command", "tool_search", "tool_invoke"]
          : ["exec_command", "tool_search"],
      );
      expect(
        runtime.search({ query: "generate an image" }).map((candidate) => candidate.name),
      ).toContain("generate_image");
      expect(
        runtime.search({ query: "generate a video" }).map((candidate) => candidate.name),
      ).toContain("generate_video");
      expect(
        runtime
          .search({ query: "video generation capabilities" })
          .map((candidate) => candidate.name),
      ).toContain("get_video_generation_capabilities");
      expect(
        runtime.search({ query: "run a shell command" }).map((candidate) => candidate.name),
      ).not.toContain("exec_command");
    }
  });

  test("keeps needsApproval on a disclosed first-party tool after native search", async () => {
    let executions = 0;
    const interactionTool = tool({
      name: "interaction__interaction_request_human",
      description: "Request a human decision in the current Browser or Computer surface",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
        additionalProperties: false,
      },
      strict: false,
      needsApproval: () => true,
      execute: ({ prompt }) => {
        executions += 1;
        return `asked:${prompt}`;
      },
    }) as unknown as Tool;
    const agent = agentWith(interactionTool);
    const runtime = installLazyToolRuntime(agent, "openai_native", new Set());
    const model = new ScriptedStreamingModel([
      [
        {
          type: "tool_search_call",
          call_id: "search-interaction",
          execution: "client",
          status: "completed",
          arguments: { query: "request a human decision" },
        },
      ],
      [
        {
          type: "function_call",
          callId: "interaction-call",
          name: "interaction__interaction_request_human",
          arguments: JSON.stringify({ prompt: "continue?" }),
        },
      ],
      [finalMessage("done")],
    ]);
    const first = await new Runner({
      modelProvider: new LazyToolModelProvider(providerFor(model), runtime),
    }).run(agent, "Ask the human", {
      stream: true,
      historyOwnership: "external",
      maxTurns: 8,
      toolNotFoundBehavior: "return_error_to_model",
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
    });
    for await (const _event of first.toStream()) void _event;
    await first.completed;

    expect(executions).toBe(0);
    expect(first.interruptions).toHaveLength(1);
    expect(first.interruptions[0]!.rawItem).toMatchObject({
      type: "function_call",
      name: "interaction__interaction_request_human",
    });
  });

  test("starts the first model request before deferred tools settle, then searches and executes them", async () => {
    let releasePreparation!: () => void;
    let preparationSettled = false;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = () => {
        preparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const deferredTool = weatherTool({
      execute: ({ city }) => {
        executions += 1;
        return `clear:${city}`;
      },
    });
    const requiredServerId = "required_tools";
    const requiredTool = tool({
      name: `${requiredServerId}__status`,
      description: "Read required weather service status",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: () => "ready",
    }) as unknown as Tool;
    const agent = new Agent({
      name: "lazy-test",
      instructions: "Use tools.",
      model: "scripted",
      tools: [requiredTool, deferredTool],
    });
    const baseGetAllTools = agent.getAllTools.bind(agent);
    agent.getAllTools = async (runContext) =>
      preparationSettled ? await baseGetAllTools(runContext) : [requiredTool];
    const runtime = installLazyToolRuntime(
      agent,
      "openai_native",
      new Set([requiredServerId, SERVER_ID]),
      preparation,
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "tool_search_call",
          call_id: "deferred-search",
          execution: "client",
          status: "completed",
          arguments: { query: "weather in a city" },
        },
      ],
      [
        {
          type: "function_call",
          callId: "deferred-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo" }),
        },
      ],
      [finalMessage("done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    await Bun.sleep(0);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual([
      `${requiredServerId}__status`,
      "tool_search",
    ]);
    expect(executions).toBe(0);

    releasePreparation();
    const result = await running;

    expect(result.finalOutput).toBe("done");
    expect(executions).toBe(1);
    expect(JSON.stringify(model.requests[1]!.input)).toContain(WEATHER_TOOL);
    expect(JSON.stringify(model.requests[1]!.input)).not.toContain(`${requiredServerId}__status`);
    expect(
      (await agent.getAllTools(undefined as never)).map((candidate) => candidate.name),
    ).toEqual([`${requiredServerId}__status`, "tool_search"]);
  });

  test("keeps the callback tool pool unique across multiple searches in one response", async () => {
    const deferredTool = weatherTool();
    (deferredTool as { deferLoading?: boolean }).deferLoading = true;
    const matchingCounts: number[] = [];
    const searchTool = toolSearchTool({
      execution: "client",
      description: "Search available tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async ({ availableTools }) => {
        const matches = availableTools.filter(
          (candidate) => candidate.type === "function" && candidate.name === WEATHER_TOOL,
        );
        matchingCounts.push(matches.length);
        return matches;
      },
    });
    const agent = new Agent({
      name: "same-response-tool-search-test",
      instructions: "Search for tools.",
      model: "scripted",
      tools: [deferredTool, searchTool],
    });
    const model = new ScriptedStreamingModel([
      [
        {
          type: "tool_search_call",
          call_id: "search-one",
          execution: "client",
          status: "completed",
          arguments: { query: "weather" },
        },
        {
          type: "tool_search_call",
          call_id: "search-two",
          execution: "client",
          status: "completed",
          arguments: { query: "weather" },
        },
      ],
      [finalMessage("done")],
    ]);
    const result = await new Runner({ modelProvider: providerFor(model) }).run(
      agent,
      "Find weather tools twice.",
      {
        stream: true,
        historyOwnership: "external",
        maxTurns: 4,
      },
    );
    for await (const _event of result.toStream()) void _event;
    await result.completed;

    expect(result.finalOutput).toBe("done");
    expect(matchingCounts).toEqual([1, 1]);
    const disclosedHistory = JSON.stringify(model.requests[1]!.input);
    expect(disclosedHistory.match(/tool_search_output/g)).toHaveLength(2);
  });

  test("replaces a callback-created tool by routed identity within one response", async () => {
    const dynamicName = "dynamic__lookup";
    const firstDefinition = tool({
      name: dynamicName,
      description: "First definition",
      parameters: {
        type: "object",
        properties: { old_query: { type: "string" } },
        required: ["old_query"],
        additionalProperties: false,
      },
      strict: false,
      execute: () => "unused",
    }) as unknown as Tool;
    const currentDefinition = tool({
      name: dynamicName,
      description: "Current definition",
      parameters: {
        type: "object",
        properties: { current_query: { type: "string" } },
        required: ["current_query"],
        additionalProperties: false,
      },
      strict: false,
      execute: () => "unused",
    }) as unknown as Tool;
    const observedDefinitions: string[][] = [];
    const searchTool = toolSearchTool({
      execution: "client",
      description: "Search dynamic tools",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async ({ availableTools, toolCall }) => {
        const query = (toolCall.arguments as { query?: string }).query;
        observedDefinitions.push(
          availableTools
            .filter((candidate) => candidate.type === "function" && candidate.name === dynamicName)
            .map((candidate) => candidate.description),
        );
        if (query === "first") return [firstDefinition];
        if (query === "replace") return [currentDefinition];
        return availableTools.filter(
          (candidate) => candidate.type === "function" && candidate.name === dynamicName,
        );
      },
    });
    const agent = new Agent({
      name: "same-response-tool-replacement-test",
      instructions: "Search for dynamic tools.",
      model: "scripted",
      tools: [searchTool],
    });
    const model = new ScriptedStreamingModel([
      [
        {
          type: "tool_search_call",
          call_id: "dynamic-first",
          execution: "client",
          status: "completed",
          arguments: { query: "first" },
        },
        {
          type: "tool_search_call",
          call_id: "dynamic-replace",
          execution: "client",
          status: "completed",
          arguments: { query: "replace" },
        },
        {
          type: "tool_search_call",
          call_id: "dynamic-current",
          execution: "client",
          status: "completed",
          arguments: { query: "current" },
        },
      ],
      [finalMessage("done")],
    ]);
    const result = await new Runner({ modelProvider: providerFor(model) }).run(
      agent,
      "Refresh the dynamic tool.",
      {
        stream: true,
        historyOwnership: "external",
        maxTurns: 4,
      },
    );
    for await (const _event of result.toStream()) void _event;
    await result.completed;

    expect(result.finalOutput).toBe("done");
    expect(observedDefinitions).toEqual([[], ["First definition"], ["Current definition"]]);
  });

  test("rebinds historical disclosure to today's same-identity tool definition", async () => {
    let executedInput: { city: string; units: string } | undefined;
    const currentTool = tool({
      name: WEATHER_TOOL,
      description: "Look up weather using the current units-aware schema",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          units: { type: "string" },
        },
        required: ["city", "units"],
        additionalProperties: false,
      },
      strict: false,
      execute: (input) => {
        executedInput = input as { city: string; units: string };
        return `${executedInput.city}:${executedInput.units}`;
      },
    }) as unknown as Tool;
    (currentTool as { deferLoading?: boolean }).deferLoading = true;
    const searchTool = toolSearchTool({
      execution: "client",
      execute: async () => [currentTool],
    });
    const agent = new Agent({
      name: "historical-tool-refresh-test",
      instructions: "Use current tools.",
      model: "scripted",
      tools: [currentTool, searchTool],
    });
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "current-weather-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Oslo", units: "metric" }),
        },
      ],
      [finalMessage("current-definition-used")],
    ]);
    const historicalInput = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Old weather request" }],
      },
      {
        type: "tool_search_call",
        call_id: "old-weather-search",
        execution: "client",
        status: "completed",
        arguments: { query: "weather" },
      },
      {
        type: "tool_search_output",
        call_id: "old-weather-search",
        execution: "client",
        status: "completed",
        tools: [
          {
            type: "function",
            name: WEATHER_TOOL,
            description: "Old city-only weather schema",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use metric units now" }],
      },
    ];
    const result = await new Runner({ modelProvider: providerFor(model) }).run(
      agent,
      historicalInput as never,
      {
        stream: true,
        historyOwnership: "external",
        maxTurns: 4,
      },
    );
    for await (const _event of result.toStream()) void _event;
    await result.completed;

    expect(result.finalOutput).toBe("current-definition-used");
    expect(executedInput).toEqual({ city: "Oslo", units: "metric" });
  });

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

  test("binds a remembered native name after the preparation fence settles", async () => {
    let releasePreparation!: () => void;
    let preparationSettled = false;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = () => {
        preparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const realTool = weatherTool({
      execute: ({ city }) => {
        executions += 1;
        return `fenced:${city}`;
      },
    });
    const agent = agentWith(realTool);
    const baseGetAllTools = agent.getAllTools.bind(agent);
    agent.getAllTools = async (runContext) =>
      preparationSettled ? await baseGetAllTools(runContext) : [];
    const runtime = installLazyToolRuntime(
      agent,
      "openai_native",
      new Set([SERVER_ID]),
      preparation,
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "fenced-native-call",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Bergen" }),
        },
      ],
      [finalMessage("fenced-done")],
    ]);

    const running = runStreamed(agent, model, runtime);
    await Bun.sleep(0);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools.map((candidate) => candidate.name)).toEqual(["tool_search"]);
    expect(executions).toBe(0);

    releasePreparation();
    const result = await running;
    expect(result.finalOutput).toBe("fenced-done");
    expect(executions).toBe(1);
    expect(JSON.stringify(model.requests[1]!.input)).not.toContain("not found");
  });

  test("resolves a qualified remembered name to the same catalog tool", async () => {
    const agent = agentWith(weatherTool());
    const runtime = installLazyToolRuntime(
      agent,
      "openai_native",
      new Set([SERVER_ID]),
      Promise.resolve(),
      new Set([SERVER_ID]),
    );
    await agent.getAllTools(undefined as never);
    const resolved = await runtime.resolveAuthorizedFunctionTool(`mcp.${WEATHER_TOOL}`);
    expect(resolved?.name).toBe(WEATHER_TOOL);
  });

  test("returns a typed model-visible error for a revoked native name", async () => {
    const agent = agentWith(weatherTool());
    const runtime = installLazyToolRuntime(
      agent,
      "openai_native",
      new Set([SERVER_ID]),
      Promise.resolve(),
      new Set([SERVER_ID]),
    );
    const model = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "revoked-native-call",
          name: `${SERVER_ID}__removed`,
          arguments: JSON.stringify({}),
        },
      ],
      [finalMessage("recovered")],
    ]);

    const result = await runStreamed(agent, model, runtime);
    expect(result.finalOutput).toBe("recovered");
    const followUp = JSON.stringify(model.requests[1]!.input);
    expect(followUp).toContain(`${SERVER_ID}__removed`);
    expect(followUp.toLowerCase()).toContain("not found");
  });

  test("resumes a native pending-approval call after the catalog is ready", async () => {
    let firstPreparationSettled = false;
    let releaseFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => {
      releaseFirstPreparation = () => {
        firstPreparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const firstAgent = agentWith(
      weatherTool({
        needsApproval: () => true,
        execute: () => {
          executions += 1;
          return "first-runtime-must-not-execute";
        },
      }),
    );
    const firstLoader = firstAgent.getAllTools.bind(firstAgent);
    firstAgent.getAllTools = async (runContext) =>
      firstPreparationSettled ? await firstLoader(runContext) : [];
    const firstRuntime = installLazyToolRuntime(
      firstAgent,
      "openai_native",
      new Set([SERVER_ID]),
      firstPreparation,
      new Set([SERVER_ID]),
    );
    const firstModel = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "native-approval",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Tromso" }),
        },
      ],
    ]);
    const firstRunPromise = runStreamed(firstAgent, firstModel, firstRuntime);
    await Bun.sleep(0);
    releaseFirstPreparation();
    const interrupted = await firstRunPromise;
    expect(interrupted.interruptions).toHaveLength(1);
    expect(executions).toBe(0);

    const resumedAgent = agentWith(
      weatherTool({
        needsApproval: () => true,
        execute: ({ city }) => {
          executions += 1;
          return `native-fresh:${city}`;
        },
      }),
    );
    let resumedPreparationSettled = false;
    let releaseResumedPreparation!: () => void;
    const resumedPreparation = new Promise<void>((resolve) => {
      releaseResumedPreparation = () => {
        resumedPreparationSettled = true;
        resolve();
      };
    });
    const resumedLoader = resumedAgent.getAllTools.bind(resumedAgent);
    resumedAgent.getAllTools = async (runContext) =>
      resumedPreparationSettled ? await resumedLoader(runContext) : [];
    const resumedRuntime = installLazyToolRuntime(
      resumedAgent,
      "openai_native",
      new Set([SERVER_ID]),
      resumedPreparation,
      new Set([SERVER_ID]),
    );
    const resumedStatePromise = restoreInterruptedRunState(
      resumedAgent,
      interrupted.state.toString(),
    );
    await Bun.sleep(0);
    releaseResumedPreparation();
    const resumedState = await resumedStatePromise;
    const [approval] = resumedState.getInterruptions();
    expect(approval).toBeDefined();
    resumedState.approve(approval!);
    const resumedModel = new ScriptedStreamingModel([[finalMessage("native-fresh-done")]]);
    const resumed = await new Runner({
      modelProvider: new LazyToolModelProvider(providerFor(resumedModel), resumedRuntime),
    }).run(resumedAgent, resumedState, {
      stream: true,
      historyOwnership: "external",
      maxTurns: 8,
      toolNotFoundBehavior: "return_error_to_model",
      resolveMissingFunctionTool: createResolveMissingFunctionTool(resumedRuntime),
    });
    for await (const _event of resumed.toStream()) void _event;
    await resumed.completed;

    expect(resumed.finalOutput).toBe("native-fresh-done");
    expect(executions).toBe(1);
  });

  test("resumes a SandboxAgent pending-approval call whose tool is off agent.tools", async () => {
    let firstPreparationSettled = false;
    let releaseFirstPreparation!: () => void;
    const firstPreparation = new Promise<void>((resolve) => {
      releaseFirstPreparation = () => {
        firstPreparationSettled = true;
        resolve();
      };
    });
    let executions = 0;
    const firstAgent = agentWith(
      weatherTool({
        needsApproval: () => true,
        execute: () => {
          executions += 1;
          return "first-runtime-must-not-execute";
        },
      }),
    );
    const firstLoader = firstAgent.getAllTools.bind(firstAgent);
    firstAgent.getAllTools = async (runContext) =>
      firstPreparationSettled ? await firstLoader(runContext) : [];
    const firstRuntime = installLazyToolRuntime(
      firstAgent,
      "openai_native",
      new Set([SERVER_ID]),
      firstPreparation,
      new Set([SERVER_ID]),
    );
    const firstModel = new ScriptedStreamingModel([
      [
        {
          type: "function_call",
          callId: "sandbox-native-approval",
          name: WEATHER_TOOL,
          arguments: JSON.stringify({ city: "Tromso" }),
        },
      ],
    ]);
    const firstRunPromise = runStreamed(firstAgent, firstModel, firstRuntime);
    await Bun.sleep(0);
    releaseFirstPreparation();
    const interrupted = await firstRunPromise;
    expect(interrupted.interruptions).toHaveLength(1);
    expect(executions).toBe(0);

    const resumedAgent = sandboxAgentWithCatalogTool(
      weatherTool({
        needsApproval: () => true,
        execute: ({ city }) => {
          executions += 1;
          return `sandbox-fresh:${city}`;
        },
      }),
    );
    let resumedPreparationSettled = false;
    let releaseResumedPreparation!: () => void;
    const resumedPreparation = new Promise<void>((resolve) => {
      releaseResumedPreparation = () => {
        resumedPreparationSettled = true;
        resolve();
      };
    });
    const resumedLoader = resumedAgent.getAllTools.bind(resumedAgent);
    resumedAgent.getAllTools = async (runContext) =>
      resumedPreparationSettled ? await resumedLoader(runContext) : [];
    installLazyToolRuntime(
      resumedAgent,
      "openai_native",
      new Set([SERVER_ID]),
      resumedPreparation,
      new Set([SERVER_ID]),
    );
    const resumedStatePromise = restoreInterruptedRunState(
      resumedAgent,
      interrupted.state.toString(),
    );
    await Bun.sleep(0);
    releaseResumedPreparation();
    const resumedState = await resumedStatePromise;
    const resumedInternals = resumedState as unknown as {
      _context: unknown;
      _lastProcessedResponse: {
        functions: Array<{
          tool: { invoke: (runContext: unknown, input: string) => Promise<unknown> };
        }>;
      };
    };
    const bound = resumedInternals._lastProcessedResponse.functions[0]?.tool;
    expect(bound).toBeDefined();
    await expect(
      bound!.invoke(resumedInternals._context, JSON.stringify({ city: "Tromso" })),
    ).resolves.toBe("sandbox-fresh:Tromso");
    expect(executions).toBe(1);
  });
});
