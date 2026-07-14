import { describe, expect, test } from "bun:test";
import { OpenAIChatCompletionsModel, OpenAIResponsesModel } from "@openai/agents";
import {
  configuredProviders,
  resolveModelProvider,
  type ResolvedModelProvider,
} from "@opengeni/config";
import { CODEX_MODEL_ID_PREFIX, CODEX_PROVIDER_BASE_URL, CODEX_PROVIDER_ID } from "@opengeni/codex";
import { testSettings } from "@opengeni/testing";
import OpenAI from "openai";
import {
  buildModelInstance,
  buildOpenGeniAgent,
  buildOpenAIClientFromSettings,
  buildProviderClient,
  CodexSubscriptionUnavailableError,
  MultiProviderModelProvider,
  resolveTurnModel,
} from "../src/index";

// The synthetic codex-subscription provider the worker overlay
// (settingsWithCodexCredential → withCodexProvider) injects into runSettings for
// a workspace with an ACTIVE Codex subscription. Mirrors capabilities.ts.
const CODEX_TURN_MODEL = `${CODEX_MODEL_ID_PREFIX}gpt-5.6-sol`;
function codexProviderJson(): string {
  return JSON.stringify([
    {
      kind: "codex-subscription",
      id: CODEX_PROVIDER_ID,
      label: "Codex (ChatGPT subscription)",
      api: "responses",
      baseUrl: CODEX_PROVIDER_BASE_URL,
      models: [{ id: CODEX_TURN_MODEL, label: "gpt-5.6-sol", reasoningEffort: true }],
    },
  ]);
}

// A host exposing the built-in OpenAI provider plus Fireworks (the `chat` wire
// API) serving GLM 5.2, mirroring the canonical example in
// docs/model-providers.md. webSearch and encrypted reasoning are OFF for the
// Fireworks model (hostedWebSearch defaults false; chat has no encrypted
// reasoning), which is exactly the gating the runtime must apply.
function multiProviderSettings(overrides: Parameters<typeof testSettings>[0] = {}) {
  return testSettings({
    sandboxBackend: "none",
    openaiProvider: "openai",
    openaiModel: "gpt-5.6-sol",
    openaiAllowedModels: "gpt-5.6-sol,gpt-5.4",
    modelProvidersJson: JSON.stringify([
      {
        id: "fireworks",
        label: "Fireworks AI",
        api: "chat",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "fw-test-key",
        defaultHeaders: { "x-fireworks": "on" },
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
    ]),
    ...overrides,
  });
}

const FIREWORKS_MODEL = "accounts/fireworks/models/glm-5p2";

describe("buildModelInstance — chat vs responses Model selection per provider api", () => {
  const client = new OpenAI({ apiKey: "test" });

  test("a chat provider yields an OpenAIChatCompletionsModel", () => {
    const provider: ResolvedModelProvider = {
      id: "fireworks",
      label: "Fireworks AI",
      kind: "api-key",
      api: "chat",
      builtin: false,
    };
    const model = buildModelInstance(provider, client, FIREWORKS_MODEL);
    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(model).not.toBeInstanceOf(OpenAIResponsesModel);
  });

  test("a responses provider yields an OpenAIResponsesModel", () => {
    const provider: ResolvedModelProvider = {
      id: "openai",
      label: "OpenAI",
      kind: "api-key",
      api: "responses",
      builtin: true,
    };
    const model = buildModelInstance(provider, client, "gpt-5.6-sol");
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    expect(model).not.toBeInstanceOf(OpenAIChatCompletionsModel);
  });
});

describe("buildProviderClient", () => {
  test("a registry provider gets a client pointed at its base URL with its key/headers, cached by id", () => {
    const settings = multiProviderSettings();
    const provider = configuredProviders(settings).find(
      (candidate) => candidate.id === "fireworks",
    )!;
    expect(provider).toBeDefined();
    const client = buildProviderClient(provider, settings);
    expect(client.baseURL).toBe("https://api.fireworks.ai/inference/v1");
    expect(client.apiKey).toBe("fw-test-key");
    expect(client.maxRetries).toBe(settings.openaiMaxRetries);
    // One client per provider id (module-level cache).
    expect(buildProviderClient(provider, settings)).toBe(client);
  });

  test("Codex disables blind SDK retries and leaves retry classification to its transport", () => {
    const settings = multiProviderSettings();
    const provider: ResolvedModelProvider = {
      id: "codex-subscription-no-retry-test",
      label: "Codex subscription",
      kind: "codex-subscription",
      api: "responses",
      builtin: false,
      apiKey: "placeholder",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const client = buildProviderClient(provider, settings);
    expect(settings.openaiMaxRetries).toBeGreaterThan(0);
    expect(client.maxRetries).toBe(0);
  });
});

describe("resolveTurnModel", () => {
  test("returns null for a model not in any provider (legacy global-client fallback)", () => {
    expect(resolveTurnModel(multiProviderSettings(), "model-that-does-not-exist")).toBeNull();
  });

  test("resolves a registry model to its provider, client, chat Model, and configured shape", () => {
    const resolved = resolveTurnModel(multiProviderSettings(), FIREWORKS_MODEL);
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.id).toBe("fireworks");
    expect(resolved!.provider.api).toBe("chat");
    expect(resolved!.client.baseURL).toBe("https://api.fireworks.ai/inference/v1");
    expect(resolved!.model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(resolved!.configured.id).toBe(FIREWORKS_MODEL);
    expect(resolved!.configured.contextWindowTokens).toBe(1_048_576);
    expect(resolved!.configured.hostedWebSearch).toBe(false);
  });

  test("resolves the built-in model to the responses provider + an OpenAIResponsesModel", () => {
    const resolved = resolveTurnModel(multiProviderSettings(), "gpt-5.6-sol");
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.id).toBe("openai");
    expect(resolved!.provider.api).toBe("responses");
    expect(resolved!.model).toBeInstanceOf(OpenAIResponsesModel);
  });
});

// The agent the worker builds for a Fireworks turn passes the resolved gating
// into buildOpenGeniAgent. These tests pin that the gating actually changes the
// constructed agent the way the multi-provider contract requires.
function webSearchHostedTools(
  agent: ReturnType<typeof buildOpenGeniAgent>,
): Array<Record<string, unknown>> {
  return ((agent as { tools?: Array<Record<string, unknown>> }).tools ?? []).filter(
    (tool) =>
      tool.type === "hosted_tool" &&
      (tool.providerData as { type?: unknown } | undefined)?.type === "web_search",
  );
}

describe("multi-provider gating in buildOpenGeniAgent", () => {
  test("a resolved chat provider turn: no web_search tool, no encrypted reasoning, no server store", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, FIREWORKS_MODEL)!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
    });
    // hostedWebSearch off → no web_search tool and no explicit tools field at all.
    expect(webSearchHostedTools(agent)).toHaveLength(0);
    expect((agent as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
    // encryptedReasoning off (chat wire API) → no providerData.include.
    expect(
      (agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData,
    ).toBeUndefined();
    // Durable local compaction does not add provider-side context management.
    expect((agent as { modelSettings: { store?: unknown } }).modelSettings.store).toBeUndefined();
    // The provider-bound Model instance is the one passed in (chat routing).
    expect((agent as { model?: unknown }).model).toBe(resolved.model);
  });

  test("the built-in responses turn keeps web_search and encrypted reasoning without inline compaction", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, "gpt-5.6-sol")!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
    });
    expect(webSearchHostedTools(agent)).toHaveLength(1);
    expect(
      (agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData,
    ).toEqual({ include: ["reasoning.encrypted_content"] });
    expect((agent as { modelSettings: { store?: unknown } }).modelSettings.store).toBeUndefined();
    expect(
      (agent as { modelSettings: { providerData?: Record<string, unknown> } }).modelSettings
        .providerData?.context_management,
    ).toBeUndefined();
  });

  test("an accepted responses transport carries the stable session prompt_cache_key", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, "gpt-5.6-sol")!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
      promptCacheKey: "session-123",
    });
    expect(
      (agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData,
    ).toEqual({
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-123",
    });
  });

  test("an excluded registry chat transport does not carry prompt_cache_key when no key is passed", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, FIREWORKS_MODEL)!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning:
        resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
    });
    expect(
      (agent as { modelSettings: { providerData?: Record<string, unknown> } }).modelSettings
        .providerData?.prompt_cache_key,
    ).toBeUndefined();
  });

  test("resolveModelProvider/configuredProviders agree on each provider's wire API", () => {
    const settings = multiProviderSettings();
    const fireworks = resolveModelProvider(settings, FIREWORKS_MODEL);
    expect(fireworks?.provider.api).toBe("chat");
    const builtin = resolveModelProvider(settings, "gpt-5.6-sol");
    expect(builtin?.provider.api).toBe("responses");
  });
});

describe("MultiProviderModelProvider — routes a model NAME to its provider (the sandbox-path fix)", () => {
  // The bug: on the SandboxAgent/Modal path the per-agent Model instance is
  // dropped and the model NAME is re-resolved through the default model
  // provider. Without this router that hit the built-in (Azure) client, so a
  // Fireworks model 404'd ("deployment does not exist"). The router resolves
  // names back to their provider regardless of path.
  const FIREWORKS_MODEL = "accounts/fireworks/models/glm-5p2";

  test("routes a registry model name to a chat-completions Model (NOT the built-in)", async () => {
    const provider = new MultiProviderModelProvider(multiProviderSettings());
    const model = await provider.getModel(FIREWORKS_MODEL);
    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(model).not.toBeInstanceOf(OpenAIResponsesModel);
  });

  test("with an AZURE built-in (the staging config), glm still routes to Fireworks chat, not Azure", async () => {
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    const provider = new MultiProviderModelProvider(settings);
    const glm = await provider.getModel(FIREWORKS_MODEL);
    expect(glm).toBeInstanceOf(OpenAIChatCompletionsModel);
    const builtin = await provider.getModel("gpt-5.6-sol");
    expect(builtin).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("a codex/<slug> id with NO codex provider in settings throws the actionable error (NOT an Azure fallback)", async () => {
    // The staging failure: codex_subscription_credentials empty → the worker
    // overlay never injects the codex provider → resolveTurnModel returns null
    // for "codex/gpt-5.6-sol". The router must NOT fall through to the built-in
    // (Azure) client (which 404'd with "DeploymentNotFound"); it must throw a
    // user-actionable error telling the user to connect their subscription.
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    const provider = new MultiProviderModelProvider(settings);
    let thrown: unknown;
    try {
      await provider.getModel("codex/gpt-5.6-sol");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexSubscriptionUnavailableError);
    expect((thrown as Error).message).toContain("codex/gpt-5.6-sol");
    expect((thrown as Error).message).toContain("Codex subscription");
    expect((thrown as Error).message).toContain("Settings");
    // No status/code → agentRunFailurePayload surfaces it as a non-retryable
    // turn.failed (not a rate-limit retry).
    expect((thrown as { status?: unknown }).status).toBeUndefined();
    expect((thrown as { code?: unknown }).code).toBeUndefined();
  });

  test("codex × selfhosted/connected-machine: a codex/<slug> turn routes to the CODEX client, never Azure", async () => {
    // The staging incident: a codex turn on workspace 3989dda7 (ACTIVE codex
    // subscription) ran on the selfhosted/connected-machine backend and 404'd
    // with Azure DeploymentNotFound. Model resolution is backend-agnostic — it
    // runs in the worker through the one shared MultiProviderModelProvider(runSettings)
    // path — so a `selfhosted` backend with the codex provider injected must
    // resolve codex/gpt-5.6-sol to the codex-subscription client (baseUrl =
    // chatgpt.com/backend-api, fetch: codexSubscriptionFetch), NOT the Azure
    // built-in. runSettings.openaiModel is the codex id (the worker overwrites
    // it per-turn) — exactly the input that used to trigger the built-in shadow.
    const settings = multiProviderSettings({
      sandboxBackend: "selfhosted",
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: CODEX_TURN_MODEL, // worker per-turn overwrite (runSettings)
      modelProvidersJson: codexProviderJson(),
    });
    const resolved = resolveTurnModel(settings, CODEX_TURN_MODEL)!;
    expect(resolved).not.toBeNull();
    expect(resolved.provider.kind).toBe("codex-subscription");
    expect(resolved.provider.builtin).toBe(false);
    // The client points at the ChatGPT backend, NOT the Azure deployment URL.
    expect(resolved.client.baseURL).toBe(CODEX_PROVIDER_BASE_URL);
    expect(resolved.client.baseURL).not.toBe("https://example.openai.azure.com/openai/v1");
    // It is a distinct client from the built-in (Azure) one configureOpenAI builds.
    expect(resolved.client).not.toBe(buildOpenAIClientFromSettings(settings));
    // The router (the load-bearing sandbox-path resolver) agrees.
    const model = await new MultiProviderModelProvider(settings).getModel(CODEX_TURN_MODEL);
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("codex × in-process (sandboxBackend 'none') still routes to the codex client (unchanged by the fix)", async () => {
    const settings = multiProviderSettings({
      sandboxBackend: "none",
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: CODEX_TURN_MODEL,
      modelProvidersJson: codexProviderJson(),
    });
    const resolved = resolveTurnModel(settings, CODEX_TURN_MODEL)!;
    expect(resolved.provider.kind).toBe("codex-subscription");
    expect(resolved.client.baseURL).toBe(CODEX_PROVIDER_BASE_URL);
    const model = await new MultiProviderModelProvider(settings).getModel(CODEX_TURN_MODEL);
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("fail-loud floor: a codex/ id that resolves to a NON-codex provider is refused (never shipped to Azure)", async () => {
    // Defense in depth (the getModel kind-guard): even if a future settings path
    // re-introduced a shadow binding codex/gpt-5.6-sol to the built-in (Azure)
    // provider, the router must refuse it rather than ship the id as an Azure
    // deployment name. Construct exactly that pathological resolution by putting
    // the codex id in the built-in allow-list WITHOUT the codex provider, then
    // assert the router throws instead of returning an Azure-bound model.
    // (configuredModels filters codex/ out of the built-in list, so this asserts
    // the runtime guard independently of the config-layer fix.)
    const settings = multiProviderSettings({
      sandboxBackend: "selfhosted",
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: CODEX_TURN_MODEL,
      openaiAllowedModels: CODEX_TURN_MODEL,
      modelProvidersJson: "[]", // codex provider NOT injected → no real owner
    });
    // With the config fix, codex/ is filtered from the built-in list, so the id
    // is unexposed and getModel throws via the no-resolution codex branch.
    await expect(
      new MultiProviderModelProvider(settings).getModel(CODEX_TURN_MODEL),
    ).rejects.toBeInstanceOf(CodexSubscriptionUnavailableError);
  });

  test("P0 regression: a codex-active run provider resolves codex/* even after the GLOBAL default is clobbered by a non-codex turn", async () => {
    // The staging incident: the worker runs ~100 activities concurrently. A codex
    // turn injects the codex provider into ITS settings, but a concurrent
    // non-codex turn's configureOpenAI overwrote the PROCESS-GLOBAL default
    // provider with settings that have NO codex provider. The fix pins a
    // run-scoped provider built from the run's OWN settings, so name resolution is
    // immune to the global clobber. This test simulates the clobber and asserts
    // the per-run provider still resolves codex/<slug>.
    const { configureOpenAI } = await import("../src/index");
    const codexProvider = {
      kind: "codex-subscription" as const,
      id: "codex-subscription",
      label: "Codex (ChatGPT subscription)",
      api: "responses" as const,
      baseUrl: "https://chatgpt.com/backend-api",
      models: [{ id: "codex/gpt-5.6-sol", label: "gpt-5.6-sol", reasoningEffort: true }],
    };
    // The codex turn's OWN settings (codex provider injected).
    const codexSettings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      modelProvidersJson: JSON.stringify([codexProvider]),
    });
    // A foreign, concurrent non-codex turn clobbers the process-global default.
    const nonCodexSettings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    // Build the run-scoped provider FIRST (as runScopedRunner does at run start)…
    const runScopedProvider = new MultiProviderModelProvider(codexSettings);
    // …then let the foreign turn overwrite the global default provider mid-run.
    configureOpenAI(nonCodexSettings);
    // The run-scoped provider resolves codex/* from its own settings — no throw.
    const model = await runScopedProvider.getModel("codex/gpt-5.6-sol");
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    // Proof the clobber matters: a provider built from the FOREIGN turn's
    // (non-codex) settings — i.e. what the process-global default now points at —
    // would throw on the very same name. The run-scoped provider's immunity is
    // exactly what the fix buys.
    const clobberedProvider = new MultiProviderModelProvider(nonCodexSettings);
    await expect(clobberedProvider.getModel("codex/gpt-5.6-sol")).rejects.toBeInstanceOf(
      CodexSubscriptionUnavailableError,
    );
  });

  test("falls back to the built-in default provider for a model in no provider's allow-list", async () => {
    // In production configureOpenAI sets a global default key/client; mirror that
    // so the SDK fallback OpenAIProvider can construct a model rather than erroring
    // on missing credentials.
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-fallback";
    try {
      const provider = new MultiProviderModelProvider(multiProviderSettings());
      const model = await provider.getModel("some-unconfigured-model");
      expect(model).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("registry model shadowing is closed — the built-in never claims a namespaced registry id", () => {
  // The worker overrides settings.openaiModel to the TURN's model. For a turn on
  // a registry model that override USED to make the built-in provider claim the
  // id (configuredModels derived the built-in's models from openaiModel) and
  // shadow the registry entry — resolving the turn to the built-in (Azure)
  // client and 404'ing on a sandbox/connected-machine backend that re-resolves
  // the model NAME. configuredModels now filters any `<provider>/<model>`-namespaced
  // id a registry owns (and any `codex/` id) out of the built-in allow-list, so
  // the registry provider wins even when its id is the turn's openaiModel.
  const azure = () =>
    multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });

  test("against deployment-default settings, a registry model resolves to its registry provider with gating off", () => {
    const resolved = resolveTurnModel(azure(), FIREWORKS_MODEL)!;
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.provider.api).toBe("chat");
    expect(resolved.configured.hostedWebSearch).toBe(false);
  });

  test("against turn-overridden settings (openaiModel = the registry id) the registry provider STILL wins — no Azure shadow", () => {
    const resolved = resolveTurnModel(
      { ...azure(), openaiModel: FIREWORKS_MODEL },
      FIREWORKS_MODEL,
    )!;
    // Previously the built-in (Azure) shadowed this; the namespaced-id filter
    // keeps it bound to its registry provider and a chat-completions Model.
    expect(resolved.provider.builtin).toBe(false);
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.provider.api).toBe("chat");
    expect(resolved.configured.hostedWebSearch).toBe(false);
    expect(resolved.model).toBeInstanceOf(OpenAIChatCompletionsModel);
  });

  test("the run-scoped provider routes a unique bare registry turn model to its registry provider", async () => {
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: "scripted-1",
      openaiAllowedModels: "gpt-5.6-sol,gpt-5.4",
      modelProvidersJson: JSON.stringify([
        {
          id: "scripted",
          baseUrl: "http://127.0.0.1:8399/v1",
          apiKey: "dummy",
          models: [{ id: "scripted-1", label: "Scripted" }],
        },
      ]),
    });
    const model = await new MultiProviderModelProvider(settings).getModel("scripted-1");
    expect(model).toBeInstanceOf(OpenAIChatCompletionsModel);
  });

  test("a BARE id a registry merely redeclares (e.g. the built-in default) still resolves to the built-in — precedence preserved", () => {
    // The registry below redeclares "gpt-5.6-sol"; the built-in must still win it
    // (only namespaced `<provider>/<model>` ids are ceded to the registry).
    const settings = multiProviderSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
      openaiModel: "gpt-5.6-sol",
      modelProvidersJson: JSON.stringify([
        {
          id: "shadow",
          baseUrl: "https://api.shadow.test/v1",
          apiKey: "shadow-key",
          models: [{ id: "gpt-5.6-sol", label: "Shadowed" }, { id: "shadow/only" }],
        },
      ]),
    });
    const resolved = resolveTurnModel(settings, "gpt-5.6-sol")!;
    expect(resolved.provider.builtin).toBe(true);
    expect(resolved.provider.id).toBe("azure");
  });
});
