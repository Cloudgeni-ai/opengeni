import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { status } from "@grpc/grpc-js";
import { ModalCommandRouterWire } from "../src/sandbox/providers/modal-command-router-wire";
import { isModalTaskExecStartDnsResolutionError } from "../src/sandbox/providers/modal";
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

describe("turn sandbox-tool cancellation boundary", () => {
  test("the production shell tool propagates native pre-dispatch DNS proof, not ambiguous starts", async () => {
    const host = "task-fbhzq89jcdq2rfyqsxjs1uuk3.w.modal.host";
    const details = `Name resolution failed for target dns:${host}:443`;
    const wire = new ModalCommandRouterWire({ url: `https://${host}`, jwt: "test-token" });
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
      expect(isModalTaskExecStartDnsResolutionError(failure)).toBe(true);
      expect(calls).toBe(1);
      Object.defineProperty(wire, "unary", {
        value: async () => {
          calls++;
          throw Object.assign(new Error("ambiguous start"), { code: status.UNAVAILABLE });
        },
      });
      expect(await tool.invoke({} as never, JSON.stringify({ cmd: "true" }))).toContain(
        "ambiguous start",
      );
      expect(calls).toBe(2);
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
