import { describe, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  tool,
  Usage,
  type MCPServer,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import { z } from "zod";
import { installRouteMoveOrdering, PrefixedMcpServer } from "../src/index";
import {
  createResolveMissingFunctionTool,
  installLazyToolRuntime,
  LazyToolModelProvider,
} from "../src/lazy-tool-transport";

class ScriptedModel implements Model {
  calls = 0;
  constructor(private outputs: ModelResponse["output"][]) {}
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    return {
      usage: new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      output: this.outputs[this.calls - 1]!,
    };
  }
  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error("not streamed");
  }
}

function call(callId: string, name: string, args: Record<string, unknown> = {}) {
  return {
    type: "function_call" as const,
    id: callId,
    callId,
    name,
    status: "completed" as const,
    arguments: JSON.stringify(args),
  };
}

function firstPartyServer(log: string[]): PrefixedMcpServer {
  const inner = {
    cacheToolsList: false,
    name: "opengeni",
    connect: async () => {},
    close: async () => {},
    listTools: async () =>
      ["sandbox_swap", "sandbox_attach", "sandboxes_list"].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    callTool: async (name: string) => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      log.push(`${name}:end`);
      return [{ type: "text", text: "{}" }];
    },
  } as unknown as MCPServer;
  return new PrefixedMcpServer(inner, "opengeni");
}

describe("route-moving tools", () => {
  test("only the first-party machine moves run in model order", async () => {
    const log: string[] = [];
    const server = firstPartyServer(log);
    const other = new PrefixedMcpServer(
      {
        cacheToolsList: false,
        name: "linear",
        connect: async () => {},
        close: async () => {},
        listTools: async () => [{ name: "sandbox_swap", inputSchema: { type: "object" } }],
        callTool: async () => [],
      } as unknown as MCPServer,
      "linear",
    );
    const agent = new Agent({ name: "Test", mcpServers: [server, other] });
    installRouteMoveOrdering(agent as never);
    const tools = await agent.getMcpTools(undefined as never);
    const exclusive = Object.fromEntries(
      tools.map((item) => [
        item.name,
        (item as { exclusiveExecution?: boolean }).exclusiveExecution,
      ]),
    );
    expect(exclusive).toEqual({
      opengeni__sandbox_swap: true,
      opengeni__sandbox_attach: true,
      opengeni__sandboxes_list: undefined,
      linear__sandbox_swap: undefined,
    });
    // Clones (the sandbox runtime resolves tools on one) keep the ordering.
    const cloned = agent.clone({});
    const clonedTools = await cloned.getMcpTools(undefined as never);
    expect(
      clonedTools.find((item) => item.name === "opengeni__sandbox_swap") as {
        exclusiveExecution?: boolean;
      },
    ).toMatchObject({ exclusiveExecution: true });
  });

  test("a call written after a swap in the same response starts once the swap is done", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("before", "computer_targets"),
        call("swap", "opengeni__sandbox_swap", { target: "machine" }),
        call("after", "computer_open"),
      ],
      [
        {
          type: "message",
          id: "done",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
    ]);
    const recorded = (name: string) =>
      tool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          log.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          log.push(`${name}:end`);
          return "ok";
        },
      });
    const agent = new Agent({
      name: "Test",
      model,
      tools: [recorded("computer_targets"), recorded("computer_open")],
      mcpServers: [firstPartyServer(log)],
    });
    installRouteMoveOrdering(agent as never);
    const result = await new Runner({ tracingDisabled: true }).run(agent, "Open the Mac screen");
    expect(result.finalOutput).toBe("Done.");
    expect(log).toEqual([
      "computer_targets:start",
      "computer_targets:end",
      "sandbox_swap:start",
      "sandbox_swap:end",
      "computer_open:start",
      "computer_open:end",
    ]);
  });

  test("a swap called through tool_invoke runs in the same model order", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("before", "computer_targets"),
        call("swap", "tool_invoke", {
          name: "opengeni__sandbox_swap",
          arguments: { target: "machine" },
        }),
        call("after", "computer_open"),
      ],
      [
        {
          type: "message",
          id: "done",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
    ]);
    const recorded = (name: string) =>
      tool({
        name,
        description: name,
        parameters: z.object({}),
        execute: async () => {
          log.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          log.push(`${name}:end`);
          return "ok";
        },
      });
    const agent = new Agent({
      name: "Test",
      model: "scripted",
      tools: [recorded("computer_targets"), recorded("computer_open")],
      mcpServers: [firstPartyServer(log)],
    });
    installRouteMoveOrdering(agent as never);
    const runtime = installLazyToolRuntime(agent as never, "generic_dispatch", new Set());
    const result = await new Runner({
      tracingDisabled: true,
      modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
    }).run(agent, "Open the Mac screen", {
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
    });
    expect(result.finalOutput).toBe("Done.");
    expect(log).toEqual([
      "computer_targets:start",
      "computer_targets:end",
      "sandbox_swap:start",
      "sandbox_swap:end",
      "computer_open:start",
      "computer_open:end",
    ]);
  });
});
