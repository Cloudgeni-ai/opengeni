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
import { anthropicMessages } from "../src/anthropic-messages";
import { baseModelInputFilterForSettings } from "../src/model-input";
import { interactionToolInputJsonSchema } from "../src/interaction-tool-json-schema";
import { projectHistoryForProvider, TOOL_DISCLOSURE_KEY } from "../src/provider-history-adapter";

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

async function runBrowserTask(
  transport: "codex_native" | "openai_native" | "generic_dispatch",
  directGenericCall = false,
) {
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
    transport === "generic_dispatch" && !directGenericCall
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

function disclosedNames(item: Record<string, unknown>): string[] {
  const disclosure = (item.providerData as Record<string, { tools: { name: string }[] }>)[
    TOOL_DISCLOSURE_KEY
  ]!;
  return disclosure.tools.map((entry) => entry.name);
}

describe("interaction family disclosure", () => {
  test.each(["codex_native", "openai_native"] as const)(
    "%s: browser_open's step is followed by one tool declaration, and the tools bind by name",
    async (transport) => {
      const { model, executions } = await runBrowserTask(transport);
      const firstTools = model.requests[0]!.tools.map((candidate) => candidate.name);
      expect(firstTools).toContain(OPEN);
      expect(firstTools).not.toContain(ACT);
      expect(firstTools).not.toContain(OBSERVE);

      expect(executions).toEqual([OPEN, ACT]);
      const second = model.requests[1]!.input as Array<Record<string, unknown>>;
      expect(itemTypes(second).slice(-3)).toEqual([
        `function_call:${OPEN}`,
        `function_call_result:${OPEN}`,
        "message",
      ]);
      const declaration = second.at(-1)!;
      expect(declaration.role).toBe("developer");
      expect(disclosedNames(declaration)).toEqual([OBSERVE, ACT]);
      // No search happened, so no search items appear.
      expect(itemTypes(second).filter((type) => type.includes("tool_search"))).toEqual([]);
      // Native transports have no tool_invoke router. Where a route needs the
      // text form, it asks the model to load the tools with native tool_search.
      expect(String(declaration.content)).toBe(
        `These tools are now available: ${OBSERVE}, ${ACT}. Load them with tool_search using names ${JSON.stringify([OBSERVE, ACT])}, then call them by name.`,
      );

      // A verified route sees the standard Responses form.
      const wire = projectHistoryForProvider(second, "responses", {
        declaresAdditionalTools: true,
      }).at(-1)!;
      expect(wire.type).toBe("unknown");
      expect((wire.providerData as Record<string, unknown>).type).toBe("additional_tools");
      // Any other Responses route gets the developer-message form.
      const fallback = projectHistoryForProvider(second, "responses").at(-1)!;
      expect(fallback.providerData).toEqual({
        type: "message",
        role: "developer",
        content: declaration.content,
      });

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

  test.each([false, true])(
    "generic dispatch: the declaration is not a search, and tools run via tool_invoke or by name (direct %p)",
    async (direct) => {
      const { model, executions } = await runBrowserTask("generic_dispatch", direct);
      const firstTools = model.requests[0]!.tools.map((candidate) => candidate.name);
      expect(firstTools).toContain(OPEN);
      expect(firstTools).not.toContain(ACT);
      expect(executions).toEqual([OPEN, ACT]);
      const second = model.requests[1]!.input as Array<Record<string, unknown>>;
      expect(itemTypes(second).slice(-2)).toEqual([`function_call_result:${OPEN}`, "message"]);
      expect(disclosedNames(second.at(-1)!)).toEqual([OBSERVE, ACT]);
      expect(String(second.at(-1)!.content)).toContain("through tool_invoke");
      expect(JSON.stringify(second)).not.toContain("tool_search");
      for (const request of model.requests) {
        expect(JSON.stringify(request.input)).not.toContain(MARKER);
      }
    },
  );

  test("does not repeat tools the history already disclosed", () => {
    const marker = {
      version: 1,
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
      { type: "message", role: "assistant", content: "opened" },
      { type: "function_call", callId: "o2", name: OPEN, providerData: { [MARKER]: marker } },
      { type: "function_call_result", callId: "o2", name: OPEN, output: "{}" },
    ];
    const expanded = expandInteractionFamilyDisclosures(history) as Array<Record<string, unknown>>;
    // One declaration, after the first open's step; the second open adds nothing new.
    expect(expanded.length).toBe(history.length + 1);
    expect(expanded[4]!.role).toBe("developer");
    expect(disclosedNames(expanded[4]!)).toEqual([OBSERVE]);
    // Expanding is pure and identity-stable, and the marker is removed by the projection.
    expect(expandInteractionFamilyDisclosures(history)[4]).toBe(expanded[4]);
    expect(JSON.stringify(restoreGenericDispatchHistoryItems(expanded))).not.toContain(MARKER);
  });

  test("an entry call inside a parallel step declares its tools after all of that step's results", () => {
    const marker = (name: string) => ({
      version: 1,
      tools: [{ type: "function", name, description: "", parameters: {} }],
    });
    const exec = (callId: string) => ({
      type: "function_call",
      callId,
      name: "exec_command",
      arguments: "{}",
      status: "completed",
    });
    const entry = (callId: string, name: string, disclosed: string) => ({
      type: "function_call",
      callId,
      name,
      arguments: "{}",
      status: "completed",
      providerData: { [MARKER]: marker(disclosed) },
    });
    const result = (callId: string, name: string) => ({
      type: "function_call_result",
      callId,
      name,
      status: "completed",
      output: { type: "text", text: callId },
    });
    const history = [
      { type: "message", role: "user", content: "check the page, the screen and the logs" },
      exec("toolu_01First"),
      entry("toolu_01Open", OPEN, OBSERVE),
      entry("toolu_01Computer", "interaction__computer_open", "interaction__computer_observe"),
      exec("toolu_01Fourth"),
      result("toolu_01First", "exec_command"),
      result("toolu_01Open", OPEN),
      result("toolu_01Computer", "interaction__computer_open"),
      result("toolu_01Fourth", "exec_command"),
    ];
    const expanded = restoreGenericDispatchHistoryItems(
      expandInteractionFamilyDisclosures(history),
    ) as Array<Record<string, unknown>>;
    // One declaration for both families, after the step's last result.
    expect(expanded).toHaveLength(history.length + 1);
    expect(expanded.slice(0, history.length)).toEqual(
      restoreGenericDispatchHistoryItems(history) as Array<Record<string, unknown>>,
    );
    expect(disclosedNames(expanded.at(-1)!)).toEqual([OBSERVE, "interaction__computer_observe"]);

    // Claude receives one uninterrupted results message, then the system declaration.
    const claude = anthropicMessages(
      projectHistoryForProvider(expanded, "anthropic-messages") as ModelRequest["input"],
    );
    expect(claude.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(
      claude[2]!.content.map((block) => (block as { tool_use_id?: string }).tool_use_id),
    ).toEqual(["toolu_01First", "toolu_01Open", "toolu_01Computer", "toolu_01Fourth"]);

    // Chat answers every call before the system declaration.
    const chat = projectHistoryForProvider(expanded, "chat");
    expect(chat.slice(0, -1)).toEqual(expanded.slice(0, -1));
    expect(chat.at(-1)!.role).toBe("system");

    // A later step leaves the declaration where it was.
    const next = [...history, { type: "message", role: "assistant", content: "done" }];
    const later = expandInteractionFamilyDisclosures(next) as Array<Record<string, unknown>>;
    expect(later.length).toBe(next.length + 1);
    expect(later[history.length]).toBe(expandInteractionFamilyDisclosures(history).at(-1));
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
