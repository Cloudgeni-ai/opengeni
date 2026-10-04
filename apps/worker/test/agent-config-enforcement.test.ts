import { describe, expect, spyOn, test } from "bun:test";
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
  AGENT_CAPABILITY_IDS,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_NAMES,
  FIRST_PARTY_IN_PROCESS_TOOL_NAMES,
  allAgentCapabilities,
  noneAgentCapabilities,
  projectAgentEffectiveTools,
  type AgentCapabilityId,
  type AgentConfigCreator,
  type AgentSkillsCapability,
  type BundledSkillId,
  type FirstPartyMcpToolName,
  type ResolvedAgentConfig,
  type AgentMediaAttachment,
  metadataWithTurnExecutionPolicyV1,
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
import { ScriptedModel, startTestMcpServer, testSettings } from "@opengeni/testing";
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
  hasSkills?: boolean;
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
  /** The stored bundled selection; `"omit"` leaves it undefined. Default `[]`. */
  bundledSkillIds?: BundledSkillId[] | "omit";
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
    sandboxBackend: "none",
    ...(options.modelId ? { openaiModel: options.modelId } : {}),
    webSearchEnabled: disabled !== "webSearch",
    lazyToolSearchEnabled: options.lazy === true,
    allowedFirstPartyMcpTools: FIRST_PARTY_MCP_TOOL_NAMES.filter(
      (name) => FIRST_PARTY_MCP_TOOL_CAPABILITIES[name] !== disabled,
    ),
    mcpServers: configuredServerIds.map((id) => ({
      id,
      url: mcp.url,
      cacheToolsList: false,
      allowedTools: id === "opengeni" ? [...FIRST_PARTY_MCP_TOOL_NAMES] : ["search_documents"],
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
  const persistence = [
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "listSkillDescriptors").mockResolvedValue(
      options.hasSkills === false
        ? []
        : [
            {
              id: "66666666-6666-4666-8666-666666666666",
              title: SKILL_SENTINEL,
              description: "Installed test Skill",
              activationMode: "workspace_managed",
            } as Awaited<ReturnType<typeof db.listSkillDescriptors>>[number],
          ],
    ),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => {
      skillCatalogWrites.push(input.catalog);
      return input.catalog;
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
      return buildOpenGeniAgent(runSettings, resources, { ...agentOptions, model });
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
          : {},
    ...(Object.hasOwn(options, "agent") ? { agent: options.agent } : {}),
    instructions: null,
    resources: [],
    tools: configuredServerIds.map((id) => ({
      kind: "mcp" as const,
      id,
      ...(options.lazy ? { eager: true } : {}),
    })),
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    variableSetIds: [],
    ...(options.bundledSkillIds === "omit"
      ? {}
      : { bundledSkillIds: options.bundledSkillIds ?? [] }),
    skills: [],
    firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
    firstPartyMcpPermissions: null,
    model: options.modelId ?? "scripted-model",
    sandboxBackend: "none",
    mcpServers: [{ id: "customer-product" }],
    nestedAgentDepth: 0,
    effectiveMaxNestedAgentDepth: 3,
  } as BuildTurnAgentDeps["session"];
  const turn = {
    id: SCOPE.turnId,
    executionGeneration: 1,
    reasoningEffort: "low",
    sandboxBackend: "none",
    initiator: { kind: "user", subjectId: "fixture-human" },
    resources: [],
    tools: session.tools,
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
    const built = await buildTurnAgent({
      ...context,
      ...toolRuntime,
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
              xaiRequestContext:
                options.subscription === "xai-subscription" || options.foreignMediaCredential
                  ? {}
                  : null,
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
      lazyToolTransport: options.lazy ? "generic_dispatch" : undefined,
    } as BuildTurnAgentDeps);
    const visibleTools = await built.agent.getAllTools(new RunContext());
    const result = await runAgentStream(
      built.agent,
      {
        input: [
          { role: "developer", content: built.modelVisibleSkillCatalogText },
          { role: "user", content: "Reply done without calling tools." },
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
      skillCatalogWrites,
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
  return allowedFirstPartyMcpToolsForSession(settings, [...FIRST_PARTY_MCP_TOOL_NAMES]).filter(
    (name) => {
      const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[name];
      if (owner === "sandbox") return sandboxAttached;
      return (
        !config ||
        owner === "runtime" ||
        (config.capabilities[owner] !== false && !config.unavailable.includes(owner))
      );
    },
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
  expect(captured.names).toContain("opengeni__wait_for_input");
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
    expect(captured.names).not.toContain("web_search");
    expect(captured.names).not.toContain("list_models");
    expect(captured.names).not.toContain("skill_search");
  });

  test.each(["all", "none", "legacy"] as const)(
    "%s receives command tools only with an attached sandbox or Connected Machine",
    async (from) => {
      const config = from === "legacy" ? null : agentConfig(from);
      const detached = await captureWorkerRequest({ agent: config });
      expect(detached.preparation.firstPartyTools).toEqual(
        expectedFirstPartyTools(config, detached.settings),
      );
      expect(detached.names).toContain("opengeni__wait_for_input");
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
        expect(captured.buildOptions.reasoningSummary).toBeUndefined();
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
});

describe("Skill attachment is distinct from Skill catalog availability", () => {
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
