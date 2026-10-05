import { describe, expect, test } from "bun:test";
import { Agent, Runner, type AgentOutputItem } from "@openai/agents";
import { assistantMessage, ScriptedModel, testSettings } from "@opengeni/testing";
import { status } from "@grpc/grpc-js";
import { ModalCommandRouterWire } from "../src/sandbox/providers/modal-command-router-wire";
import { isModalTaskExecStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal";
import {
  buildAgentCapabilities,
  buildOpenGeniAgent,
  HUMAN_INPUT_TOOL_NAME,
  type TurnToolCancellationFence,
} from "../src/index";

function capabilityTypes(settings: Parameters<typeof buildAgentCapabilities>[0]): string[] {
  return buildAgentCapabilities(settings, []).map(
    (cap) => (cap as { type?: unknown }).type as string,
  );
}

describe("portable local compaction capability boundary", () => {
  test("no provider receives the Agents SDK inline compaction capability", () => {
    for (const openaiProvider of ["openai", "azure"] as const) {
      const types = capabilityTypes(testSettings({ openaiProvider }));
      expect(types).not.toContain("compaction");
      expect(types).toContain("filesystem");
      expect(types).toContain("shell");
      expect(types).not.toContain("skills");
    }
  });
});

describe("filesystem function tool schemas", () => {
  test("apply_patch presents one string patch field and preserves tuple invocation", async () => {
    const operations: unknown[] = [];
    const session = {
      createEditor: () => ({
        createFile: async (operation: unknown) => {
          operations.push(operation);
          return { status: "completed", output: "created" };
        },
      }),
    };
    for (const structuredToolTransport of [undefined, false]) {
      const filesystem = buildAgentCapabilities(testSettings(), [], {
        structuredToolTransport,
      }).find((cap) => cap.type === "filesystem")!;
      const patch = filesystem
        .clone()
        .bind(session as never)
        .tools()
        .find((tool) => tool.name === "apply_patch");
      if (!patch || patch.type !== "function") throw new Error("No apply_patch function");
      expect(Object.keys(patch.parameters.properties ?? {})).toEqual(["patch"]);
      expect(patch.parameters.properties?.patch).toMatchObject({ type: "string" });
      expect(patch.parameters.required).toEqual(["patch"]);
      expect(patch.description).toContain("*** Begin Patch");
      await patch.invoke(
        {} as never,
        JSON.stringify({
          command: [
            "apply_patch",
            "*** Begin Patch\n*** Add File: example.txt\n+example\n*** End Patch",
          ],
        }),
      );
    }
    // The trailing empty "+" line gives the created file Codex's final newline.
    expect(operations).toEqual([
      { type: "create_file", path: "example.txt", diff: "+example\n+\n" },
      { type: "create_file", path: "example.txt", diff: "+example\n+\n" },
    ]);
  });
});

// Production soak: an OpenAI-compatible chat model sent apply_patch arguments
// that were truncated JSON. The SDK forces a human approval for unparseable
// arguments of any tool whose approval policy is dynamic, and the filesystem
// fallback's never-approve closure counted as dynamic: the session stalled in
// requires_action on a broken patch. Malformed arguments must be a tool error.
describe("malformed apply_patch arguments", () => {
  const malformedArguments = [
    // Exact production arguments: unterminated JSON string.
    '{"diff": "*** Begin Patch\\n*** Add File: notes/soak.txt\\n+alpha\\n+beta\\n+gamma\\n*** End Patch\\n',
    // The same intent as valid JSON under an unrecognized key.
    JSON.stringify({
      diff: "*** Begin Patch\n*** Add File: notes/soak.txt\n+alpha\n+beta\n+gamma\n*** End Patch\n",
    }),
  ];

  for (const [index, args] of malformedArguments.entries()) {
    test(`returns a model-visible tool error, never an approval (${index})`, async () => {
      const operations: unknown[] = [];
      const session = {
        createEditor: () => ({
          createFile: async (operation: unknown) => {
            operations.push(operation);
            return { status: "completed", output: "created" };
          },
        }),
      };
      const filesystem = buildAgentCapabilities(testSettings(), [], {
        structuredToolTransport: false,
      }).find((cap) => cap.type === "filesystem")!;
      const tools = filesystem
        .clone()
        .bind(session as never)
        .tools()
        .filter((tool) => tool.name === "apply_patch");
      const model = new ScriptedModel([
        {
          output: [
            {
              id: "call-malformed",
              type: "function_call",
              callId: "call-malformed",
              name: "apply_patch",
              status: "completed",
              arguments: args,
            } as AgentOutputItem,
          ],
        },
        { output: [assistantMessage("retrying")] },
      ]);
      const agent = new Agent({ name: "patcher", model, tools });
      const result = await new Runner({ tracingDisabled: true }).run(agent, "create the file");

      expect(result.interruptions).toHaveLength(0);
      expect(operations).toEqual([]);
      expect(model.calls).toBe(2);
      const toolOutput = result.newItems.find((item) => item.type === "tool_call_output_item");
      expect(toolOutput).toBeDefined();
      const text = JSON.stringify(toolOutput!.rawItem);
      expect(text).toMatch(
        index === 0 ? /parsing tool arguments/ : /Invalid apply_patch arguments/,
      );
      if (index === 1) expect(text).toContain("got keys diff");
    });
  }

  test("a well-formed patch still runs without approval", async () => {
    const operations: unknown[] = [];
    const session = {
      createEditor: () => ({
        createFile: async (operation: unknown) => {
          operations.push(operation);
          return { status: "completed", output: "created" };
        },
      }),
    };
    const filesystem = buildAgentCapabilities(testSettings(), [], {
      structuredToolTransport: false,
    }).find((cap) => cap.type === "filesystem")!;
    const tools = filesystem
      .clone()
      .bind(session as never)
      .tools()
      .filter((tool) => tool.name === "apply_patch");
    const model = new ScriptedModel([
      {
        output: [
          {
            id: "call-ok",
            type: "function_call",
            callId: "call-ok",
            name: "apply_patch",
            status: "completed",
            arguments: JSON.stringify({
              patch: "*** Begin Patch\n*** Add File: notes/soak.txt\n+alpha\n*** End Patch",
            }),
          } as AgentOutputItem,
        ],
      },
      { output: [assistantMessage("done")] },
    ]);
    const agent = new Agent({ name: "patcher", model, tools });
    const result = await new Runner({ tracingDisabled: true }).run(agent, "create the file");
    expect(result.interruptions).toHaveLength(0);
    expect(operations).toEqual([
      { type: "create_file", path: "notes/soak.txt", diff: "+alpha\n+\n" },
    ]);
  });
});

describe("turn sandbox-tool cancellation boundary", () => {
  test("the production shell tool propagates pre-dispatch proof, not DNS-shaped server replies", async () => {
    const host = "task-fbhzq89jcdq2rfyqsxjs1uuk3.w.modal.host";
    const details = `Name resolution failed for target dns:${host}:443`;
    const wire = new ModalCommandRouterWire({ url: `https://${host}`, jwt: "test-token" });
    let ready = false;
    Object.defineProperty(wire, "client", {
      value: {
        waitForReady: (_deadline: number, callback: (error?: Error) => void) =>
          callback(ready ? undefined : new Error("channel not ready")),
        close: () => {},
      },
    });
    let calls = 0;
    Object.defineProperty(wire, "unary", {
      value: async () => {
        calls++;
        throw Object.assign(new Error(`14 UNAVAILABLE: ${details}`), {
          code: status.UNAVAILABLE,
          details,
        });
      },
      configurable: true,
    });
    const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "modal" }), []);
    const shell = caps.find((cap) => cap.type === "shell")!;
    const session = {
      execCommand: async () =>
        wire.start({
          taskId: "task-test",
          execId: "exec-test",
          commandArgs: ["true"],
          workdir: "/tmp",
          env: {},
        }),
    };
    const tool = shell
      .clone()
      .bind(session as never)
      .tools()
      .find((candidate) => candidate.name === "exec_command");
    expect(tool?.type).toBe("function");
    if (!tool || tool.type !== "function") throw new Error("No shell tool");
    try {
      const failure = await tool
        .invoke({} as never, JSON.stringify({ cmd: "true" }))
        .catch((error: unknown) => error);
      expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(true);
      expect(calls).toBe(0);
      ready = true;
      Object.defineProperty(wire, "unary", {
        value: async () => {
          calls++;
          throw Object.assign(new Error(`14 UNAVAILABLE: ${details}`), {
            code: status.UNAVAILABLE,
            details,
          });
        },
      });
      const output = await tool.invoke({} as never, JSON.stringify({ cmd: "true" }));
      expect(output).toContain("outcome unknown");
      expect(output).toContain("Do not blindly retry");
      expect(output).not.toContain("Please try again");
      expect(calls).toBe(1);
    } finally {
      wire.close();
    }
  });

  test("buildOpenGeniAgent installs and exposes one shared physical tool fence", async () => {
    const abort = new AbortController();
    let fence: TurnToolCancellationFence | null = null;
    const agent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "local", webSearchEnabled: false }),
      [],
      {
        turnCancellationSignal: abort.signal,
        onToolCancellationFence: (value) => {
          fence = value;
        },
      },
    );
    const capabilities = (agent as unknown as { capabilities: Array<Record<string, unknown>> })
      .capabilities;

    expect(fence).not.toBeNull();
    expect(capabilities.map((capability) => capability.type)).toEqual(["filesystem", "shell"]);
    expect(agent.tools.map((tool) => tool.name)).toContain("skill_read");
    expect(agent.tools.map((tool) => tool.name)).not.toContain("load_skill");
    expect(capabilities.every((capability) => Object.hasOwn(capability, "tools"))).toBe(true);

    abort.abort(new Error("steered"));
    await fence!.waitForQuiescence();
  });
});

function webSearchHostedTools(
  agent: ReturnType<typeof buildOpenGeniAgent>,
): Array<Record<string, unknown>> {
  return ((agent as { tools?: Array<Record<string, unknown>> }).tools ?? []).filter(
    (tool) =>
      tool.type === "hosted_tool" &&
      (tool.providerData as { type?: unknown } | undefined)?.type === "web_search",
  );
}

describe("native web search hosted tool", () => {
  test("default settings attach a web_search hosted tool on the non-sandbox Agent path", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    const tools = webSearchHostedTools(agent);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("web_search");
  });

  test("default settings attach a web_search hosted tool on the SandboxAgent path", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker" }), []);
    const tools = webSearchHostedTools(agent);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("web_search");
  });

  test("web_search is on by default even on Azure (provider-unconditional)", () => {
    const agent = buildOpenGeniAgent(
      testSettings({
        sandboxBackend: "none",
        openaiProvider: "azure",
      }),
      [],
    );
    expect(webSearchHostedTools(agent)).toHaveLength(1);
  });

  test("the hosted tool serializes into the model request items the SDK sends", async () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    // getAllTools is the exact snapshot the runner serializes into request.tools[]
    // (runner/modelPreparation: serializedTools = getAllTools().map(serializeTool)).
    const allTools = await (
      agent as unknown as {
        getAllTools: (ctx?: unknown) => Promise<Array<Record<string, unknown>>>;
      }
    ).getAllTools();
    const webSearch = allTools.filter(
      (tool) =>
        tool.type === "hosted_tool" &&
        (tool.providerData as { type?: unknown } | undefined)?.type === "web_search",
    );
    expect(webSearch).toHaveLength(1);
    expect((webSearch[0]!.providerData as { type: string }).type).toBe("web_search");
  });

  test("operators can disable it without removing the structured human-input tool", () => {
    const noneAgent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "none", webSearchEnabled: false }),
      [],
    );
    const sandboxAgent = buildOpenGeniAgent(
      testSettings({ sandboxBackend: "docker", webSearchEnabled: false }),
      [],
    );
    expect(webSearchHostedTools(noneAgent)).toHaveLength(0);
    expect(webSearchHostedTools(sandboxAgent)).toHaveLength(0);
    expect(
      ((noneAgent as { tools?: Array<{ name?: unknown }> }).tools ?? []).map((tool) => tool.name),
    ).toContain(HUMAN_INPUT_TOOL_NAME);
  });
});

describe("main agent request has no inline compaction policy", () => {
  test("OpenAI and Azure both leave store/context_management unset", () => {
    for (const openaiProvider of ["openai", "azure"] as const) {
      const agent = buildOpenGeniAgent(
        testSettings({ sandboxBackend: "none", openaiProvider }),
        [],
      );
      const settings = agent.modelSettings as {
        store?: unknown;
        providerData?: Record<string, unknown>;
      };
      expect(settings.store).toBeUndefined();
      expect(settings.providerData?.context_management).toBeUndefined();
    }
  });
});

describe("model service tier", () => {
  test("adds the resolved tier beside existing provider data only for Fast mode", () => {
    const standard = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      latencyMode: "standard",
    });
    const fast = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      latencyMode: "fast",
      serviceTier: "priority",
      promptCacheKey: "session-1",
    });

    expect(
      (standard.modelSettings as { providerData?: Record<string, unknown> }).providerData
        ?.service_tier,
    ).toBeUndefined();
    expect(
      (fast.modelSettings as { providerData?: Record<string, unknown> }).providerData,
    ).toMatchObject({
      service_tier: "priority",
      prompt_cache_key: "session-1",
    });
  });
});
