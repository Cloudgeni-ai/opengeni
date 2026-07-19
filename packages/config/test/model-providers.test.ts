import { describe, expect, test } from "bun:test";
import {
  calculateModelUsageCostMicros,
  canonicalizeConfiguredModelId,
  configuredAllowedModels,
  configuredModelPricing,
  configuredModelPricingSchedules,
  configuredModels,
  configuredProviders,
  defaultModelPricing,
  getSettings,
  parseModelProvidersJson,
  policyProviderIdForModel,
  resolveModelProvider,
  resolveProviderApiKey,
  resolveTurnExecutionPolicyV1,
  selectModelPricing,
  assertTurnExecutionPolicyMatchesConfigV1,
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

// The synthetic codex-subscription provider the worker overlay injects into
// runSettings for a workspace with an active Codex subscription (mirrors
// apps/worker withCodexProvider). No apiKey — the per-request bearer is supplied
// at call time by codexSubscriptionFetch.
const codexRegistry = JSON.stringify([
  {
    kind: "codex-subscription",
    id: "codex-subscription",
    label: "Codex (ChatGPT subscription)",
    api: "responses",
    baseUrl: "https://chatgpt.com/backend-api",
    models: [{ id: "codex/gpt-5.6-sol", label: "gpt-5.6-sol", reasoningEffort: true }],
  },
]);

const grok45Capabilities = {
  reasoning: {
    upstream: "supported",
    runnable: true,
    efforts: ["low", "medium", "high"],
    defaultEffort: "high",
    required: true,
  },
  functionCalling: { upstream: "supported", runnable: true },
  structuredOutput: { upstream: "supported", runnable: true },
  hostedTools: {
    webSearch: { upstream: "supported", runnable: true },
    xSearch: { upstream: "supported", runnable: false },
    codeExecution: { upstream: "supported", runnable: false },
  },
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  transports: {
    sse: { upstream: "supported", runnable: true },
    responsesWebSocket: { upstream: "supported", runnable: false },
    realtimeAudio: { upstream: "unsupported", runnable: false },
  },
  latencyModes: [
    { id: "standard", upstream: "supported", runnable: true },
    {
      id: "priority",
      upstream: "supported",
      runnable: false,
      billingMultiplierBps: 20_000,
    },
  ],
} as const;

const grok45Registry = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify([
    {
      id: "xai",
      label: "xAI",
      api: "responses",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "xai_mock_only",
      models: [
        {
          id: "xai/grok-4.5",
          upstreamModelId: "grok-4.5",
          aliases: ["grok-4.5"],
          label: "Grok 4.5",
          contextWindowTokens: 500_000,
          capabilities: grok45Capabilities,
          pricing: {
            default: {
              inputMicrosPerMillionTokens: 2_000_000,
              cachedInputMicrosPerMillionTokens: 300_000,
              outputMicrosPerMillionTokens: 6_000_000,
            },
            inputTokenTiers: [
              {
                minimumInputTokens: 200_000,
                pricing: {
                  inputMicrosPerMillionTokens: 4_000_000,
                  cachedInputMicrosPerMillionTokens: 600_000,
                  outputMicrosPerMillionTokens: 12_000_000,
                },
              },
            ],
          },
          ...overrides,
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
    const providers = parseModelProvidersJson(
      JSON.stringify([
        {
          id: "fireworks",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY",
          models: [{ id: "accounts/fireworks/models/glm-5p2" }],
        },
      ]),
    );
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
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([{ id: "fireworks", apiKey: "fw", models: [{ id: "m" }] }]),
      ),
    ).toThrow("provider[0] is invalid");
  });

  test("rejects a provider id with illegal characters", () => {
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          { id: "fire works", baseUrl: "https://x.test", apiKey: "fw", models: [{ id: "m" }] },
        ]),
      ),
    ).toThrow("provider[0] is invalid");
  });

  test("rejects a provider with an empty models list", () => {
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([{ id: "fireworks", baseUrl: "https://x.test", apiKey: "fw", models: [] }]),
      ),
    ).toThrow("provider[0] is invalid");
  });

  test("normalizes a safe base URL and HTTP header names while preserving query-name case", () => {
    const [provider] = parseModelProvidersJson(
      JSON.stringify([
        {
          id: "acme",
          baseUrl: "https://API.Acme.Test:443/v1/../v1",
          apiKey: "mock",
          defaultHeaders: { "X-API-Version": "2026-07-18" },
          publicDefaultHeaderNames: ["x-api-version"],
          defaultQuery: { ApiVersion: "2026-07-18" },
          publicDefaultQueryNames: ["ApiVersion"],
          models: [{ id: "acme/model" }],
        },
      ]),
    );
    expect(provider!.baseUrl).toBe("https://api.acme.test/v1");
    expect(provider!.defaultHeaders).toEqual({ "x-api-version": "2026-07-18" });
    expect(provider!.publicDefaultHeaderNames).toEqual(["x-api-version"]);
    expect(provider!.defaultQuery).toEqual({ ApiVersion: "2026-07-18" });
    expect(provider!.publicDefaultQueryNames).toEqual(["ApiVersion"]);
  });

  test.each([
    ["userinfo", "https://user:pass@api.acme.test/v1", "must not contain userinfo"],
    ["query", "https://api.acme.test/v1?api-version=1", "move query entries to defaultQuery"],
    ["fragment", "https://api.acme.test/v1#models", "must not contain a fragment"],
  ])("rejects a base URL containing %s", (_case, baseUrl, message) => {
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([{ id: "acme", baseUrl, apiKey: "mock", models: [{ id: "acme/model" }] }]),
      ),
    ).toThrow(message);
  });

  test("rejects invalid/colliding header names and SDK-managed authorization overrides", () => {
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "mock",
            defaultHeaders: { "bad header": "value" },
            models: [{ id: "acme/model" }],
          },
        ]),
      ),
    ).toThrow("invalid HTTP field name");
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "mock",
            defaultHeaders: { "X-Version": "one", "x-version": "two" },
            models: [{ id: "acme/model" }],
          },
        ]),
      ),
    ).toThrow("collide after lowercase normalization");
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "mock",
            defaultHeaders: { Authorization: "must-not-override" },
            models: [{ id: "acme/model" }],
          },
        ]),
      ),
    ).toThrow("must not override SDK-managed Authorization");
  });

  test.each(["x-api-key", "x-auth-token", "cf-aig-authorization", "x-goog-api-key"])(
    "rejects credential-like public header name %s",
    (name) => {
      expect(() =>
        parseModelProvidersJson(
          JSON.stringify([
            {
              id: "acme",
              baseUrl: "https://api.acme.test/v1",
              apiKey: "mock",
              defaultHeaders: { [name]: "secret" },
              publicDefaultHeaderNames: [name],
              models: [{ id: "acme/model" }],
            },
          ]),
        ),
      ).toThrow("cannot classify credential-like name");
    },
  );

  test("rejects absent, duplicate, and credential-like public request metadata declarations", () => {
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "mock",
            defaultHeaders: { "x-version": "1" },
            publicDefaultHeaderNames: ["x-missing"],
            models: [{ id: "acme/model" }],
          },
        ]),
      ),
    ).toThrow("declares absent defaultHeaders entry");
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "mock",
            defaultHeaders: { "x-version": "1" },
            publicDefaultHeaderNames: ["X-Version", "x-version"],
            models: [{ id: "acme/model" }],
          },
        ]),
      ),
    ).toThrow("duplicate normalized name");
    expect(() =>
      parseModelProvidersJson(
        JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "mock",
            defaultQuery: { access_token: "secret" },
            publicDefaultQueryNames: ["access_token"],
            models: [{ id: "acme/model" }],
          },
        ]),
      ),
    ).toThrow("cannot classify credential-like name");
  });

  test("rejects generic registry attempts to enable workspace BYOK or reattribute billing", () => {
    for (const forbidden of [
      { credentialSource: { kind: "workspace_connection", mechanism: "api_key" } },
      { billing: { upstreamPayer: "workspace", metering: "external" } },
    ]) {
      expect(() =>
        parseModelProvidersJson(
          JSON.stringify([
            {
              id: "acme",
              baseUrl: "https://api.acme.test/v1",
              apiKey: "mock",
              ...forbidden,
              models: [{ id: "acme/model" }],
            },
          ]),
        ),
      ).toThrow("provider[0] is invalid");
    }
  });
});

describe("resolveProviderApiKey", () => {
  test("prefers an inline apiKey", () => {
    expect(
      resolveProviderApiKey({ apiKey: "inline", apiKeyEnv: "SOME_ENV" }, { SOME_ENV: "from-env" }),
    ).toBe("inline");
  });

  test("falls back to the named env var", () => {
    expect(
      resolveProviderApiKey(
        { apiKeyEnv: "OPENGENI_FIREWORKS_API_KEY" },
        { OPENGENI_FIREWORKS_API_KEY: "fw_env" },
      ),
    ).toBe("fw_env");
  });

  test("returns undefined when neither inline nor env is resolvable", () => {
    expect(resolveProviderApiKey({ apiKeyEnv: "MISSING" }, {})).toBeUndefined();
    expect(resolveProviderApiKey({ apiKeyEnv: "BLANK" }, { BLANK: "  " })).toBeUndefined();
    expect(resolveProviderApiKey({})).toBeUndefined();
  });
});

describe("configuredProviders", () => {
  test("returns the built-in OpenAI provider first, then registry providers", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
      },
      () => getSettings(),
    );
    const providers = configuredProviders(settings);
    expect(providers.map((provider) => provider.id)).toEqual(["openai", "fireworks"]);
    expect(providers[0]).toMatchObject({
      id: "openai",
      label: "OpenAI",
      api: "responses",
      builtin: true,
      apiKey: "sk-test",
    });
    expect(providers[1]).toMatchObject({
      id: "fireworks",
      label: "Fireworks AI",
      api: "chat",
      builtin: false,
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw_inline",
    });
  });

  test("returns the built-in Azure provider id and label", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
      },
      () => getSettings(),
    );
    const builtin = configuredProviders(settings)[0]!;
    expect(builtin).toMatchObject({
      id: "azure",
      label: "Azure OpenAI",
      api: "responses",
      builtin: true,
      baseUrl: "https://res.openai.azure.com/openai/v1",
      apiKey: "az-key",
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    });
  });

  test("Azure API key wins over AD bearer and AD-only remains explicitly classified", () => {
    const both = withEnv(
      {
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
        OPENGENI_AZURE_OPENAI_AD_TOKEN: "az-ad-token",
      },
      () => configuredProviders(getSettings())[0]!,
    );
    expect(both.apiKey).toBe("az-key");
    expect(both.credentialSource).toEqual({ kind: "deployment", mechanism: "api_key" });

    const adOnly = withEnv(
      {
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_AD_TOKEN: "az-ad-token",
      },
      () => configuredProviders(getSettings())[0]!,
    );
    expect(adOnly.apiKey).toBe("az-ad-token");
    expect(adOnly.credentialSource).toEqual({
      kind: "deployment",
      mechanism: "azure_ad_bearer",
    });
  });
});

describe("configuredModels", () => {
  test("with no registry returns exactly the built-in allow-list, default model first", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4,gpt-5.4-mini",
      },
      () => getSettings(),
    );
    const models = configuredModels(settings);
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.4", "gpt-5.4-mini"]);
    expect(models[0]).toMatchObject({
      id: "gpt-5.6-sol",
      label: "gpt-5.6-sol",
      providerId: "openai",
      providerLabel: "OpenAI",
      api: "responses",
      contextWindowTokens: settings.contextWindowTokens,
      reasoningEffort: true,
      hostedWebSearch: settings.webSearchEnabled,
    });
  });

  test("unions built-in models first, then registry models in declaration order", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4",
        OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
      },
      () => getSettings(),
    );
    const models = configuredModels(settings);
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
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
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
          {
            id: "acme",
            baseUrl: "https://api.acme.test/v1",
            apiKey: "acme-key",
            models: [{ id: "acme/model-a" }],
          },
        ]),
      },
      () => getSettings(),
    );
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

  test("the built-in never claims a codex/ id even when it is the turn's openaiModel — codex provider wins, no Azure shadow", () => {
    // The staging defect: the worker overwrites settings.openaiModel with the
    // turn's model ("codex/gpt-5.6-sol") and injects the codex provider. Without the
    // namespaced-id filter the built-in (Azure) allow-list claimed the id FIRST
    // and the first-wins de-dup dropped the real codex entry → Azure 404. Mirror
    // the worker's per-turn runSettings overlay by spread-overriding a validated
    // base (matching production, which never re-validates the overlay).
    const base = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
      },
      () => getSettings(),
    );
    const runSettings = {
      ...base,
      openaiModel: "codex/gpt-5.6-sol",
      modelProvidersJson: codexRegistry,
    };
    const models = configuredModels(runSettings);
    const codexEntries = models.filter((model) => model.id === "codex/gpt-5.6-sol");
    expect(codexEntries).toHaveLength(1);
    expect(codexEntries[0]!.providerId).toBe("codex-subscription");
    const resolved = resolveModelProvider(runSettings, "codex/gpt-5.6-sol");
    expect(resolved).toBeDefined();
    expect(resolved!.provider.kind).toBe("codex-subscription");
    expect(resolved!.provider.builtin).toBe(false);
    expect(resolved!.model.credentialSource).toEqual({
      kind: "connected_subscription",
      provider: "codex",
    });
    expect(resolved!.model.billing).toEqual({
      upstreamPayer: "connected_subscription",
      metering: "external",
    });
  });

  test("a codex/ openaiModel with NO codex provider injected is unexposed (so the runtime fails loud, never Azure)", () => {
    const base = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
      },
      () => getSettings(),
    );
    const runSettings = { ...base, openaiModel: "codex/gpt-5.6-sol" };
    expect(configuredModels(runSettings).some((model) => model.id === "codex/gpt-5.6-sol")).toBe(
      false,
    );
    expect(resolveModelProvider(runSettings, "codex/gpt-5.6-sol")).toBeUndefined();
  });

  test("a namespaced registry id (Fireworks) as the turn's openaiModel resolves to its registry provider, not the Azure built-in", () => {
    // The same shadow class for registry providers (Investigation 3's flag):
    // closing it routes a registry-model turn to its provider instead of Azure.
    const base = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_API_KEY: "az-key",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
      },
      () => getSettings(),
    );
    const runSettings = { ...base, openaiModel: "accounts/fireworks/models/glm-5p2" };
    const entries = configuredModels(runSettings).filter(
      (model) => model.id === "accounts/fireworks/models/glm-5p2",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.providerId).toBe("fireworks");
    expect(
      resolveModelProvider(runSettings, "accounts/fireworks/models/glm-5p2")!.provider.builtin,
    ).toBe(false);
  });

  test("fails boot instead of silently shadowing a duplicate canonical product id", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_OPENAI_API_KEY: "sk-test",
          OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: "shadow",
              baseUrl: "https://api.shadow.test/v1",
              apiKey: "shadow-key",
              models: [{ id: "gpt-5.6-sol", label: "Shadowed" }],
            },
          ]),
        },
        () => getSettings(),
      ),
    ).toThrow('model id "gpt-5.6-sol" is declared by both');
  });

  test("canonicalizes an alias exactly once and routes only the upstream deployment slug", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: grok45Registry(),
      },
      () => getSettings(),
    );
    expect(canonicalizeConfiguredModelId(settings, "grok-4.5")).toBe("xai/grok-4.5");
    expect(canonicalizeConfiguredModelId(settings, "xai/grok-4.5")).toBe("xai/grok-4.5");
    expect(canonicalizeConfiguredModelId(settings, "future/model")).toBe("future/model");
    expect(configuredAllowedModels(settings)).toContain("xai/grok-4.5");
    expect(configuredAllowedModels(settings)).not.toContain("grok-4.5");
    const resolved = resolveModelProvider(settings, "grok-4.5")!;
    expect(resolved.model.id).toBe("xai/grok-4.5");
    expect(resolved.model.upstreamModelId).toBe("grok-4.5");
    expect(resolved.model.deployment).toEqual({
      upstreamModelId: "grok-4.5",
      wireApi: "responses",
    });
  });

  test("fails boot on alias-to-canonical, cross-provider, and normalized duplicate aliases", () => {
    for (const providers of [
      [
        {
          id: "acme",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "mock",
          models: [{ id: "acme/one", aliases: ["acme/two"] }, { id: "acme/two" }],
        },
      ],
      [
        {
          id: "acme",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "mock",
          models: [{ id: "acme/one", aliases: ["shared"] }],
        },
        {
          id: "other",
          baseUrl: "https://api.other.test/v1",
          apiKey: "mock",
          models: [{ id: "other/one", aliases: ["shared"] }],
        },
      ],
      [
        {
          id: "acme",
          baseUrl: "https://api.acme.test/v1",
          apiKey: "mock",
          models: [{ id: "acme/one", aliases: ["same", "same"] }],
        },
      ],
    ]) {
      expect(() =>
        withEnv(
          {
            OPENGENI_OPENAI_API_KEY: "sk-test",
            OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify(providers),
          },
          () => getSettings(),
        ),
      ).toThrow(/alias|duplicate/u);
    }
  });
});

describe("normalized model definitions", () => {
  function definitionFor(input?: {
    apiKey?: string;
    providerLabel?: string;
    modelLabel?: string;
    aliases?: string[];
    secretHeaderValue?: string;
    publicHeaderValue?: string;
    secretQueryValue?: string;
    publicQueryValue?: string;
    publicHeaderNameCase?: string;
    modelOverrides?: Record<string, unknown>;
  }) {
    const registry = JSON.stringify([
      {
        id: "acme",
        label: input?.providerLabel ?? "Acme",
        api: "responses",
        baseUrl: "https://api.acme.test/v1",
        apiKey: input?.apiKey ?? "api-key-one",
        defaultHeaders: {
          "X-Secret-Metadata": input?.secretHeaderValue ?? "secret-header-one",
          "X-Public-Version": input?.publicHeaderValue ?? "2026-07-18",
        },
        publicDefaultHeaderNames: [input?.publicHeaderNameCase ?? "x-public-version"],
        defaultQuery: {
          opaque: input?.secretQueryValue ?? "secret-query-one",
          version: input?.publicQueryValue ?? "v1",
        },
        publicDefaultQueryNames: ["version"],
        models: [
          {
            id: "acme/model",
            upstreamModelId: "upstream-model",
            aliases: input?.aliases ?? ["model-alias"],
            label: input?.modelLabel ?? "Acme Model",
            contextWindowTokens: 100_000,
            effectiveContextWindowTokens: 90_000,
            autoCompactTokenLimit: 80_000,
            toolOutputTruncationTokens: 9_000,
            capabilities: grok45Capabilities,
            pricing: {
              default: {
                inputMicrosPerMillionTokens: 10,
                cachedInputMicrosPerMillionTokens: 2,
                outputMicrosPerMillionTokens: 30,
              },
            },
            ...input?.modelOverrides,
          },
        ],
      },
    ]);
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: registry,
      },
      () => getSettings(),
    );
    return configuredModels(settings).find((model) => model.id === "acme/model")!;
  }

  test("pins the V1 digest and excludes labels, aliases, API keys, and secret metadata values", () => {
    const baseline = definitionFor();
    expect(baseline.definitionVersion).toBe(
      "sha256:40e81d830e81001fb8bc29050c22ba6170b78c0a54554ca3594bc59801912015",
    );
    expect(
      definitionFor({
        apiKey: "rotated-api-key",
        providerLabel: "Renamed provider",
        modelLabel: "Renamed model",
        aliases: ["new-alias"],
        secretHeaderValue: "rotated-secret-header",
        secretQueryValue: "rotated-secret-query",
        publicHeaderNameCase: "X-PUBLIC-VERSION",
      }).definitionVersion,
    ).toBe(baseline.definitionVersion);
    const projected = JSON.stringify(baseline);
    expect(projected).not.toContain("api-key-one");
    expect(projected).not.toContain("secret-header-one");
    expect(projected).not.toContain("secret-query-one");
  });

  test("binds public metadata values and every normalized executable model field", () => {
    const baseline = definitionFor().definitionVersion;
    const variants = [
      definitionFor({ publicHeaderValue: "2026-07-19" }).definitionVersion,
      definitionFor({ publicQueryValue: "v2" }).definitionVersion,
      definitionFor({ modelOverrides: { upstreamModelId: "other-upstream" } }).definitionVersion,
      definitionFor({ modelOverrides: { contextWindowTokens: 100_001 } }).definitionVersion,
      definitionFor({
        modelOverrides: {
          capabilities: {
            ...grok45Capabilities,
            reasoning: { ...grok45Capabilities.reasoning, required: false },
          },
        },
      }).definitionVersion,
      definitionFor({
        modelOverrides: {
          pricing: {
            default: {
              inputMicrosPerMillionTokens: 11,
              cachedInputMicrosPerMillionTokens: 2,
              outputMicrosPerMillionTokens: 30,
            },
          },
        },
      }).definitionVersion,
    ];
    for (const variant of variants) {
      expect(variant).not.toBe(baseline);
    }
  });
});

describe("turn execution policy V1", () => {
  test("canonicalizes an explicit alias while freezing provider, deployment, credential, and billing identity", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: grok45Registry(),
      },
      () => getSettings(),
    );
    const policy = resolveTurnExecutionPolicyV1(settings, {
      modelId: "xai/grok-4.5",
      requestedModelId: "grok-4.5",
      modelSource: "explicit",
      reasoningEffort: "high",
      reasoningSource: "explicit",
    });

    expect(policy).toMatchObject({
      schemaVersion: 1,
      productModelId: "xai/grok-4.5",
      requestedModelId: "grok-4.5",
      modelSource: "explicit",
      reasoningEffort: "high",
      reasoningSource: "explicit",
      providerId: "xai",
      upstreamModelId: "grok-4.5",
      wireApi: "responses",
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    });
    expect(
      assertTurnExecutionPolicyMatchesConfigV1(settings, policy, {
        modelId: "xai/grok-4.5",
        reasoningEffort: "high",
      }).model.id,
    ).toBe("xai/grok-4.5");
  });

  test("fails closed on turn mismatch or any executable provider-definition drift", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: grok45Registry(),
      },
      () => getSettings(),
    );
    const policy = resolveTurnExecutionPolicyV1(settings, {
      modelId: "xai/grok-4.5",
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "high",
      reasoningSource: "session",
    });

    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(settings, policy, {
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    ).toThrow("accepted turn model/reasoning");
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(settings, policy, {
        modelId: policy.productModelId,
        reasoningEffort: "medium",
      }),
    ).toThrow("accepted turn model/reasoning");

    const definitionDrifts = [
      { ...policy, providerId: "other" },
      { ...policy, upstreamModelId: "other-upstream" },
      { ...policy, wireApi: "chat" as const },
      {
        ...policy,
        credentialSource: { kind: "workspace_connection" as const, mechanism: "api_key" as const },
      },
      {
        ...policy,
        billing: { upstreamPayer: "workspace" as const, metering: "external" as const },
      },
      { ...policy, definitionVersion: `sha256:${"f".repeat(64)}` },
    ];
    for (const drift of definitionDrifts) {
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(settings, drift, {
          modelId: policy.productModelId,
          reasoningEffort: policy.reasoningEffort,
        }),
      ).toThrow("current provider definition");
    }
  });

  test("does not bind secret rotation but rejects public executable metadata drift", () => {
    const settings = (apiKey: string, publicVersion: string) =>
      withEnv(
        {
          OPENGENI_OPENAI_API_KEY: "sk-test",
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: "acme",
              api: "responses",
              baseUrl: "https://api.acme.test/v1",
              apiKey,
              defaultHeaders: { "x-api-key": apiKey, "x-public-version": publicVersion },
              publicDefaultHeaderNames: ["x-public-version"],
              models: [{ id: "acme/model", upstreamModelId: "upstream-model" }],
            },
          ]),
        },
        () => getSettings(),
      );
    const acceptedSettings = settings("first-secret", "v1");
    const policy = resolveTurnExecutionPolicyV1(acceptedSettings, {
      modelId: "acme/model",
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "low",
      reasoningSource: "session",
    });

    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(settings("rotated-secret", "v1"), policy, {
        modelId: "acme/model",
        reasoningEffort: "low",
      }),
    ).not.toThrow();
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(settings("rotated-secret", "v2"), policy, {
        modelId: "acme/model",
        reasoningEffort: "low",
      }),
    ).toThrow("current provider definition");
  });

  test("attributes connected Codex subscription turns explicitly as externally billed", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
      },
      () => getSettings(),
    );
    const policy = resolveTurnExecutionPolicyV1(settings, {
      modelId: "codex/gpt-5.6-sol",
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "xhigh",
      reasoningSource: "session",
    });
    expect(policy).toMatchObject({
      productModelId: "codex/gpt-5.6-sol",
      providerId: "codex-subscription",
      upstreamModelId: "gpt-5.6-sol",
      credentialSource: { kind: "connected_subscription", provider: "codex" },
      billing: { upstreamPayer: "connected_subscription", metering: "external" },
    });
  });
});

describe("Grok 4.5 explicit xAI registry contract", () => {
  test("projects evidence-backed support separately from conservative runnable support", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: grok45Registry(),
      },
      () => getSettings(),
    );
    const grok = configuredModels(settings).find((model) => model.id === "xai/grok-4.5")!;
    expect(grok).toMatchObject({
      aliases: ["grok-4.5"],
      upstreamModelId: "grok-4.5",
      providerId: "xai",
      api: "responses",
      contextWindowTokens: 500_000,
      credentialSource: { kind: "deployment", mechanism: "api_key" },
      billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
      reasoningEffort: true,
      hostedWebSearch: true,
    });
    expect(grok.capabilities.reasoning).toMatchObject({
      efforts: ["low", "medium", "high"],
      defaultEffort: "high",
      required: true,
    });
    expect(grok.capabilities.hostedTools.xSearch).toEqual({
      upstream: "supported",
      runnable: false,
    });
    expect(grok.capabilities.hostedTools.codeExecution.runnable).toBe(false);
    expect(grok.capabilities.transports.responsesWebSocket).toEqual({
      upstream: "supported",
      runnable: false,
    });
    expect(grok.capabilities.transports.realtimeAudio).toEqual({
      upstream: "unsupported",
      runnable: false,
    });
    expect(grok.capabilities.latencyModes.find((mode) => mode.id === "priority")).toMatchObject({
      upstream: "supported",
      runnable: false,
      billingMultiplierBps: 20_000,
    });
  });

  test("selects official standard pricing below and at the 200,000-token threshold", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: grok45Registry(),
      },
      () => getSettings(),
    );
    const schedule = configuredModelPricingSchedules(settings)["xai/grok-4.5"]!;
    expect(selectModelPricing(schedule, 199_999)).toEqual({
      inputMicrosPerMillionTokens: 2_000_000,
      cachedInputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 6_000_000,
    });
    expect(selectModelPricing(schedule, 200_000)).toEqual({
      inputMicrosPerMillionTokens: 4_000_000,
      cachedInputMicrosPerMillionTokens: 600_000,
      outputMicrosPerMillionTokens: 12_000_000,
    });
    expect(calculateModelUsageCostMicros(settings, "xai/grok-4.5", { inputTokens: 199_999 })).toBe(
      399_998,
    );
    expect(calculateModelUsageCostMicros(settings, "xai/grok-4.5", { inputTokens: 200_000 })).toBe(
      800_000,
    );
  });

  test("rejects unordered/duplicate threshold schedules", () => {
    expect(() =>
      parseModelProvidersJson(
        grok45Registry({
          pricing: {
            default: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
            inputTokenTiers: [
              {
                minimumInputTokens: 200_000,
                pricing: { inputMicrosPerMillionTokens: 2, outputMicrosPerMillionTokens: 2 },
              },
              {
                minimumInputTokens: 200_000,
                pricing: { inputMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 3 },
              },
            ],
          },
        }),
      ),
    ).toThrow("strictly increasing");
  });
});

describe("configuredAllowedModels", () => {
  test("with no registry is exactly today's behaviour: default model first, then the allow-list", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_MODEL: "custom-model",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.4",
      },
      () => getSettings(),
    );
    expect(configuredAllowedModels(settings)).toEqual(["custom-model", "gpt-5.6-sol", "gpt-5.4"]);
  });

  test("appends registry ids after the built-in allow-list", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_OPENAI_ALLOWED_MODELS: "gpt-5.4",
        OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
      },
      () => getSettings(),
    );
    expect(configuredAllowedModels(settings)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.4",
      "accounts/fireworks/models/glm-5p2",
    ]);
  });
});

describe("resolveModelProvider", () => {
  test("resolves a built-in model to the built-in provider", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_OPENAI_MODEL: "gpt-5.6-sol",
        OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
      },
      () => getSettings(),
    );
    const resolved = resolveModelProvider(settings, "gpt-5.6-sol");
    expect(resolved).toBeDefined();
    expect(resolved!.provider.id).toBe("openai");
    expect(resolved!.provider.builtin).toBe(true);
    expect(resolved!.provider.api).toBe("responses");
    expect(resolved!.model.id).toBe("gpt-5.6-sol");
  });

  test("resolves a registry model to its registry provider", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry,
      },
      () => getSettings(),
    );
    const resolved = resolveModelProvider(settings, "accounts/fireworks/models/glm-5p2");
    expect(resolved).toBeDefined();
    expect(resolved!.provider.id).toBe("fireworks");
    expect(resolved!.provider.builtin).toBe(false);
    expect(resolved!.provider.api).toBe("chat");
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
    const settings = withEnv(
      {
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
      },
      () => getSettings(),
    );
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
    expect(pricing["gpt-5.6-sol"]).toEqual(defaultModelPricing["gpt-5.6-sol"]!);
  });
});

describe("validateSettings registry checks", () => {
  test("rejects a registry id colliding with the built-in provider id", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_OPENAI_API_KEY: "sk-test",
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            { id: "openai", baseUrl: "https://x.test/v1", apiKey: "k", models: [{ id: "m" }] },
          ]),
        },
        () => getSettings(),
      ),
    ).toThrow("collides with the built-in provider id");
  });

  test("rejects duplicate registry provider ids", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_OPENAI_API_KEY: "sk-test",
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            { id: "dup", baseUrl: "https://a.test/v1", apiKey: "k", models: [{ id: "m1" }] },
            { id: "dup", baseUrl: "https://b.test/v1", apiKey: "k", models: [{ id: "m2" }] },
          ]),
        },
        () => getSettings(),
      ),
    ).toThrow("duplicate provider id");
  });

  test("rejects a registry provider with no resolvable API key", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_OPENAI_API_KEY: "sk-test",
          OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
            {
              id: "fireworks",
              baseUrl: "https://x.test/v1",
              apiKeyEnv: "MISSING_KEY_ENV",
              models: [{ id: "m" }],
            },
          ]),
        },
        () => getSettings(),
      ),
    ).toThrow("requires a resolvable API key");
  });

  test("accepts a registry provider whose key resolves from the environment", () => {
    // configuredProviders resolves apiKeyEnv against process.env at CALL time,
    // so both getSettings (boot validation) and configuredProviders must run
    // inside the patched environment.
    withEnv(
      {
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
      },
      () => {
        const settings = getSettings();
        expect(configuredProviders(settings)[1]?.apiKey).toBe("fw_from_env");
      },
    );
  });

  test("surfaces a malformed registry as a boot error", () => {
    expect(() =>
      withEnv(
        {
          OPENGENI_OPENAI_API_KEY: "sk-test",
          OPENGENI_MODEL_PROVIDERS_JSON: "[not valid json",
        },
        () => getSettings(),
      ),
    ).toThrow("OPENGENI_MODEL_PROVIDERS_JSON must be valid JSON");
  });

  test("managed billing requires pricing for registry models that lack a default", () => {
    expect(() =>
      withEnv(
        {
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
        },
        () => getSettings(),
      ),
    ).toThrow("Missing model pricing for managed billing");
  });

  test("managed billing accepts the GLM-5.2 registry model via its built-in default pricing", () => {
    const settings = withEnv(
      {
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
      },
      () => getSettings(),
    );
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

describe("policyProviderIdForModel", () => {
  // The attribution the workspace model policy evaluates MUST agree with the
  // real router on every path — especially the two that historically leaked:
  // a codex/ id evaluated against BASE settings (no overlay injected), and an
  // UNKNOWN id (the legacy resolveTurnModel-null fallback → built-in client).
  test("codex/ id attributes to codex-subscription even on BASE settings", () => {
    const settings = withEnv({ OPENGENI_OPENAI_API_KEY: "sk-test" }, () => getSettings());
    // No codex provider is injected here — attribution is by prefix, mirroring
    // the router's guarantee that a codex/ id NEVER routes to the built-in.
    expect(policyProviderIdForModel(settings, "codex/gpt-5.6-sol")).toBe("codex-subscription");
  });

  test("registry model attributes to its registry provider", () => {
    const settings = withEnv(
      { OPENGENI_OPENAI_API_KEY: "sk-test", OPENGENI_MODEL_PROVIDERS_JSON: fireworksRegistry },
      () => getSettings(),
    );
    expect(policyProviderIdForModel(settings, "accounts/fireworks/models/glm-5p2")).toBe(
      "fireworks",
    );
  });

  test("configured bare model attributes to the built-in id", () => {
    const settings = withEnv({ OPENGENI_OPENAI_API_KEY: "sk-test" }, () => getSettings());
    expect(policyProviderIdForModel(settings, settings.openaiModel)).toBe("openai");
  });

  test("UNKNOWN model id attributes to the built-in (legacy null-resolution fallback)", () => {
    const settings = withEnv(
      {
        OPENGENI_OPENAI_PROVIDER: "azure",
        OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1",
        OPENGENI_AZURE_OPENAI_API_KEY: "azure-test",
      },
      () => getSettings(),
    );
    // An id the router cannot resolve falls back to the built-in client, so a
    // policy blocking the built-in must see the built-in's identity here.
    expect(policyProviderIdForModel(settings, "totally-unknown-model")).toBe("azure");
  });
});
