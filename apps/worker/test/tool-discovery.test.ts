import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSharedAzureEntraAccessTokenSources } from "@opengeni/network/azure-entra";
import { testSettings } from "@opengeni/testing";
import { DecisionError, type DecisionUsage } from "@opengeni/decisions";
import type { DocumentEmbedder } from "@opengeni/documents";
import { createToolSelector } from "@opengeni/runtime";
import {
  TOOL_DECISION_DURATION_METRIC,
  TOOL_DECISION_SPAN,
  configuredToolDecisionModel,
  configuredToolMeaningRanker,
  toolSelectionFallbackReason,
} from "../src/activities/agent-turn/tool-discovery";
import { configuredDecisionModel } from "../src/activities/agent-turn/decision-model";

describe("tool search selection fallback reasons", () => {
  const failure = (error: unknown, timedOut = false) => ({
    error,
    elapsedMs: 8000,
    timedOut,
    attempts: 2,
  });

  test("names the deadline, rate limits, provider errors, failed requests and bad answers", () => {
    expect(toolSelectionFallbackReason(failure(new Error("aborted"), true))).toBe("deadline");
    expect(
      toolSelectionFallbackReason(failure(new DecisionError("slow down", { status: 429 }))),
    ).toBe("rate_limited");
    expect(
      toolSelectionFallbackReason(failure(new DecisionError("bad gateway", { status: 502 }))),
    ).toBe("provider_error");
    expect(
      toolSelectionFallbackReason(
        failure(new DecisionError("network", { code: "request_failed" })),
      ),
    ).toBe("request_failed");
    expect(toolSelectionFallbackReason(failure(new DecisionError("invalid typed answers")))).toBe(
      "invalid_answer",
    );
  });
});

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
  test("an Azure AI Foundry decision model posts to its endpoint as the deployment identity, in the EU", async () => {
    const resource = "https://foundry-decisions.services.ai.azure.test";
    const endpoint = `${resource}/providers/microsoft/v1/systemone`;
    const directory = await mkdtemp(join(tmpdir(), "foundry-decisions-"));
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, "projected-assertion");
    const originalFetch = globalThis.fetch;
    const tokenRequests: URLSearchParams[] = [];
    const calls: Array<{ url: string; authorization: string | null; body: any }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://login.microsoftonline.com/")) {
        tokenRequests.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: "entra-token", expires_in: 3600 });
      }
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        id: "decision-response",
        model: "decision-deployment",
        answers: { 0: { type: "noul", noul: 0.6 }, 1: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 120, output_tokens: 0 },
      });
    }) as typeof fetch;
    resetSharedAzureEntraAccessTokenSources();
    try {
      const settings = testSettings({
        decisionModelAuth: "deployment_identity",
        decisionModelProvider: "openrouter",
        decisionModelId: "decision-deployment",
        decisionModelEndpoint: endpoint,
        azureTenantId: "tenant-test",
        azureClientId: "client-test",
        azureFederatedTokenFile: tokenFile,
        requiredModelGeography: "eu",
        sideFeatureResidencyJson: JSON.stringify({
          "decision_model.openrouter": {
            endpoint: resource,
            residency: {
              geography: "eu",
              deploymentType: "azure_data_zone",
              regions: ["germanywestcentral"],
              evidence: {
                source: "operator_declaration",
                reference: "Decision deployment, DataZoneStandard",
                verifiedAt: "2026-11-18",
              },
            },
          },
        }),
      });
      const choose = configuredToolDecisionModel({
        settings,
        recordUsage: async () => {},
        onUnavailable: () => {
          throw new Error("available");
        },
      })!;
      const candidates = [
        { name: "tasks__read", description: "Read task", inputFields: ["id"] },
        { name: "tasks__list", description: "List tasks", inputFields: [] },
      ];
      expect(await createToolSelector(choose)({ query: "read task", candidates })).toEqual([
        { name: "tasks__read", probability: 0.6 },
        { name: "tasks__list", probability: 0.1 },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(endpoint);
      expect(calls[0]!.authorization).toBe("Bearer entra-token");
      // The openrouter-shaped request: the deployment as the model, state and named questions.
      expect(calls[0]!.body.model).toBe("decision-deployment");
      expect(calls[0]!.body.state).toBeDefined();
      expect(calls[0]!.body.questions["0"].type).toBe("noul");
      expect(tokenRequests[0]!.get("scope")).toBe("https://cognitiveservices.azure.com/.default");
      // The deployment's threshold travels with the selector.
      expect(createToolSelector(choose).loadThreshold).toBeUndefined();
      expect(createToolSelector(choose, { loadThreshold: 0.7 }).loadThreshold).toBe(0.7);
      // Undeclared, the route is not EU, so the model is not configured for this run.
      expect(
        configuredDecisionModel({ ...settings, sideFeatureResidencyJson: undefined }),
      ).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      resetSharedAzureEntraAccessTokenSources();
      await rm(directory, { recursive: true, force: true });
    }
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
  test("each decision request is a span and a duration sample, a hedge loser included", async () => {
    const spans: Array<{ name: string; attributes: Record<string, unknown>; error?: unknown }> = [];
    const samples: Array<{ name: string; labels?: Record<string, unknown>; value: number }> = [];
    const observability = {
      startSpan: (name: string, attributes: Record<string, unknown> = {}) => ({
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        end: (end: { attributes?: Record<string, unknown>; error?: unknown } = {}) => {
          spans.push({
            name,
            attributes: { ...attributes, ...end.attributes },
            ...("error" in end ? { error: end.error } : {}),
          });
        },
      }),
      observeHistogram: (sample: {
        name: string;
        labels?: Record<string, unknown>;
        value: number;
      }) => {
        samples.push(sample);
      },
    };
    let requests = 0;
    const choose = configuredToolDecisionModel({
      settings: testSettings({
        decisionModelProvider: "openrouter",
        decisionModelId: "openai/gpt-6-luna-decisions",
        decisionModelApiKey: "test-key-configured",
      }),
      observability: observability as never,
      // The first request never answers; the hedged second one does.
      fetch: (async (_url, init) => {
        if (++requests === 1)
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
              once: true,
            });
          });
        return Response.json({
          id: "decision-response",
          model: "actual-model-version",
          answers: { 0: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1234, output_tokens: 0 },
        });
      }) as typeof fetch,
      recordUsage: async () => {},
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
    expect(requests).toBe(2);
    // The losing request is cancelled as the winner returns and settles after it.
    for (let tick = 0; spans.length < 2 && tick < 100; tick++) await Bun.sleep(1);
    expect(spans.map((span) => [span.name, span.attributes])).toEqual([
      [
        TOOL_DECISION_SPAN,
        {
          provider: "openrouter/openai/gpt-6-luna-decisions",
          questions: 1,
          outcome: "completed",
          input_tokens: 1234,
        },
      ],
      [
        TOOL_DECISION_SPAN,
        { provider: "openrouter/openai/gpt-6-luna-decisions", questions: 1, outcome: "cancelled" },
      ],
    ]);
    expect(spans.every((span) => !("error" in span))).toBe(true);
    expect(samples.map((sample) => [sample.name, sample.labels])).toEqual([
      [TOOL_DECISION_DURATION_METRIC.name, { outcome: "completed" }],
      [TOOL_DECISION_DURATION_METRIC.name, { outcome: "cancelled" }],
    ]);
    // The winner waited for the hedge, so its sample covers that wait.
    expect(samples[0]!.value).toBeGreaterThan(0);
  });
  test("a refused decision request is a failed span carrying its error", async () => {
    const ended: Array<{ attributes?: Record<string, unknown>; error?: unknown }> = [];
    const choose = configuredToolDecisionModel({
      settings: testSettings({
        decisionModelProvider: "openrouter",
        decisionModelId: "openai/gpt-6-luna-decisions",
        decisionModelApiKey: "test-key-configured",
      }),
      observability: {
        startSpan: () => ({
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          end: (end = {}) => {
            ended.push(end);
          },
        }),
        observeHistogram: () => {},
      } as never,
      fetch: (async () => new Response("bad request", { status: 400 })) as typeof fetch,
      recordUsage: async () => {},
      onUnavailable: () => {
        throw new Error("available");
      },
    })!;
    await expect(
      choose.decide("state", { 0: { type: "predicate", instructions: "q" } } as never),
    ).rejects.toThrow("HTTP 400");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.attributes).toEqual({ outcome: "failed" });
    expect(ended[0]!.error).toBeInstanceOf(DecisionError);
  });
});
