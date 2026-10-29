import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { DecisionUsage } from "@opengeni/decisions";
import type { DocumentEmbedder } from "@opengeni/documents";
import { createToolSelector } from "@opengeni/runtime";
import {
  configuredToolDecisionModel,
  configuredToolMeaningRanker,
} from "../src/activities/agent-turn/tool-discovery";
import { configuredDecisionModel } from "../src/activities/agent-turn/decision-model";

describe("tool search meaning ranking", () => {
  const remote = (overrides: Partial<DocumentEmbedder> = {}) => {
    const calls: string[][] = [];
    const embedder: DocumentEmbedder = {
      model: "embedding-model",
      dimensions: 2,
      endpoint: "https://embeddings.example.test/v1",
      embedMany: async (texts) => {
        calls.push(texts);
        return texts.map((text) => (text.includes("calendar") ? [1, 0] : [0, 1]));
      },
      embedQuery: async () => [1, 0],
      ...overrides,
    } as DocumentEmbedder;
    return { embedder, calls };
  };
  const openai = () => testSettings({ documentEmbeddingProvider: "openai" });

  test("none for the word-count stand-in, a local embedder or one without a credential", () => {
    const { embedder, calls } = remote();
    expect(
      configuredToolMeaningRanker({ settings: testSettings(), embedder: () => embedder }),
    ).toBeUndefined();
    expect(
      configuredToolMeaningRanker({
        settings: openai(),
        embedder: () => remote({ local: true }).embedder,
      }),
    ).toBeUndefined();
    expect(
      configuredToolMeaningRanker({
        settings: openai(),
        embedder: () => remote({ available: false }).embedder,
      }),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("none when EU-only inference has no EU record for the embedding endpoint", () => {
    const { embedder } = remote();
    expect(
      configuredToolMeaningRanker({
        settings: testSettings({
          documentEmbeddingProvider: "openai",
          requiredModelGeography: "eu",
        }),
        embedder: () => embedder,
      }),
    ).toBeUndefined();
  });

  test("the deployment identity signs the Knowledge embedder in for tool search too", () => {
    const identity = {
      documentEmbeddingProvider: "openai" as const,
      documentEmbeddingAuth: "deployment_identity" as const,
      documentEmbeddingBaseUrl: "https://resource.openai.azure.com/openai/v1",
    };
    expect(
      configuredToolMeaningRanker({
        settings: testSettings({
          ...identity,
          azureTenantId: "tenant",
          azureClientId: "client",
          azureClientSecret: "secret",
        }),
      }),
    ).toBeFunction();
    // Without the identity nothing signs in, and no other key is tried.
    expect(
      configuredToolMeaningRanker({ settings: testSettings({ ...identity, openaiApiKey: "key" }) }),
    ).toBeUndefined();
  });

  test("turns with the same embedding setup share one ranker and its tool vectors", async () => {
    const settings = testSettings({
      documentEmbeddingProvider: "openai",
      documentEmbeddingModel: "shared-space-model",
    });
    const first = remote({ model: "shared-space-model" });
    const second = remote({ model: "shared-space-model" });
    const tools = [
      { type: "function", name: "mcp_a__calendar_list", description: "List calendar events." },
      { type: "function", name: "mcp_a__files_list", description: "List files." },
    ] as never[];
    const rankOne = configuredToolMeaningRanker({ settings, embedder: () => first.embedder })!;
    // A cold cache answers nothing and computes the tool vectors in the background.
    const signal = AbortSignal.timeout(1_000);
    expect(await rankOne({ queries: ["my calendar"], tools, signal })).toBeUndefined();
    for (let i = 0; i < 50 && first.calls.length === 0; i++) await Bun.sleep(5);
    await Bun.sleep(5);
    const rankTwo = configuredToolMeaningRanker({ settings, embedder: () => second.embedder })!;
    expect(await rankTwo({ queries: ["my calendar"], tools, signal })).toEqual([
      ["mcp_a__calendar_list", "mcp_a__files_list"],
    ]);
    // The second turn embedded only its query, through its own embedder.
    expect(second.calls).toEqual([["my calendar"]]);
    expect(first.calls.flat()).toHaveLength(2);
  });
});

describe("shared deployment decision category", () => {
  test("unset configuration makes no request", () => {
    expect(
      configuredToolDecisionModel({
        settings: testSettings(),
        recordUsage: async () => {},
        onUnavailable: () => {
          throw new Error("not configured");
        },
        fetch: (async () => {
          throw new Error("must not fetch");
        }) as typeof fetch,
      }),
    ).toBeUndefined();
  });
  test("partial explicit configuration cannot borrow a legacy or customer credential", () => {
    let unavailable = 0;
    const settings = testSettings({
      decisionModelProvider: "openrouter",
      decisionModelId: "openai/gpt-6-luna-decisions",
      jevApiKey: "legacy-test-key",
    });
    expect(
      configuredToolDecisionModel({
        settings,
        recordUsage: async () => {},
        onUnavailable: () => {
          unavailable++;
        },
      }),
    ).toBeUndefined();
    expect(unavailable).toBe(1);
    expect(configuredDecisionModel(settings, { allowLegacyCodeSearch: true })).toBeUndefined();
  });
  test("legacy Jev code-search configuration never silently enables paid tool search", () => {
    const settings = testSettings({ jevApiKey: "legacy-test-key" });
    expect(configuredDecisionModel(settings)).toBeUndefined();
    expect(configuredDecisionModel(settings, { allowLegacyCodeSearch: true })?.id).toBe(
      "jev/jev-latest",
    );
  });
  test("an Azure OpenAI decision model can sign in as the deployment identity", () => {
    const azure = {
      decisionModelAuth: "deployment_identity" as const,
      decisionModelProvider: "openai" as const,
      decisionModelId: "selector-deployment",
      decisionModelBaseUrl: "https://resource.openai.azure.test/openai/v1",
    };
    expect(
      configuredDecisionModel(
        testSettings({
          ...azure,
          azureTenantId: "tenant-test",
          azureClientId: "client-test",
          azureClientSecret: "secret-test",
        }),
      )?.id,
    ).toBe("openai/selector-deployment");
    let unavailable = 0;
    expect(
      configuredToolDecisionModel({
        settings: testSettings(azure),
        recordUsage: async () => {},
        onUnavailable: () => {
          unavailable++;
        },
      }),
    ).toBeUndefined();
    expect(unavailable).toBe(1);
  });
  test("uses the typed endpoint, model and usage hook rather than chat completions", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const usage: DecisionUsage[] = [];
    const choose = configuredToolDecisionModel({
      settings: testSettings({
        decisionModelProvider: "openrouter",
        decisionModelId: "openai/gpt-6-luna-decisions",
        decisionModelApiKey: "test-key-configured",
      }),
      fetch: (async (url, init) => {
        expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return Response.json({
          id: "decision-response",
          model: "actual-model-version",
          provider: "OpenAI",
          answers: { 0: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
        });
      }) as typeof fetch,
      recordUsage: async (_id, event) => {
        usage.push(event);
      },
      onUnavailable: () => {
        throw new Error("available");
      },
    })!;
    expect(
      await createToolSelector(choose)({
        query: "read task",
        candidates: [{ name: "tasks__read", description: "Read task", inputFields: ["id"] }],
      }),
    ).toEqual([{ name: "tasks__read", probability: 0.9 }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe("openai/gpt-6-luna-decisions");
    expect(bodies[0]!.messages).toBeUndefined();
    expect(bodies[0]!.tools).toBeUndefined();
    expect(usage[0]).toMatchObject({
      model: "actual-model-version",
      provider: "OpenAI",
      inputTokens: 100,
      costSource: "provider-reported",
    });
  });
});
