import { describe, expect, spyOn, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { INFERENCE_FEATURE_IDS } from "@opengeni/contracts";
import * as db from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { InferenceRegionRestrictedError } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing/settings";
import {
  createRealtimeVoiceBilling,
  inferenceFeatureAvailability,
  prepareKnowledgeSave,
  realtimeVoiceRegionAllowed,
  realtimeVoiceRoute,
  sideFeatureAllowedForWorkspace,
  searchKnowledgeEntries,
  sideFeatureRouteUnavailableReason,
} from "../src";
import {
  createSpeechToTextDeployment,
  createTranscriptionService,
  speechToTextProcessingResidency,
} from "../src/transcription-service";

function declaration(deploymentType: "self_hosted" | "azure_data_zone", region: string) {
  return {
    geography: "eu",
    deploymentType,
    regions: [region],
    evidence: {
      source: "operator_declaration",
      reference: "Operator-declared EU deployment",
      verifiedAt: "2026-10-26",
    },
  } as const;
}

/** Operator declarations, each for the one endpoint a route sends to. */
const declare = (routes: Record<string, [endpoint: string, ReturnType<typeof declaration>]>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(routes).map(([route, [endpoint, residency]]) => [
        route,
        { endpoint, residency },
      ]),
    ),
  );

const EMBEDDINGS = "https://embed.example.openai.azure.com";

const scope = { accountId: "account", workspaceId: "workspace" };
const database = {} as Database;

describe("live voice under EU-only inference", () => {
  const azureLive = {
    azureLiveEndpoint: "https://voice.example.test",
    azureLiveApiKey: "key",
    vercelAiGatewayApiKey: "gateway-key",
  } satisfies Partial<Settings>;
  const gatewayModel = "opengeni-gateway/openai/gpt-realtime-mini";
  const azureModel = "opengeni-azure/gpt-live-1";

  test("each model's route comes from the deployment's own tables", () => {
    const settings = testSettings(azureLive);
    expect(realtimeVoiceRoute(azureModel, settings)).toEqual({
      route: "realtime_voice.azure_live",
      endpoint: azureLive.azureLiveEndpoint,
    });
    expect(realtimeVoiceRoute(gatewayModel, settings)).toBe("realtime_voice.ai_gateway");
    expect(realtimeVoiceRoute("unknown/eu-voice", settings)).toBeNull();
    const eu = testSettings({ requiredModelGeography: "eu" });
    expect(realtimeVoiceRegionAllowed(eu, "unknown/eu-voice")).toBe(false);
    expect(realtimeVoiceRegionAllowed(testSettings(), gatewayModel)).toBe(true);
  });

  test("an Azure Live declaration for another endpoint does not admit this one", () => {
    const eu = testSettings({
      ...azureLive,
      requiredModelGeography: "eu",
      sideFeatureResidencyJson: declare({
        "realtime_voice.azure_live": [
          "https://other-voice.example.test",
          declaration("azure_data_zone", "swedencentral"),
        ],
      }),
    });
    expect(realtimeVoiceRegionAllowed(eu, azureModel)).toBe(false);
  });

  test("admission refuses a non-EU model in an EU-only workspace before any connection", async () => {
    const settings = testSettings({
      ...azureLive,
      billingMode: "disabled",
      usageLimitsMode: "none",
    });
    const live = createRealtimeVoiceBilling({
      db: database,
      settings,
      isEuOnly: async () => true,
    });
    for (const model of [gatewayModel, azureModel]) {
      const admitted = live.admit({
        ...scope,
        model: model as never,
        attribution: { kind: "human", initiatingHumanSubjectId: "user:a" } as never,
      });
      await expect(admitted).rejects.toBeInstanceOf(InferenceRegionRestrictedError);
      await expect(admitted).rejects.toMatchObject({ code: "region_restricted" });
    }
  });

  test("a declared-EU Azure Live deployment is admitted; outside EU nothing changes", async () => {
    const declared = testSettings({
      ...azureLive,
      billingMode: "disabled",
      usageLimitsMode: "none",
      sideFeatureResidencyJson: declare({
        "realtime_voice.azure_live": [
          azureLive.azureLiveEndpoint,
          declaration("azure_data_zone", "swedencentral"),
        ],
      }),
    });
    const attribution = { kind: "human", initiatingHumanSubjectId: "user:a" } as never;
    const eu = createRealtimeVoiceBilling({
      db: database,
      settings: declared,
      isEuOnly: async () => true,
    });
    await eu.admit({ ...scope, model: azureModel as never, attribution });
    await expect(
      eu.admit({ ...scope, model: gatewayModel as never, attribution }),
    ).rejects.toBeInstanceOf(InferenceRegionRestrictedError);
    const open = createRealtimeVoiceBilling({
      db: database,
      settings: declared,
      isEuOnly: async () => false,
    });
    await open.admit({ ...scope, model: gatewayModel as never, attribution });
  });
});

describe("speech to text under EU-only inference", () => {
  const azureSpeech = {
    recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
    recordingAzureSpeechApiKey: "key",
    voiceInputProviderOrder: "openai,azure-speech",
  } satisfies Partial<Settings>;
  const request = {
    ...scope,
    subjectId: "subject",
    requestId: "request",
    audio: new Uint8Array([1, 2, 3]),
    mimeType: "audio/webm",
  };

  function recordingFetch() {
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    return { calls, impl };
  }

  test("only a provider whose route is declared EU serves an EU-only workspace", async () => {
    const settings = testSettings({
      ...azureSpeech,
      sideFeatureResidencyJson: declare({
        "transcription.azure-speech": [
          azureSpeech.recordingAzureSpeechEndpoint,
          declaration("azure_data_zone", "swedencentral"),
        ],
      }),
    });
    const deployment = createSpeechToTextDeployment({ settings }, { isEuOnly: async () => true });
    expect(deployment.route("openai")).toBe("transcription.openai");
    expect(deployment.route("azure-speech")).toEqual({
      route: "transcription.azure-speech",
      endpoint: azureSpeech.recordingAzureSpeechEndpoint,
    });
    expect(await deployment.regionAllowed("openai", scope)).toBe(false);
    expect(await deployment.regionAllowed("azure-speech", scope)).toBe(true);
    expect(await deployment.available("openai", scope)).toBe(false);
    expect(await deployment.available("azure-speech", scope)).toBe(true);
    await expect(deployment.assertRegion("openai", scope, "voice_input")).rejects.toBeInstanceOf(
      InferenceRegionRestrictedError,
    );
    const service = createTranscriptionService({ settings, db: {} as never, deployment });
    // The fallback order never reaches the non-EU provider.
    expect(await service.selectProvider?.({ ...scope, preferredProvider: "openai" })).toBe(
      "azure-speech",
    );
    expect(speechToTextProcessingResidency(settings, deployment.route("azure-speech"))).toEqual({
      geography: "eu",
      deploymentType: "azure_data_zone",
      regions: ["swedencentral"],
    });
  });

  test("with no EU provider dictation is refused and no audio is sent", async () => {
    const settings = testSettings(azureSpeech);
    const fake = recordingFetch();
    const deployment = createSpeechToTextDeployment(
      { settings },
      { isEuOnly: async () => true, fetch: fake.impl },
    );
    const service = createTranscriptionService({ settings, db: {} as never, deployment });
    await expect(service.transcribe(request)).rejects.toBeInstanceOf(
      InferenceRegionRestrictedError,
    );
    await expect(service.transcribe({ ...request, providerId: "openai" })).rejects.toBeInstanceOf(
      InferenceRegionRestrictedError,
    );
    expect(fake.calls).toEqual([]);
  });

  test("outside EU every provider stays available", async () => {
    const deployment = createSpeechToTextDeployment(
      { settings: testSettings(azureSpeech) },
      { isEuOnly: async () => false },
    );
    expect(await deployment.regionAllowed("openai", scope)).toBe(true);
    expect(await deployment.available("openai", scope)).toBe(true);
  });

  test("a declaration for another Azure Speech resource does not admit this one", async () => {
    const settings = testSettings({
      ...azureSpeech,
      sideFeatureResidencyJson: declare({
        "transcription.azure-speech": [
          "https://other.cognitiveservices.azure.com",
          declaration("azure_data_zone", "swedencentral"),
        ],
      }),
    });
    const deployment = createSpeechToTextDeployment({ settings }, { isEuOnly: async () => true });
    expect(await deployment.regionAllowed("azure-speech", scope)).toBe(false);
  });

  test("without a database the EU-only setting cannot be read, so every route is held to EU", async () => {
    const deployment = createSpeechToTextDeployment({ settings: testSettings(azureSpeech) });
    expect(await deployment.regionAllowed("openai", scope)).toBe(false);
  });
});

describe("feature availability", () => {
  test("outside EU every feature is available", () => {
    const availability = inferenceFeatureAvailability(testSettings());
    expect(availability.map((feature) => feature.id)).toEqual([...INFERENCE_FEATURE_IDS]);
    expect(availability.every((feature) => feature.available)).toBe(true);
    expect(availability.every((feature) => feature.unavailableReason === null)).toBe(true);
  });

  test("under EU a feature with no EU route reports region_restricted", () => {
    const availability = inferenceFeatureAvailability(
      testSettings({
        requiredModelGeography: "eu",
        webSearchEnabled: true,
        webSearchProvider: "searxng",
        webSearchProviderCredentials: { searxng: { baseUrl: "https://search.example.test" } },
        sideFeatureResidencyJson: declare({
          "web_search.searxng": ["https://search.example.test", declaration("self_hosted", "fsn1")],
        }),
      }),
    );
    const byId = new Map(availability.map((feature) => [feature.id, feature]));
    expect(byId.get("web_search")).toEqual({
      id: "web_search",
      available: true,
      unavailableReason: null,
    });
    for (const id of ["image_generation", "video_generation", "realtime_voice", "code_search"]) {
      expect(byId.get(id as never)).toEqual({
        id,
        available: false,
        unavailableReason: "region_restricted",
      });
    }
    expect(
      sideFeatureRouteUnavailableReason(
        testSettings({ requiredModelGeography: "eu" }),
        "video_generation.ai_gateway",
      ),
    ).toBe("Not supported in EU");
  });

  test("availability follows the route the deployment is configured to use", () => {
    // An EU declaration for a provider the deployment does not use changes nothing.
    const tavily = testSettings({
      requiredModelGeography: "eu",
      webSearchEnabled: true,
      webSearchProvider: "tavily",
      webSearchProviderCredentials: { tavily: { apiKey: "key" } },
      sideFeatureResidencyJson: declare({
        "web_search.firecrawl": ["https://crawl.example.test", declaration("self_hosted", "fsn1")],
        "knowledge.embeddings": [EMBEDDINGS, declaration("azure_data_zone", "swedencentral")],
      }),
    });
    const byId = (sources: Parameters<typeof inferenceFeatureAvailability>[1]) =>
      new Map(inferenceFeatureAvailability(tavily, sources).map((f) => [f.id, f.available]));
    expect(byId({}).get("web_search")).toBe(false);
    // Knowledge follows the configured embedder's endpoint; a local one sends nothing.
    expect(byId({}).get("knowledge_embeddings")).toBe(false);
    expect(byId({ embedder: { endpoint: EMBEDDINGS } }).get("knowledge_embeddings")).toBe(true);
    expect(
      byId({ embedder: { endpoint: "https://api.openai.com/v1" } }).get("knowledge_embeddings"),
    ).toBe(false);
    expect(byId({ embedder: { local: true } }).get("knowledge_embeddings")).toBe(true);
  });

  test("outside a turn the workspace setting decides, and only EU records pass", async () => {
    const settings = testSettings({
      sideFeatureResidencyJson: declare({
        "knowledge.embeddings": [EMBEDDINGS, declaration("azure_data_zone", "swedencentral")],
      }),
    });
    const target = { route: "knowledge.embeddings", endpoint: EMBEDDINGS } as const;
    const euOnly = async () => true;
    const notEuOnly = async () => false;
    expect(
      await sideFeatureAllowedForWorkspace(database, testSettings(), scope, target, euOnly),
    ).toBe(false);
    expect(await sideFeatureAllowedForWorkspace(database, settings, scope, target, euOnly)).toBe(
      true,
    );
    // The same declaration does not cover the vendor default host.
    expect(
      await sideFeatureAllowedForWorkspace(
        database,
        settings,
        scope,
        { ...target, endpoint: "https://api.openai.com/v1" },
        euOnly,
      ),
    ).toBe(false);
    expect(
      await sideFeatureAllowedForWorkspace(database, testSettings(), scope, target, notEuOnly),
    ).toBe(true);
    // A failed read of the setting never lets the call through.
    await expect(
      sideFeatureAllowedForWorkspace(database, testSettings(), scope, target, async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");
  });
});

describe("Knowledge semantic search under EU-only inference", () => {
  const context = { ...scope, actor: { kind: "human", subjectId: "user:a" } } as const;
  function fakeEmbedder(endpoint: string = "https://api.openai.com/v1") {
    const queries: string[] = [];
    let resolved = 0;
    return {
      queries,
      resolved: () => resolved,
      embedder: () => {
        resolved += 1;
        return {
          model: "embedding",
          dimensions: 3,
          endpoint,
          embedQuery: async (query: string) => {
            queries.push(query);
            return [1, 0, 0];
          },
          embedMany: async () => [[1, 0, 0]],
        } as never;
      },
    };
  }

  test("an EU-only workspace without an EU embedding route falls back to keyword, sending nothing", async () => {
    const euOnly = spyOn(db, "isWorkspaceEuOnly").mockResolvedValue(true);
    const list = spyOn(db, "listKnowledgeEntries").mockResolvedValue({
      entries: [],
      nextCursor: null,
    } as never);
    try {
      const fake = fakeEmbedder();
      const result = await searchKnowledgeEntries(
        database,
        context as never,
        { query: "where does it run", mode: "hybrid" },
        fake.embedder,
        testSettings(),
      );
      expect(result).toMatchObject({ searchMode: "keyword", fallbackReason: "region_restricted" });
      expect(fake.queries).toEqual([]);
      // Vector-only search has no keyword answer: it is refused.
      await expect(
        searchKnowledgeEntries(
          database,
          context as never,
          { query: "where does it run", mode: "vector" },
          fake.embedder,
          testSettings(),
        ),
      ).rejects.toBeInstanceOf(InferenceRegionRestrictedError);
      expect(fake.queries).toEqual([]);
    } finally {
      euOnly.mockRestore();
      list.mockRestore();
    }
  });

  test("the embedder is resolved once, so the region check covers the call that runs", async () => {
    const euOnly = spyOn(db, "isWorkspaceEuOnly").mockResolvedValue(true);
    const list = spyOn(db, "listKnowledgeEntries").mockResolvedValue({
      entries: [],
      nextCursor: null,
    } as never);
    try {
      // Declared EU for another endpoint than the one the embedder calls.
      const fake = fakeEmbedder("https://api.openai.com/v1");
      const result = await searchKnowledgeEntries(
        database,
        context as never,
        { query: "where does it run", mode: "hybrid" },
        fake.embedder,
        testSettings({
          sideFeatureResidencyJson: declare({
            "knowledge.embeddings": [EMBEDDINGS, declaration("azure_data_zone", "swedencentral")],
          }),
        }),
      );
      expect(result).toMatchObject({ searchMode: "keyword", fallbackReason: "region_restricted" });
      expect(fake.queries).toEqual([]);
      expect(fake.resolved()).toBe(1);
    } finally {
      euOnly.mockRestore();
      list.mockRestore();
    }
  });

  test("Knowledge preparation keeps the embedder's placement and residency settings for both views", async () => {
    const settings = testSettings();
    const seen: Array<{
      local: unknown;
      endpoint: unknown;
      metering: unknown;
      residency: unknown;
    }> = [];
    const search = (async (
      _db: unknown,
      _context: unknown,
      _request: unknown,
      embedder: () => { local?: boolean; endpoint?: string },
      metering?: unknown,
      ...rest: unknown[]
    ) => {
      const provider = embedder();
      // Like the real search, residency defaults to the metering settings.
      const residency = rest.length > 0 ? rest[0] : metering;
      seen.push({ local: provider.local, endpoint: provider.endpoint, metering, residency });
      return { entries: [], searchMode: "hybrid" };
    }) as never;
    await prepareKnowledgeSave(
      database,
      { ...context, actor: { kind: "agent", subjectId: "agent:a" } } as never,
      { query: "where does it run", collectionCursors: { published: null, needs_review: null } },
      () =>
        ({
          model: "local",
          dimensions: 3,
          local: true,
          endpoint: EMBEDDINGS,
          embedQuery: async () => [1, 0, 0],
          embedMany: async () => [[1, 0, 0]],
        }) as never,
      { get: (async () => null) as never, list: (async () => ({ entries: [] })) as never, search },
      settings,
    );
    expect(seen).toEqual([
      { local: true, endpoint: EMBEDDINGS, metering: settings, residency: settings },
      // The second view reuses the query embedding: it meters nothing, but its
      // region check still reads the residency declarations.
      { local: true, endpoint: EMBEDDINGS, metering: undefined, residency: settings },
    ]);
  });

  test("a deployment whose embedder cannot be resolved still falls back to keyword search", async () => {
    const euOnly = spyOn(db, "isWorkspaceEuOnly").mockResolvedValue(false);
    const list = spyOn(db, "listKnowledgeEntries").mockResolvedValue({
      entries: [],
      nextCursor: null,
    } as never);
    try {
      const result = await searchKnowledgeEntries(
        database,
        context as never,
        { query: "where does it run", mode: "hybrid" },
        () => {
          throw new Error("no embedding provider configured");
        },
        testSettings(),
      );
      expect(result).toMatchObject({
        searchMode: "keyword",
        fallbackReason: "provider_unavailable",
      });
    } finally {
      euOnly.mockRestore();
      list.mockRestore();
    }
  });
});
