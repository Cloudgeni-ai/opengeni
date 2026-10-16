import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  tool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
  type Tool,
} from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { z } from "zod";
import {
  LazyToolModelProvider,
  createResolveMissingFunctionTool,
  expandInteractionFamilyDisclosures,
  installLazyToolRuntime,
  restoreGenericDispatchHistoryItems,
} from "../src/lazy-tool-transport";
import { baseModelInputFilterForSettings } from "../src/model-input";
import { interactionToolInputJsonSchema } from "../src/interaction-tool-json-schema";

const OPEN = "interaction__browser_open";
const OBSERVE = "interaction__browser_observe";
const ACT = "interaction__browser_act";
const MARKER = "opengeni.family_disclosure.v1";

function interactionTool(name: string, executions: string[]): Tool {
  return tool({
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: { browserSessionId: { type: "string" } },
      additionalProperties: false,
    },
    strict: false,
    execute: () => {
      executions.push(name);
      return JSON.stringify({ ok: true, tool: name });
    },
  }) as unknown as Tool;
}

function responseDone(id: string, output: ModelResponse["output"]): StreamEvent {
  return {
    type: "response_done",
    response: { id, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output },
  } as StreamEvent;
}

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly outputs: ModelResponse["output"][]) {}
  async getResponse(): Promise<ModelResponse> {
    throw new Error("streaming only");
  }
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const { signal: _signal, ...rest } = request;
    this.requests.push({
      ...rest,
      input: structuredClone(request.input),
      tools: structuredClone(request.tools),
    } as ModelRequest);
    const output = this.outputs[this.requests.length - 1];
    if (!output) throw new Error("script exhausted");
    yield responseDone(`response-${this.requests.length}`, output);
  }
}

function call(callId: string, name: string): ModelResponse["output"][number] {
  return { type: "function_call", callId, name, arguments: "{}", status: "completed" };
}

const done: ModelResponse["output"][number] = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "done" }],
};

async function runBrowserTask(transport: "codex_native" | "openai_native" | "generic_dispatch") {
  const executions: string[] = [];
  const agent = new Agent({
    name: "family-test",
    instructions: "Use tools.",
    model: "scripted",
    tools: [
      interactionTool(OPEN, executions),
      interactionTool(OBSERVE, executions),
      interactionTool(ACT, executions),
      interactionTool("connected__weather_lookup", executions),
    ],
  });
  const runtime = installLazyToolRuntime(agent, transport, new Set());
  const act =
    transport === "generic_dispatch"
      ? {
          type: "function_call" as const,
          callId: "act-1",
          name: "tool_invoke",
          arguments: JSON.stringify({ name: ACT, arguments: {} }),
          status: "completed" as const,
        }
      : call("act-1", ACT);
  const model = new ScriptedModel([[call("open-1", OPEN)], [act], [done]]);
  const runner = new Runner({
    modelProvider: new LazyToolModelProvider(
      { getModel: () => model } satisfies ModelProvider,
      runtime,
    ),
  });
  const result = await runner.run(agent, "Open the page and click submit", {
    stream: true,
    historyOwnership: "external",
    maxTurns: 6,
    toolNotFoundBehavior: "return_error_to_model",
    resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
    callModelInputFilter: baseModelInputFilterForSettings(testSettings({ sandboxBackend: "none" })),
  });
  for await (const _event of result.toStream()) void _event;
  await result.completed;
  return { model, executions };
}

function itemTypes(input: ModelRequest["input"]): string[] {
  return (input as Array<Record<string, unknown>>).map((item) =>
    item.type === "function_call" || item.type === "function_call_result"
      ? `${String(item.type)}:${String(item.name)}`
      : String(item.type ?? item.role),
  );
}

describe("interaction family disclosure", () => {
  test.each(["codex_native", "openai_native"] as const)(
    "%s: browser_open is visible and its result discloses the family without a search",
    async (transport) => {
      const { model, executions } = await runBrowserTask(transport);
      const firstTools = model.requests[0]!.tools.map((candidate) => candidate.name);
      expect(firstTools).toContain(OPEN);
      expect(firstTools).not.toContain(ACT);
      expect(firstTools).not.toContain(OBSERVE);

      expect(executions).toEqual([OPEN, ACT]);
      const second = model.requests[1]!.input as Array<Record<string, unknown>>;
      expect(itemTypes(second).slice(-4)).toEqual([
        `function_call:${OPEN}`,
        `function_call_result:${OPEN}`,
        "tool_search_call",
        "tool_search_output",
      ]);
      const output = second.at(-1)!;
      expect((output.tools as Array<{ name: string }>).map((entry) => entry.name)).toEqual([
        OBSERVE,
        ACT,
      ]);
      expect(output.execution).toBe("client");
      expect(second.at(-2)!.call_id).toBe(output.call_id);

      // Later requests reproduce the identical prefix, and the marker never
      // reaches the provider.
      const third = model.requests[2]!.input;
      expect(JSON.stringify((third as unknown[]).slice(0, second.length))).toBe(
        JSON.stringify(second),
      );
      for (const request of model.requests) {
        expect(JSON.stringify(request.input)).not.toContain(MARKER);
      }
    },
  );

  test("generic dispatch: the disclosure is a tool_search call the model can invoke from", async () => {
    const { model, executions } = await runBrowserTask("generic_dispatch");
    const firstTools = model.requests[0]!.tools.map((candidate) => candidate.name);
    expect(firstTools).toContain(OPEN);
    expect(firstTools).not.toContain(ACT);
    expect(executions).toEqual([OPEN, ACT]);
    const second = model.requests[1]!.input as Array<Record<string, unknown>>;
    expect(itemTypes(second).slice(-3)).toEqual([
      `function_call_result:${OPEN}`,
      "function_call:tool_search",
      "function_call_result:tool_search",
    ]);
    const disclosed = JSON.parse(String(second.at(-1)!.output)) as { tools: { name: string }[] };
    expect(disclosed.tools.map((entry) => entry.name)).toEqual([OBSERVE, ACT]);
    for (const request of model.requests) {
      expect(JSON.stringify(request.input)).not.toContain(MARKER);
    }
  });

  test("does not repeat tools the history already disclosed", () => {
    const marker = {
      version: 1,
      format: "native",
      tools: [
        { type: "function", name: OBSERVE, description: "", parameters: {} },
        { type: "function", name: ACT, description: "", parameters: {} },
      ],
    };
    const history = [
      { type: "tool_search_call", call_id: "s1", execution: "client", arguments: {} },
      {
        type: "tool_search_output",
        call_id: "s1",
        execution: "client",
        tools: [{ type: "function", name: ACT }],
      },
      { type: "function_call", callId: "o1", name: OPEN, providerData: { [MARKER]: marker } },
      { type: "function_call_result", callId: "o1", name: OPEN, output: "{}" },
      { type: "function_call", callId: "o2", name: OPEN, providerData: { [MARKER]: marker } },
      { type: "function_call_result", callId: "o2", name: OPEN, output: "{}" },
    ];
    const expanded = expandInteractionFamilyDisclosures(history) as Array<Record<string, unknown>>;
    const outputs = expanded.filter((item) => item.type === "tool_search_output");
    expect(outputs.length).toBe(2);
    expect((outputs[1]!.tools as Array<{ name: string }>).map((entry) => entry.name)).toEqual([
      OBSERVE,
    ]);
    // A second open of the same family discloses nothing new.
    expect(expanded.length).toBe(history.length + 2);
    // Expanding is pure and the marker is removed by the provider projection.
    expect(JSON.stringify(expandInteractionFamilyDisclosures(history))).toBe(
      JSON.stringify(expanded),
    );
    expect(JSON.stringify(restoreGenericDispatchHistoryItems(expanded))).not.toContain(MARKER);
  });

  test("a tagged union with two members for one tag shows one entry", () => {
    const schema = interactionToolInputJsonSchema(
      z.object({
        placement: z.union([
          z.object({ kind: z.literal("box"), boxId: z.string() }).strict(),
          z.object({ kind: z.literal("device"), deviceId: z.string() }).strict(),
          z.object({ kind: z.literal("device") }).strict(),
        ]),
      }),
    );
    const placement = (schema.properties as Record<string, { description: string }>).placement!;
    expect(placement.description).toBe(
      "Fields by kind (? = optional): box: boxId; device: deviceId?.",
    );
  });
});
