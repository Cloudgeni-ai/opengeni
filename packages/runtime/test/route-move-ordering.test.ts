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
import {
  callNamesConnectedMachine,
  installRouteMoveOrdering,
  PrefixedMcpServer,
} from "../src/index";
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

const DONE: ModelResponse["output"] = [
  {
    type: "message",
    id: "done",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done." }],
  },
];

function recordedTool(log: string[], name: string) {
  return tool({
    name,
    description: name,
    parameters: z.object({}),
    execute: async () => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      log.push(`${name}:end`);
      return "ok";
    },
  });
}

function firstPartyServer(log: string[]): PrefixedMcpServer {
  const inner = {
    cacheToolsList: false,
    name: "opengeni",
    connect: async () => {},
    close: async () => {},
    listTools: async () =>
      [
        "sandbox_swap",
        "sandbox_attach",
        "sandboxes_list",
        "computer_open",
        "browser_open",
        "computer_observe",
        "computer_act",
        "browser_observe",
        "browser_act",
      ].map((name) => ({
        name,
        inputSchema: { type: "object", properties: {} },
      })),
    callTool: async (name: string, args?: Record<string, unknown> | null) => {
      // Name the session (and tab) a call used, so concurrency is visible.
      const used = [args?.computerSessionId, args?.browserSessionId, args?.targetId]
        .filter((value) => typeof value === "string")
        .join("/");
      const label = used ? `${name}@${used}` : name;
      log.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      log.push(`${label}:end`);
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
      // The opens move the chat only when a call names a machine placement.
      opengeni__computer_open: callNamesConnectedMachine,
      opengeni__browser_open: callNamesConnectedMachine,
      opengeni__computer_observe: undefined,
      // Actions and reads are ordered per session by key, never globally.
      opengeni__computer_act: undefined,
      opengeni__browser_observe: undefined,
      opengeni__browser_act: undefined,
      linear__sandbox_swap: undefined,
    });
    const keys = (name: string, args: Record<string, unknown> = {}) =>
      (
        tools.find((item) => item.name === name) as {
          executionOrderKeys?: (call: { name: string; arguments: string }) => string[];
        }
      ).executionOrderKeys?.({ name, arguments: JSON.stringify(args) });
    expect(keys("opengeni__computer_act")).toEqual(["computer"]);
    expect(keys("opengeni__computer_observe", { computerSessionId: "a" })).toEqual(["computer:a"]);
    // An open without a session starts or finds its own: several run together.
    expect(keys("opengeni__computer_open")).toEqual([]);
    expect(keys("opengeni__computer_open", { computerSessionId: "a" })).toEqual(["computer:a"]);
    expect(keys("opengeni__browser_act", { browserSessionId: "b", targetId: "t" })).toEqual([
      "browser:b:t",
    ]);
    // Opening acts on the whole BrowserSession, not one tab.
    expect(keys("opengeni__browser_open", { browserSessionId: "b", targetId: "t" })).toEqual([
      "browser:b",
    ]);
    expect(keys("opengeni__sandboxes_list")).toBeUndefined();
    expect(keys("linear__sandbox_swap")).toBeUndefined();
    expect(
      callNamesConnectedMachine({
        arguments: JSON.stringify({ placement: { kind: "connected_machine", sandboxId: "m" } }),
      }),
    ).toBe(true);
    expect(callNamesConnectedMachine({ arguments: "{}" })).toBe(false);
    expect(
      callNamesConnectedMachine({
        arguments: JSON.stringify({ placement: { kind: "attached_device" } }),
      }),
    ).toBe(false);
    expect(callNamesConnectedMachine({ arguments: "not json" })).toBe(false);
    // Clones (the sandbox runtime resolves tools on one) keep the ordering.
    const cloned = agent.clone({});
    const clonedTools = await cloned.getMcpTools(undefined as never);
    expect(
      clonedTools.find((item) => item.name === "opengeni__sandbox_swap") as {
        exclusiveExecution?: boolean;
      },
    ).toMatchObject({ exclusiveExecution: true });
  });

  test("a computer action runs in model order with the reads of its response", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("before", "opengeni__computer_observe"),
        call("act", "opengeni__computer_act", {
          action: { type: "keyboard", action: "press", value: "Escape" },
        }),
        call("after", "opengeni__computer_observe"),
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
    const agent = new Agent({ name: "Test", model, mcpServers: [firstPartyServer(log)] });
    installRouteMoveOrdering(agent as never);
    const result = await new Runner({ tracingDisabled: true }).run(agent, "Close the dialog");
    expect(result.finalOutput).toBe("Done.");
    // Started together, the read after the action could be served first and
    // show the window before it, and the read before it could replace the
    // reading the action was fenced on.
    expect(log).toEqual([
      "computer_observe:start",
      "computer_observe:end",
      "computer_act:start",
      "computer_act:end",
      "computer_observe:start",
      "computer_observe:end",
    ]);
  });

  test("a call naming a ComputerSession is ordered with one on the current session", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("act", "opengeni__computer_act", {
          computerSessionId: "a",
          action: { type: "keyboard", action: "press", value: "Escape" },
        }),
        // No session named: the current one, which may be "a".
        call("observe", "opengeni__computer_observe"),
      ],
      DONE,
    ]);
    const agent = new Agent({ name: "Test", model, mcpServers: [firstPartyServer(log)] });
    installRouteMoveOrdering(agent as never);
    await new Runner({ tracingDisabled: true }).run(agent, "Close the dialog");
    expect(log).toEqual([
      "computer_act@a:start",
      "computer_act@a:end",
      "computer_observe:start",
      "computer_observe:end",
    ]);
  });

  test("calls on different ComputerSessions, and unrelated tools, stay concurrent", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("act-a", "opengeni__computer_act", { computerSessionId: "a" }),
        call("act-b", "opengeni__computer_act", { computerSessionId: "b" }),
        call("shell", "exec_command"),
        call("observe-a", "opengeni__computer_observe", { computerSessionId: "a" }),
      ],
      DONE,
    ]);
    const agent = new Agent({
      name: "Test",
      model,
      tools: [recordedTool(log, "exec_command")],
      mcpServers: [firstPartyServer(log)],
    });
    installRouteMoveOrdering(agent as never);
    await new Runner({ tracingDisabled: true }).run(agent, "Work on both computers");
    const at = (entry: string) => log.indexOf(entry);
    const firstEnd = log.findIndex((entry) => entry.endsWith(":end"));
    // Both sessions' actions and the shell command start together.
    expect(at("computer_act@a:start")).toBeLessThan(firstEnd);
    expect(at("computer_act@b:start")).toBeLessThan(firstEnd);
    expect(at("exec_command:start")).toBeLessThan(firstEnd);
    // Only the read of session "a" waits, for the action on "a".
    expect(at("computer_observe@a:start")).toBeGreaterThan(at("computer_act@a:end"));
    expect(log).toHaveLength(8);
  });

  test("browser calls on one tab run in model order, on another tab concurrently", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("act", "opengeni__browser_act", { browserSessionId: "s", targetId: "t1" }),
        call("same", "opengeni__browser_observe", { browserSessionId: "s", targetId: "t1" }),
        call("other", "opengeni__browser_observe", { browserSessionId: "s", targetId: "t2" }),
      ],
      DONE,
    ]);
    const agent = new Agent({ name: "Test", model, mcpServers: [firstPartyServer(log)] });
    installRouteMoveOrdering(agent as never);
    await new Runner({ tracingDisabled: true }).run(agent, "Fill the form");
    const at = (entry: string) => log.indexOf(entry);
    expect(at("browser_observe@s/t2:start")).toBeLessThan(at("browser_act@s/t1:end"));
    expect(at("browser_observe@s/t1:start")).toBeGreaterThan(at("browser_act@s/t1:end"));
  });

  test("a computer action called through tool_invoke is ordered with the reads of its session", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("act", "tool_invoke", {
          name: "opengeni__computer_act",
          arguments: { action: { type: "keyboard", action: "press", value: "Escape" } },
        }),
        call("observe", "opengeni__computer_observe"),
      ],
      DONE,
    ]);
    const agent = new Agent({
      name: "Test",
      model: "scripted",
      mcpServers: [firstPartyServer(log)],
    });
    installRouteMoveOrdering(agent as never);
    const runtime = installLazyToolRuntime(agent as never, "generic_dispatch", new Set());
    await new Runner({
      tracingDisabled: true,
      modelProvider: new LazyToolModelProvider({ getModel: () => model }, runtime),
    }).run(agent, "Close the dialog", {
      resolveMissingFunctionTool: createResolveMissingFunctionTool(runtime),
    });
    expect(log).toEqual([
      "computer_act:start",
      "computer_act:end",
      "computer_observe:start",
      "computer_observe:end",
    ]);
  });

  test("an open runs in model order only when it names a Connected Machine", async () => {
    const log: string[] = [];
    const model = new ScriptedModel([
      [
        call("a", "opengeni__browser_open"),
        call("b", "opengeni__browser_open"),
        call("c", "opengeni__computer_open", {
          placement: { kind: "connected_machine", sandboxId: "machine" },
        }),
        call("d", "opengeni__computer_observe"),
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
    const agent = new Agent({ name: "Test", model, mcpServers: [firstPartyServer(log)] });
    installRouteMoveOrdering(agent as never);
    const result = await new Runner({ tracingDisabled: true }).run(agent, "Open things");
    expect(result.finalOutput).toBe("Done.");
    expect(log).toEqual([
      // The two plain opens start together.
      "browser_open:start",
      "browser_open:start",
      "browser_open:end",
      "browser_open:end",
      // The open naming a machine waits for them, and the next call for it.
      "computer_open:start",
      "computer_open:end",
      "computer_observe:start",
      "computer_observe:end",
    ]);
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
