import { afterEach, describe, expect, test } from "bun:test";
import {
  bedrockClaudeBaseModelId,
  bedrockModelPricing,
  bedrockProductModelId,
  calculateModelUsageCostBreakdown,
  claudeNativeModelProfile,
  configuredModelListPricingSchedules,
  configuredModels,
  configuredProviders,
  getSettings,
  setBedrockDiscoveredModels,
} from "../src/index";
import { testSettings } from "@opengeni/testing/settings";

const APP = "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/a1b2c3";
afterEach(() => setBedrockDiscoveredModels([]));

describe("Bedrock model ids", () => {
  test.each([
    ["eu.anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["global.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["us-gov.anthropic.claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["apac.anthropic.claude-opus-4-6-v1", "claude-opus-4-6"],
    ["anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001"],
    [
      "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-opus-5-5",
      "claude-opus-5-5",
    ],
    ["arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-opus-5-5", "claude-opus-5-5"],
  ])("%s serves %s", (id, base) => {
    expect(bedrockClaudeBaseModelId(id)).toBe(base);
    expect(claudeNativeModelProfile(id)).toBe(claudeNativeModelProfile(base));
  });

  test("non-Claude ids and unresolved application profiles have no Claude base", () => {
    expect(bedrockClaudeBaseModelId("eu.amazon.nova-pro-v1:0")).toBeUndefined();
    expect(bedrockClaudeBaseModelId("claude-opus-5-5")).toBeUndefined();
    expect(bedrockClaudeBaseModelId(APP)).toBeUndefined();
    setBedrockDiscoveredModels([
      { upstreamModelId: APP, baseUpstreamModelId: "global.anthropic.claude-opus-5-5" },
    ]);
    expect(bedrockClaudeBaseModelId(APP)).toBe("claude-opus-5-5");
  });

  test("product ids keep account and region out of ARNs", () => {
    expect(bedrockProductModelId("eu.anthropic.claude-opus-5-5")).toBe(
      "bedrock/eu.anthropic.claude-opus-5-5",
    );
    expect(bedrockProductModelId(APP)).toBe("bedrock/application-inference-profile/a1b2c3");
  });
});

describe("Bedrock pricing", () => {
  test("global profiles cost Anthropic's list price, geographic and in-Region 10% more", () => {
    expect(bedrockModelPricing("global.anthropic.claude-opus-5-5")?.default).toMatchObject({
      inputMicrosPerMillionTokens: 4_000_000,
      cachedInputMicrosPerMillionTokens: 200_000,
      cacheWriteMicrosPerMillionTokens: 5_000_000,
      outputMicrosPerMillionTokens: 20_000_000,
    });
    expect(bedrockModelPricing("eu.anthropic.claude-opus-5-5")?.default).toMatchObject({
      inputMicrosPerMillionTokens: 4_400_000,
      cachedInputMicrosPerMillionTokens: 220_000,
      cacheWriteMicrosPerMillionTokens: 5_500_000,
      outputMicrosPerMillionTokens: 22_000_000,
    });
    // Haiku 5.5's long-input tier scales too.
    const haiku = bedrockModelPricing("eu.anthropic.claude-haiku-5-5");
    expect(haiku?.inputTokenTiers?.[0]?.pricing.inputMicrosPerMillionTokens).toBeGreaterThan(0);
    expect(bedrockModelPricing(APP)).toBeUndefined();
    setBedrockDiscoveredModels([
      { upstreamModelId: APP, baseUpstreamModelId: "global.anthropic.claude-opus-5-5" },
    ]);
    expect(bedrockModelPricing(APP)?.default.inputMicrosPerMillionTokens).toBe(4_000_000);
  });
});

describe("Bedrock provider", () => {
  const settings = (overrides: Record<string, unknown> = {}) =>
    testSettings({
      bedrockRegion: "eu-west-1",
      bedrockModels:
        "eu.anthropic.claude-opus-5-5, bedrock/global.anthropic.claude-sonnet-5-5,eu.amazon.nova-pro-v1:0",
      ...overrides,
    });
  const bedrockModels = (value = settings()) =>
    configuredModels(value).filter((model) => model.providerId === "bedrock");

  test("is off without a region", () => {
    expect(configuredProviders(testSettings()).some((p) => p.id === "bedrock")).toBe(false);
  });

  test("serves native Claude Messages on bedrock-runtime with the deployment's AWS identity", () => {
    const provider = configuredProviders(settings()).find((p) => p.id === "bedrock")!;
    expect(provider).toMatchObject({
      label: "Amazon Bedrock",
      api: "anthropic-messages",
      baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic/v1",
      bedrock: { region: "eu-west-1" },
      credentialSource: { kind: "deployment", mechanism: "aws_iam" },
    });
    expect(provider.apiKey).toBeUndefined();
    const custom = configuredProviders(
      settings({
        bedrockEndpointUrl: "https://vpce-0abc.bedrock-runtime.eu-west-1.vpce.amazonaws.com/",
      }),
    ).find((p) => p.id === "bedrock")!;
    expect(custom.baseUrl).toBe(
      "https://vpce-0abc.bedrock-runtime.eu-west-1.vpce.amazonaws.com/anthropic/v1",
    );
  });

  test("lists Claude models with profile limits, prices and residency; other vendors are left out", () => {
    const models = bedrockModels();
    expect(models.map((model) => [model.id, model.label])).toEqual([
      ["bedrock/eu.anthropic.claude-opus-5-5", "Claude Opus 5.5 (EU)"],
      ["bedrock/global.anthropic.claude-sonnet-5-5", "Claude Sonnet 5.5 (Global)"],
    ]);
    const [opus, sonnet] = models;
    expect(opus).toMatchObject({
      upstreamModelId: "eu.anthropic.claude-opus-5-5",
      contextWindowTokens: 1_000_000,
      reasoningEffort: true,
      // Anthropic's server-side web search does not run on Bedrock.
      hostedWebSearch: false,
      residency: { geography: "eu", deploymentType: "bedrock_geo_profile" },
    });
    expect(opus!.capabilities.promptCaching?.runnable).toBe(true);
    expect(sonnet!.residency).toMatchObject({
      geography: "global",
      deploymentType: "bedrock_global_profile",
    });
    expect(
      configuredModelListPricingSchedules(settings())["bedrock/eu.anthropic.claude-opus-5-5"]
        ?.default.outputMicrosPerMillionTokens,
    ).toBe(22_000_000);
    // Usage is recorded at Bedrock's rate for the route.
    expect(
      calculateModelUsageCostBreakdown(settings(), "bedrock/eu.anthropic.claude-opus-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      }).providerCostMicros,
    ).toBe(4_400_000 + 2_200_000);
  });

  test("discovered models join the list, and application profiles carry their name and base", () => {
    setBedrockDiscoveredModels([
      { upstreamModelId: "global.anthropic.claude-opus-5-5" },
      { upstreamModelId: APP, baseUpstreamModelId: "eu.anthropic.claude-opus-5-5", name: "team-a" },
    ]);
    const app = bedrockModels().find((model) => model.upstreamModelId === APP)!;
    expect(app).toMatchObject({
      id: "bedrock/application-inference-profile/a1b2c3",
      label: "team-a (Claude Opus 5.5)",
      reasoningEffort: true,
    });
    expect(app.pricing?.default.inputMicrosPerMillionTokens).toBe(4_400_000);
    expect(bedrockModels().some((m) => m.id === "bedrock/global.anthropic.claude-opus-5-5")).toBe(
      true,
    );
  });

  test("a bedrock/ default model works without listing it", () => {
    const value = testSettings({
      bedrockRegion: "eu-west-1",
      openaiModel: "bedrock/eu.anthropic.claude-opus-5-5",
    });
    const models = configuredModels(value);
    expect(models[0]).toMatchObject({
      id: "bedrock/eu.anthropic.claude-opus-5-5",
      providerId: "bedrock",
    });
  });

  test("settings reject a malformed region or attribution role", () => {
    const env = (values: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, values);
      try {
        return getSettings();
      } finally {
        process.env = saved;
      }
    };
    expect(() => env({ OPENGENI_BEDROCK_REGION: "europe" })).toThrow("AWS region");
    expect(() =>
      env({ OPENGENI_BEDROCK_REGION: "eu-west-1", OPENGENI_BEDROCK_ATTRIBUTION_ROLE_ARN: "x" }),
    ).toThrow("IAM role ARN");
    expect(
      env({
        OPENGENI_BEDROCK_REGION: "eu-west-1",
        OPENGENI_BEDROCK_MODEL_DISCOVERY: "false",
        OPENGENI_BEDROCK_ATTRIBUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/opengeni-users",
      }),
    ).toMatchObject({ bedrockRegion: "eu-west-1", bedrockModelDiscovery: false });
  });
});
