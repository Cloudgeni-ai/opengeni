import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPENROUTER_MODEL_ID,
  OPENROUTER_BASE_URL,
  applyModelCatalogDocument,
  configuredModels,
  configuredProviders,
  getSettings,
  parseModelCatalogDocument,
} from "../src";

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { OPENGENI_OPENAI_API_KEY: "openai-test-key", ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

describe("deployment model catalog source", () => {
  test("injects the validated managed OpenRouter starter only when its key exists", () => {
    const absent = withEnv({}, () => getSettings());
    expect(configuredModels(absent).some((model) => model.id === DEFAULT_OPENROUTER_MODEL_ID)).toBe(
      false,
    );

    const settings = withEnv({ OPENGENI_OPENROUTER_API_KEY: "openrouter-test-key" }, () =>
      getSettings(),
    );
    const provider = configuredProviders(settings).find(
      (candidate) => candidate.id === "openrouter",
    );
    const model = configuredModels(settings).find(
      (candidate) => candidate.id === DEFAULT_OPENROUTER_MODEL_ID,
    );

    expect(provider).toMatchObject({
      kind: "openrouter-managed",
      api: "chat",
      wireProfile: "openai",
      baseUrl: OPENROUTER_BASE_URL,
      billing: { upstreamPayer: "deployment", metering: "external" },
    });
    expect(provider?.defaultHeaders).toMatchObject({ "x-title": "OpenGeni" });
    expect(model).toMatchObject({
      cost: "free",
      contextWindowTokens: 262_144,
      effectiveContextWindowTokens: 235_929,
      autoCompactTokenLimit: 220_000,
      capabilities: {
        functionCalling: { upstream: "supported", runnable: true },
        structuredOutput: { upstream: "supported", runnable: true },
      },
    });
  });

  test("keeps workspace-facing free or credits independent from provider settlement", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENROUTER_API_KEY: "openrouter-test-key",
        OPENGENI_MODEL_COST_POLICY_JSON: JSON.stringify({
          [DEFAULT_OPENROUTER_MODEL_ID]: "credits",
          "gpt-5.6-luna": "free",
        }),
      },
      () => getSettings(),
    );
    expect(
      configuredModels(settings).find((model) => model.id === DEFAULT_OPENROUTER_MODEL_ID),
    ).toMatchObject({
      cost: "credits",
      billing: { upstreamPayer: "deployment", metering: "external" },
    });
    expect(configuredModels(settings).find((model) => model.id === "gpt-5.6-luna")?.cost).toBe(
      "free",
    );
  });

  test("requires separate deployment pricing when managed billing marks OpenRouter as credits", () => {
    const managed = {
      OPENGENI_ENVIRONMENT: "production",
      OPENGENI_PRODUCT_ACCESS_MODE: "managed",
      OPENGENI_PUBLIC_BASE_URL: "https://managed.example.test",
      OPENGENI_BETTER_AUTH_SECRET: "managed-better-auth-secret",
      OPENGENI_DELEGATION_SECRET: "managed-delegation-secret",
      OPENGENI_RESEND_API_KEY: "re_test",
      OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      OPENGENI_BILLING_MODE: "stripe",
      OPENGENI_STRIPE_SECRET_KEY: "sk_test",
      OPENGENI_STRIPE_WEBHOOK_SECRET: "whsec_test",
      OPENGENI_OPENROUTER_API_KEY: "openrouter-test-key",
      OPENGENI_MODEL_COST_POLICY_JSON: JSON.stringify({
        [DEFAULT_OPENROUTER_MODEL_ID]: "credits",
      }),
    };

    expect(() => withEnv(managed, () => getSettings())).toThrow(
      `Missing model pricing for managed billing model(s): ${DEFAULT_OPENROUTER_MODEL_ID}`,
    );

    const settings = withEnv(
      {
        ...managed,
        OPENGENI_MODEL_PRICING_JSON: JSON.stringify({
          [DEFAULT_OPENROUTER_MODEL_ID]: {
            inputMicrosPerMillionTokens: 75_000,
            outputMicrosPerMillionTokens: 250_000,
          },
        }),
      },
      () => getSettings(),
    );
    expect(
      configuredModels(settings).find((model) => model.id === DEFAULT_OPENROUTER_MODEL_ID),
    ).toMatchObject({ cost: "credits" });
  });

  test("rejects reserved provider ids in host JSON", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: "openrouter",
              baseUrl: "https://host-openrouter.example.test/v1",
              apiKey: "host-key",
              models: [{ id: "host/model" }],
            },
          ]),
        },
        () => getSettings(),
      ),
    ).toThrow("provider id openrouter is reserved");
  });

  test("validates a secret-free singleton document and line-safe model notes", () => {
    const document = parseModelCatalogDocument({
      schemaVersion: 1,
      builtInModels: ["gpt-5.6-luna"],
      modelNotes: { "gpt-5.6-luna": "Use for careful work." },
    });
    const settings = applyModelCatalogDocument(
      withEnv({}, () => getSettings()),
      document,
    );
    expect(settings.openaiModel).toBe("gpt-5.6-luna");
    expect(settings.openaiAllowedModels).toBe("");
    expect(settings.modelNotesJson).toBe(JSON.stringify(document.modelNotes));

    for (const note of ["bad\nnote", "bad|note", "x".repeat(501)]) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          modelNotes: { "gpt-5.6-luna": note },
        }),
      ).toThrow();
    }
    for (const forbidden of ["apiKey", "billing", "enabled", "bands"] as const) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          [forbidden]: {},
        }),
      ).toThrow();
    }
    expect(() =>
      parseModelCatalogDocument({
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        modelNotes: { "unknown/model": "Unknown models are rejected." },
      }),
    ).toThrow("model note references a product id outside the deployment catalog");
  });
});
