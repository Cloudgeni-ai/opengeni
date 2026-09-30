import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { sessionWithEffectiveToolPolicy, resolveSessionAgentConfigForCreate } from "@opengeni/core";
import { RunContext, type ModelRequest, type Tool } from "@openai/agents";
import { allowedFirstPartyMcpToolsForSession, type Settings } from "@opengeni/config";
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
  type FirstPartyMcpToolName,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { sessionEffectiveToolProjectionInput } from "@opengeni/core";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
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
};

// Execute all three production worker phases and the production runtime builder.
// The fixture replaces only unrelated persistence, the first-party API's
// token-scoped tools/list response, and transport providers. It never applies
// agent capability filtering itself.
async function captureWorkerRequest(options: FixtureOptions = {}) {
  const mcp = startTestMcpServer({
    toolsForAuthorization: () => [...FIRST_PARTY_MCP_TOOL_NAMES],
  });
  const configuredServerIds = [
    "opengeni",
    ...(options.builtins === false ? [] : ["files", "docs"]),
    ...(options.productMcp === false ? [] : ["customer-product"]),
  ];
  const disabled = options.deploymentDisabled;
  const settings = testSettings({
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
  let preparation: PrepareToolsOptions | undefined;
  let buildOptions: BuildAgentOptions | undefined;
  const runtime = {
    prepareTools: async (runSettings: Settings, tools, prepareOptions) => {
      preparation = prepareOptions;
      // Model the real first-party API's accepted token selection. The shared
      // MCP fixture advertises arbitrary extra names but does not decode tokens.
      const scopedSettings: Settings = {
        ...runSettings,
        mcpServers: runSettings.mcpServers.map((server) =>
          server.id === "opengeni"
            ? {
                ...server,
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
    model: settings.openaiModel,
    sandboxBackend: "none",
    activeSandboxId: null,
    mcpServers: [],
    rootSessionId: SCOPE.sessionId,
    title: "Configured test session",
    titleSource: "human",
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
    bundledSkillIds: [],
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
  const turnExecutionPolicy = {
    providerId: "openai",
    productModelId: "scripted-model",
    upstreamModelId: "scripted-model",
    latencyMode: "standard",
  } as BuildTurnAgentDeps["turnExecutionPolicy"];
  try {
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
      nativeImageProviderBinding: {
        providerId: "openai",
        providerBindingHash: "fixture-native-image-binding",
      },
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
    return {
      request,
      names: request.tools.map(toolName).sort(),
      visibleNames: visibleTools.map(toolName).sort(),
      catalog: prepared.attemptToolCatalog!,
      preparation: preparation!,
      buildOptions: buildOptions!,
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

function expectedFirstPartyTools(config: ResolvedAgentConfig | null, settings: Settings) {
  return allowedFirstPartyMcpToolsForSession(settings, [...FIRST_PARTY_MCP_TOOL_NAMES]).filter(
    (name) => {
      const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[name];
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
    if (owner && owner !== "runtime") {
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
  expect(captured.names).toContain("opengeni__command_read");
}

describe("agent configuration reaches the production model request", () => {
  test.each(["api", "slack", "scheduled", "automation", "site_auth_maintenance"] as const)(
    "%s creator retains null legacy and all request parity",
    async (creator: AgentConfigCreator) => {
      const settings = testSettings({ agentConfigAdmissionEnabled: true });
      const base = {
        creator,
        settings,
        instructions: undefined,
        workspaceSettings: {},
        parent: null,
        goal: false,
      };
      const legacyConfig = resolveSessionAgentConfigForCreate({
        ...base,
        request: undefined,
      }).config;
      const allConfig = resolveSessionAgentConfigForCreate({
        ...base,
        request: { capabilities: "all" },
      }).config;
      expect(legacyConfig).toBeNull();
      const legacy = await captureWorkerRequest({ agent: legacyConfig });
      const configured = await captureWorkerRequest({ agent: allConfig });
      // "all" keeps the legacy tool surface; its prompt is the modular composition (M4).
      expect(configured.request.tools).toEqual(legacy.request.tools);
      expect(configured.names).toEqual(legacy.names);
      expect({
        names: legacy.names,
        hosted: legacy.request.tools.filter((tool) => tool.type === "hosted_tool"),
        requestSha256: createHash("sha256").update(JSON.stringify(legacy.request)).digest("hex"),
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
    expect({
      names: explicitNull.names,
      hosted: explicitNull.request.tools.filter((tool) => tool.type === "hosted_tool"),
      requestSha256: createHash("sha256")
        .update(JSON.stringify(explicitNull.request))
        .digest("hex"),
    }).toMatchSnapshot();
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
