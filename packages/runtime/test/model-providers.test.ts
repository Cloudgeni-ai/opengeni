import { describe, expect, test } from "bun:test";
import { OpenAIChatCompletionsModel, OpenAIResponsesModel } from "@openai/agents";
import { configuredProviders, resolveModelProvider, type ResolvedModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import OpenAI from "openai";
import { buildModelInstance, buildOpenGeniAgent, buildProviderClient, CodexSubscriptionUnavailableError, MultiProviderModelProvider, resolveTurnModel } from "../src/index";

// A host exposing the built-in OpenAI provider plus Fireworks (the `chat` wire
// API) serving GLM 5.2, mirroring the canonical example in
// docs/model-providers.md. webSearch and encrypted reasoning are OFF for the
// Fireworks model (hostedWebSearch defaults false; chat has no encrypted
// reasoning), which is exactly the gating the runtime must apply.
function multiProviderSettings(overrides: Parameters<typeof testSettings>[0] = {}) {
  return testSettings({
    sandboxBackend: "none",
    openaiProvider: "openai",
    openaiModel: "gpt-5.5",
    openaiAllowedModels: "gpt-5.5,gpt-5.4",
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
      compactionMode: "client",
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
      compactionMode: "server",
    };
    const model = buildModelInstance(provider, client, "gpt-5.5");
    expect(model).toBeInstanceOf(OpenAIResponsesModel);
    expect(model).not.toBeInstanceOf(OpenAIChatCompletionsModel);
  });
});

describe("buildProviderClient", () => {
  test("a registry provider gets a client pointed at its base URL with its key/headers, cached by id", () => {
    const settings = multiProviderSettings();
    const provider = configuredProviders(settings).find((candidate) => candidate.id === "fireworks")!;
    expect(provider).toBeDefined();
    const client = buildProviderClient(provider, settings);
    expect(client.baseURL).toBe("https://api.fireworks.ai/inference/v1");
    expect(client.apiKey).toBe("fw-test-key");
    expect(client.maxRetries).toBe(settings.openaiMaxRetries);
    // One client per provider id (module-level cache).
    expect(buildProviderClient(provider, settings)).toBe(client);
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
    expect(resolved!.provider.compactionMode).toBe("client");
    expect(resolved!.client.baseURL).toBe("https://api.fireworks.ai/inference/v1");
    expect(resolved!.model).toBeInstanceOf(OpenAIChatCompletionsModel);
    expect(resolved!.configured.id).toBe(FIREWORKS_MODEL);
    expect(resolved!.configured.contextWindowTokens).toBe(1_048_576);
    expect(resolved!.configured.hostedWebSearch).toBe(false);
  });

  test("resolves the built-in model to the responses provider + an OpenAIResponsesModel", () => {
    const resolved = resolveTurnModel(multiProviderSettings(), "gpt-5.5");
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.id).toBe("openai");
    expect(resolved!.provider.api).toBe("responses");
    expect(resolved!.model).toBeInstanceOf(OpenAIResponsesModel);
  });
});

// The agent the worker builds for a Fireworks turn passes the resolved gating
// into buildOpenGeniAgent. These tests pin that the gating actually changes the
// constructed agent the way the multi-provider contract requires.
function webSearchHostedTools(agent: ReturnType<typeof buildOpenGeniAgent>): Array<Record<string, unknown>> {
  return ((agent as { tools?: Array<Record<string, unknown>> }).tools ?? []).filter((tool) =>
    tool.type === "hosted_tool"
    && (tool.providerData as { type?: unknown } | undefined)?.type === "web_search");
}

describe("multi-provider gating in buildOpenGeniAgent", () => {
  test("a resolved chat provider turn: no web_search tool, no encrypted reasoning, no server store", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, FIREWORKS_MODEL)!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      compactionMode: resolved.provider.compactionMode,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning: resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
      contextWindowTokens: resolved.configured.contextWindowTokens,
    });
    // hostedWebSearch off → no web_search tool and no explicit tools field at all.
    expect(webSearchHostedTools(agent)).toHaveLength(0);
    expect((agent as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
    // encryptedReasoning off (chat wire API) → no providerData.include.
    expect((agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData).toBeUndefined();
    // compactionMode "client" → store is NOT forced false.
    expect((agent as { modelSettings: { store?: unknown } }).modelSettings.store).toBeUndefined();
    // The provider-bound Model instance is the one passed in (chat routing).
    expect((agent as { model?: unknown }).model).toBe(resolved.model);
  });

  test("the built-in responses turn keeps web_search, encrypted reasoning, and server store on", () => {
    const settings = multiProviderSettings();
    const resolved = resolveTurnModel(settings, "gpt-5.5")!;
    const agent = buildOpenGeniAgent(settings, [], {
      model: resolved.model,
      compactionMode: resolved.provider.compactionMode,
      hostedWebSearch: resolved.configured.hostedWebSearch,
      encryptedReasoning: resolved.provider.api === "responses" && settings.openaiReasoningEncryptedContent,
      contextWindowTokens: resolved.configured.contextWindowTokens,
    });
    expect(webSearchHostedTools(agent)).toHaveLength(1);
    expect((agent as { modelSettings: { providerData?: unknown } }).modelSettings.providerData).toEqual({ include: ["reasoning.encrypted_content"] });
    expect((agent as { modelSettings: { store?: unknown } }).modelSettings.store).toBe(false);
  });

  test("resolveModelProvider/configuredProviders agree on the registry provider's client gating", () => {
    // Cross-check the config layer the runtime builds on: the resolved provider
    // for the Fireworks model is the chat/client provider, and the built-in
    // provider stays responses/server — the runtime never re-derives this.
    const settings = multiProviderSettings();
    const fireworks = resolveModelProvider(settings, FIREWORKS_MODEL);
    expect(fireworks?.provider.compactionMode).toBe("client");
    expect(fireworks?.provider.api).toBe("chat");
    const builtin = resolveModelProvider(settings, "gpt-5.5");
    expect(builtin?.provider.compactionMode).toBe("server");
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
    const builtin = await provider.getModel("gpt-5.5");
    expect(builtin).toBeInstanceOf(OpenAIResponsesModel);
  });

  test("a codex/<slug> id with NO codex provider in settings throws the actionable error (NOT an Azure fallback)", async () => {
    // The staging failure: codex_subscription_credentials empty → the worker
    // overlay never injects the codex provider → resolveTurnModel returns null
    // for "codex/gpt-5.5". The router must NOT fall through to the built-in
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
      await provider.getModel("codex/gpt-5.5");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexSubscriptionUnavailableError);
    expect((thrown as Error).message).toContain("codex/gpt-5.5");
    expect((thrown as Error).message).toContain("Codex subscription");
    expect((thrown as Error).message).toContain("Settings");
    // No status/code → agentRunFailurePayload surfaces it as a non-retryable
    // turn.failed (not a rate-limit retry).
    expect((thrown as { status?: unknown }).status).toBeUndefined();
    expect((thrown as { code?: unknown }).code).toBeUndefined();
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

describe("registry model shadowing — why the worker resolves gating against the deployment-default settings", () => {
  // The worker overrides settings.openaiModel to the TURN's model. For a turn on
  // a registry model that override makes the built-in provider claim the id
  // (configuredModels derives the built-in's models from openaiModel) and shadow
  // the registry entry — resolving the turn to built-in (Azure) gating while the
  // global router routes the name to the registry provider, attaching web_search
  // to a chat-only Fireworks model. So the worker MUST resolve against the
  // default-model settings, asserted here.
  const azure = () => multiProviderSettings({
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

  test("against turn-overridden settings (openaiModel = the registry id) the built-in shadows it — the trap the worker avoids", () => {
    const shadowed = resolveTurnModel({ ...azure(), openaiModel: FIREWORKS_MODEL }, FIREWORKS_MODEL)!;
    expect(shadowed.provider.builtin).toBe(true);
    expect(shadowed.configured.hostedWebSearch).toBe(true);
  });
});
