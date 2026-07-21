import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  buildAgentCapabilities,
  buildOpenGeniAgent,
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
      expect(types).toContain("skills");
    }
  });
});

describe("turn sandbox-tool cancellation boundary", () => {
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
    expect(capabilities.map((capability) => capability.type)).toEqual([
      "filesystem",
      "shell",
      "skills",
    ]);
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

  test("operators can disable it: webSearchEnabled=false attaches no web_search tool and no tools field", () => {
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
    // With the flag off the explicit tools field is omitted entirely, preserving
    // the SDK's "no explicit tools" tool-choice semantics.
    expect((noneAgent as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
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
