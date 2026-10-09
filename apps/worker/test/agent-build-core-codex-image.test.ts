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

// Execute the production builder with a mocked database and capture the
// options it hands to the runtime; only the media image option is asserted.
async function capturedImageGeneration(coreCodex: boolean) {
  const settings: Settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
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
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
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
    } as BuildTurnAgentDeps["turn"],
    session: { id: "session" } as BuildTurnAgentDeps["session"],
    runSettings: settings,
    mcpServers: [],
    skillCatalog: [],
    turnExecutionPolicy: {
      providerId: "codex-subscription",
      latencyMode: "standard",
    } as BuildTurnAgentDeps["turnExecutionPolicy"],
    resolvedModel: {
      provider: { kind: "codex-subscription", id: "codex-subscription", api: "responses" },
      configured: { id: "codex/gpt-5.5", capabilities: { reasoning: { runnable: false } } },
    } as unknown as BuildTurnAgentDeps["resolvedModel"],
    codexContext: {} as BuildTurnAgentDeps["codexContext"],
    nativeImageProviderBinding: null,
    providerTurn: {
      ...context.providerTurn,
      effectiveCodexCredentialId: "codex-connection",
      codexSubscriptionCore: coreCodex
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
            connectionId: "codex-connection",
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
  await buildTurnAgent(deps as BuildTurnAgentDeps);
  expect(options).toHaveLength(1);
  return options[0]?.imageGeneration;
}

test("a legacy Codex turn funds image generation through its leased account", async () => {
  expect(await capturedImageGeneration(false)).toMatchObject({ kind: "provider_adapter" });
});

test("a Codex turn placed by the shared core exposes no legacy-funded image tool", async () => {
  expect(await capturedImageGeneration(true)).toBeUndefined();
});
