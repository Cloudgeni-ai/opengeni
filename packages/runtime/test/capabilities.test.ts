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
