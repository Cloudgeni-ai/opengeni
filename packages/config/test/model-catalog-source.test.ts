import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_COST_POLICY_JSON,
  DEFAULT_OPENROUTER_MODEL_ID,
  OPENROUTER_BASE_URL,
  applyModelCatalogDocument,
  configuredModels,
  configuredProviders,
  getSettings,
  parseModelCatalogDocument,
  resolveTurnExecutionPolicyV1,
  validateModelCatalogSettings,
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

  test("defaults cost policy by catalog source without weakening explicit policy validation", () => {
    const code = withEnv({}, () => getSettings());
    expect(code.modelCostPolicyJson).toBe(DEFAULT_MODEL_COST_POLICY_JSON);

    const database = withEnv({ OPENGENI_MODEL_CATALOG_SOURCE: "database" }, () => getSettings());
    expect(database.modelCostPolicyJson).toBe("{}");

    const explicit = withEnv(
      {
        OPENGENI_MODEL_CATALOG_SOURCE: "database",
        OPENGENI_MODEL_COST_POLICY_JSON: JSON.stringify({ "database/model": "free" }),
      },
      () => getSettings(),
    );
    expect(explicit.modelCostPolicyJson).toBe(JSON.stringify({ "database/model": "free" }));
  });

  test("allows database deployments to stage cost before future catalog membership", () => {
    const settings = withEnv(
      {
        OPENGENI_MODEL_CATALOG_SOURCE: "database",
        OPENGENI_MODEL_COST_POLICY_JSON: JSON.stringify({ "future/database-model": "free" }),
      },
      () =>
        applyModelCatalogDocument(getSettings(), {
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
        }),
    );
    expect(() => validateModelCatalogSettings(settings)).not.toThrow();
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
      withEnv({ OPENGENI_MODEL_CATALOG_SOURCE: "database" }, () => getSettings()),
      document,
    );
    expect(settings.openaiModel).toBe("gpt-5.6-luna");
    expect(settings.openaiAllowedModels).toBe("gpt-5.6-luna");
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
        registryProviders: [
          {
            id: "database-provider",
            baseUrl: "https://provider.example.test/v1",
            apiKeyEnv: "AWS_SECRET_ACCESS_KEY",
            models: [{ id: "database/model" }],
          },
        ],
      }),
    ).toThrow();
    for (const [baseUrl, message] of [
      ["https://user:password@provider.example.test/v1", "must not contain userinfo"],
      ["https://provider.example.test/v1?api_key=secret", "must not contain a query"],
      ["https://provider.example.test/v1#secret", "must not contain a fragment"],
    ] as const) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          registryProviders: [
            {
              id: "database-provider",
              baseUrl,
              models: [{ id: "database/model" }],
            },
          ],
        }),
      ).toThrow(message);
    }
    for (const kind of [
      "codex-subscription",
      "xai-subscription",
      "vercel-gateway-managed",
      "vercel-gateway-workspace",
    ] as const) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          registryProviders: [
            {
              kind,
              id: "database-provider",
              baseUrl: "https://provider.example.test/v1",
              models: [{ id: "database/model" }],
            },
          ],
        }),
      ).toThrow();
    }
    for (const forbidden of [
      "defaultHeaders",
      "defaultQuery",
      "publicDefaultHeaderNames",
      "publicDefaultQueryNames",
    ] as const) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          registryProviders: [
            {
              id: "database-provider",
              baseUrl: "https://provider.example.test/v1",
              models: [{ id: "database/model" }],
              [forbidden]: forbidden.endsWith("Names") ? ["version"] : { version: "v1" },
            },
          ],
        }),
      ).toThrow();
    }
    for (const productId of ["bad\nmodel", "bad|model"]) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: [productId],
        }),
      ).toThrow("catalog product ids must not contain newlines or the | field separator");
    }
    expect(() =>
      parseModelCatalogDocument({
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        modelNotes: { "unknown/model": "Unknown models are rejected." },
      }),
    ).toThrow("model note references a product id outside the deployment catalog");

    for (const providerId of ["openrouter", "openai"]) {
      expect(() =>
        parseModelCatalogDocument({
          schemaVersion: 1,
          builtInModels: ["gpt-5.6-luna"],
          registryProviders: [
            {
              kind: "anonymous",
              id: providerId,
              baseUrl: "https://provider.example.test/v1",
              models: [{ id: `database/${providerId}` }],
            },
          ],
        }),
      ).toThrow("reserved for a reviewed OpenGeni provider");
    }
    expect(() =>
      parseModelCatalogDocument({
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        registryProviders: [
          {
            kind: "anonymous",
            id: "database-provider",
            baseUrl: "https://one.example.test/v1",
            models: [{ id: "database/one" }],
          },
          {
            kind: "anonymous",
            id: "database-provider",
            baseUrl: "https://two.example.test/v1",
            models: [{ id: "database/two" }],
          },
        ],
      }),
    ).toThrow("duplicate provider id database-provider");

    expect(() =>
      parseModelCatalogDocument({
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        gatewayModels: [
          {
            productId: "gateway/one",
            workspaceProductId: "workspace-gateway/one",
            upstreamModelId: "provider/shared",
            label: "One",
            providers: ["provider-a"],
          },
          {
            productId: "gateway/two",
            workspaceProductId: "workspace-gateway/two",
            upstreamModelId: "provider/shared",
            label: "Two",
            providers: ["provider-b"],
          },
        ],
      }),
    ).toThrow("duplicate Gateway upstream model id provider/shared");
    expect(() =>
      parseModelCatalogDocument({
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        registryProviders: [
          {
            kind: "anonymous",
            id: "database-provider",
            baseUrl: "https://provider.example.test/v1",
            models: [
              {
                id: "database/priced",
                pricing: {
                  inputMicrosPerMillionTokens: 1,
                  outputMicrosPerMillionTokens: 1,
                },
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseModelCatalogDocument({
        schemaVersion: 1,
        builtInModels: ["gpt-5.6-luna"],
        gatewayModels: [
          {
            productId: "gateway/priced",
            workspaceProductId: "workspace-gateway/priced",
            upstreamModelId: "provider/priced",
            label: "Priced",
            providers: ["provider"],
            pricing: {
              inputMicrosPerMillionTokens: 1,
              outputMicrosPerMillionTokens: 1,
            },
          },
        ],
      }),
    ).toThrow();
  });

  test("preserves an explicit non-built-in default across database catalog cutover", () => {
    const settings = applyModelCatalogDocument(
      withEnv({}, () => getSettings()),
      {
        schemaVersion: 1,
        defaultModel: "database/default-model",
        builtInModels: ["gpt-5.6-luna"],
        registryProviders: [
          {
            kind: "anonymous",
            id: "database-provider",
            baseUrl: "https://provider.example.test/v1",
            models: [{ id: "database/default-model" }],
          },
        ],
      },
    );

    expect(settings.openaiModel).toBe("database/default-model");
    expect(configuredModels(settings)[0]?.id).toBe("database/default-model");
    expect(() =>
      validateModelCatalogSettings(
        applyModelCatalogDocument(
          withEnv({ OPENGENI_MODEL_CATALOG_SOURCE: "database" }, () => getSettings()),
          {
            schemaVersion: 1,
            defaultModel: "database/missing",
            builtInModels: ["gpt-5.6-luna"],
          },
        ),
      ),
    ).toThrow("catalog default model must reference deployment catalog membership");
  });

  test("allows an enabled connected-subscription default in a database document", () => {
    const settings = applyModelCatalogDocument(
      withEnv(
        {
          OPENGENI_MODEL_CATALOG_SOURCE: "database",
          OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
        },
        () => getSettings(),
      ),
      {
        schemaVersion: 1,
        defaultModel: "codex/gpt-5.6-sol",
        builtInModels: ["gpt-5.6-luna"],
      },
    );

    expect(validateModelCatalogSettings(settings)[0]?.id).toBe("gpt-5.6-luna");
    expect(settings.openaiModel).toBe("codex/gpt-5.6-sol");
    expect(
      resolveTurnExecutionPolicyV1(settings, {
        modelId: settings.openaiModel,
        requestedModelId: null,
        modelSource: "deployment",
        reasoningEffort: "low",
        reasoningSource: "deployment",
        latencyMode: "standard",
        latencyModeSource: "deployment",
      }),
    ).toMatchObject({
      productModelId: "codex/gpt-5.6-sol",
      providerId: "codex-subscription",
    });
  });

  test("rejects a resolved catalog with no executable default model", () => {
    const settings = applyModelCatalogDocument(
      getSettings({
        OPENGENI_OPENAI_API_KEY: "openai-test-key",
        OPENGENI_MODEL_CATALOG_SOURCE: "database",
      }),
      {
        schemaVersion: 1,
        builtInModels: ["codex/not-connected"],
      },
    );
    expect(() =>
      validateModelCatalogSettings(settings, {
        OPENGENI_OPENAI_API_KEY: "openai-test-key",
      }),
    ).toThrow("contains no executable models");
  });

  test("allows an enabled connected-subscription model as the code-mode default", () => {
    expect(() =>
      getSettings({
        OPENGENI_OPENAI_API_KEY: "openai-test-key",
        OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
        OPENGENI_OPENAI_MODEL: "codex/gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "codex/gpt-5.6-sol",
      }),
    ).not.toThrow();
  });

  test("resolves host provider credentials from an explicit environment", () => {
    const env = {
      OPENGENI_OPENAI_API_KEY: "openai-test-key",
      HOST_PROVIDER_KEY: "provider-test-key",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: "host-provider",
          baseUrl: "https://provider.example.test/v1",
          apiKeyEnv: "HOST_PROVIDER_KEY",
          models: [{ id: "host/model" }],
        },
      ]),
    };
    const settings = getSettings(env);
    expect(
      configuredProviders(settings, env).find((provider) => provider.id === "host-provider"),
    ).toMatchObject({ apiKey: "provider-test-key" });
  });

  test("binds database-owned provider membership only to host-authorized credentials", () => {
    const { settings, models } = withEnv(
      {
        FIREWORKS_DATABASE_KEY: "fireworks-secret",
        OPENGENI_MODEL_CATALOG_SOURCE: "database",
        OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id: "fireworks",
            baseUrl: "https://api.fireworks.ai/inference/v1",
            apiKeyEnv: "FIREWORKS_DATABASE_KEY",
            defaultHeaders: {
              "x-api-key": "header-secret",
              "x-public-version": "2026-08-28",
            },
            publicDefaultHeaderNames: ["x-public-version"],
            defaultQuery: { access_token: "query-secret", version: "v1" },
            publicDefaultQueryNames: ["version"],
            models: [{ id: "host/placeholder" }],
          },
        ]),
      },
      () => {
        const resolved = applyModelCatalogDocument(
          getSettings(),
          parseModelCatalogDocument({
            schemaVersion: 1,
            builtInModels: ["gpt-5.6-luna"],
            registryProviders: [
              {
                id: "fireworks",
                baseUrl: "https://api.fireworks.ai/inference/v1",
                models: [{ id: "fireworks/database-model" }],
              },
            ],
          }),
        );
        return { settings: resolved, models: validateModelCatalogSettings(resolved) };
      },
    );
    const [provider] = JSON.parse(settings.modelProvidersJson) as Array<{
      baseUrl: string;
      apiKeyEnv?: string;
      defaultHeaders?: Record<string, string>;
      defaultQuery?: Record<string, string>;
      models: Array<{ id: string }>;
    }>;
    expect(provider).toMatchObject({
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKeyEnv: "FIREWORKS_DATABASE_KEY",
      defaultHeaders: {
        "x-api-key": "header-secret",
        "x-public-version": "2026-08-28",
      },
      defaultQuery: { access_token: "query-secret", version: "v1" },
      models: [{ id: "fireworks/database-model" }],
    });
    expect(models).toBeArray();
  });

  test("rejects a database provider that redirects a host-authorized API key", () => {
    expect(() =>
      withEnv(
        {
          FIREWORKS_DATABASE_KEY: "fireworks-secret",
          OPENGENI_MODEL_CATALOG_SOURCE: "database",
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: "fireworks",
              baseUrl: "https://api.fireworks.ai/inference/v1",
              apiKeyEnv: "FIREWORKS_DATABASE_KEY",
              models: [{ id: "host/placeholder" }],
            },
          ]),
        },
        () =>
          applyModelCatalogDocument(getSettings(), {
            schemaVersion: 1,
            builtInModels: ["gpt-5.6-luna"],
            registryProviders: [
              {
                id: "fireworks",
                baseUrl: "https://attacker.example.test/v1",
                models: [{ id: "fireworks/database-model" }],
              },
            ],
          }),
      ),
    ).toThrow("does not match its host-authorized transport");
  });
});
