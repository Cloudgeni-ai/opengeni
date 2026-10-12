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
// The legacy SuperGrok branch needs a request context; it has none here, so
// an exposed image tool can only come from the core branch.
async function capturedImageGeneration(coreXai: boolean, coreLeaseGeneration: number | null = 1) {
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
      providerId: "xai-subscription",
      latencyMode: "standard",
    } as BuildTurnAgentDeps["turnExecutionPolicy"],
    resolvedModel: {
      provider: { kind: "xai-subscription", id: "xai-subscription", api: "responses" },
      configured: { id: "supergrok/grok-4", capabilities: { reasoning: { runnable: false } } },
    } as unknown as BuildTurnAgentDeps["resolvedModel"],
    codexContext: null as unknown as BuildTurnAgentDeps["codexContext"],
    nativeImageProviderBinding: null,
    providerTurn: {
      ...context.providerTurn,
      effectiveXaiCredentialId: "xai-connection",
      xaiRequestContext: null,
      xaiSubscriptionCore: coreXai
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
  (deps as { leases?: unknown }).leases = {
    codex: { generation: null },
    xai: { generation: coreLeaseGeneration },
  };
  await buildTurnAgent(deps as BuildTurnAgentDeps);
  expect(options).toHaveLength(1);
  return options[0]?.imageGeneration;
}

test("a legacy SuperGrok turn without a request context exposes no image tool", async () => {
  expect(await capturedImageGeneration(false)).toBeUndefined();
});

test("a SuperGrok turn placed by the shared core funds image generation through core operation leases", async () => {
  expect(await capturedImageGeneration(true)).toMatchObject({ kind: "provider_adapter" });
});

test("a core SuperGrok turn without a held lease generation exposes no image tool", async () => {
  expect(await capturedImageGeneration(true, null)).toBeUndefined();
});
