import { expect, test } from "bun:test";
import {
  parseModelCostPolicyJson,
  parseModelPricingJson,
  parseModelProvidersJson,
} from "../src/index";

const providers = [
  {
    id: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1/",
    apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY",
    defaultHeaders: { "X-Trace": "1" },
    publicDefaultHeaderNames: ["x-trace"],
    models: [
      {
        id: "accounts/fireworks/models/glm-5p2",
        pricing: {
          inputMicrosPerMillionTokens: 1_000_000,
          cachedInputMicrosPerMillionTokens: 100_000,
          outputMicrosPerMillionTokens: 2_000_000,
        },
      },
    ],
  },
  {
    id: "azure-secondary",
    api: "responses",
    wireProfile: "azure-openai",
    baseUrl: "https://secondary.openai.azure.com/openai/v1",
    apiKey: "az-test",
    models: [{ id: "gpt-5.6-terra" }],
  },
];
const pricing = {
  "gpt-x": {
    inputMicrosPerMillionTokens: 1,
    cachedInputMicrosPerMillionTokens: 1,
    outputMicrosPerMillionTokens: 2,
  },
};

test("a repeated settings text parses to the same value as a first parse, as an independent copy", () => {
  for (const [parse, value] of [
    [parseModelProvidersJson, providers],
    [parseModelPricingJson, pricing],
    [parseModelCostPolicyJson, { "gpt-x": "free", "gpt-y": "credits" }],
  ] as Array<[(raw: string) => unknown, unknown]>) {
    const raw = JSON.stringify(value);
    // Whitespace makes another key, so this is a genuinely fresh parse.
    const fresh = parse(JSON.stringify(value, null, 1));
    const first = parse(raw);
    const repeated = parse(raw);
    expect(first).toStrictEqual(fresh);
    expect(repeated).toStrictEqual(fresh);
    expect(repeated).not.toBe(first);
    // A caller that changes its copy cannot change what the next caller gets.
    (repeated as Record<string, unknown>)["0"] = "changed";
    if (Array.isArray(repeated)) (repeated as unknown[]).length = 0;
    expect(parse(raw)).toStrictEqual(fresh);
  }
});

test("invalid settings text throws the parser's error on every call", () => {
  const invalid = JSON.stringify([{ id: "missing-base-url", models: [] }]);
  const message = (() => {
    try {
      parseModelProvidersJson(invalid);
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  })();
  expect(message).toStartWith("OPENGENI_MODEL_PROVIDERS_JSON provider[0] is invalid");
  expect(() => parseModelProvidersJson(invalid)).toThrow(message!);
  expect(() => parseModelPricingJson("{")).toThrow(
    "OPENGENI_MODEL_PRICING_JSON must be valid JSON",
  );
  expect(() => parseModelPricingJson("{")).toThrow(
    "OPENGENI_MODEL_PRICING_JSON must be valid JSON",
  );
});
