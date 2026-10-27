import { describe, expect, test } from "bun:test";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import type { WebSearchBilling, WebSearchCallCost } from "@opengeni/core";
import { InferenceRegionRestrictedError, withInferenceResidency } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import {
  gateImageGenerationOption,
  gateVideoGenerationOption,
  imageGenerationRoute,
  videoGenerationRoute,
} from "../src/activities/agent-turn/side-feature-gates";
import {
  WebProviderHealth,
  webSearchToolDefinitions,
} from "../src/activities/agent-turn/web-search";
import { configuredToolDecisionModel } from "../src/activities/agent-turn/tool-discovery";

const eu = testSettings({ requiredModelGeography: "eu" });
const open = testSettings();

function imageOption() {
  const executed: string[] = [];
  return {
    executed,
    option: {
      imageGeneration: {
        kind: "provider_adapter" as const,
        execute: async (_input: unknown, context: { toolCallId: string }) => {
          executed.push(context.toolCallId);
          return { ok: true };
        },
      },
    },
  };
}

function videoOption() {
  const executed: string[] = [];
  return {
    executed,
    option: {
      videoGeneration: {
        capabilities: async () => ({}) as never,
        execute: async (_input: unknown, context: { toolCallId: string }) => {
          executed.push(context.toolCallId);
          return {} as never;
        },
      },
    },
  };
}

describe("image and video generation under EU-only inference", () => {
  test("routes come from the tool's backing provider", () => {
    expect(imageGenerationRoute({ nativeHosted: true, providerKind: "registry" })).toBe(
      "image_generation.openai_hosted",
    );
    expect(imageGenerationRoute({ nativeHosted: false, providerKind: "codex-subscription" })).toBe(
      "image_generation.codex_subscription",
    );
    expect(imageGenerationRoute({ nativeHosted: false, providerKind: "registry" })).toBe(
      "image_generation.ai_gateway",
    );
    expect(videoGenerationRoute("supergrok_subscription")).toBe(
      "video_generation.supergrok_subscription",
    );
    expect(videoGenerationRoute("workspace_gateway")).toBe("video_generation.ai_gateway");
  });

  test("outside EU the tools are offered and run", async () => {
    const image = imageOption();
    const gatedImage = gateImageGenerationOption(open, "image_generation.ai_gateway", image.option);
    expect(gatedImage.imageGeneration?.kind).toBe("provider_adapter");
    await (gatedImage.imageGeneration as typeof image.option.imageGeneration).execute({} as never, {
      toolCallId: "i1",
    });
    expect(image.executed).toEqual(["i1"]);

    const video = videoOption();
    const gatedVideo = gateVideoGenerationOption(open, "video_generation.ai_gateway", video.option);
    await gatedVideo.videoGeneration!.execute({} as never, { toolCallId: "v1" });
    expect(video.executed).toEqual(["v1"]);

    expect(
      gateImageGenerationOption(open, "image_generation.openai_hosted", {
        imageGeneration: { kind: "native_hosted" },
      }),
    ).toEqual({ imageGeneration: { kind: "native_hosted" } });
  });

  test("under EU the tools are not offered", () => {
    expect(
      gateImageGenerationOption(eu, "image_generation.ai_gateway", imageOption().option),
    ).toEqual({});
    expect(
      gateImageGenerationOption(eu, "image_generation.openai_hosted", {
        imageGeneration: { kind: "native_hosted" },
      }),
    ).toEqual({});
    expect(
      gateVideoGenerationOption(eu, "video_generation.ai_gateway", videoOption().option),
    ).toEqual({});
  });

  test("a tool built before the run turned EU refuses before calling its provider", async () => {
    const image = imageOption();
    const gatedImage = gateImageGenerationOption(open, "image_generation.ai_gateway", image.option);
    const video = videoOption();
    const gatedVideo = gateVideoGenerationOption(open, "video_generation.ai_gateway", video.option);
    await withInferenceResidency(eu, async () => {
      await expect(
        (gatedImage.imageGeneration as typeof image.option.imageGeneration).execute({} as never, {
          toolCallId: "i2",
        }),
      ).rejects.toBeInstanceOf(InferenceRegionRestrictedError);
      await expect(
        gatedVideo.videoGeneration!.execute({} as never, { toolCallId: "v2" }),
      ).rejects.toBeInstanceOf(InferenceRegionRestrictedError);
    });
    expect(image.executed).toEqual([]);
    expect(video.executed).toEqual([]);
  });
});

describe("web search failover under EU-only inference", () => {
  const scope = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
  };
  const euSelfHosted = {
    geography: "eu",
    deploymentType: "self_hosted",
    regions: ["fsn1"],
    evidence: {
      source: "operator_declaration",
      reference: "SearXNG on the deployment's own host",
      verifiedAt: "2026-10-26",
    },
  } as const;
  const quiet = {
    warn: () => undefined,
    incrementCounter: () => undefined,
    observeHistogram: () => undefined,
  };
  const context = () =>
    ({
      operationId: crypto.randomUUID(),
      caller: { kind: "model" },
    }) as unknown as AttemptToolExecutionContext;

  function harness() {
    const calls: string[] = [];
    const settled: WebSearchCallCost[] = [];
    const billing = {
      active: true,
      admit: async () => {},
      settle: async (_scope: unknown, cost: WebSearchCallCost) => {
        settled.push(cost);
      },
    } as unknown as WebSearchBilling;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const body = url.startsWith("https://api.exa.ai")
        ? { results: [{ title: "Exa", url: "https://exa.example", highlights: ["x"] }] }
        : { results: [{ title: "Local", url: "https://local.example", content: "y" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { calls, settled, billing, fetchImpl };
  }

  const configured = (declare: boolean) =>
    testSettings({
      webSearchProvider: "exa,searxng",
      webSearchProviderCredentials: {
        exa: { apiKey: "exa-key" },
        searxng: { baseUrl: "http://searxng.internal" },
      },
      ...(declare
        ? {
            sideFeatureResidencyJson: JSON.stringify({
              "web_search.searxng": {
                endpoint: "http://searxng.internal",
                residency: euSelfHosted,
              },
            }),
          }
        : {}),
    });

  function searchTool(settings: ReturnType<typeof testSettings>, h: ReturnType<typeof harness>) {
    const [search] = webSearchToolDefinitions({
      settings,
      tools: ["web_search"],
      scope,
      billing: h.billing,
      observability: quiet,
      fetch: h.fetchImpl,
      health: new WebProviderHealth(),
    });
    return search!;
  }

  test("outside EU the first provider answers", async () => {
    const h = harness();
    await searchTool(configured(false), h).execute({ query: "q" }, context());
    expect(h.calls[0]).toStartWith("https://api.exa.ai");
  });

  test("under EU a non-EU provider is skipped and the EU provider answers", async () => {
    const h = harness();
    const tool = searchTool(configured(true), h);
    await withInferenceResidency(eu, async () => {
      await tool.execute({ query: "q" }, context());
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toStartWith("http://searxng.internal/search");
    expect(h.settled[0]).toMatchObject({
      provider: "searxng",
      processingResidency: { geography: "eu", deploymentType: "self_hosted", regions: ["fsn1"] },
    });
  });

  test("under EU with no EU provider nothing is sent", async () => {
    const h = harness();
    const tool = searchTool(configured(false), h);
    const result = await withInferenceResidency(eu, async () =>
      tool.execute({ query: "q" }, context()),
    );
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(result)).toContain("Web search is not supported in EU.");
  });
});

describe("decision models under EU-only inference", () => {
  const decision = {
    decisionModelProvider: "openai",
    decisionModelId: "gpt-decide",
    decisionModelApiKey: "key",
    decisionModelBaseUrl: "https://decide.example.com/v1",
  } as const;

  function build(settings: ReturnType<typeof testSettings>) {
    const calls: string[] = [];
    let unavailable = 0;
    const model = configuredToolDecisionModel({
      settings,
      recordUsage: async () => undefined,
      onUnavailable: () => {
        unavailable += 1;
      },
      fetch: (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("{}", { status: 500 });
      }) as typeof fetch,
    });
    return { model, calls, unavailable: () => unavailable };
  }

  test("an undeclared decision route is not offered on an EU turn", () => {
    const euTurn = build(testSettings({ ...decision, requiredModelGeography: "eu" }));
    expect(euTurn.model).toBeUndefined();
    expect(euTurn.unavailable()).toBe(1);
    expect(build(testSettings(decision)).model).toBeDefined();
  });

  test("a decision model built before the run turned EU sends nothing", async () => {
    const built = build(testSettings(decision));
    await withInferenceResidency(eu, async () => {
      await expect(built.model!.decide({} as never, [] as never)).rejects.toThrow();
    });
    expect(built.calls).toEqual([]);
  });
});
