import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";
import {
  AGENT_CAPABILITY_PROMPT_MODULES,
  AGENT_PROMPT_MODULE_IDS,
  allAgentCapabilities,
  noneAgentCapabilities,
  type AgentCapabilityId,
  type AgentRenderer,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  AGENT_PROMPT_MODULES,
  CODE_SEARCH_DIRECTIVE,
  CODEMODE_PROGRAMMATIC_DIRECTIVE,
  DEFAULT_AGENT_IDENTITY,
  INSTRUCTION_PRECEDENCE,
  SESSION_INSTRUCTIONS_PREAMBLE,
  agentPromptResourcesFor,
  buildOpenGeniAgent,
  composeModularAgentInstructions,
  inspectPersistentAgentInstructions,
  joinPersistentAgentInstructionLayers,
  resolveAgentIdentity,
  type AgentPromptResources,
} from "../../src/index";
import { ALL_RESOURCES } from "./prompt-sentences";

const NO_RESOURCES: AgentPromptResources = {
  managedSandbox: false,
  connectedMachine: false,
  repositories: false,
  gitCredentials: false,
  attachments: false,
};

function config(
  capabilities: ResolvedAgentCapabilities,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities,
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
    ...overrides,
  };
}

function compose(
  capabilities: ResolvedAgentCapabilities,
  resources: AgentPromptResources,
  renderer: AgentRenderer = "opengeni",
) {
  return composeModularAgentInstructions({
    capabilities,
    renderer,
    identity: DEFAULT_AGENT_IDENTITY,
    resources,
  });
}

function moduleIds(result: ReturnType<typeof compose>): string[] {
  return (result.layers.find((layer) => layer.id === "operational_contract")?.modules ?? []).map(
    (module) => module.id,
  );
}

/** Text that belongs to exactly one capability or resource (AC12). */
const MARKERS: Record<string, RegExp> = {
  goals:
    /goal_(?:set|complete|update|pause|resume)|goal pause|active goal|goal is active|goal tools|goal\.completed|completing a goal/u,
  knowledge: /knowledge_|instruction_policy|task_note|Knowledge|durable storage/u,
  subagents: /session_(?:events|wait|get|send_message)|child worker|Session coordination|a child,/u,
  artifacts:
    /opengeni-documents|opengeni-visualize|opengeni-sites|document Artifact|\bSites?\b|artifact:<|Visuals in chat/u,
  repositories: /repos\/<host>|pull request|git reset|dirty worktree|gh, glab/u,
  attachments: /\.opengeni\/files|Attached files/u,
  machines: /Connected Machine|\/home\/u\/proj|C:\/repo/u,
  admin:
    /variable_set_list|capability_catalog_search|custom_mcp_setup_request|rig_propose_change|rig_get|Variable Set/u,
  skills: /# Using skills|Skill index/u,
  media: /# Images and video|generate_image|generate_video|image_generation/u,
  sandbox: /apply_patch|exec_command|rg --files|mktemp|sandbox:\/workspace/u,
};

describe("modular composer: module selection (AC12)", () => {
  test("none + no resources keeps only identity, base behavior, and runtime mechanics", () => {
    const capabilities = { ...noneAgentCapabilities(), skills: false as const };
    const result = compose(capabilities, NO_RESOURCES);
    expect(moduleIds(result)).toEqual(["base_behavior", "runtime_mechanics"]);
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect({ name, match: result.composed.match(marker)?.[0] ?? null }).toEqual({
        name,
        match: null,
      });
    }
    expect(result.composed).toContain(INSTRUCTION_PRECEDENCE);
    expect(result.composed).toContain("# Runtime mechanics");
    expect(result.composed).toContain("`wait_for_input`");
  });

  test("all + every resource includes every module", () => {
    const result = compose(allAgentCapabilities(), ALL_RESOURCES);
    expect(moduleIds(result)).toEqual(
      AGENT_PROMPT_MODULE_IDS.filter((id) => id !== "renderer_markdown"),
    );
    for (const marker of Object.values(MARKERS)) expect(result.composed).toMatch(marker);
  });

  test("goal completion retains upstream final-answer guidance only when goals are enabled", () => {
    const enabled = compose(allAgentCapabilities(), NO_RESOURCES).composed;
    const disabled = compose({ ...allAgentCapabilities(), goals: false }, NO_RESOURCES).composed;
    for (const sentence of [
      "Goal completion records short ledger proof, not the user-facing deliverable.",
      "After goal_complete succeeds, finish the same turn with the requested answer, or a concise summary and retained artifact link.",
      "Never use evidence as the final reply.",
      "A later child result after completion is context to integrate, not a reason to stay silent or restart the completed goal.",
    ]) {
      expect(enabled).toContain(sentence);
      expect(disabled).not.toContain(sentence);
    }
  });

  const capabilityCases: Array<[AgentCapabilityId, keyof typeof MARKERS]> = [
    ["goals", "goals"],
    ["knowledge", "knowledge"],
    ["subagents", "subagents"],
    ["artifacts", "artifacts"],
    ["media", "media"],
    ["workspaceAdmin", "admin"],
  ];
  for (const [capability, marker] of capabilityCases) {
    test(`${capability} toggles only its own text`, () => {
      const off = { ...allAgentCapabilities(), [capability]: false };
      const on = { ...noneAgentCapabilities(), skills: false as const, [capability]: true };
      expect(compose(off, ALL_RESOURCES).composed).not.toMatch(MARKERS[marker]!);
      const enabled = compose(on, NO_RESOURCES);
      expect(enabled.composed).toMatch(MARKERS[marker]!);
      expect(moduleIds(enabled)).toEqual([
        "base_behavior",
        "runtime_mechanics",
        ...(AGENT_CAPABILITY_PROMPT_MODULES[capability] ?? []),
      ]);
    });
  }

  test("skills: read and manage include the skills module; false removes it", () => {
    for (const skills of ["read", "manage"] as const) {
      expect(moduleIds(compose({ ...allAgentCapabilities(), skills }, NO_RESOURCES))).toContain(
        "skills",
      );
    }
    const off = compose({ ...allAgentCapabilities(), skills: false }, NO_RESOURCES);
    expect(off.composed).not.toMatch(MARKERS.skills!);
  });

  const resourceCases: Array<[keyof AgentPromptResources, keyof typeof MARKERS]> = [
    ["repositories", "repositories"],
    ["attachments", "attachments"],
    ["connectedMachine", "machines"],
    ["managedSandbox", "sandbox"],
  ];
  for (const [resource, marker] of resourceCases) {
    test(`${resource} guidance appears only when the resource is present`, () => {
      const capabilities = allAgentCapabilities();
      const without = { ...ALL_RESOURCES, [resource]: false };
      if (resource === "managedSandbox") without.connectedMachine = false;
      if (resource === "repositories") {
        without.gitCredentials = false;
        without.connectedMachine = false;
      }
      if (resource === "connectedMachine") without.managedSandbox = true;
      expect(compose(capabilities, without).composed).not.toMatch(MARKERS[marker]!);
      expect(
        compose(capabilities, { ...NO_RESOURCES, managedSandbox: true, [resource]: true }).composed,
      ).toMatch(MARKERS[marker]!);
    });
  }

  test("sandbox guidance appears for a Connected Machine alone", () => {
    const result = compose(allAgentCapabilities(), { ...NO_RESOURCES, connectedMachine: true });
    expect(moduleIds(result)).toEqual(expect.arrayContaining(["sandbox", "connected_machine"]));
    expect(result.composed).not.toContain("In managed sandboxes, never link directly to `/tmp`");
    expect(result.composed).not.toContain("Provider CLIs such as gh, glab, and az");
    expect(result.composed).not.toContain("Repository resources are mounted");
  });

  test("the workspace environment and rig blocks follow their resources", () => {
    const withBoth = compose(allAgentCapabilities(), ALL_RESOURCES).composed;
    expect(withBoth).toContain('A workspace environment named "prod" is attached');
    expect(withBoth).toContain("rig_propose_change");
    const noAdmin = compose(
      { ...allAgentCapabilities(), workspaceAdmin: false },
      ALL_RESOURCES,
    ).composed;
    expect(noAdmin).toContain('This session uses sandbox environment "python"');
    expect(noAdmin).not.toMatch(/rig_propose_change|rig_get/u);
    const none = compose(allAgentCapabilities(), NO_RESOURCES).composed;
    expect(none).not.toContain("workspace environment named");
    expect(none).not.toContain("sandbox environment");
  });

  test("every module id has exactly one module definition in composition order", () => {
    expect([
      "base_behavior",
      "runtime_mechanics",
      ...AGENT_PROMPT_MODULES.map((m) => m.id),
    ]).toEqual([...AGENT_PROMPT_MODULE_IDS]);
  });
});

describe("modular composer: renderer (AC15)", () => {
  test("markdown removes sandbox:/artifact: link rules and visual rules", () => {
    const markdown = compose(allAgentCapabilities(), ALL_RESOURCES, "markdown");
    expect(moduleIds(markdown)[2]).toBe("renderer_markdown");
    for (const rule of [
      "](sandbox:",
      "](artifact:",
      "Clickable file links",
      "## File links",
      "Visuals in chat",
      "Use inline HTML when",
      "Display images with",
      "Source-code navigation may still use workspace file links.",
    ]) {
      expect(markdown.composed).not.toContain(rule);
    }
    expect(markdown.composed).toContain("# Links and rendering");
    // Delivery rules that do not depend on the renderer stay.
    expect(markdown.composed).toContain("Create a document Artifact only when");
    expect(markdown.composed).toContain(
      "Sites and native documents keep their tool-returned canonical links.",
    );

    const opengeni = compose(allAgentCapabilities(), ALL_RESOURCES, "opengeni");
    expect(opengeni.composed).toContain("](sandbox:");
    expect(opengeni.composed).not.toContain("# Links and rendering");
  });
});

describe("modular composer: identity and precedence (AC12, AC14)", () => {
  test("identity tiers replace each other in order", () => {
    const deploymentTemplate = "You are Deploy Bot. {{core}}";
    expect(
      resolveAgentIdentity({
        sessionIdentity: "Session identity.",
        workspaceIdentity: "Workspace identity.",
        deploymentTemplate,
      }),
    ).toBe("Session identity.");
    expect(resolveAgentIdentity({ workspaceIdentity: "Acme. {{core}}", deploymentTemplate })).toBe(
      "Acme.",
    );
    expect(resolveAgentIdentity({ deploymentTemplate })).toBe("You are Deploy Bot.");
    expect(resolveAgentIdentity({ deploymentTemplate: DEFAULT_AGENT_INSTRUCTIONS })).toBe(
      DEFAULT_AGENT_IDENTITY,
    );
    expect(resolveAgentIdentity({})).toBe(DEFAULT_AGENT_IDENTITY);
  });

  test("an identity replaces only the identity slot", () => {
    const settings = testSettings();
    const base = config(allAgentCapabilities());
    const standard = inspectPersistentAgentInstructions(settings, { agentConfig: base });
    const custom = inspectPersistentAgentInstructions(settings, {
      agentConfig: { ...base, identity: "You are Acme Assistant." },
    });
    expect(custom.layers[0]).toMatchObject({ id: "identity", content: "You are Acme Assistant." });
    expect(custom.composed).not.toContain("OpenGeni workspace agent");
    expect(custom.layers.slice(1)).toEqual(standard.layers.slice(1));
  });

  test("workspace identity survives an active instruction policy (D9)", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {
      agentConfig: config(allAgentCapabilities()),
      workspaceAgentIdentity: "You are Acme Assistant. {{core}}",
      workspaceGovernance: "Active workspace governance follows.\n\nWorkspace charter: be kind.",
    });
    expect(inspection.layers.map((layer) => layer.id)).toEqual([
      "identity",
      "operational_contract",
      "workspace_governance",
    ]);
    expect(inspection.layers[0]?.content).toBe("You are Acme Assistant.");
    expect(inspection.composed).toContain("Workspace charter: be kind.");
  });

  test("layer order: identity, contract, directives, governance, memory, session last", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {
      agentConfig: config(allAgentCapabilities()),
      codemodeAvailable: true,
      codeSearchAvailable: true,
      gitCredentialBindings: [
        { credentialBindingId: "a", provider: "github", token: "x" },
        { credentialBindingId: "b", provider: "github", token: "y" },
      ],
      workspaceGovernance: "GOVERNANCE",
      workspaceMemory: "MEMORY",
      sessionInstructions: "Always answer in exactly one sentence.",
    });
    expect(inspection.layers.map((layer) => layer.id)).toEqual([
      "identity",
      "operational_contract",
      "codemode",
      "code_search",
      "git_bindings",
      "workspace_governance",
      "workspace_memory",
      "session_instructions",
    ]);
    expect(inspection.composed).toBe(joinPersistentAgentInstructionLayers(inspection.layers));
    expect(inspection.composed).toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
    expect(inspection.composed).toContain(CODE_SEARCH_DIRECTIVE);
    expect(
      inspection.composed.endsWith(
        `${SESSION_INSTRUCTIONS_PREAMBLE}Always answer in exactly one sentence.`,
      ),
    ).toBe(true);
    expect(inspection.composed.indexOf(INSTRUCTION_PRECEDENCE)).toBeLessThan(
      inspection.composed.indexOf("# Personality"),
    );
  });
});

describe("modular composer: prompt-cache stability", () => {
  test("composition is deterministic and the prefix ignores per-turn context", () => {
    const settings = testSettings();
    const options = {
      agentConfig: config(allAgentCapabilities()),
      codemodeAvailable: true,
      agentPromptResources: { ...ALL_RESOURCES, attachments: false },
    };
    const first = inspectPersistentAgentInstructions(settings, options);
    const second = inspectPersistentAgentInstructions(settings, options);
    expect(second.composed).toBe(first.composed);
    const withContext = inspectPersistentAgentInstructions(settings, {
      ...options,
      workspaceGovernance: "GOVERNANCE v2",
      workspaceMemory: "MEMORY",
      sessionInstructions: "SESSION",
    });
    expect(withContext.composed.startsWith(first.composed)).toBe(true);
  });

  test("resource facts come from the build resources and options", () => {
    const settings = testSettings({ sandboxBackend: "docker" });
    expect(
      agentPromptResourcesFor(
        settings,
        [
          { kind: "repository", uri: "https://github.com/acme/app" },
          { kind: "file", fileId: "11111111-1111-4111-8111-111111111111" },
        ] as never,
        { gitTokenSeeds: { github: "t" } },
      ),
    ).toEqual({
      managedSandbox: true,
      connectedMachine: false,
      repositories: true,
      gitCredentials: true,
      attachments: true,
    });
    expect(
      agentPromptResourcesFor(settings, [{ kind: "repository", uri: "x" }] as never, {
        activeSandboxBackend: "selfhosted",
      }),
    ).toEqual({
      managedSandbox: false,
      connectedMachine: true,
      repositories: false,
      gitCredentials: false,
      attachments: false,
    });
    expect(agentPromptResourcesFor(testSettings({ sandboxBackend: "none" }), [], {})).toEqual(
      NO_RESOURCES,
    );
  });

  test("buildOpenGeniAgent uses the modular composer only with a configuration", () => {
    const settings = testSettings({ sandboxBackend: "none" });
    const legacy = buildOpenGeniAgent(settings, [], {});
    const modular = buildOpenGeniAgent(settings, [], {
      agentConfig: config(noneAgentCapabilities(), { from: "none", renderer: "markdown" }),
    });
    expect(String(legacy.instructions)).toStartWith("You are an agent for the current workspace.");
    expect(String(modular.instructions)).toStartWith(DEFAULT_AGENT_IDENTITY);
    expect(String(modular.instructions)).toContain("# Links and rendering");
    expect(String(modular.instructions)).not.toMatch(MARKERS.knowledge!);
    expect(String(modular.instructions).length).toBeLessThan(
      String(legacy.instructions).length / 2,
    );
  });
});
