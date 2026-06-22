import { describe, expect, test } from "bun:test";
import {
  configuredAllowedModels,
  configuredModelPricing,
  configuredModels,
  configuredProviders,
  defaultModelPricing,
  getSettings,
  parseModelProvidersJson,
  resolveModelProvider,
  resolveProviderApiKey,
} from "../src";

// A reusable Fireworks/GLM-5.2 registry JSON mirroring the doc's host example.
// Uses an inline apiKey so the registry resolves without touching process.env.
const fireworksRegistry = JSON.stringify([
  {
    id: "fireworks",
    label: "Fireworks AI",
    api: "chat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKey: "fw_inline",
    models: [
      {
        id: "accounts/fireworks/models/glm-5p2",
        label: "GLM 5.2",
        contextWindowTokens: 1_048_576,
        reasoningEffort: true,
        hostedWebSearch: false,
      },
    ],
  },
]);

describe("parseModelProvidersJson", () => {
  test("returns an empty list for the default/empty value", () => {
    expect(parseModelProvidersJson("[]")).toEqual([]);
    expect(parseModelProvidersJson("")).toEqual([]);
    expect(parseModelProvidersJson("   ")).toEqual([]);
  });

  test("parses a valid provider registry and applies defaults", () => {
    const providers = parseModelProvidersJson(JSON.stringify([
      {
        id: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY",
        models: [{ id: "accounts/fireworks/models/glm-5p2" }],
      },
    ]));
    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    // api defaults to "chat" for registry providers; label is optional here.
    expect(provider.api).toBe("chat");
    expect(provider.label).toBeUndefined();
    expect(provider.models[0]?.id).toBe("accounts/fireworks/models/glm-5p2");
  });

  test("rejects non-array JSON", () => {
    expect(() => parseModelProvidersJson('{"id":"fireworks"}')).toThrow("must be a JSON array");
  });

  test("rejects malformed JSON", () => {
    expect(() => parseModelProvidersJson("[not json")).toThrow("must be valid JSON");
  });

  test("rejects an entry missing a required field, naming the index", () => {
    // baseUrl is required; provider[0] omits it.
    expect(() => parseModelProvidersJson(JSON.stringify([
      { id: "fireworks", apiKey: "fw", models: [{ id: "m" }] },
    ]))).toThrow("provider[0] is invalid");
  });

  test("rejects a provider id with illegal characters", () => {
    expect(() => parseModelProvidersJson(JSON.stringify([
      { id: "fire works", baseUrl: "https://x.test", apiKey: "fw", models: [{ id: "m" }] },
    ]))).toThrow("provider[0] is invalid");
  });

  test("rejects a provider with an empty models list", () => {
    expect(() => parseModelProvidersJson(JSON.stringify([
      { id: "fireworks", baseUrl: "https://x.test", apiKey: "fw", models: [] },
    ]))).toThrow("provider[0] is invalid");
  });
});

describe("resolveProviderApiKey", () => {
  test("prefers an inline apiKey", () => {
    expect(resolveProviderApiKey({ apiKey: "inline", apiKeyEnv: "SOME_ENV" }, { SOME_ENV: "from-env" })).toBe("inline");
  });

  test("falls back to the named env var", () => {
    expect(resolveProviderApiKey({ apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY" }, { OPENGENI_FIREWORKS_API_KEY: "fw_env" })).toBe("fw_env");
  });

  test("returns undefined when neither inline nor env is resolvable", () => {
    expect(resolveProviderApiKey({ apiKeyEnv: "MISSING" }, {})).toBeUndefined();
    expect(resolveProviderApiKey({ apiKeyEnv: "BLANK" }, { BLANK: "  " })).toBeUndefined();
    expect(resolveProviderApiKey({})).toBeUndefined();
  });
});

describe("configuredProviders", () => {
  test("built-in OpenAI provider first with server compaction, then registry providers with client compaction", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
    }, () => getSettings());
    const providers = configuredProviders(settings);
    expect(providers.map((provider) => provider.id)).toEqual(["openai", "fireworks"]);
    expect(providers[0]).toMatchObject({
      id: "openai",
      label: "OpenAI",
      api: "responses",
      builtin: true,
      apiKey: "sk-test",
      compactionMode: "server",
    });
    expect(providers[1]).toMatchObject({
      id: "fireworks",
      label: "Fireworks AI",
      api: "chat",
      builtin: false,
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw_inline",
      compactionMode: "client",
    });
  });

  test("built-in Azure provider id/label and client compaction", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
      OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
    }, () => getSettings());
    const builtin = configuredProviders(settings)[0]!;
    expect(builtin).toMatchObject({
      id: "azure",
      label: "Azure OpenAI",
      api: "responses",
      builtin: true,
      baseUrl: "https://res.openai.azure.com/openai/v1",
      apiKey: "az-key",
      // Azure rejects server-side context_management, so it must run client compaction.
      compactionMode: "client",
    });
  });
});

describe("configuredModels", () => {
  test("with no registry returns exactly the built-in allow-list, default model first", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4,gpt-5.4-mini",
    }, () => getSettings());
    const models = configuredModels(settings);
    expect(models.map((model) => model.id)).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(models[0]).toMatchObject({
      id: "gpt-5.5",
      label: "gpt-5.5",
      providerId: "openai",
      providerLabel: "OpenAI",
      api: "responses",
      contextWindowTokens: settings.contextWindowTokens,
      reasoningEffort: true,
      hostedWebSearch: settings.webSearchEnabled,
    });
  });

  test("unions built-in models first, then registry models in declaration order", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4",
      OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
    }, () => getSettings());
    const models = configuredModels(settings);
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "accounts/fireworks/models/glm-5p2",
    ]);
    const glm = models.find((model) => model.id === "accounts/fireworks/models/glm-5p2")!;
    expect(glm).toMatchObject({
      label: "GLM 5.2",
      providerId: "fireworks",
      providerLabel: "Fireworks AI",
      api: "chat",
      contextWindowTokens: 1_048_576,
      reasoningEffort: true,
      hostedWebSearch: false,
    });
  });

  test("registry model defaults: label falls back to id, reasoningEffort/hostedWebSearch default false", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: "acme",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "acme-key",
          models: [{ id: "acme/model-a" }],
        },
      ]),
    }, () => getSettings());
    const model = configuredModels(settings).find((candidate) => candidate.id === "acme/model-a")!;
    expect(model).toMatchObject({
      label: "acme/model-a",
      providerId: "acme",
      providerLabel: "acme",
      api: "chat",
      reasoningEffort: false,
      hostedWebSearch: false,
    });
    expect(model.contextWindowTokens).toBeUndefined();
  });

  test("de-dups by id with first (built-in) winning when a registry repeats it", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: "shadow",
          baseUrl: "https://api.shadow.test/v1",
          apiKey: "shadow-key",
          // Redeclares the built-in default model id; built-in entry must win.
          models: [{ id: "gpt-5.5", label: "Shadowed" }, { id: "shadow/only" }],
        },
      ]),
    }, () => getSettings());
    const models = configuredModels(settings);
    expect(models.map((model) => model.id)).toEqual(["gpt-5.5", "gpt-5.4", "shadow/only"]);
    const gpt = models.find((model) => model.id === "gpt-5.5")!;
    expect(gpt.providerId).toBe("openai");
    expect(gpt.label).toBe("gpt-5.5");
  });
});

describe("configuredAllowedModels", () => {
  test("with no registry is exactly today's behaviour: default model first, then the allow-list", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "custom-model",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.5,gpt-5.4",
    }, () => getSettings());
    expect(configuredAllowedModels(settings)).toEqual(["custom-model", "gpt-5.5", "gpt-5.4"]);
  });

  test("appends registry ids after the built-in allow-list", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4",
      OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
    }, () => getSettings());
    expect(configuredAllowedModels(settings)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "accounts/fireworks/models/glm-5p2",
    ]);
  });
});

describe("resolveModelProvider", () => {
  test("resolves a built-in model to the built-in provider", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_OPENAI_MODEL: "gpt-5.5",
      OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
    }, () => getSettings());
    const resolved = resolveModelProvider(settings, "gpt-5.5");
    expect(resolved).toBeDefined();
    expect(resolved!.provider.id).toBe("openai");
    expect(resolved!.provider.builtin).toBe(true);
    expect(resolved!.provider.api).toBe("responses");
    expect(resolved!.model.id).toBe("gpt-5.5");
  });

  test("resolves a registry model to its registry provider", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
    }, () => getSettings());
    const resolved = resolveModelProvider(settings, "accounts/fireworks/models/glm-5p2");
    expect(resolved).toBeDefined();
    expect(resolved!.provider.id).toBe("fireworks");
    expect(resolved!.provider.builtin).toBe(false);
    expect(resolved!.provider.api).toBe("chat");
    expect(resolved!.provider.compactionMode).toBe("client");
    expect(resolved!.model.contextWindowTokens).toBe(1_048_576);
  });

  test("returns undefined for a model that is not exposed", () => {
    const settings = withEnv({ OPENGENI_OPENAI_API_KEY: "sk-test" }, () => getSettings());
    expect(resolveModelProvider(settings, "not-a-real-model")).toBeUndefined();
  });
});

describe("configuredModelPricing", () => {
  test("includes the built-in GLM-5.2 default pricing entry", () => {
    expect(defaultModelPricing["accounts/fireworks/models/glm-5p2"]).toEqual({
      inputMicrosPerMillionTokens: 1_400_000,
      cachedInputMicrosPerMillionTokens: 260_000,
      outputMicrosPerMillionTokens: 4_400_000,
      marginBps: 2_500,
    });
  });

  test("merge precedence: registry model pricing overrides defaults, explicit JSON overrides registry", () => {
    const settings = withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: "fireworks",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          apiKey: "fw",
          models: [
            {
              id: "accounts/fireworks/models/glm-5p2",
              // Registry override differs from the built-in default.
              pricing: {
                inputMicrosPerMillionTokens: 999_000,
                outputMicrosPerMillionTokens: 999_000,
              },
            },
            {
              id: "fireworks/another",
              pricing: {
                inputMicrosPerMillionTokens: 111_000,
                outputMicrosPerMillionTokens: 222_000,
              },
            },
          ],
        },
      ]),
      // Explicit JSON wins over the registry entry for the same id.
      OPENGENI_MODEL_PRICING_JSON: JSON.stringify({
        "accounts/fireworks/models/glm-5p2": {
          inputMicrosPerMillionTokens: 1_000,
          outputMicrosPerMillionTokens: 2_000,
        },
      }),
    }, () => getSettings());
    const pricing = configuredModelPricing(settings);
    // explicit OPENGENI_MODEL_PRICING_JSON beats both registry + default.
    expect(pricing["accounts/fireworks/models/glm-5p2"]).toEqual({
      inputMicrosPerMillionTokens: 1_000,
      outputMicrosPerMillionTokens: 2_000,
    });
    // registry-only model keeps its registry pricing.
    expect(pricing["fireworks/another"]).toEqual({
      inputMicrosPerMillionTokens: 111_000,
      outputMicrosPerMillionTokens: 222_000,
    });
    // an untouched default stays intact.
    expect(pricing["gpt-5.5"]).toEqual(defaultModelPricing["gpt-5.5"]!);
  });
});

describe("validateSettings registry checks", () => {
  test("rejects a registry id colliding with the built-in provider id", () => {
    expect(() => withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        { id: "openai", baseUrl: "https://x.test/v1", apiKey: "k", models: [{ id: "m" }] },
      ]),
    }, () => getSettings())).toThrow("collides with the built-in provider id");
  });

  test("rejects duplicate registry provider ids", () => {
    expect(() => withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        { id: "dup", baseUrl: "https://a.test/v1", apiKey: "k", models: [{ id: "m1" }] },
        { id: "dup", baseUrl: "https://b.test/v1", apiKey: "k", models: [{ id: "m2" }] },
      ]),
    }, () => getSettings())).toThrow("duplicate provider id");
  });

  test("rejects a registry provider with no resolvable API key", () => {
    expect(() => withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        { id: "fireworks", baseUrl: "https://x.test/v1", apiKeyEnv: "MISSING_KEY_ENV", models: [{ id: "m" }] },
      ]),
    }, () => getSettings())).toThrow("requires a resolvable API key");
  });

  test("accepts a registry provider whose key resolves from the environment", () => {
    // configuredProviders resolves apiKeyEnv against process.env at CALL time,
    // so both getSettings (boot validation) and configuredProviders must run
    // inside the patched environment.
    withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_FIREWORKS_API_KEY: "fw_from_env",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: "fireworks",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY",
          models: [{ id: "accounts/fireworks/models/glm-5p2" }],
        },
      ]),
    }, () => {
      const settings = getSettings();
      expect(configuredProviders(settings)[1]?.apiKey).toBe("fw_from_env");
    });
  });

  test("surfaces a malformed registry as a boot error", () => {
    expect(() => withEnv({
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: "[not valid json",
    }, () => getSettings())).toThrow("OPENGENI_MODEL_PROVIDERS_JSON must be valid JSON");
  });

  test("managed billing requires pricing for registry models that lack a default", () => {
    expect(() => withEnv({
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
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: "acme",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "acme-key",
          // No default pricing and no pricing entry -> managed billing must reject.
          models: [{ id: "acme/unpriced" }],
        },
      ]),
    }, () => getSettings())).toThrow("Missing model pricing for managed billing");
  });

  test("managed billing accepts the GLM-5.2 registry model via its built-in default pricing", () => {
    const settings = withEnv({
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
      OPENGENI_OPENAI_API_KEY: "sk-test",
      OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
    }, () => getSettings());
    expect(configuredAllowedModels(settings)).toContain("accounts/fireworks/models/glm-5p2");
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}
