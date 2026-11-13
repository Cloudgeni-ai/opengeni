import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { sessionWithEffectiveToolPolicy, resolveSessionAgentConfigForCreate } from "@opengeni/core";
import { RunContext, type ModelRequest, type Tool } from "@openai/agents";
import { CODEX_FALLBACK_MODEL_SLUGS, CODEX_MODEL_ID_PREFIX } from "@opengeni/codex/constants";
import {
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XAI_SUBSCRIPTION_MODEL_SLUGS,
} from "@opengeni/xai-subscription";
import {
  allowedFirstPartyMcpToolsForSession,
  resolveTurnExecutionPolicyV1,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import {
  bundledSkillSelectionFromMetadata,
  AGENT_CAPABILITY_IDS,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_NAMES,
  FIRST_PARTY_IN_PROCESS_TOOL_NAMES,
  AGENT_FUNCTION_TOOL_CAPABILITIES,
  allAgentCapabilities,
  noneAgentCapabilities,
  projectAgentEffectiveTools,
  resolveAgentToolFamilies,
  type AgentCapabilityId,
  type AgentConfigCreator,
  type AgentSkillsCapability,
  type BundledSkillId,
  type FirstPartyMcpToolName,
  type ResolvedAgentConfig,
  type AgentMediaAttachment,
  metadataWithTurnExecutionPolicyV1,
  SESSION_UNATTENDED_METADATA_KEY,
  verifyDelegatedAccessToken,
} from "@opengeni/contracts";
import { sessionEffectiveToolProjectionInput } from "@opengeni/core";
import * as db from "@opengeni/db";
import * as runtimeExports from "@opengeni/runtime";
import { createObservability } from "@opengeni/observability";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
  resolveTurnModel,
  runAgentStream,
  type BuildAgentOptions,
  type OpenGeniRuntime,
  type PrepareToolsOptions,
} from "@opengeni/runtime";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { testSettings } from "@opengeni/testing/settings";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import {
  prepareTurnToolPolicy,
  prepareTurnToolRuntime,
  type PrepareTurnToolRuntimeDeps,
} from "../src/activities/agent-turn/tool-environment";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import { lazyToolRuntimeForAgent } from "../../../packages/runtime/src/lazy-tool-transport";

const SCOPE = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
};
const SKILL_SENTINEL = "m3-enforcement-installed-skill";
const SKILL_MANAGEMENT_TOOLS = [
  "skill_search",
  "skill_checkout",
  "skill_save",
  "skill_install",
  "skill_publish",
  "skill_remove",
] as const;

function agentConfig(
  from: "all" | "none",
  capability?: AgentCapabilityId,
  value?: boolean | AgentSkillsCapability,
): ResolvedAgentConfig {
  const capabilities = from === "all" ? allAgentCapabilities() : noneAgentCapabilities();
  if (capability === "skills") capabilities.skills = value as AgentSkillsCapability;
  else if (capability) capabilities[capability] = value as boolean;
  return {
    version: 1,
    from,
    capabilities,
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

function toolName(tool: Tool | ModelRequest["tools"][number]): string {
  if (tool.type === "hosted_tool") {
    return String((tool.providerData as { type?: string }).type ?? tool.name);
  }
  return tool.name;
}

type FixtureOptions = {
  agent?: ResolvedAgentConfig | null;
  humanRecipient?: boolean;
  /** The product server is listed eagerly with lazy tool search on: the embedding profile. */
  eagerProduct?: boolean;
  hasSkills?: boolean;
  inlineSkills?: BuildTurnAgentDeps["session"]["skills"];
  loadSkillDescriptors?: () => Promise<Awaited<ReturnType<typeof db.listSkillDescriptors>>>;
  loadVideoPolicy?: (
    phase: "tool-preparation" | "agent-build",
  ) => Promise<Awaited<ReturnType<typeof db.getWorkspaceVideoGenerationPolicy>>>;
  videoEnabled?: boolean;
  /** Build the runtime agent without the video adapter, as before it was always attached. */
  withoutVideoAdapter?: boolean;
  lazy?: boolean;
  productMcp?: boolean;
  builtins?: boolean;
  deploymentDisabled?: AgentCapabilityId;
  modelId?: string;
  subscription?: "codex-subscription" | "xai-subscription";
  localMediaCredential?: boolean;
  foreignMediaCredential?: boolean;
  credentialRestrictionSource?: "accepted" | "initial" | "spoof" | "none";
  /** Route this turn to an attached Connected Machine (home stays `none`). */
  machineAttached?: boolean;
  /** The turn minted a Codemode bearer. */
  codemodeToken?: boolean;
  /** The stored bundled selection; `"omit"` leaves it undefined. Default `[]`. */
  bundledSkillIds?: BundledSkillId[] | "omit";
  /** Rendered workspace governance for this turn. */
  workspaceGovernance?: string;
  /** The agent revision in the chat's system prompt (sessions.agent_prompt_revision). */
  agentPrompt?: BuildTurnAgentDeps["agentPrompt"];
  /** The session started unattended (frozen in its metadata) and still is. */
  unattended?: boolean;
  /** Above zero: a child session, which a parent agent can answer. */
  nestedAgentDepth?: number;
  /** The deployment Files server's allow-list (default: only the fixture tool). */
  filesAllowedTools?: string[];
  /** Observes what the worker hands the spill port for an oversized result. */
  onSpill?: (input: Parameters<PrepareTurnToolRuntimeDeps["toolResultSpill"]["spill"]>[0]) => void;
  /**
   * The product connector needs the person's own sign-in, and none was
   * admitted for this turn (no accepted account binding).
   */
  productSignInNotAdmitted?: boolean;
  /** The goal frozen with the turn; omitted leaves it unknown. */
  goal?: "none" | "paused";
};

// Execute all three production worker phases and the production runtime builder.
// The fixture replaces only unrelated persistence, the first-party API's
// token-scoped tools/list response, and transport providers. It never applies
// agent capability filtering itself.
async function captureWorkerRequest(options: FixtureOptions = {}) {
  const delegatedPayloads: Awaited<ReturnType<typeof verifyDelegatedAccessToken>>[] = [];
  const interactionPayloads: Awaited<ReturnType<typeof verifyDelegatedAccessToken>>[] = [];
  const mcp = startTestMcpServer({
    toolsForAuthorization: () => [...FIRST_PARTY_MCP_TOOL_NAMES],
    validateAuthorization: async (authorization) => {
      if (authorization?.startsWith("Bearer ")) {
        const payload = await verifyDelegatedAccessToken(
          "test-delegation-secret",
          authorization.slice(7),
        );
        if (payload) delegatedPayloads.push(payload);
      }
      return true;
    },
  });
  const configuredServerIds = [
    "opengeni",
    ...(options.builtins === false ? [] : ["files", "docs"]),
    ...(options.productMcp === false ? [] : ["customer-product"]),
  ];
  const disabled = options.deploymentDisabled;
  const baseSettings = testSettings({
    sandboxBackend: options.videoEnabled ? "docker" : "none",
    ...(options.videoEnabled
      ? {
          vercelAiGatewayApiKey: "fixture-video-gateway-key",
          environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
        }
      : {}),
    ...(options.modelId ? { openaiModel: options.modelId } : {}),
    webSearchEnabled: disabled !== "webSearch",
    lazyToolSearchEnabled: options.lazy === true || options.eagerProduct === true,
    allowedFirstPartyMcpTools: FIRST_PARTY_MCP_TOOL_NAMES.filter(
      (name) => FIRST_PARTY_MCP_TOOL_CAPABILITIES[name] !== disabled,
    ),
    mcpServers: configuredServerIds.map((id) => ({
      id,
      url: mcp.url,
      cacheToolsList: false,
      allowedTools:
        id === "opengeni"
          ? [...FIRST_PARTY_MCP_TOOL_NAMES]
          : id === "files" && options.filesAllowedTools
            ? options.filesAllowedTools
            : ["search_documents"],
      ...(options.productSignInNotAdmitted && id === "customer-product"
        ? {
            name: "Customer Product",
            connectionRef: {
              providerDomain: "product.example",
              kind: "oauth2" as const,
              subjectScope: "subject" as const,
            },
          }
        : {}),
    })),
  });
  const settings =
    options.subscription === "codex-subscription"
      ? withCodexCatalogProvider(baseSettings)
      : options.subscription === "xai-subscription"
        ? withXaiSubscriptionCatalogProvider(baseSettings)
        : baseSettings;
  const model = new ScriptedModel("done");
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  context.attempt.turnId = SCOPE.turnId;
  context.attempt.executionGeneration = 1;
  context.eventing.publish = async () => {};
  const skillCatalogWrites: string[] = [];
  const governanceWrites: Array<string | null> = [];
  const agentInstructionChecks: Array<NonNullable<BuildTurnAgentDeps["agentPrompt"]>> = [];
  let preparationPhase: "tool-preparation" | "agent-build" = "tool-preparation";
  const metadataReads = { skillDescriptors: 0, videoPolicy: 0 };
  const persistence = [
    spyOn(db, "requireWorkspace").mockResolvedValue({
      id: SCOPE.workspaceId,
      settings: {},
    } as Awaited<ReturnType<typeof db.requireWorkspace>>),
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockImplementation(async () => {
      metadataReads.videoPolicy++;
      if (options.loadVideoPolicy) return await options.loadVideoPolicy(preparationPhase);
      return {
        schemaVersion: 1,
        revision: 0,
        fundingSource: options.videoEnabled ? "opengeni_credits" : "workspace_gateway",
        enabledModelIds: options.videoEnabled ? ["bytedance/seedance-2.5"] : [],
        defaultModelId: options.videoEnabled ? "bytedance/seedance-2.5" : null,
      };
    }),
    spyOn(db, "listSkillDescriptors").mockImplementation(async () => {
      metadataReads.skillDescriptors++;
      if (options.loadSkillDescriptors) return await options.loadSkillDescriptors();
      return options.hasSkills === false
        ? []
        : [
            {
              id: "66666666-6666-4666-8666-666666666666",
              title: SKILL_SENTINEL,
              description: "Installed test Skill",
              activationMode: "workspace_managed",
            } as Awaited<ReturnType<typeof db.listSkillDescriptors>>[number],
          ];
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => {
      skillCatalogWrites.push(input.catalog);
      // A session that never saw an index keeps none when told to omit it.
      return input.omitWhenEmpty ? "" : input.catalog;
    }),
    spyOn(db, "ensureSessionWorkspaceGovernance").mockImplementation(async (_db, input) => {
      governanceWrites.push(input.governance);
      return input.governance;
    }),
    spyOn(db, "ensureSessionAgentInstructions").mockImplementation(async (_db, input) => {
      agentInstructionChecks.push(input.prompt);
      return null;
    }),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
    ...(typeof db.sessionHasToolRouterHistory === "function"
      ? [spyOn(db, "sessionHasToolRouterHistory").mockResolvedValue(false)]
      : []),
    spyOn(db, "persistAttemptToolCatalog").mockImplementation(async (_db, catalog) => catalog),
    spyOn(db, "cancelQueuedCodemodeOperationsForAttempt").mockResolvedValue(0),
  ];
  if (options.credentialRestrictionSource) {
    const createInteractionTools = runtimeExports.createFirstPartyInteractionAttemptToolDefinitions;
    persistence.push(
      spyOn(runtimeExports, "createFirstPartyInteractionAttemptToolDefinitions").mockImplementation(
        (input) =>
          createInteractionTools({
            ...input,
            fetch: (async (_request, init) => {
              const authorization = new Headers(init?.headers).get("authorization")!;
              interactionPayloads.push(
                await verifyDelegatedAccessToken("test-delegation-secret", authorization.slice(7)),
              );
              return Response.json({
                browserSessionId: SCOPE.sessionId,
                controllerGeneration: "controller-1",
                revision: 1,
                text: "clipboard",
                source: "copy",
                sourceTargetId: "tab-1",
                updatedAt: new Date().toISOString(),
              });
            }) as typeof fetch,
          }),
      ),
    );
  }
  let preparation: PrepareToolsOptions | undefined;
  let buildOptions: BuildAgentOptions | undefined;
  const runtime = {
    prepareTools: async (runSettings: Settings, tools, prepareOptions) => {
      preparation = prepareOptions;
      // Model the real first-party API's accepted token selection. The shared
      // MCP fixture advertises arbitrary extra names but does not decode tokens.
      const scopedSettings: Settings = {
        ...runSettings,
        ...(options.credentialRestrictionSource
          ? { opengeniMcpInternalUrl: `${mcp.url}?ws={workspaceId}` }
          : {}),
        mcpServers: runSettings.mcpServers.map((server) =>
          server.id === "opengeni"
            ? {
                ...server,
                ...(options.credentialRestrictionSource
                  ? { url: `${mcp.url}?ws={workspaceId}` }
                  : {}),
                allowedTools: [...(prepareOptions?.firstPartyTools ?? [])].filter(
                  (name) =>
                    !options.modelId || !FIRST_PARTY_IN_PROCESS_TOOL_NAMES.includes(name as never),
                ),
              }
            : server,
        ),
      };
      return await prepareAgentTools(scopedSettings, tools, prepareOptions);
    },
    buildAgent: (runSettings: Settings, resources, agentOptions) => {
      buildOptions = agentOptions;
      // Exercise worker video admission and the real model request without
      // provisioning physical compute; this fixture never invokes media tools.
      // Preserve the worker's required cancellation-controller handshake too.
      if (options.videoEnabled)
        agentOptions.onToolCancellationFence?.(
          runtimeExports.createTurnToolCancellationController(),
        );
      const { videoGeneration, ...withoutVideo } = agentOptions;
      return buildOpenGeniAgent(
        options.videoEnabled ? { ...runSettings, sandboxBackend: "none" } : runSettings,
        resources,
        {
          ...withoutVideo,
          ...(videoGeneration && !options.withoutVideoAdapter ? { videoGeneration } : {}),
          model,
        },
      );
    },
  } satisfies Pick<OpenGeniRuntime, "prepareTools" | "buildAgent">;
  const session = {
    id: SCOPE.sessionId,
    accountId: SCOPE.accountId,
    workspaceId: SCOPE.workspaceId,
    activeSandboxId: null,
    rootSessionId: SCOPE.sessionId,
    title: "Configured test session",
    titleSource: "human",
    metadata:
      options.credentialRestrictionSource === "initial"
        ? metadataWithTurnExecutionPolicyV1(
            {},
            {
              ...resolveTurnExecutionPolicyV1(settings, {
                modelId: settings.openaiModel,
                requestedModelId: null,
                modelSource: "session",
                reasoningEffort: "low",
                reasoningSource: "session",
              }),
              credentialRestriction: "developer_setup",
            },
          )
        : options.credentialRestrictionSource === "spoof"
          ? { credentialRestriction: "developer_setup" }
          : options.unattended
            ? { [SESSION_UNATTENDED_METADATA_KEY]: true }
            : {},
    ...(options.unattended ? { unattended: true } : {}),
    ...(Object.hasOwn(options, "agent") ? { agent: options.agent } : {}),
    instructions: null,
    resources: [],
    tools: configuredServerIds.map((id) => ({
      kind: "mcp" as const,
      id,
      ...(options.lazy || (options.eagerProduct && id === "customer-product")
        ? { eager: true }
        : {}),
    })),
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    ...(options.bundledSkillIds === "omit"
      ? {}
      : { bundledSkillIds: options.bundledSkillIds ?? [] }),
    skills: options.inlineSkills ?? [],
    firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
    firstPartyMcpPermissions: null,
    model: options.modelId ?? "scripted-model",
    sandboxBackend: "none",
    mcpServers: [{ id: "customer-product" }],
    nestedAgentDepth: options.nestedAgentDepth ?? 0,
    effectiveMaxNestedAgentDepth: 3,
  } as BuildTurnAgentDeps["session"];
  const turn = {
    id: SCOPE.turnId,
    executionGeneration: 1,
    reasoningEffort: "low",
    sandboxBackend: "none",
    initiator:
      options.humanRecipient === false
        ? { kind: "api_key", subjectId: "api_key:fixture" }
        : { kind: "subject", subjectId: "user:fixture-human" },
    resources: [],
    tools: session.tools,
    ...(options.goal === "none"
      ? { goalSnapshot: { state: "none", capturedAt: "2026-01-01T00:00:00.000Z" } }
      : options.goal === "paused"
        ? {
            goalSnapshot: {
              state: "paused",
              goalId: "77777777-7777-4777-8777-777777777777",
              objectiveRevision: 1,
              text: "Finish the migration",
              successCriteria: null,
              rootConstraints: [],
              mutationPolicy: "preserve_intent",
              capturedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : {}),
    personalConnectionDelegations: [],
    mcpAccountBindings: [],
  } as BuildTurnAgentDeps["turn"];
  const input = {
    ...SCOPE,
    workflowId: "workflow",
    workflowRunId: "workflow-run",
    trigger: { kind: "next" as const },
  };
  const trigger = {
    type: "user.message",
    payload: {},
  } as BuildTurnAgentDeps["trigger"];
  let turnExecutionPolicy = {
    providerId: "openai",
    reasoningEffort: "low",
    productModelId: "scripted-model",
    upstreamModelId: "scripted-model",
    latencyMode: "standard",
    ...(options.credentialRestrictionSource === "accepted"
      ? { credentialRestriction: "developer_setup" }
      : {}),
  } as BuildTurnAgentDeps["turnExecutionPolicy"];
  try {
    // Use the complete production catalog contract, not a partial model cast.
    // Catalog identity is not a credential grant: the exact local credential
    // and request context below remain the media admission boundary.
    const resolvedModel: BuildTurnAgentDeps["resolvedModel"] = options.subscription
      ? resolveTurnModel(settings, options.modelId ?? "")
      : null;
    if (options.subscription) {
      if (!resolvedModel || resolvedModel.provider.kind !== options.subscription) {
        throw new Error("subscription fixture requires an exposed model of the selected provider");
      }
      turnExecutionPolicy = resolveTurnExecutionPolicyV1(settings, {
        modelId: resolvedModel.configured.id,
        requestedModelId: null,
        modelSource: "session",
        reasoningEffort: turn.reasoningEffort,
        reasoningSource: "session",
      });
    }
    const policy = await prepareTurnToolPolicy({
      input,
      db: {} as BuildTurnAgentDeps["db"],
      cancellationSignal: undefined,
      connectionCredentials: undefined,
      turn,
      session,
      fileAuthoritySubjectId: null,
      capabilitySettings: settings,
      runSettings: settings,
      rigVersion: null,
      workspaceRefs: context.workspaceRefs,
    });
    const toolRuntime = await prepareTurnToolRuntime({
      ...context,
      input,
      catalogSourceSettings: settings,
      db: {} as BuildTurnAgentDeps["db"],
      bus: { subscribeRequests: () => () => {} } as PrepareTurnToolRuntimeDeps["bus"],
      runtime: runtime as OpenGeniRuntime,
      objectStorage: null,
      observability: createObservability(settings, { component: "worker" }),
      media: {} as BuildTurnAgentDeps["media"],
      ...(options.onSpill
        ? {
            toolResultSpill: {
              spill: async (spillInput) => {
                options.onSpill!(spillInput);
                return { content: [{ type: "text", text: "spilled" }] };
              },
            } as PrepareTurnToolRuntimeDeps["toolResultSpill"],
          }
        : {}),
      turn,
      session,
      fileAuthoritySubjectId: null,
      capabilitySettings: settings,
      installedApiIntegrations: [],
      codexAppsCredentialId: null,
      turnExecutionPolicy,
      trigger,
      runSettings: settings,
      resolvedModel: null,
      lazyToolTransport: "generic_dispatch",
      ...policy,
      sandboxArtifactRuntime: { available: false, environment: {} },
      groupBoxBackend: "none",
      ...(options.machineAttached ? { activeSandboxBackend: "selfhosted" as const } : {}),
      routingOn: false,
      credentialSubjectId: null,
      interactionInterventionResume: null,
      codeSearchEnabled: false,
      throwIfWorkerShuttingDown: () => {},
      throwIfTurnCancelled: () => {},
    } as PrepareTurnToolRuntimeDeps);
    preparationPhase = "agent-build";
    const built = await buildTurnAgent({
      ...context,
      ...toolRuntime,
      ...(options.workspaceGovernance !== undefined
        ? { workspaceGovernance: options.workspaceGovernance }
        : {}),
      agentPrompt: options.agentPrompt ?? null,
      input,
      db: {} as BuildTurnAgentDeps["db"],
      runtime: runtime as OpenGeniRuntime,
      observability: createObservability(settings, { component: "worker" }),
      objectStorage: {} as NonNullable<BuildTurnAgentDeps["objectStorage"]>,
      media: {} as BuildTurnAgentDeps["media"],
      turn,
      session,
      runSettings: settings,
      capabilitySettings: settings,
      nativeImageProviderBinding: options.subscription
        ? null
        : {
            providerId: "openai",
            providerBindingHash: "fixture-native-image-binding",
          },
      ...(options.subscription
        ? {
            resolvedModel,
            codexContext:
              options.subscription === "codex-subscription" || options.foreignMediaCredential
                ? {}
                : undefined,
            providerTurn: {
              ...context.providerTurn,
              effectiveCodexCredentialId: (
                options.subscription === "codex-subscription"
                  ? options.localMediaCredential
                  : options.foreignMediaCredential
              )
                ? "fixture-codex-media-id"
                : null,
              effectiveXaiCredentialId: (
                options.subscription === "xai-subscription"
                  ? options.localMediaCredential
                  : options.foreignMediaCredential
              )
                ? "fixture-xai-media-id"
                : null,
              xaiRequestContext: null,
              // SuperGrok's only media credential is its shared-core placement
              // (its legacy credential path was deleted after the cutover).
              xaiSubscriptionCore: (
                options.subscription === "xai-subscription"
                  ? options.localMediaCredential
                  : options.foreignMediaCredential
              )
                ? {
                    identity: {
                      accountId: SCOPE.accountId,
                      workspaceId: SCOPE.workspaceId,
                      sessionId: SCOPE.sessionId,
                      turnId: "fixture-turn",
                      sessionOwnerSubjectId: "user:fixture",
                      sessionOwnerMembershipId: null,
                      initiatingHumanSubjectId: "user:fixture",
                      acceptedAuthorityV2: { version: 2, personal: [] },
                    },
                    connectionId: "fixture-xai-media-id",
                    placedRefreshGeneration: 1,
                    personal: false,
                  }
                : null,
            },
            leases: {
              codex: { generation: null },
              xai: { generation: 1, assertCurrentForDispatch: async () => {} },
            },
          }
        : {}),
      turnExecutionPolicy,
      trigger,
      agentHumanInputEnabled: disabled !== "humanInput",
      runtimeResources: [],
      sandboxEnvironment: {},
      sandboxArtifactRuntime: { available: false, environment: {} },
      fileResourceDownloads: [],
      modelInputPolicy: { inputFileMediaTypes: [], supportsImageInput: true },
      groupBoxBackend: "none",
      lazyToolTransport: options.lazy || options.eagerProduct ? "generic_dispatch" : undefined,
      ...(options.machineAttached ? { activeSandboxBackend: "selfhosted" as const } : {}),
      ...(options.codemodeToken ? { sandboxCodemodeToken: "fixture-codemode-token" } : {}),
    } as BuildTurnAgentDeps);
    const visibleTools = await built.agent.getAllTools(new RunContext());
    const result = await runAgentStream(
      built.agent,
      {
        // As in session history: an omitted Skill index leaves no item.
        input: [
          ...(built.modelVisibleSkillCatalogText
            ? [{ role: "developer" as const, content: built.modelVisibleSkillCatalogText }]
            : []),
          { role: "user" as const, content: "Reply done without calling tools." },
        ],
        persistedHistoryCount: 0,
      },
      settings,
    );
    for await (const _event of result.toStream()) {
      /* consume the real runner's serialized request */
    }
    await result.completed;
    expect(model.requests).toHaveLength(1);
    const request = model.requests[0]!;
    const prepared =
      (await context.eventing.preparedTools!.ready) ?? context.eventing.preparedTools!;
    if (options.credentialRestrictionSource) {
      const interaction = preparation!.attemptToolDefinitions!.find(
        (tool) => tool.identity.toolName === "browser_clipboard",
      );
      if (!interaction) throw new Error("interaction tool missing from worker preparation");
      await interaction.execute(
        { browserSessionId: SCOPE.sessionId },
        { operationId: crypto.randomUUID(), caller: { kind: "model", subjectId: "fixture" } },
      );
    }
    return {
      metadataReads,
      delegatedPayloads,
      interactionPayloads,
      request,
      names: request.tools.map(toolName).sort(),
      visibleNames: visibleTools.map(toolName).sort(),
      catalog: prepared.attemptToolCatalog!,
      preparation: preparation!,
      buildOptions: buildOptions!,
      resolvedModel,
      mediaAttachment: {
        image: buildOptions?.imageGeneration?.kind ?? null,
        video: buildOptions?.videoGeneration !== undefined,
      } satisfies AgentMediaAttachment,
      skillCatalog: toolRuntime.skillCatalog,
      mcpAvailabilityNote: toolRuntime.mcpAvailabilityNote,
      modelVisibleSkillCatalogText: built.modelVisibleSkillCatalogText,
      skillCatalogWrites,
      governanceWrites,
      agentInstructionChecks,
      selectedServerIds: policy.turnTools.map((tool) => tool.id).sort(),
      settings,
      session,
      deferredNames:
        lazyToolRuntimeForAgent(built.agent)
          ?.inspectSearchableTools()
          .map((tool) => tool.name) ?? [],
      turnTools: policy.turnTools,
    };
  } finally {
    await context.eventing.codemodeDispatcher?.close();
    await context.eventing.preparedTools?.close();
    for (const spy of persistence) spy.mockRestore();
    mcp.close();
  }
}

test.each(["accepted", "initial", "spoof", "none"] as const)(
  "worker tool environment signs only trusted %s setup provenance",
  async (credentialRestrictionSource) => {
    const captured = await captureWorkerRequest({ credentialRestrictionSource, builtins: false });
    const restriction =
      credentialRestrictionSource === "accepted" || credentialRestrictionSource === "initial"
        ? "developer_setup"
        : undefined;
    expect(captured.preparation.credentialRestriction).toBe(restriction);
    expect(captured.delegatedPayloads.length).toBeGreaterThan(0);
    expect(captured.interactionPayloads).toHaveLength(1);
    for (const payload of [...captured.delegatedPayloads, ...captured.interactionPayloads]) {
      expect(payload.credentialRestriction).toBe(restriction);
      expect(Object.hasOwn(payload, "credentialRestriction")).toBe(!!restriction);
      expect(payload.principalKind).toBe("agent_attempt");
    }
  },
);

// The fixture turn has no sandbox or Connected Machine unless `sandboxAttached`.
function expectedFirstPartyTools(
  config: ResolvedAgentConfig | null,
  settings: Settings,
  sandboxAttached = false,
) {
  const families = resolveAgentToolFamilies(config, { sandboxAttached });
  return allowedFirstPartyMcpToolsForSession(settings, [...FIRST_PARTY_MCP_TOOL_NAMES]).filter(
    (name) => families.allowsFirstPartyTool(name),
  );
}

function assertCapabilitySurface(
  captured: Awaited<ReturnType<typeof captureWorkerRequest>>,
  config: ResolvedAgentConfig,
) {
  expect(captured.buildOptions.agentConfig).toEqual(config);
  expect(captured.preparation.firstPartyTools).toEqual(
    expectedFirstPartyTools(config, captured.settings),
  );
  expect(captured.names).toEqual(captured.visibleNames);
  for (const name of captured.preparation.firstPartyTools!) {
    expect(captured.names).toContain(`opengeni__${name}`);
  }
  for (const name of FIRST_PARTY_MCP_TOOL_NAMES) {
    if (!captured.preparation.firstPartyTools!.includes(name)) {
      expect(captured.names).not.toContain(`opengeni__${name}`);
    }
  }
  const enabled = (id: AgentCapabilityId) =>
    config.capabilities[id] !== false && !config.unavailable.includes(id);
  for (const entry of captured.catalog.entries) {
    if (!["opengeni", "interaction"].includes(entry.identity.serverId)) continue;
    const owner =
      FIRST_PARTY_MCP_TOOL_CAPABILITIES[entry.identity.toolName as FirstPartyMcpToolName];
    if (owner && owner !== "runtime" && owner !== "sandbox") {
      expect(enabled(owner)).toBe(true);
    }
  }
  expect(captured.names.includes("web_search")).toBe(
    enabled("webSearch") && captured.settings.webSearchEnabled,
  );
  expect(captured.names.includes("request_human_input")).toBe(
    enabled("humanInput") && captured.buildOptions.humanInputEnabled !== false,
  );
  expect(captured.names.includes("list_models")).toBe(enabled("subagents"));
  // Privacy answers come from server facts whenever privacyFacts is on.
  expect(captured.names.includes("privacy_facts")).toBe(enabled("privacyFacts"));
  expect(captured.names.includes("image_generation")).toBe(enabled("media"));
  expect(captured.names.includes("skill_read")).toBe(enabled("skills"));
  for (const name of SKILL_MANAGEMENT_TOOLS) {
    expect(captured.names.includes(name)).toBe(
      enabled("skills") && config.capabilities.skills === "manage",
    );
  }
  expect(captured.selectedServerIds.includes("files")).toBe(enabled("workspaceFiles"));
  expect(captured.selectedServerIds.includes("docs")).toBe(enabled("knowledge"));
  expect(captured.names).toContain(prefixedMcpToolName("customer-product", "search_documents"));
  // Waiting follows the families: something must be able to resume the agent.
  expect(captured.names.includes("opengeni__wait_for_input")).toBe(
    resolveAgentToolFamilies(config, { sandboxAttached: false }).waitForInput,
  );
  // No sandbox or Connected Machine is attached, so no command can exist.
  expect(captured.names).not.toContain("opengeni__command_read");
  expect(captured.names).not.toContain("opengeni__command_wait");
}

// Assert the model-facing contract directly. A whole-request digest also pins
// incidental product copy in tool descriptions (for example, the Skill library
// name), hiding which behavioral or authority boundary actually changed.
function assertLegacyRequestContract(request: ModelRequest) {
  expect(request.input).toEqual([
    { role: "developer", content: expect.stringContaining(SKILL_SENTINEL) },
    { role: "user", content: "Reply done without calling tools." },
  ]);
  expect(request.modelSettings).toEqual({
    reasoning: { effort: "low", summary: "detailed" },
    providerData: {
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: SCOPE.sessionId,
    },
  });
  expect(request.toolsExplicitlyProvided).toBe(true);
  expect(request.handoffs).toEqual([]);
  expect(request.outputType).toBe("text");
  expect(request.systemInstructions).toContain("Never invent URLs or request credentials in chat.");
  expect(JSON.stringify(request)).not.toContain("test-delegation-secret");
  const install = request.tools.find((tool) => tool.name === "skill_install");
  expect(install).toMatchObject({
    type: "function",
    strict: false,
  });
  if (install?.type !== "function") throw new Error("Skill installation function missing");
  expect(install.parameters).toEqual({
    type: "object",
    properties: {
      operationId: { type: "string", format: "uuid" },
      source: { type: "string", minLength: 1, maxLength: 2048 },
      expectedInstallationVersion: { type: "integer", minimum: 0 },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["operationId", "source", "reason"],
    additionalProperties: true,
  });
  expect(install.description).toContain("Off prevents agent installation");
  expect(install.description).toContain("requires its current installation version");
}

describe("agent configuration reaches the production model request", () => {
  test.each(["api", "slack", "scheduled", "automation", "site_auth_maintenance"] as const)(
    "%s creator retains null legacy and all request parity",
    async (creator: AgentConfigCreator) => {
      const settings = testSettings();
      const base = {
        creator,
        settings,
        instructions: undefined,
        workspaceSettings: {},
        parent: null,
        goal: false,
      };
      const omittedConfig = resolveSessionAgentConfigForCreate({
        ...base,
        request: undefined,
      }).config;
      const allConfig = resolveSessionAgentConfigForCreate({
        ...base,
        request: { capabilities: "all" },
      }).config;
      // An omitted agent resolves "all"; only site-auth maintenance stays null.
      expect(omittedConfig === null).toBe(creator === "site_auth_maintenance");
      // Sessions created before agent configuration keep a null config.
      const legacy = await captureWorkerRequest({ agent: null });
      const configured = await captureWorkerRequest({ agent: allConfig });
      // "all" keeps the legacy tool surface; its prompt is the modular composition (M4).
      expect(configured.request.tools).toEqual(legacy.request.tools);
      expect(configured.names).toEqual(legacy.names);
      expect({ ...configured.request, systemInstructions: undefined }).toEqual({
        ...legacy.request,
        systemInstructions: undefined,
      });
      assertLegacyRequestContract(legacy.request);
      expect({
        names: legacy.names,
        hosted: legacy.request.tools.filter((tool) => tool.type === "hosted_tool"),
      }).toMatchSnapshot();
    },
  );

  test("omitted and null configuration retain legacy request parity", async () => {
    const omitted = await captureWorkerRequest();
    const explicitNull = await captureWorkerRequest({ agent: null });
    expect(explicitNull.request).toEqual(omitted.request);
    expect(explicitNull.catalog.entries).toEqual(omitted.catalog.entries);
    expect(explicitNull.names).toContain("list_models");
    expect(explicitNull.names).toContain("skill_save");
    assertLegacyRequestContract(explicitNull.request);
    expect({
      names: explicitNull.names,
      hosted: explicitNull.request.tools.filter((tool) => tool.type === "hosted_tool"),
    }).toMatchSnapshot();
  });

  test.each(["legacy", "all"] as const)(
    "workspace governance reaches durable history, never the system prompt (%s config)",
    async (from) => {
      const agent = from === "all" ? agentConfig("all") : null;
      const governed = await captureWorkerRequest({
        agent,
        workspaceGovernance: "Workspace rule: answer in English.",
      });
      const other = await captureWorkerRequest({
        agent,
        workspaceGovernance: "Workspace rule: answer in Norwegian.",
      });
      // A different initiator or an edited policy must not rewrite the
      // system prompt that every earlier request of the session sent.
      expect(governed.request.systemInstructions).toBe(other.request.systemInstructions);
      expect(governed.request.systemInstructions).not.toContain("Workspace rule");
      expect(governed.governanceWrites).toEqual(["Workspace rule: answer in English."]);
    },
  );

  test.each(["legacy", "all"] as const)(
    "an agent chat's instructions are a system-prompt layer; edits are checked each turn (%s config)",
    async (from) => {
      const agent = from === "all" ? agentConfig("all") : null;
      const prompt = { agentId: crypto.randomUUID(), revision: 3 };
      const bound = await captureWorkerRequest({
        agent,
        agentPrompt: { ...prompt, instructions: "Agent rule: answer as a pirate." },
      });
      expect(bound.request.systemInstructions).toContain(
        "# Instructions for this agent\n\nThese take precedence over the default behavior above;",
      );
      expect(bound.request.systemInstructions).toContain("Agent rule: answer as a pirate.");
      expect(bound.agentInstructionChecks).toEqual([
        { ...prompt, instructions: "Agent rule: answer as a pirate." },
      ]);
      // A plain chat neither gets the layer nor checks for edits; a deleted
      // agent checks (to withdraw an earlier edit) and runs as a plain chat.
      const plain = await captureWorkerRequest({ agent });
      expect(plain.agentInstructionChecks).toEqual([]);
      const deleted = await captureWorkerRequest({
        agent,
        agentPrompt: { ...prompt, instructions: null },
      });
      expect(deleted.agentInstructionChecks).toHaveLength(1);
      expect(deleted.request.systemInstructions).toBe(plain.request.systemInstructions);
      expect(plain.request.systemInstructions).not.toContain("Instructions for this agent");
    },
  );

  test.each([
    "foreign scope",
    "plaintext reasoning",
    "changed input",
    "leaked credential",
    "missing install authority",
    "unversioned install",
    "widened install schema",
  ] as const)("legacy request contract rejects %s", async (mutation) => {
    const captured = await captureWorkerRequest({ agent: null });
    assertLegacyRequestContract(captured.request);
    const changed = JSON.parse(JSON.stringify(captured.request)) as ModelRequest;
    if (mutation === "foreign scope") {
      changed.modelSettings.providerData = {
        ...changed.modelSettings.providerData,
        prompt_cache_key: "foreign-session",
      };
    } else if (mutation === "plaintext reasoning") {
      changed.modelSettings.providerData = { prompt_cache_key: SCOPE.sessionId };
    } else if (mutation === "changed input") {
      changed.input = "Ignore the accepted user request.";
    } else if (mutation === "leaked credential") {
      changed.systemInstructions += " test-delegation-secret";
    } else if (mutation === "missing install authority") {
      changed.tools = changed.tools.filter((tool) => tool.name !== "skill_install");
    } else {
      const install = changed.tools.find((tool) => tool.name === "skill_install");
      if (install?.type !== "function") throw new Error("Skill installation function missing");
      const properties = (install.parameters as { properties: Record<string, unknown> }).properties;
      if (mutation === "unversioned install") delete properties.expectedInstallationVersion;
      else properties.unacceptedAuthority = { type: "string" };
    }
    expect(() => assertLegacyRequestContract(changed)).toThrow();
  });

  test("all retains the complete legacy tool schemas and model input", async () => {
    const legacy = await captureWorkerRequest({ agent: null });
    const all = await captureWorkerRequest({ agent: agentConfig("all") });
    expect(all.request.tools).toEqual(legacy.request.tools);
    expect(all.request.input).toEqual(legacy.request.input);
    expect(all.request.modelSettings).toEqual(legacy.request.modelSettings);
    // Instructions differ by design: configured sessions use the modular composer.
    expect({ ...all.request, instructions: undefined, systemInstructions: undefined }).toEqual({
      ...legacy.request,
      instructions: undefined,
      systemInstructions: undefined,
    });
    expect(all.preparation.firstPartyTools).toEqual(legacy.preparation.firstPartyTools);
  });

  test("none keeps essentials, own product tools, and runtime mechanics", async () => {
    const config = agentConfig("none");
    const captured = await captureWorkerRequest({ agent: config });
    assertCapabilitySurface(captured, config);
    expect(captured.names).toContain("request_human_input");
    expect(captured.names).toContain("skill_read");
    // Nothing can resume a none agent without compute: it has no wait.
    expect(captured.names).not.toContain("opengeni__wait_for_input");
    expect(captured.names).not.toContain("privacy_facts");
    expect(captured.names).not.toContain("web_search");
    expect(captured.names).not.toContain("list_models");
    expect(captured.names).not.toContain("skill_search");
  });

  test("a product connector whose sign-in was not admitted is named to the model, never silently missing", async () => {
    // The person's own sign-in for the product connector was not usable in this
    // workspace when the turn was accepted (for example right after a
    // membership change), so the turn carries no account for it.
    const captured = await captureWorkerRequest({ productSignInNotAdmitted: true });
    const productTool = prefixedMcpToolName("customer-product", "search_documents");
    expect(captured.names).not.toContain(productTool);
    expect(captured.deferredNames).not.toContain(productTool);
    // The turn's own notice names the connector and the reason category.
    expect(captured.mcpAvailabilityNote).toContain(
      '- "Customer Product" (customer-product): no signed-in account for it was available to this turn.',
    );
    // Tool search and tool listing report it beside runtime failures.
    expect(captured.preparation.preparationUnavailableMcpServers?.get("customer-product")).toMatch(
      /^not loaded this turn: no signed-in account for it was available to this turn\./u,
    );

    // With every connector available there is no notice at all.
    const ordinary = await captureWorkerRequest();
    expect(ordinary.names).toContain(productTool);
    expect(ordinary.mcpAvailabilityNote).toBeUndefined();
    expect(ordinary.preparation.preparationUnavailableMcpServers).toBeUndefined();
  });

  test("Codemode guidance needs a sandbox or Connected Machine to run it from", async () => {
    const codemode = "Every tool in the Codemode catalog";
    const detached = await captureWorkerRequest({
      agent: agentConfig("none"),
      codemodeToken: true,
    });
    expect(detached.request.systemInstructions).not.toContain(codemode);
    const attached = await captureWorkerRequest({
      agent: agentConfig("none"),
      codemodeToken: true,
      machineAttached: true,
    });
    expect(attached.request.systemInstructions).toContain(codemode);
    // run_on opens a Codemode-enabled shell on another machine.
    const remote = await captureWorkerRequest({
      agent: agentConfig("none", "workspaceAdmin", true),
      codemodeToken: true,
    });
    expect(remote.request.systemInstructions).toContain(codemode);
  });

  test.each([true, false])(
    "none leaves out wait_for_input and keeps questions (a person started the turn: %s)",
    async (human) => {
      const config = agentConfig("none");
      const captured = await captureWorkerRequest({ agent: config, humanRecipient: human });
      expect(captured.preparation.firstPartyTools).toEqual(
        expectedFirstPartyTools(config, captured.settings),
      );
      expect(captured.names).not.toContain("opengeni__wait_for_input");
      expect(captured.names).toContain("request_human_input");
    },
  );

  test("anything that can resume a none agent brings waiting back", async () => {
    // Turning on anything that can resume the agent brings waiting back.
    const scheduled = agentConfig("none", "schedules", true);
    const withSchedules = await captureWorkerRequest({ agent: scheduled, humanRecipient: false });
    expect(withSchedules.names).toContain("opengeni__wait_for_input");
    // A run_on command on another machine settles later and wakes the wait.
    const admin = agentConfig("none", "workspaceAdmin", true);
    const withRunOn = await captureWorkerRequest({ agent: admin, humanRecipient: false });
    expect(withRunOn.names).toContain("opengeni__wait_for_input");
  });

  test.each(["all", "none", "legacy"] as const)(
    "%s receives command tools only with an attached sandbox or Connected Machine",
    async (from) => {
      const config = from === "legacy" ? null : agentConfig(from);
      const detached = await captureWorkerRequest({ agent: config });
      expect(detached.preparation.firstPartyTools).toEqual(
        expectedFirstPartyTools(config, detached.settings),
      );
      // Waiting needs something that can resume the agent: compute does.
      expect(detached.names.includes("opengeni__wait_for_input")).toBe(from !== "none");
      expect(detached.names).not.toContain("opengeni__command_read");
      expect(detached.names).not.toContain("opengeni__command_wait");

      const attached = await captureWorkerRequest({ agent: config, machineAttached: true });
      expect(attached.preparation.firstPartyTools).toEqual(
        expectedFirstPartyTools(config, attached.settings, true),
      );
      expect(attached.names).toContain("opengeni__wait_for_input");
      expect(attached.names).toContain("opengeni__command_read");
      expect(attached.names).toContain("opengeni__command_wait");
    },
  );

  test.each(["all", "none"] as const)(
    "%s effectiveTools matches the captured next model request",
    async (from) => {
      const captured = await captureWorkerRequest({
        agent: agentConfig(from),
        modelId: "gpt-5.6-sol",
      });
      const result = sessionWithEffectiveToolPolicy(
        captured.session,
        ["opengeni", "files", "docs", "customer-product"],
        [],
        {
          settings: captured.settings,
          humanInputEnabled: true,
          hasWorkspaceSkills: true,
          objectStorageAvailable: true,
          mediaAttachments: new Map([[captured.session.id, captured.mediaAttachment]]),
        } as Parameters<typeof sessionWithEffectiveToolPolicy>[3],
      );
      const known = result.effectiveTools!.tools;
      const externalNames = captured.names.filter((name) =>
        ["files", "docs", "customer-product"].some((id) =>
          name.startsWith(`${prefixedMcpToolName(id, "search_documents").split("__")[0]}__`),
        ),
      );
      expect(known.map((tool) => tool.name).sort()).toEqual(
        captured.names.filter((name) => !externalNames.includes(name)),
      );
      expect(known.every((tool) => tool.visibility === "upfront")).toBe(true);
      for (const server of result.effectiveTools!.mcpServers) {
        if (server.id !== "opengeni") expect(server.toolsKnown).toBe(false);
      }
    },
  );

  test.each(
    AGENT_CAPABILITY_IDS.flatMap((capability) =>
      (["all", "none"] as const).map((from) => ({ capability, from })),
    ),
  )(
    "$from toggling $capability changes the actual catalog and request",
    async ({ from, capability }) => {
      const config = agentConfig(
        from,
        capability,
        capability === "skills" ? (from === "all" ? false : "manage") : from === "none",
      );
      assertCapabilitySurface(await captureWorkerRequest({ agent: config }), config);
    },
  );

  test.each(AGENT_CAPABILITY_IDS)(
    "deployment-disabled %s cannot be re-enabled by an all configuration",
    async (capability) => {
      const config = agentConfig("all");
      config.unavailable = [capability];
      const captured = await captureWorkerRequest({
        agent: config,
        deploymentDisabled: capability,
      });
      assertCapabilitySurface(captured, config);
    },
  );

  test.each(["webSearch", "humanInput", "goals"] as const)(
    "the current deployment ceiling narrows an already-frozen all config for %s",
    async (capability) => {
      const config = agentConfig("all");
      expect(config.unavailable).toEqual([]);
      const captured = await captureWorkerRequest({
        agent: config,
        deploymentDisabled: capability,
      });
      assertCapabilitySurface(captured, config);
      if (capability === "goals") {
        expect(captured.names).not.toContain("opengeni__goal_set");
      } else {
        expect(captured.names).not.toContain(
          capability === "webSearch" ? "web_search" : "request_human_input",
        );
      }
    },
  );
});

// goal_resume acts only on an existing goal, so a configured session whose
// frozen goal is none is not sent it; any goal, or an unknown one, keeps it.
describe("goal_resume follows the session's goal", () => {
  const resume = "opengeni__goal_resume";
  test("a configured session without a goal has no goal_resume or its guidance", async () => {
    const captured = await captureWorkerRequest({ agent: agentConfig("all"), goal: "none" });
    expect(captured.names).toContain("opengeni__goal_set");
    expect(captured.names).toContain("opengeni__goal_pause");
    expect(captured.names).not.toContain(resume);
    expect(captured.request.systemInstructions).not.toContain("goal_resume");
  });

  test.each([
    ["a paused goal", { agent: agentConfig("all"), goal: "paused" }],
    ["an unknown goal", { agent: agentConfig("all") }],
    ["a legacy session without a goal", { agent: null, goal: "none" }],
  ] as const)("%s keeps goal_resume", async (_label, options) => {
    const captured = await captureWorkerRequest(options);
    expect(captured.names).toContain(resume);
    expect(captured.request.systemInstructions).toContain("goal_resume");
  });
});

describe("effective-tools projection agrees with actual model preparation", () => {
  const subscriptionModels = [
    {
      subscription: "codex-subscription",
      modelId: `${CODEX_MODEL_ID_PREFIX}${CODEX_FALLBACK_MODEL_SLUGS[0]}`,
    },
    {
      subscription: "xai-subscription",
      modelId: `${XAI_SUBSCRIPTION_MODEL_ID_PREFIX}${XAI_SUBSCRIPTION_MODEL_SLUGS[0]}`,
    },
  ] as const;
  test.each(subscriptionModels)(
    "$subscription projection follows the worker's exact local media credential identity",
    async ({ subscription, modelId }) => {
      for (const [localMediaCredential, foreignMediaCredential] of [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ] as const) {
        const captured = await captureWorkerRequest({
          agent: agentConfig("all"),
          subscription,
          localMediaCredential,
          foreignMediaCredential,
          modelId,
        });
        expect(captured.resolvedModel!.provider.kind).toBe(subscription);
        expect(captured.resolvedModel!.configured.id).toBe(modelId);
        expect(captured.resolvedModel!.configured.capabilities.reasoning.runnable).toBe(true);
        // Codex states the same `detailed` the runtime default sends; SuperGrok keeps the default.
        expect(captured.buildOptions.reasoningSummary).toBe(
          subscription === "codex-subscription" ? "detailed" : undefined,
        );
        const result = sessionWithEffectiveToolPolicy(
          captured.session,
          captured.selectedServerIds,
          [],
          {
            settings: captured.settings,
            humanInputEnabled: true,
            hasWorkspaceSkills: true,
            objectStorageAvailable: true,
            mediaAttachments: new Map([[captured.session.id, captured.mediaAttachment]]),
          },
        ).effectiveTools!;
        expect(captured.names.includes("generate_image")).toBe(localMediaCredential);
        expect(result.tools.some((tool) => tool.name === "generate_image")).toBe(
          localMediaCredential,
        );
        expect(result.mediaToolsKnown).toBe(true);
        const unresolved = sessionWithEffectiveToolPolicy(
          captured.session,
          captured.selectedServerIds,
          [],
          {
            settings: captured.settings,
            humanInputEnabled: true,
            hasWorkspaceSkills: true,
            objectStorageAvailable: true,
          },
        ).effectiveTools!;
        expect(unresolved.mediaToolsKnown).toBe(false);
        expect(unresolved.tools.some((tool) => tool.capability === "media")).toBe(false);
        expect(unresolved.unavailable).not.toContain("media");
      }
    },
  );

  test.each(subscriptionModels)(
    "$subscription fixture refuses unknown or wrong-provider models instead of global fallback",
    async ({ subscription, modelId }) => {
      for (const rejectedModelId of [
        `${modelId.split("/")[0]}/not-an-exposed-model`,
        "gpt-5.6-sol",
      ]) {
        await expect(
          captureWorkerRequest({
            subscription,
            modelId: rejectedModelId,
            localMediaCredential: true,
          }),
        ).rejects.toThrow(
          "subscription fixture requires an exposed model of the selected provider",
        );
      }
    },
  );

  test("search visibility matches the captured first request and deferred catalog", async () => {
    const captured = await captureWorkerRequest({
      agent: agentConfig("all"),
      modelId: "gpt-5.6-sol",
      lazy: true,
    });
    const projection = projectAgentEffectiveTools(
      sessionEffectiveToolProjectionInput(
        captured.session as Parameters<typeof sessionEffectiveToolProjectionInput>[0],
        captured.turnTools,
        {
          settings: captured.settings,
          humanInputEnabled: true,
          hasWorkspaceSkills: true,
          objectStorageAvailable: true,
          mediaAttachments: new Map([[captured.session.id, captured.mediaAttachment]]),
        },
      ),
    );
    for (const entry of projection.tools) {
      if (entry.visibility === "search") {
        expect(captured.deferredNames).toContain(entry.name);
        expect(captured.names).not.toContain(entry.name);
      } else {
        expect(captured.names).toContain(entry.name);
      }
    }
  });

  test.each([
    { label: "all", agent: agentConfig("all") },
    { label: "none", agent: agentConfig("none") },
    { label: "skills disabled", agent: agentConfig("all", "skills", false) },
    { label: "skills read", agent: agentConfig("none", "skills", "read") },
    { label: "skills manage", agent: agentConfig("none", "skills", "manage") },
    { label: "media disabled", agent: agentConfig("all", "media", false) },
    {
      label: "search deployment unavailable",
      agent: { ...agentConfig("all"), unavailable: ["webSearch"] } as ResolvedAgentConfig,
    },
  ])("$label projects the captured known tool surface", async ({ agent }) => {
    const captured = await captureWorkerRequest({ agent, modelId: "gpt-5.6-sol" });
    const input = sessionEffectiveToolProjectionInput(
      captured.session as Parameters<typeof sessionEffectiveToolProjectionInput>[0],
      captured.turnTools,
      {
        settings: captured.settings,
        humanInputEnabled: true,
        hasWorkspaceSkills: true,
        objectStorageAvailable: true,
        mediaAttachments: new Map([[captured.session.id, captured.mediaAttachment]]),
      },
    );
    const projected = projectAgentEffectiveTools(input);
    const actualKnownNames = captured.names.filter(
      (name) =>
        !["files", "docs", "customer-product"].some((id) =>
          name.startsWith(`${prefixedMcpToolName(id, "search_documents").split("__")[0]}__`),
        ),
    );
    expect(projected.tools.map((tool) => tool.name).sort()).toEqual(actualKnownNames);
    expect(projected.tools.every((tool) => tool.visibility === "upfront")).toBe(true);
    expect(projected.mcpServers.map((server) => server.id)).toEqual(captured.selectedServerIds);
    expect(projected.mcpServers.find((server) => server.id === "customer-product")).toEqual({
      id: "customer-product",
      capability: "product",
      toolsKnown: false,
    });
  });

  // With tool search on, the projection follows the worker's router decision:
  // no router or title tool when nothing is deferred, and no wait_for_input
  // when nothing can resume the agent. (The fixture's `opengeni` server is not
  // first party, so harness control tools cannot join its first request here;
  // "search visibility matches" covers "all" with tool search on.)
  test.each([
    { label: "embedding, API turn", agent: agentConfig("none"), eagerProduct: true, human: false },
    { label: "none, lazy, API turn", agent: agentConfig("none"), lazy: true, human: false },
  ])(
    "$label projects the captured lazy tool surface",
    async ({ agent, eagerProduct, lazy, human }) => {
      const captured = await captureWorkerRequest({
        agent,
        builtins: false,
        hasSkills: false,
        humanRecipient: human,
        ...(eagerProduct ? { eagerProduct } : {}),
        ...(lazy ? { lazy } : {}),
      });
      const projected = projectAgentEffectiveTools(
        sessionEffectiveToolProjectionInput(
          captured.session as Parameters<typeof sessionEffectiveToolProjectionInput>[0],
          captured.turnTools,
          {
            settings: captured.settings,
            humanInputEnabled: true,
            hasWorkspaceSkills: false,
            objectStorageAvailable: true,
            mediaAttachments: new Map([[captured.session.id, captured.mediaAttachment]]),
          },
        ),
      );
      const product = `${prefixedMcpToolName("customer-product", "search_documents").split("__")[0]}__`;
      const upfront = projected.tools.filter((tool) => tool.visibility === "upfront");
      expect(upfront.map((tool) => tool.name).sort()).toEqual(
        captured.names.filter((name) => !name.startsWith(product)).sort(),
      );
      for (const entry of projected.tools.filter((tool) => tool.visibility === "search"))
        expect(captured.deferredNames).toContain(entry.name);
    },
  );
});

describe("Skill attachment is distinct from Skill catalog availability", () => {
  // Only the Skill index reads the video policy at turn start; the video tools
  // read it live when called.
  test.each([
    { label: "explicit empty", selection: [], reads: 0 },
    { label: "explicit unrelated", selection: ["builtin:opengeni-help"], reads: 0 },
    {
      label: "legacy unrelated",
      selection: bundledSkillSelectionFromMetadata({
        _opengeni_bundled_skill_ids_v1: ["builtin:opengeni-projects"],
      }),
      reads: 0,
    },
    { label: "defaults", selection: "omit", reads: 1 },
    { label: "explicit video", selection: ["builtin:video-generation"], reads: 1 },
    {
      label: "legacy video",
      selection: bundledSkillSelectionFromMetadata({
        _opengeni_bundled_skill_ids_v1: ["builtin:opengeni-video-generation"],
      }),
      reads: 1,
    },
  ])(
    "$label reads video policy only when the bundled descriptor can use it",
    async ({ selection, reads }) => {
      for (const videoEnabled of [false, true]) {
        const captured = await captureWorkerRequest({
          agent: agentConfig("all"),
          bundledSkillIds: selection as FixtureOptions["bundledSkillIds"],
          videoEnabled,
        });
        expect(captured.metadataReads).toEqual({ skillDescriptors: 1, videoPolicy: reads });
        expect(captured.skillCatalog.some((entry) => entry.id === "builtin:video-generation")).toBe(
          reads === 1 && videoEnabled,
        );
        expect(captured.names.includes("generate_video")).toBe(videoEnabled);
        expect(captured.skillCatalog.some((entry) => entry.name === SKILL_SENTINEL)).toBe(true);
      }
    },
  );

  test.each([false, true])(
    "selected video reads the policy once, for the Skill index (enabled=%s)",
    async (initialEnabled) => {
      const phases: string[] = [];
      const captured = await captureWorkerRequest({
        agent: agentConfig("all"),
        bundledSkillIds: ["builtin:video-generation"],
        videoEnabled: true,
        loadVideoPolicy: async (phase) => {
          phases.push(phase);
          return {
            schemaVersion: 1,
            revision: 1,
            fundingSource: "opengeni_credits",
            enabledModelIds: initialEnabled ? ["bytedance/seedance-2.5"] : [],
            defaultModelId: initialEnabled ? "bytedance/seedance-2.5" : null,
          };
        },
      });
      expect(phases).toEqual(["tool-preparation"]);
      expect(captured.skillCatalog.some((entry) => entry.id === "builtin:video-generation")).toBe(
        initialEnabled,
      );
      expect(captured.names).toContain("generate_video");
    },
  );
  test("a short personal Skill is shown in full in the model-visible Skill index", async () => {
    const captured = await captureWorkerRequest({
      agent: agentConfig("all"),
      loadSkillDescriptors: async () => [
        {
          id: "77777777-7777-4777-8777-777777777777",
          title: "reply-in-norwegian",
          description: "Applies in every conversation with this user.",
          activationMode: "workspace_managed",
          personalSkillMarkdown:
            "---\nname: reply-in-norwegian\ndescription: Applies in every conversation with this user.\n---\n\nAlways reply in Norwegian.\n",
        } as Awaited<ReturnType<typeof db.listSkillDescriptors>>[number],
        {
          id: "88888888-8888-4888-8888-888888888888",
          title: SKILL_SENTINEL,
          description: "Installed test Skill",
          activationMode: "workspace_managed",
          personalSkillMarkdown: null,
        } as Awaited<ReturnType<typeof db.listSkillDescriptors>>[number],
      ],
    });
    expect(captured.modelVisibleSkillCatalogText).toContain(
      '- {"name":"reply-in-norwegian","description":"Applies in every conversation with this user.","instructions":"Always reply in Norwegian."}',
    );
    expect(captured.modelVisibleSkillCatalogText).toContain(
      '- {"name":"' + SKILL_SENTINEL + '","description":"Installed test Skill"}',
    );
    expect(captured.modelVisibleSkillCatalogText).toContain(
      "The following entries are descriptors, except that an instructions field holds that Skill's complete instructions",
    );
    expect(captured.modelVisibleSkillCatalogText).not.toContain(
      "The following entries are descriptors, not the Skill instructions.",
    );
  });
  test("omitted video descriptor reads no video policy at turn start", async () => {
    const failure = new Error("live video policy unavailable");
    const phases: string[] = [];
    const captured = await captureWorkerRequest({
      agent: agentConfig("all"),
      bundledSkillIds: [],
      videoEnabled: true,
      loadVideoPolicy: async (phase) => {
        phases.push(phase);
        throw failure;
      },
    });
    expect(phases).toEqual([]);
    expect(captured.names).toContain("generate_video");
  });

  test.each([false, true])(
    "disabled Skills skip unused metadata/files with inline selections (unavailable=%s)",
    async (unavailable) => {
      const config = agentConfig("all", "skills", unavailable ? "manage" : false);
      if (unavailable) config.unavailable = ["skills"];
      const reads = spyOn(fs, "readFileSync");
      try {
        const captured = await captureWorkerRequest({
          agent: config,
          bundledSkillIds: "omit",
          inlineSkills: [
            {
              name: "inline-disabled-sentinel",
              description: "Must stay outside the model request",
              files: [
                {
                  path: "SKILL.md",
                  content:
                    "---\nname: inline-disabled-sentinel\ndescription: Must stay outside the model request\n---\nNever include this disabled Skill",
                },
              ],
            },
          ],
          loadSkillDescriptors: async () => {
            throw new Error("disabled Skills must not read their descriptors");
          },
          videoEnabled: true,
        });
        // The video tools read the policy when called, never at turn start.
        expect(captured.metadataReads).toEqual({ skillDescriptors: 0, videoPolicy: 0 });
        expect(reads.mock.calls.filter(([path]) => String(path).includes("bundled_"))).toEqual([]);
        expect(captured.skillCatalog).toEqual([]);
        expect(captured.names).not.toContain("skill_read");
        expect(captured.catalog.entries.map((entry) => entry.modelName)).not.toContain(
          "skill_save",
        );
        expect(JSON.stringify(captured.request)).not.toContain("inline-disabled-sentinel");
        expect(JSON.stringify(captured.request)).not.toContain(SKILL_SENTINEL);
        expect(captured.mediaAttachment.video).toBe(true);
        expect(captured.names).toContain("generate_video");
      } finally {
        reads.mockRestore();
      }
    },
  );

  test("a failing live video-policy read fails the video tool call, not the turn's start", async () => {
    const phases: string[] = [];
    const failure = new Error("live video policy unavailable");
    const captured = await captureWorkerRequest({
      agent: agentConfig("all", "skills", false),
      videoEnabled: true,
      loadVideoPolicy: async (phase) => {
        phases.push(phase);
        throw failure;
      },
    });
    expect(phases).toEqual([]);
    expect(captured.names).toContain("generate_video");
    // The tool's own call reads the live policy, and its failure is the call's.
    const live = spyOn(db, "getWorkspaceVideoGenerationPolicy").mockRejectedValue(failure);
    try {
      await expect(captured.buildOptions.videoGeneration!.capabilities()).rejects.toBe(failure);
      expect(live).toHaveBeenCalledTimes(1);
    } finally {
      live.mockRestore();
    }
  });

  test.each(["read", "manage"] as const)(
    "enabled Skills %s retain metadata failures and their video-policy read",
    async (skills) => {
      const failure = new Error("Skill metadata unavailable");
      for (const failingRead of ["descriptors", "initial-video"] as const) {
        const phases: string[] = [];
        await expect(
          captureWorkerRequest({
            agent: agentConfig("all", "skills", skills),
            bundledSkillIds: "omit",
            loadSkillDescriptors: async () => {
              if (failingRead === "descriptors") throw failure;
              return [];
            },
            loadVideoPolicy: async (phase) => {
              phases.push(phase);
              if (failingRead === "initial-video") throw failure;
              return {
                schemaVersion: 1,
                revision: 0,
                fundingSource: "workspace_gateway",
                enabledModelIds: [],
                defaultModelId: null,
              };
            },
          }),
        ).rejects.toBe(failure);
        expect(phases).toEqual(["tool-preparation"]);
      }
    },
  );

  test("with video off, attaching the video tools leaves the first model request byte-identical", async () => {
    const off = async () => ({
      schemaVersion: 1 as const,
      revision: 4,
      fundingSource: "workspace_gateway" as const,
      enabledModelIds: [],
      defaultModelId: null,
    });
    const attached = await captureWorkerRequest({
      agent: agentConfig("all", "skills", "read"),
      videoEnabled: true,
      lazy: true,
      loadVideoPolicy: off,
    });
    const before = await captureWorkerRequest({
      agent: agentConfig("all", "skills", "read"),
      videoEnabled: true,
      lazy: true,
      loadVideoPolicy: off,
      withoutVideoAdapter: true,
    });
    expect(attached.deferredNames).toContain("generate_video");
    expect(attached.deferredNames).toContain("get_video_generation_capabilities");
    expect(before.deferredNames).not.toContain("generate_video");
    expect(JSON.stringify(attached.request)).toBe(JSON.stringify(before.request));
    expect(attached.modelVisibleSkillCatalogText).toBe(before.modelVisibleSkillCatalogText);
  });

  test.each([false, "read", "manage"] as const)(
    "skills %s exposes only its permitted tool family",
    async (skills) => {
      const config = agentConfig("none", "skills", skills);
      const captured = await captureWorkerRequest({ agent: config });
      assertCapabilitySurface(captured, config);
      if (skills === false) {
        expect(captured.skillCatalog).toEqual([]);
        expect(JSON.stringify(captured.request)).not.toContain(SKILL_SENTINEL);
        expect(captured.skillCatalogWrites.join("\n")).not.toContain(SKILL_SENTINEL);
      } else {
        expect(JSON.stringify(captured.request)).toContain(SKILL_SENTINEL);
      }
    },
  );

  test.each([false, "read", "manage"] as const)(
    "skills %s with no installed or bundled catalog does not synthesize a reader",
    async (skills) => {
      const captured = await captureWorkerRequest({
        agent: agentConfig("none", "skills", skills),
        hasSkills: false,
        productMcp: false,
        builtins: false,
        lazy: true,
      });
      expect(captured.skillCatalog).toEqual([]);
      expect(captured.names.includes("skill_read")).toBe(skills === "manage");
      const catalogNames = captured.catalog.entries.map((entry) => entry.modelName);
      for (const name of SKILL_MANAGEMENT_TOOLS) {
        expect(catalogNames.includes(name)).toBe(skills === "manage");
      }
      expect(captured.names.includes("tool_search")).toBe(skills === "manage");
      expect(captured.names.includes("tool_list")).toBe(skills === "manage");
    },
  );

  test("none omits bundled Opengeni guides unless listed; all keeps the defaults", async () => {
    const base = { hasSkills: false, productMcp: false, builtins: false } as const;
    const noneOmitted = await captureWorkerRequest({
      ...base,
      agent: agentConfig("none"),
      bundledSkillIds: "omit",
    });
    expect(noneOmitted.skillCatalog).toEqual([]);
    expect(noneOmitted.names).not.toContain("skill_read");

    const noneExplicit = await captureWorkerRequest({
      ...base,
      agent: agentConfig("none"),
      bundledSkillIds: ["builtin:opengeni-help"],
    });
    expect(noneExplicit.skillCatalog.map((entry) => entry.id)).toEqual(["builtin:opengeni-help"]);
    expect(noneExplicit.names).toContain("skill_read");

    const allOmitted = await captureWorkerRequest({
      ...base,
      agent: agentConfig("all"),
      bundledSkillIds: "omit",
    });
    expect(allOmitted.skillCatalog.map((entry) => entry.id)).toContain("builtin:opengeni-help");
    expect(allOmitted.names).toContain("skill_read");
  });

  test("legacy null still attaches Skill management and the router with no catalog", async () => {
    const captured = await captureWorkerRequest({
      agent: null,
      hasSkills: false,
      productMcp: false,
      builtins: false,
      lazy: true,
    });
    expect(captured.names).toContain("skill_read");
    expect(captured.names).toContain("tool_search");
    expect(captured.names).toContain("tool_list");
    expect(captured.catalog.entries.map((entry) => entry.modelName)).toContain("skill_install");
  });
});

test.each(["native_hosted", "provider_adapter"] as const)(
  "media gating removes %s image and video schemas before model serialization",
  async (kind) => {
    for (const media of [true, false] as const) {
      const model = new ScriptedModel("done");
      const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
      const imageGeneration: NonNullable<BuildAgentOptions["imageGeneration"]> =
        kind === "native_hosted"
          ? { kind }
          : {
              kind,
              execute: async () => {
                throw new Error("must not execute media");
              },
            };
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        agentConfig: agentConfig("none", "media", media),
        skillCatalog: [],
        imageGeneration,
        videoGeneration: {
          capabilities: async () => {
            throw new Error("must not execute media");
          },
          execute: async () => {
            throw new Error("must not execute media");
          },
        },
      });
      const result = await runAgentStream(agent, "Reply done.", settings);
      for await (const _event of result.toStream()) {
        /* consume */
      }
      await result.completed;
      const names = model.requests[0]!.tools.map(toolName);
      expect(names.includes(kind === "native_hosted" ? "image_generation" : "generate_image")).toBe(
        media,
      );
      expect(names.includes("generate_video")).toBe(media);
      expect(names.includes("get_video_generation_capabilities")).toBe(media);
    }
  },
);

test("direct runtime construction removes Skill catalog guidance when Skills are disabled", () => {
  const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
    agentConfig: agentConfig("all", "skills", false),
    skillCatalog: [{ id: "hidden-skill", name: "hidden-skill", description: SKILL_SENTINEL }],
  });
  expect(String(agent.instructions)).not.toContain(SKILL_SENTINEL);
});

test("a configured retained router survives deployment search disabled", async () => {
  const agent = buildOpenGeniAgent(
    testSettings({
      sandboxBackend: "none",
      lazyToolSearchEnabled: false,
      webSearchEnabled: false,
    }),
    [],
    { agentConfig: agentConfig("none"), toolRouterInHistory: true, skillCatalog: [] },
  );
  expect((await agent.getAllTools(new RunContext())).map(toolName)).toContain("tool_list");
});

/**
 * The embedding profile: capabilities "none", no sandbox, one eager product
 * MCP server, no goal, identity or instructions, started through the API or by
 * a person. Everything in its first request except the product's own tools is
 * a fixed per-call cost.
 */
async function embeddingFixedPrefix(human = false, extra: FixtureOptions = {}) {
  const captured = await captureWorkerRequest({
    agent: agentConfig("none"),
    builtins: false,
    eagerProduct: true,
    hasSkills: false,
    humanRecipient: human,
    ...extra,
  });
  const productTool = prefixedMcpToolName("customer-product", "search_documents");
  const system = captured.request.systemInstructions ?? "";
  const sections: Record<string, number> = {};
  let heading = "identity";
  for (const block of system.split(/\n(?=#{1,3} )/)) {
    const first = block.split("\n", 1)[0]!;
    if (/^#{1,3} /.test(first)) heading = first;
    sections[heading] = (sections[heading] ?? 0) + Buffer.byteLength(block);
  }
  const tools: Record<string, number> = {};
  for (const tool of captured.request.tools) {
    const name = toolName(tool);
    if (name === productTool) continue;
    tools[name] = Buffer.byteLength(JSON.stringify(tool));
  }
  const developer = captured.request.input.filter(
    (item) => (item as { role?: string }).role === "developer",
  );
  return { captured, system, sections, tools, developer };
}

describe("embedding profile fixed prefix", () => {
  // Raise only with a reviewed reason: every byte here is paid on every call.
  const BUDGET_BYTES = 12_000;

  test("stays within its budget", async () => {
    const prefix = await embeddingFixedPrefix();
    const toolBytes = Object.values(prefix.tools).reduce((sum, size) => sum + size, 0);
    expect(prefix.developer).toEqual([]);
    expect(Buffer.byteLength(prefix.system) + toolBytes).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  // Who started the turn never changes the prefix, so mixed API and person
  // turns share one prompt cache.
  test("is the same whether the API or a person started the turn", async () => {
    const api = await embeddingFixedPrefix(false);
    const person = await embeddingFixedPrefix(true);
    expect(person.system).toBe(api.system);
    expect(person.tools).toEqual(api.tools);
  });

  // A reviewed inventory: a change to any section or built-in tool shows up
  // here by name, so growth in the minimal profile is always a decision.
  test("inventory of sections and built-in tools", async () => {
    const prefix = await embeddingFixedPrefix();
    expect({ sections: prefix.sections, tools: prefix.tools }).toEqual(INVENTORY);
  });

  // A backend that no person answers creates the session with
  // `unattended: true`: it pays for no question tool and is told so instead.
  test("an unattended session has no question tool and stays within its budget", async () => {
    const prefix = await embeddingFixedPrefix(false, { unattended: true });
    const toolBytes = Object.values(prefix.tools).reduce((sum, size) => sum + size, 0);
    expect(prefix.developer).toEqual([]);
    expect(Object.keys(prefix.tools)).toEqual([]);
    expect(prefix.system).toContain(runtimeExports.UNATTENDED_SESSION_GUIDANCE);
    expect(prefix.system).not.toContain("request_human_input");
    expect(Buffer.byteLength(prefix.system) + toolBytes).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(prefix.sections["# Unattended session"]).toBe(559);
  });
});

// request_human_input is sent only where someone can answer it: a person in
// an interactive chat or an API-started one (the API can answer), and the
// parent agent of a child session. A session created unattended, one whose
// `humanInput` capability is off, and a workspace that turned questions off
// get none (the workspace switch is applied with the governance read, see
// runtime.test.ts).
describe("request_human_input follows who can answer", () => {
  const hasQuestionTool = async (options: FixtureOptions) => {
    const captured = await captureWorkerRequest(options);
    const tool = captured.request.tools.find(
      (candidate) => toolName(candidate) === "request_human_input",
    );
    return { captured, tool: tool as { description?: string } | undefined };
  };
  const embedding: FixtureOptions = {
    agent: agentConfig("none"),
    builtins: false,
    eagerProduct: true,
    hasSkills: false,
  };

  const kept: Array<[string, FixtureOptions]> = [
    ["embedding profile, a person started the turn", { ...embedding, humanRecipient: true }],
    ["embedding profile, the API started the turn", { ...embedding, humanRecipient: false }],
    ["all", { agent: agentConfig("all") }],
    ["legacy", { agent: null }],
  ];
  test.each(kept)("%s keeps it", async (_label, options) => {
    const { tool } = await hasQuestionTool(options);
    expect(tool).toBeDefined();
    expect(tool!.description).not.toContain("parent agent");
  });

  const children: Array<[string, FixtureOptions]> = [
    ["embedding profile", { ...embedding, nestedAgentDepth: 1 }],
    ["all", { agent: agentConfig("all"), nestedAgentDepth: 2 }],
  ];
  test.each(children)(
    "a child session (%s) keeps it, with the parent-agent guidance",
    async (_label, options) => {
      const { tool } = await hasQuestionTool(options);
      expect(tool!.description).toContain("message your parent agent instead");
    },
  );

  const leftOut: Array<[string, FixtureOptions]> = [
    ["embedding profile, unattended", { ...embedding, unattended: true }],
    ["all, unattended", { agent: agentConfig("all"), unattended: true }],
    ["legacy, unattended", { agent: null, unattended: true }],
    [
      "embedding profile, humanInput off",
      { ...embedding, agent: agentConfig("none", "humanInput", false) },
    ],
    ["all, humanInput off", { agent: agentConfig("all", "humanInput", false) }],
  ];
  test.each(leftOut)("%s leaves it out", async (_label, options) => {
    const { captured, tool } = await hasQuestionTool(options);
    expect(tool).toBeUndefined();
    expect(captured.request.systemInstructions ?? "").not.toContain("request_human_input");
  });
});

// A result too large to show names only the readers the session has.
describe("oversized tool results", () => {
  const readersFor = async (options: FixtureOptions) => {
    const seen: unknown[] = [];
    const captured = await captureWorkerRequest({
      ...options,
      onSpill: (input) => seen.push(input.readers),
    });
    await captured.preparation.spillOversizedModelToolResult!({
      operationId: "66666666-6666-4666-8666-666666666666",
      result: { content: [{ type: "text", text: "x" }] },
      serializedBytes: 1,
    });
    return seen;
  };

  test("the embedding profile has no shell and no download tool", async () => {
    expect(
      await readersFor({
        agent: agentConfig("none"),
        builtins: false,
        eagerProduct: true,
        hasSkills: false,
      }),
    ).toEqual([{ shell: false, fileDownload: false }]);
  });

  test("attached compute brings the shell", async () => {
    expect(await readersFor({ agent: agentConfig("none"), machineAttached: true })).toEqual([
      { shell: true, fileDownload: false },
    ]);
  });

  test("full capabilities with compute bring the shell and the download tool", async () => {
    const filesAllowedTools = ["search_documents", "files_get_download_url"];
    expect(
      await readersFor({ agent: agentConfig("all"), machineAttached: true, filesAllowedTools }),
    ).toEqual([{ shell: true, fileDownload: true }]);
    // The same session under capabilities "none" has no Files server selected.
    expect(
      await readersFor({ agent: agentConfig("none"), machineAttached: true, filesAllowedTools }),
    ).toEqual([{ shell: true, fileDownload: false }]);
  });
});

const INVENTORY = {
  sections: {
    identity: 476,
    "# Personality": 349,
    "## Writing style": 552,
    "# Working with the user": 128,
    "## Match effort to the request": 733,
    "## Progress updates": 747,
    "## Final answer": 434,
    "### Formatting rules": 127,
    "# Rules for getting work done": 626,
    "## Autonomy and persistence": 3047,
    "# Destructive Actions": 547,
    "# Runtime mechanics": 20,
    "## New messages while you work": 589,
    "## Compaction": 698,
  },
  tools: { request_human_input: 2048 },
};

// Every tool the prompt names must be one the model can reach in that request:
// in the tool list, or behind the search router when the router is there.
describe("the prompt names only attached tools", () => {
  // "remember" is also an English word in prose. The media module names the
  // provider-dependent media tools on purpose: the capability permits
  // discovering them, and it says an adapter may not be attached.
  const NAMED_BY_DESIGN: ReadonlySet<string> = new Set([
    "remember",
    "generate_image",
    "generate_video",
    "get_video_generation_capabilities",
    "image_generation",
  ]);
  const KNOWN_TOOLS = [
    ...new Set([
      ...FIRST_PARTY_MCP_TOOL_NAMES,
      ...FIRST_PARTY_IN_PROCESS_TOOL_NAMES,
      ...Object.keys(AGENT_FUNCTION_TOOL_CAPABILITIES),
      "tool_search",
      "tool_invoke",
      "tool_list",
      "web_search",
    ]),
  ].filter((tool) => !NAMED_BY_DESIGN.has(tool));
  const named = (text: string, tool: string) =>
    new RegExp(`(?:^|[^a-z0-9_]|__)${tool}(?![a-z0-9_])`, "u").test(text);
  const bare = (name: string) => name.replace(/^(?:opengeni|interaction)__/u, "");
  const cases: Array<[string, FixtureOptions]> = [
    ["none, API turn", { agent: agentConfig("none"), humanRecipient: false, builtins: false }],
    ["none, user turn", { agent: agentConfig("none"), builtins: false }],
    [
      "embedding profile",
      {
        agent: agentConfig("none"),
        builtins: false,
        eagerProduct: true,
        hasSkills: false,
        humanRecipient: false,
      },
    ],
    [
      "embedding profile, unattended",
      {
        agent: agentConfig("none"),
        builtins: false,
        eagerProduct: true,
        hasSkills: false,
        humanRecipient: false,
        unattended: true,
      },
    ],
    ["all", { agent: agentConfig("all") }],
    ["all, tool search on", { agent: agentConfig("all"), lazy: true }],
    ...AGENT_CAPABILITY_IDS.map(
      (id) =>
        [
          `none + ${id}`,
          {
            agent: agentConfig("none", id, id === "skills" ? "manage" : true),
            humanRecipient: false,
          },
        ] as [string, FixtureOptions],
    ),
  ];
  for (const [name, options] of cases) {
    test(name, async () => {
      const captured = await captureWorkerRequest(options);
      const system = captured.request.systemInstructions ?? "";
      const reachable = new Set([...captured.names, ...captured.deferredNames].map(bare));
      const router = reachable.has("tool_search");
      const missing = KNOWN_TOOLS.filter(
        (tool) =>
          named(system, tool) &&
          !reachable.has(tool) &&
          !(router && captured.catalog.entries.some((entry) => entry.identity.toolName === tool)),
      );
      expect(missing).toEqual([]);
    });
  }
});
