import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities, buildOpenGeniAgent } from "../src/index";

function capabilityTypes(settings: Parameters<typeof buildAgentCapabilities>[0]): string[] {
  return buildAgentCapabilities(settings, []).map((cap) => (cap as { type?: unknown }).type as string);
}

describe("provider-aware capability selection", () => {
  test("Azure (auto -> client): NO compaction capability is attached (closes the live 400 path)", () => {
    const types = capabilityTypes(testSettings({ openaiProvider: "azure", contextCompactionMode: "auto" }));
    expect(types).not.toContain("compaction");
    // filesystem/shell/skills are still present (only compaction is provider-gated).
    expect(types).toContain("filesystem");
    expect(types).toContain("shell");
    expect(types).toContain("skills");
  });

  test("OpenAI platform (auto -> server): compaction capability IS attached", () => {
    const types = capabilityTypes(testSettings({ openaiProvider: "openai", contextCompactionMode: "auto" }));
    expect(types).toContain("compaction");
    expect(types).toContain("filesystem");
    expect(types).toContain("shell");
    expect(types).toContain("skills");
  });

  test("explicit client mode never attaches compaction even on the OpenAI provider", () => {
    const types = capabilityTypes(testSettings({ openaiProvider: "openai", contextCompactionMode: "client" }));
    expect(types).not.toContain("compaction");
  });

  test("explicit server mode attaches compaction even on Azure (operator override)", () => {
    const types = capabilityTypes(testSettings({ openaiProvider: "azure", contextCompactionMode: "server" }));
    expect(types).toContain("compaction");
  });

  test("off mode attaches no compaction capability (legacy unbounded escape hatch)", () => {
    const types = capabilityTypes(testSettings({ openaiProvider: "openai", contextCompactionMode: "off" }));
    expect(types).not.toContain("compaction");
  });

  test("server-path compaction policy emits the correct gpt-5.5 threshold, not the 240k fallback", () => {
    const settings = testSettings({ openaiProvider: "openai", contextCompactionMode: "server", openaiModel: "gpt-5.5" });
    const caps = buildAgentCapabilities(settings, []);
    const compactionCap = caps.find((cap) => (cap as { type?: unknown }).type === "compaction") as
      | { samplingParams: (p: Record<string, unknown>) => Record<string, unknown> }
      | undefined;
    expect(compactionCap).toBeDefined();
    const params = compactionCap!.samplingParams({ model: "gpt-5.5" });
    const contextManagement = params.context_management as Array<{ type: string; compact_threshold: number }>;
    expect(contextManagement[0]!.type).toBe("compaction");
    // floor((1_050_000 - 128_000) * 0.70) = 645_400, NOT the SDK's 240_000 fallback.
    expect(contextManagement[0]!.compact_threshold).toBe(Math.floor((1_050_000 - 128_000) * 0.7));
    expect(contextManagement[0]!.compact_threshold).not.toBe(240_000);
  });
});

function webSearchHostedTools(agent: ReturnType<typeof buildOpenGeniAgent>): Array<Record<string, unknown>> {
  return ((agent as { tools?: Array<Record<string, unknown>> }).tools ?? []).filter((tool) =>
    tool.type === "hosted_tool"
    && (tool.providerData as { type?: unknown } | undefined)?.type === "web_search");
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
      testSettings({ sandboxBackend: "none", openaiProvider: "azure", contextCompactionMode: "client" }),
      [],
    );
    expect(webSearchHostedTools(agent)).toHaveLength(1);
  });

  test("the hosted tool serializes into the model request items the SDK sends", async () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), []);
    // getAllTools is the exact snapshot the runner serializes into request.tools[]
    // (runner/modelPreparation: serializedTools = getAllTools().map(serializeTool)).
    const allTools = await (agent as unknown as {
      getAllTools: (ctx?: unknown) => Promise<Array<Record<string, unknown>>>;
    }).getAllTools();
    const webSearch = allTools.filter((tool) =>
      tool.type === "hosted_tool"
      && (tool.providerData as { type?: unknown } | undefined)?.type === "web_search");
    expect(webSearch).toHaveLength(1);
    expect((webSearch[0]!.providerData as { type: string }).type).toBe("web_search");
  });

  test("operators can disable it: webSearchEnabled=false attaches no web_search tool and no tools field", () => {
    const noneAgent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none", webSearchEnabled: false }), []);
    const sandboxAgent = buildOpenGeniAgent(testSettings({ sandboxBackend: "docker", webSearchEnabled: false }), []);
    expect(webSearchHostedTools(noneAgent)).toHaveLength(0);
    expect(webSearchHostedTools(sandboxAgent)).toHaveLength(0);
    // With the flag off the explicit tools field is omitted entirely, preserving
    // the SDK's "no explicit tools" tool-choice semantics.
    expect((noneAgent as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
  });
});

describe("server-path store:false precondition", () => {
  test("server mode sets store=false (encrypted compaction item round-trips)", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none", openaiProvider: "openai", contextCompactionMode: "server" }), []);
    expect((agent.modelSettings as { store?: unknown }).store).toBe(false);
  });

  test("client mode does not force store=false", () => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none", openaiProvider: "azure", contextCompactionMode: "client" }), []);
    expect((agent.modelSettings as { store?: unknown }).store).toBeUndefined();
  });
});
