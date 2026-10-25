import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { withWorkspaceGatewayCredential, type Settings } from "@opengeni/config";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { buildOpenGeniAgent, prepareAgentTools, type BuildAgentOptions } from "@opengeni/runtime";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import * as gatewayImages from "../src/activities/gateway-image-generation";
import { managedImageGenerationCredential } from "../src/activities/gateway-image-generation";
import type { GeneratedImageReceipt } from "../src/activities/generated-images";

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!.mockRestore();
});

const MANAGED_KEY = "vck_managed_deployment";
const billed = { billingMode: "stripe", vercelAiGatewayApiKey: MANAGED_KEY } as const;

// Execute the production builder for an ordinary credit-funded turn (a
// deployment model on a non-OpenAI-direct route) and capture the image option
// it hands to the runtime.
async function creditTurnImageGeneration(input: {
  settings: Partial<Settings>;
  workspaceCreditModelsAllowed?: boolean;
  capabilitySettings?: (settings: Settings) => Settings;
}) {
  const settings: Settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    ...input.settings,
  });
  const capabilitySettings = input.capabilitySettings?.(settings) ?? settings;
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.eventing.preparedTools = await prepareAgentTools(settings, [], {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
    credentialSubjectId: null,
  });
  restores.push(
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "opengeni_credits",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, value) => value.catalog),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  );
  const remembered: GeneratedImageReceipt[] = [];
  const options: Array<BuildAgentOptions | undefined> = [];
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
      buildAgent: (runSettings: Settings, resources, buildOptions) => {
        options.push(buildOptions);
        return buildOpenGeniAgent(runSettings, resources, {
          ...buildOptions,
          model: new ScriptedModel("done"),
        });
      },
    } as BuildTurnAgentDeps["runtime"],
    observability: createObservability(settings, { component: "worker" }),
    objectStorage: {} as NonNullable<BuildTurnAgentDeps["objectStorage"]>,
    media: {
      rememberGeneratedImageCreatedThisTurn: (receipt: GeneratedImageReceipt) => {
        remembered.push(receipt);
      },
      materializeGeneratedImage: async () => true,
    } as unknown as BuildTurnAgentDeps["media"],
    turn: {
      id: "turn",
      executionGeneration: 1,
      reasoningEffort: "low",
    } as BuildTurnAgentDeps["turn"],
    session: { id: "session" } as BuildTurnAgentDeps["session"],
    runSettings: settings,
    capabilitySettings,
    mcpServers: [],
    skillCatalog: [],
    turnExecutionPolicy: {
      providerId: "azure",
      latencyMode: "standard",
      productModelId: "gpt-6-sol",
    } as BuildTurnAgentDeps["turnExecutionPolicy"],
    resolvedModel: {
      provider: { kind: "azure", id: "azure", api: "responses", builtin: true },
      configured: { id: "gpt-6-sol", capabilities: { reasoning: { runnable: false } } },
    } as unknown as BuildTurnAgentDeps["resolvedModel"],
    codexContext: null as unknown as BuildTurnAgentDeps["codexContext"],
    nativeImageProviderBinding: null,
    workspaceCreditModelsAllowed: input.workspaceCreditModelsAllowed ?? true,
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
  (deps as { leases?: unknown }).leases = {
    codex: { generation: null },
    xai: { generation: null },
  };
  await buildTurnAgent(deps as BuildTurnAgentDeps);
  expect(options).toHaveLength(1);
  return { imageGeneration: options[0]?.imageGeneration, remembered };
}

function fakeReceipt(): GeneratedImageReceipt {
  return { type: "generated_image" } as unknown as GeneratedImageReceipt;
}

describe("credit-funded image generation tool selection", () => {
  test("a credit turn gets the image tool on the deployment's managed key and frozen price", async () => {
    const execute = spyOn(gatewayImages, "executeGatewayImageGeneration").mockResolvedValue(
      fakeReceipt(),
    );
    restores.push(execute);
    const { imageGeneration, remembered } = await creditTurnImageGeneration({ settings: billed });
    expect(imageGeneration).toMatchObject({ kind: "provider_adapter" });
    if (imageGeneration?.kind !== "provider_adapter") throw new Error("no adapter");

    const receipt = await imageGeneration.execute(
      { prompt: "A cat wearing a birthday hat", references: [] },
      { toolCallId: "call-cat" },
    );
    expect(receipt).toEqual(fakeReceipt());
    expect(remembered).toEqual([fakeReceipt()]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      apiKey: MANAGED_KEY,
      modelId: "openai/gpt-image-2",
      pricedCostMicros: 250_000,
      // Plan and trial grants covering the turn's chat model may pay.
      creditUsageModelId: "gpt-6-sol",
      prompt: "A cat wearing a birthday hat",
      toolCallId: "call-cat",
      turnId: "turn",
    });
  });

  test("a refused image is a plain result the agent can relay, not a failed turn", async () => {
    restores.push(
      spyOn(gatewayImages, "executeGatewayImageGeneration").mockRejectedValue(
        new db.ImageGenerationCreditError(),
      ),
    );
    const { imageGeneration, remembered } = await creditTurnImageGeneration({ settings: billed });
    if (imageGeneration?.kind !== "provider_adapter") throw new Error("no adapter");
    const result = await imageGeneration.execute(
      { prompt: "A cat wearing a birthday hat", references: [] },
      { toolCallId: "call-refused" },
    );
    expect(result).toEqual({
      isError: true,
      status: "rejected",
      code: "insufficient_credits",
      message: "this workspace doesn't have enough Opengeni credits left for it",
      content: [
        {
          type: "text",
          text: "This image can't be paid for: this workspace doesn't have enough Opengeni credits left for it.",
        },
      ],
    });
    expect(remembered).toEqual([]);

    // Anything else still fails loudly.
    restores.push(
      spyOn(gatewayImages, "executeGatewayImageGeneration").mockRejectedValue(
        new Error("provider exploded"),
      ),
    );
    await expect(
      imageGeneration.execute({ prompt: "Another", references: [] }, { toolCallId: "call-2" }),
    ).rejects.toThrow("provider exploded");
  });

  test("an operator can turn credit-funded images off", async () => {
    const { imageGeneration } = await creditTurnImageGeneration({
      settings: { ...billed, imageGenerationOpengeniCreditsEnabled: false },
    });
    expect(imageGeneration).toBeUndefined();
  });

  test("a workspace that turned Opengeni credits off is not offered credit-funded images", async () => {
    const { imageGeneration } = await creditTurnImageGeneration({
      settings: billed,
      workspaceCreditModelsAllowed: false,
    });
    expect(imageGeneration).toBeUndefined();
  });

  test("a billed deployment without a priced image model offers no image tool", async () => {
    const { imageGeneration } = await creditTurnImageGeneration({
      settings: { ...billed, imageGenerationModel: "example/unpriced-image-model" },
    });
    expect(imageGeneration).toBeUndefined();
  });

  test("a deployment without a managed Gateway key offers no credit-funded image tool", async () => {
    const { imageGeneration } = await creditTurnImageGeneration({
      settings: { billingMode: "stripe" },
    });
    expect(imageGeneration).toBeUndefined();
  });

  test("the workspace's own Gateway key still pays first and is never charged credits", async () => {
    const execute = spyOn(gatewayImages, "executeGatewayImageGeneration").mockResolvedValue(
      fakeReceipt(),
    );
    restores.push(execute);
    const { imageGeneration } = await creditTurnImageGeneration({
      settings: billed,
      // The workspace key also applies when the workspace turned credits off.
      workspaceCreditModelsAllowed: false,
      capabilitySettings: (settings) => withWorkspaceGatewayCredential(settings, "vck_workspace"),
    });
    if (imageGeneration?.kind !== "provider_adapter") throw new Error("no adapter");
    await imageGeneration.execute({ prompt: "A logo", references: [] }, { toolCallId: "call-1" });
    const call = execute.mock.calls[0]![0];
    expect(call.apiKey).toBe("vck_workspace");
    expect(call).not.toHaveProperty("pricedCostMicros");
    expect(call).not.toHaveProperty("creditUsageModelId");
  });
});

describe("managed image generation credential", () => {
  const base = {
    vercelAiGatewayApiKey: MANAGED_KEY,
    imageGenerationModel: "openai/gpt-image-2",
    imageGenerationOpengeniCreditsEnabled: true,
    imageGenerationCreditMicrosPerImage: undefined,
    billingMode: "stripe",
    usageLimitsMode: "none",
  } as const;

  test("prices the configured model where credits are billed or metered", () => {
    expect(managedImageGenerationCredential(base)).toEqual({
      apiKey: MANAGED_KEY,
      modelId: "openai/gpt-image-2",
      pricedCostMicros: 250_000,
    });
    expect(
      managedImageGenerationCredential({
        ...base,
        billingMode: "disabled",
        usageLimitsMode: "managed",
        imageGenerationCreditMicrosPerImage: 400_000,
      })?.pricedCostMicros,
    ).toBe(400_000);
  });

  test("funds images at no charge where the deployment does not bill credits", () => {
    expect(
      managedImageGenerationCredential({
        ...base,
        billingMode: "disabled",
        imageGenerationModel: "example/unpriced-image-model",
      })?.pricedCostMicros,
    ).toBe(0);
  });

  test("fails closed without a managed key or a price for a billed model", () => {
    expect(
      managedImageGenerationCredential({ ...base, vercelAiGatewayApiKey: undefined }),
    ).toBeNull();
    expect(managedImageGenerationCredential({ ...base, vercelAiGatewayApiKey: "  " })).toBeNull();
    expect(
      managedImageGenerationCredential({
        ...base,
        imageGenerationModel: "example/unpriced-image-model",
      }),
    ).toBeNull();
    expect(
      managedImageGenerationCredential({ ...base, imageGenerationOpengeniCreditsEnabled: false }),
    ).toBeNull();
  });
});
