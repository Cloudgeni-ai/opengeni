import { describe, expect, spyOn, test } from "bun:test";
import {
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import * as db from "@opengeni/db";
import {
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XAI_SUBSCRIPTION_MODEL_SLUGS,
} from "@opengeni/xai-subscription";
import { createObservability } from "@opengeni/observability";
import { buildOpenGeniAgent, prepareAgentTools, resolveTurnModel } from "@opengeni/runtime";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import { textVerbosityForTurn } from "../src/activities/agent-turn/tool-policy";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

function builtinSettings(overrides: Parameters<typeof testSettings>[0] = {}): Settings {
  return testSettings({
    sandboxBackend: "none",
    openaiProvider: "openai",
    openaiModel: "gpt-5.6-sol",
    openaiAllowedModels: "gpt-5.6-sol,gpt-4.1",
    modelProvidersJson: JSON.stringify([
      {
        id: "fireworks",
        label: "Fireworks AI",
        api: "chat",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "fw-test-key",
        models: [{ id: "accounts/fireworks/models/glm-5p2", label: "GLM 5.2" }],
      },
      {
        id: "compatible",
        label: "OpenAI-compatible Responses",
        api: "responses",
        baseUrl: "https://responses.example.test/v1",
        apiKey: "compatible-test-key",
        models: [{ id: "compatible/gpt-5.6-sol", upstreamModelId: "gpt-5.6-sol", label: "Sol" }],
      },
    ]),
    ...overrides,
  });
}

function resolved(settings: Settings, modelId: string) {
  const model = resolveTurnModel(settings, modelId);
  if (!model) throw new Error(`${modelId} did not resolve`);
  return model;
}

function verbosityFor(settings: Settings, modelId: string) {
  const model = resolved(settings, modelId);
  return textVerbosityForTurn(model, model.configured.upstreamModelId);
}

describe("textVerbosityForTurn", () => {
  test("asks for low verbosity only on routes that accept it", () => {
    const codex = withCodexCatalogProvider(builtinSettings());
    expect(verbosityFor(codex, "codex/gpt-6-sol")).toBe("low");
    expect(verbosityFor(builtinSettings(), "gpt-5.6-sol")).toBe("low");

    // Older models accept only the default verbosity.
    expect(verbosityFor(builtinSettings(), "gpt-4.1")).toBeUndefined();
    const codexModel = resolved(codex, "codex/gpt-6-sol");
    expect(textVerbosityForTurn(codexModel, "gpt-5.1-codex-max")).toBeUndefined();
    expect(textVerbosityForTurn(codexModel, "gpt-5-chat-latest")).toBeUndefined();

    // Unverified wires keep the provider default.
    const azure = builtinSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    });
    expect(resolved(azure, "gpt-5.6-sol").provider.wireProfile).toBe("azure-openai");
    expect(verbosityFor(azure, "gpt-5.6-sol")).toBeUndefined();
    const proxied = builtinSettings({ openaiBaseUrl: "https://proxy.example.test/v1" });
    expect(verbosityFor(proxied, "gpt-5.6-sol")).toBeUndefined();
    expect(verbosityFor(builtinSettings(), "compatible/gpt-5.6-sol")).toBeUndefined();
    expect(verbosityFor(builtinSettings(), "accounts/fireworks/models/glm-5p2")).toBeUndefined();
    const xai = withXaiSubscriptionCatalogProvider(builtinSettings());
    const xaiModelId = `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}${XAI_SUBSCRIPTION_MODEL_SLUGS[0]}`;
    expect(resolved(xai, xaiModelId).provider.kind).toBe("xai-subscription");
    expect(verbosityFor(xai, xaiModelId)).toBeUndefined();
    // The legacy global-client path stays byte-identical.
    expect(textVerbosityForTurn(null, "gpt-5.6-sol")).toBeUndefined();
  });
});

// Execute the production builder. Only unrelated persistence is stubbed.
async function buildWorkerAgent(settings: Settings, modelId: string) {
  const resolvedModel = resolved(settings, modelId);
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.eventing.preparedTools = await prepareAgentTools(settings, []);
  const persistence = [
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => input.catalog),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  ];
  try {
    const deps: Partial<BuildTurnAgentDeps> = {
      ...context,
      input: {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "workflow-run",
        trigger: { kind: "next" },
      },
      db: {} as BuildTurnAgentDeps["db"],
      runtime: {
        buildAgent: (runSettings: Settings, resources, options) =>
          buildOpenGeniAgent(runSettings, resources, {
            ...options,
            model: new ScriptedModel("ok"),
          }),
      } as BuildTurnAgentDeps["runtime"],
      observability: createObservability(settings, { component: "worker" }),
      objectStorage: null,
      media: {} as BuildTurnAgentDeps["media"],
      turn: {
        id: "turn",
        executionGeneration: 1,
        reasoningEffort: "medium",
      } as BuildTurnAgentDeps["turn"],
      session: { id: "session" } as BuildTurnAgentDeps["session"],
      runSettings: settings,
      mcpServers: [],
      skillCatalog: [],
      resolvedModel,
      turnExecutionPolicy: {
        providerId: resolvedModel.provider.id,
        latencyMode: "standard",
        upstreamModelId: resolvedModel.configured.upstreamModelId,
      } as BuildTurnAgentDeps["turnExecutionPolicy"],
      runtimeResources: [],
      sandboxEnvironment: {},
      sandboxArtifactRuntime: { available: false, environment: {} },
      fileResourceDownloads: [],
      attemptConnectorActionBindings: [],
      modelInputPolicy: { inputFileMediaTypes: [], supportsImageInput: true },
      preparationIndependentToolNames: [],
      groupBoxBackend: "none",
      postToolPreparationStartedAt: performance.now(),
      trigger: { type: "user.message", payload: {} } as BuildTurnAgentDeps["trigger"],
    };
    return (await buildTurnAgent(deps as BuildTurnAgentDeps)).agent;
  } finally {
    for (const spy of persistence) spy.mockRestore();
    await context.eventing.preparedTools?.close();
  }
}

test("the worker builds every Codex turn with low verbosity and leaves Azure unchanged", async () => {
  const codex = await buildWorkerAgent(
    withCodexCatalogProvider(builtinSettings()),
    "codex/gpt-6-sol",
  );
  expect(codex.modelSettings.text).toEqual({ verbosity: "low" });
  expect(codex.modelSettings.reasoning).toEqual({ effort: "medium", summary: "detailed" });

  const azure = await buildWorkerAgent(
    builtinSettings({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "az-test-key",
    }),
    "gpt-5.6-sol",
  );
  expect(azure.modelSettings.text).toBeUndefined();
  expect(azure.modelSettings.reasoning).toEqual({ effort: "medium", summary: "detailed" });
});
