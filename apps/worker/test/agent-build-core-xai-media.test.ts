import { afterEach, expect, spyOn, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { buildOpenGeniAgent, prepareAgentTools, type BuildAgentOptions } from "@opengeni/runtime";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!.mockRestore();
});

const LEGACY_REACHED = "legacy SuperGrok credential read";

// Execute the production builder for a SuperGrok turn with SuperGrok-funded
// video and a connected image credential, and capture the media options it
// hands to the runtime. Every legacy SuperGrok credential reader is spied on
// and fails loudly, so reaching one is observable.
async function buildSuperGrokTurn(
  core: boolean,
  videoFunding: "supergrok_subscription" | "opengeni_credits" = "supergrok_subscription",
) {
  const settings: Settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
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
  const legacyReaders = [
    spyOn(db, "resolveXaiProviderAccountAuthoritySnapshotForAcceptance").mockRejectedValue(
      new Error(LEGACY_REACHED),
    ),
    spyOn(db, "getXaiSessionAccountPin").mockRejectedValue(new Error(LEGACY_REACHED)),
    spyOn(db, "materializeXaiCredentialForRun").mockRejectedValue(new Error(LEGACY_REACHED)),
    spyOn(db, "selectXaiCredentialForUse").mockRejectedValue(new Error(LEGACY_REACHED)),
  ];
  restores.push(
    ...legacyReaders,
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: videoFunding,
      enabledModelIds: ["xai/grok-imagine-video"],
      defaultModelId: "xai/grok-imagine-video",
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => input.catalog),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  );
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
    media: {} as BuildTurnAgentDeps["media"],
    turn: {
      id: "turn",
      executionGeneration: 1,
      reasoningEffort: "low",
      initiatingHumanSubjectId: "user:owner",
    } as BuildTurnAgentDeps["turn"],
    session: { id: "session" } as BuildTurnAgentDeps["session"],
    runSettings: settings,
    mcpServers: [],
    skillCatalog: [],
    turnExecutionPolicy: {
      providerId: "xai-subscription",
      latencyMode: "standard",
    } as BuildTurnAgentDeps["turnExecutionPolicy"],
    resolvedModel: {
      provider: { kind: "xai-subscription", id: "xai-subscription", api: "responses" },
      configured: { id: "xai/grok-4", capabilities: { reasoning: { runnable: false } } },
    } as unknown as BuildTurnAgentDeps["resolvedModel"],
    codexContext: {} as BuildTurnAgentDeps["codexContext"],
    nativeImageProviderBinding: null,
    providerTurn: {
      ...context.providerTurn,
      // Both routes carry a connected request context and connection id, so
      // only the core gate separates them.
      xaiRequestContext: {} as BuildTurnAgentDeps["providerTurn"]["xaiRequestContext"],
      effectiveXaiCredentialId: "xai-connection",
      xaiRotationEnabled: false,
      xaiSubscriptionCore: core
        ? {
            identity: {
              accountId: "account",
              workspaceId: "workspace",
              sessionId: "session",
              turnId: "turn",
              sessionOwnerSubjectId: "user:owner",
              sessionOwnerMembershipId: null,
              initiatingHumanSubjectId: "user:owner",
              acceptedAuthorityV2: { version: 2, personal: [] },
            },
            connectionId: "xai-connection",
            placedRefreshGeneration: 1,
            personal: false,
          }
        : null,
    },
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
  (deps as { workspaceCreditModelsAllowed?: boolean }).workspaceCreditModelsAllowed = false;
  (deps as { leases?: unknown }).leases = {
    codex: { generation: null },
    xai: { subjectId: "user:owner", generation: 1 },
  };
  const built = buildTurnAgent(deps as BuildTurnAgentDeps);
  return { built, options, legacyReaders };
}

test("a core-placed SuperGrok turn offers no image or video tool and reads no legacy credential", async () => {
  const { built, options, legacyReaders } = await buildSuperGrokTurn(true);
  await built;
  expect(options).toHaveLength(1);
  expect(options[0]?.imageGeneration).toBeUndefined();
  expect(options[0]?.videoGeneration).toBeUndefined();
  for (const reader of legacyReaders) expect(reader).not.toHaveBeenCalled();
});

test("a legacy SuperGrok turn keeps its connected image tool", async () => {
  const { built, options, legacyReaders } = await buildSuperGrokTurn(false, "opengeni_credits");
  await built;
  expect(options[0]?.imageGeneration).toMatchObject({ kind: "provider_adapter" });
  for (const reader of legacyReaders) expect(reader).not.toHaveBeenCalled();
});

test("a legacy SuperGrok turn reaches the legacy video credential", async () => {
  const { built, legacyReaders } = await buildSuperGrokTurn(false);
  // The legacy path reads the subject's v1 authority for SuperGrok-funded video.
  await expect(built).rejects.toThrow(LEGACY_REACHED);
  expect(legacyReaders[0]).toHaveBeenCalledTimes(1);
});
