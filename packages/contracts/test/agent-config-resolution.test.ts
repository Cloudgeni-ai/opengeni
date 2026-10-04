import { describe, expect, test } from "bun:test";
import {
  AGENT_CAPABILITY_IDS,
  AgentCapabilities,
  AgentConfigError,
  AgentConfigRequest,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_NAMES,
  ResolvedAgentConfig,
  agentConfigAddedFirstPartyMcpTools,
  agentConfigDeploymentLimitsFromAllowlist,
  agentConfigFirstPartyMcpTools,
  agentConfigToolRefs,
  allAgentCapabilities,
  legacyEffectiveAgentCapabilities,
  noneAgentCapabilities,
  projectAgentEffectiveTools,
  resolveAgentConfig,
  resolveAgentToolFamilies,
  resolveAgentMediaToolSurface,
  resolveAgentConfigUpdate,
  resolveWorkspaceAgentDefaults,
  resolveWorkspaceDefaultAgentIdentity,
  type ResolveAgentConfigInput,
  type ToolRef,
} from "../src/index";

const deployment = {
  unavailable: {},
} satisfies ResolveAgentConfigInput["deployment"];
const workspace = { defaults: null, humanInputEnabled: true };

function resolve(overrides: Partial<ResolveAgentConfigInput> = {}) {
  return resolveAgentConfig({
    creator: "api",
    workspace,
    deployment,
    goal: false,
    ...overrides,
  });
}

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof AgentConfigError) return error.code;
    throw error;
  }
  return null;
}

describe("agent config schemas", () => {
  test("capability shapes", () => {
    expect(AgentCapabilities.parse("all")).toBe("all");
    expect(AgentCapabilities.parse({ from: "none", goals: true, skills: "manage" })).toEqual({
      from: "none",
      goals: true,
      skills: "manage",
    });
    expect(() => AgentCapabilities.parse({ from: "none", unknown: true })).toThrow();
    expect(() => AgentCapabilities.parse({ goals: true })).toThrow();
    expect(() => AgentConfigRequest.parse({ identity: "x".repeat(8001) })).toThrow();
    expect(AgentConfigRequest.parse({ identity: null })).toEqual({ identity: null });
    expect(() => AgentConfigRequest.parse({ renderer: "html" })).toThrow();
  });
});

describe("resolveAgentConfig", () => {
  test("omitted agent on a top-level session resolves all", () => {
    expect(resolve().config).toMatchObject({ source: "deployment_default", from: "all" });
    expect(resolve({ instructions: "be brief" }).instructions).toBe("be brief");
  });

  test("all and none starting points", () => {
    const all = resolve({ request: { capabilities: "all" } }).config!;
    expect(all.capabilities).toEqual(allAgentCapabilities());
    expect(all).toMatchObject({ version: 1, from: "all", source: "request", renderer: "opengeni" });
    const none = resolve({ request: { capabilities: "none" } }).config!;
    expect(none.capabilities).toEqual(noneAgentCapabilities());
    expect(none.capabilities.humanInput).toBe(true);
    expect(none.capabilities.skills).toBe("read");
  });

  test("toggle matrix over every capability and both starting points", () => {
    for (const from of ["all", "none"] as const) {
      for (const id of AGENT_CAPABILITY_IDS) {
        const on = id === "skills" ? "manage" : true;
        const off = false;
        const enabled = resolve({ request: { capabilities: { from, [id]: on } } }).config!;
        const disabled = resolve({ request: { capabilities: { from, [id]: off } } }).config!;
        expect(enabled.capabilities[id]).toBe(on);
        expect(disabled.capabilities[id]).toBe(off);
        const base = from === "all" ? allAgentCapabilities() : noneAgentCapabilities();
        for (const other of AGENT_CAPABILITY_IDS) {
          if (other === id) continue;
          expect(enabled.capabilities[other]).toBe(base[other]);
        }
      }
    }
  });

  test("deployment limits: from all reports off; explicit on is refused", () => {
    const limited = { ...deployment, unavailable: { webSearch: "hosted web search is off" } };
    const all = resolve({ request: { capabilities: "all" }, deployment: limited }).config!;
    expect(all.capabilities.webSearch).toBe(false);
    expect(all.unavailable).toEqual(["webSearch"]);
    expect(
      errorCode(() =>
        resolve({
          request: { capabilities: { from: "none", webSearch: true } },
          deployment: limited,
        }),
      ),
    ).toBe("agent_capability_unavailable");
    const none = resolve({ request: { capabilities: "none" }, deployment: limited }).config!;
    expect(none.unavailable).toEqual([]);
  });

  test("goal implies goals; explicit goals:false with a goal conflicts", () => {
    const implied = resolve({ request: { capabilities: "none" }, goal: true }).config!;
    expect(implied.capabilities.goals).toBe(true);
    expect(
      errorCode(() =>
        resolve({ request: { capabilities: { from: "all", goals: false } }, goal: true }),
      ),
    ).toBe("agent_config_conflict");
  });

  test("instructions alias", () => {
    expect(resolve({ request: { instructions: "a" } }).instructions).toBe("a");
    expect(resolve({ request: { instructions: "a" }, instructions: "a" }).instructions).toBe("a");
    expect(errorCode(() => resolve({ request: { instructions: "a" }, instructions: "b" }))).toBe(
      "agent_config_conflict",
    );
    // An instructions-only agent still creates a configuration.
    expect(resolve({ request: { instructions: "a" } }).config?.from).toBe("all");
  });

  test("renderer defaults per creator", () => {
    expect(resolve({ request: {}, creator: "api" }).config!.source).toBe("deployment_default");
    expect(resolve({ request: { capabilities: "all" }, creator: "slack" }).config!.renderer).toBe(
      "markdown",
    );
    expect(
      resolve({ request: { capabilities: "all" }, creator: "scheduled" }).config!.renderer,
    ).toBe("opengeni");
    expect(resolve({ request: { renderer: "markdown" }, creator: "api" }).config!.renderer).toBe(
      "markdown",
    );
  });

  test("workspace defaults and the deployment default", () => {
    const defaults = { capabilities: { from: "none" as const, goals: true }, identity: "Acme bot" };
    const fromWorkspace = resolve({ workspace: { defaults, humanInputEnabled: true } }).config!;
    expect(fromWorkspace).toMatchObject({ source: "workspace_default", identity: "Acme bot" });
    expect(fromWorkspace.capabilities.goals).toBe(true);
    expect(fromWorkspace.capabilities.knowledge).toBe(false);
    const deploymentDefault = resolve().config!;
    expect(deploymentDefault).toMatchObject({ source: "deployment_default", from: "all" });
    // Site-auth maintenance always stays legacy.
    expect(resolve({ creator: "site_auth_maintenance" }).config).toBeNull();
    // Request capabilities override the workspace default entirely; identity falls back.
    const request = resolve({
      workspace: { defaults, humanInputEnabled: true },
      request: { capabilities: "all" },
    }).config!;
    expect(request.capabilities.knowledge).toBe(true);
    expect(request.identity).toBe("Acme bot");
  });

  test("legacy agentHumanInputEnabled=false maps to humanInput off unless toggled", () => {
    const off = { defaults: null, humanInputEnabled: false };
    expect(
      resolve({ workspace: off, request: { capabilities: "all" } }).config!.capabilities.humanInput,
    ).toBe(false);
    expect(
      resolve({ workspace: off, request: { capabilities: { from: "all", humanInput: true } } })
        .config!.capabilities.humanInput,
    ).toBe(true);
  });

  test("children inherit and may only narrow", () => {
    const parentConfig = resolve({
      request: { capabilities: { from: "all", knowledge: false }, identity: "P" },
    }).config!;
    const parent = { kind: "configured" as const, config: parentConfig };
    const inherited = resolve({ parent }).config!;
    expect(inherited).toEqual({ ...parentConfig, source: "inherited" });
    const narrowed = resolve({
      parent,
      request: { capabilities: { from: "all", goals: false } },
    }).config!;
    expect(narrowed.capabilities.goals).toBe(false);
    expect(narrowed.capabilities.knowledge).toBe(false);
    expect(narrowed.identity).toBe("P");
    expect(
      errorCode(() =>
        resolve({ parent, request: { capabilities: { from: "all", knowledge: true } } }),
      ),
    ).toBe("agent_config_widening");
    // none for a child keeps only essentials the parent also has.
    const skillsOffParent = {
      kind: "configured" as const,
      config: resolve({ request: { capabilities: { from: "none", skills: false } } }).config!,
    };
    expect(
      resolve({ parent: skillsOffParent, request: { capabilities: "none" } }).config!.capabilities
        .skills,
    ).toBe(false);
    // A child goal needs goals on the parent.
    const noGoalsParent = {
      kind: "configured" as const,
      config: resolve({ request: { capabilities: "none" } }).config!,
    };
    expect(errorCode(() => resolve({ parent: noGoalsParent, goal: true }))).toBe(
      "agent_config_widening",
    );
  });

  test("children of legacy parents stay legacy unless they ask", () => {
    const legacy = {
      kind: "legacy" as const,
      ceiling: { ...allAgentCapabilities(), schedules: false },
    };
    expect(resolve({ parent: legacy }).config).toBeNull();
    const child = resolve({
      parent: legacy,
      request: { capabilities: { from: "all", media: false } },
    }).config!;
    expect(child.capabilities.schedules).toBe(false);
    expect(child.capabilities.media).toBe(false);
    expect(
      errorCode(() =>
        resolve({ parent: legacy, request: { capabilities: { from: "none", schedules: true } } }),
      ),
    ).toBe("agent_config_widening");
  });

  test("resolved configs round-trip their schema", () => {
    const config = resolve({
      request: { capabilities: { from: "none", skills: "manage" } },
    }).config!;
    expect(ResolvedAgentConfig.parse(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });
});

describe("write-through", () => {
  const all = resolve({ request: { capabilities: "all" } }).config!;
  const none = resolve({ request: { capabilities: "none" } }).config!;

  test('"all" reproduces the creator baseline exactly', () => {
    for (const baseline of [
      [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      [...FIRST_PARTY_MCP_TOOL_NAMES],
      ["goal_set", "slack_bot_search"] as const,
      [],
    ]) {
      expect(agentConfigFirstPartyMcpTools(all, baseline)).toEqual([...baseline]);
    }
    const tools: ToolRef[] = [
      { kind: "mcp", id: "opengeni" },
      { kind: "mcp", id: "files", optional: true },
      { kind: "mcp", id: "docs", optional: true },
      { kind: "mcp", id: "github", optional: true },
    ];
    const policy = { mode: "workspace_default" as const, inheritedFromSessionId: null };
    expect(
      agentConfigToolRefs({ config: all, tools, toolPolicy: policy, productServerIds: new Set() }),
    ).toEqual({ tools, toolPolicy: policy });
  });

  test('"none" keeps only runtime mechanics', () => {
    expect(
      agentConfigFirstPartyMcpTools(none, DEFAULT_FIRST_PARTY_MCP_TOOLS).sort() as string[],
    ).toEqual(["command_read", "command_wait", "set_session_title", "wait_for_input"].sort());
  });

  test("each capability keeps exactly its tools", () => {
    for (const id of AGENT_CAPABILITY_IDS) {
      if (id === "skills") continue;
      const config = resolve({ request: { capabilities: { from: "none", [id]: true } } }).config!;
      const kept = agentConfigFirstPartyMcpTools(config, FIRST_PARTY_MCP_TOOL_NAMES);
      for (const tool of FIRST_PARTY_MCP_TOOL_NAMES) {
        const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES[tool];
        const expected = owner === "runtime" || owner === id;
        expect({ tool, kept: kept.includes(tool) }).toEqual({ tool, kept: expected });
      }
    }
  });

  test("explicit legacy selections must not contradict capabilities", () => {
    expect(errorCode(() => agentConfigFirstPartyMcpTools(none, ["goal_set"], ["goal_set"]))).toBe(
      "agent_config_conflict",
    );
    expect(agentConfigFirstPartyMcpTools(none, ["wait_for_input"], ["wait_for_input"])).toEqual([
      "wait_for_input",
    ]);
  });

  test("deployment-unavailable capabilities never rewrite the stored selection", () => {
    const limits = agentConfigDeploymentLimitsFromAllowlist(
      FIRST_PARTY_MCP_TOOL_NAMES.filter(
        (tool) =>
          !tool.startsWith("browser_") &&
          !tool.startsWith("computer_") &&
          !tool.startsWith("interaction_"),
      ),
    );
    expect(Object.keys(limits.unavailable)).toEqual(["browser"]);
    const config = resolve({
      request: { capabilities: "all" },
      deployment: { ...deployment, ...limits },
    }).config!;
    expect(config.capabilities.browser).toBe(false);
    expect(agentConfigFirstPartyMcpTools(config, DEFAULT_FIRST_PARTY_MCP_TOOLS)).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
    ]);
  });

  test("tool refs follow workspaceFiles, knowledge and workspaceConnectors", () => {
    const tools: ToolRef[] = [
      { kind: "mcp", id: "opengeni" },
      { kind: "mcp", id: "files", optional: true },
      { kind: "mcp", id: "docs", optional: true },
      { kind: "mcp", id: "github", optional: true },
      { kind: "mcp", id: "acme" },
    ];
    const workspaceDefault = { mode: "workspace_default" as const, inheritedFromSessionId: null };
    const filesOff = resolve({
      request: { capabilities: { from: "all", workspaceFiles: false, knowledge: false } },
    }).config!;
    expect(
      agentConfigToolRefs({
        config: filesOff,
        tools,
        toolPolicy: workspaceDefault,
        productServerIds: new Set(["acme"]),
      }),
    ).toEqual({
      tools: tools.filter((tool) => tool.id !== "files" && tool.id !== "docs"),
      toolPolicy: { ...workspaceDefault, excludedMcpServerIds: ["docs", "files"] },
    });
    expect(
      agentConfigToolRefs({
        config: none,
        tools,
        toolPolicy: workspaceDefault,
        productServerIds: new Set(["acme"]),
      }),
    ).toEqual({
      tools: [
        { kind: "mcp", id: "opengeni" },
        { kind: "mcp", id: "acme", eager: true },
      ],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    });
    expect(
      errorCode(() =>
        agentConfigToolRefs({
          config: none,
          tools,
          toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
          productServerIds: new Set(["acme"]),
          explicitServerIds: new Set(["files"]),
        }),
      ),
    ).toBe("agent_config_conflict");
  });

  test("none product tools default upfront without overriding explicit search visibility", () => {
    const refs: ToolRef[] = [
      { kind: "mcp", id: "acme" },
      { kind: "mcp", id: "explicit-search", eager: false },
    ];
    const input = {
      tools: refs,
      toolPolicy: { mode: "explicit" as const, inheritedFromSessionId: null },
      productServerIds: new Set(refs.map((ref) => ref.id)),
    };
    expect(agentConfigToolRefs({ ...input, config: none }).tools).toEqual([
      { kind: "mcp", id: "acme", eager: true },
      refs[1]!,
    ]);
    expect(agentConfigToolRefs({ ...input, config: all }).tools).toEqual(refs);
  });
});

describe("mid-session update", () => {
  const legacyCeiling = legacyEffectiveAgentCapabilities({
    firstPartyMcpTools: DEFAULT_FIRST_PARTY_MCP_TOOLS,
    tools: [{ kind: "mcp", id: "opengeni" }],
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    humanInputEnabled: true,
  });

  test("legacy sessions convert from their current effective state", () => {
    const converted = resolveAgentConfigUpdate({
      current: null,
      legacyCeiling,
      request: { identity: "Helper" },
      deployment,
      onlyNarrow: false,
      goal: false,
    });
    expect(converted.source).toBe("legacy_conversion");
    expect(converted.capabilities).toEqual(legacyCeiling);
    expect(converted.capabilities.workspaceFiles).toBe(false);
    expect(converted.identity).toBe("Helper");
  });

  test("agents may only narrow", () => {
    const current = resolve({ request: { capabilities: "none" } }).config!;
    expect(
      errorCode(() =>
        resolveAgentConfigUpdate({
          current,
          legacyCeiling,
          request: { capabilities: { from: "none", goals: true } },
          deployment,
          onlyNarrow: true,
          goal: false,
        }),
      ),
    ).toBe("agent_config_widening");
    // "all" by an agent clamps to what it already holds.
    const clamped = resolveAgentConfigUpdate({
      current,
      legacyCeiling,
      request: { capabilities: "all" },
      deployment,
      onlyNarrow: true,
      goal: false,
    });
    expect(clamped.capabilities).toEqual(current.capabilities);
    // A human may widen.
    const widened = resolveAgentConfigUpdate({
      current,
      legacyCeiling,
      request: { capabilities: { from: "none", goals: true } },
      deployment,
      onlyNarrow: false,
      goal: false,
    });
    expect(widened.capabilities.goals).toBe(true);
    expect(widened.source).toBe("request");
    expect(
      agentConfigAddedFirstPartyMcpTools(
        current.capabilities,
        widened,
        DEFAULT_FIRST_PARTY_MCP_TOOLS,
      ).sort(),
    ).toEqual(DEFAULT_FIRST_PARTY_MCP_TOOLS.filter((tool) => tool.startsWith("goal_")).sort());
  });

  test("omitted fields keep current values and admission is enforced", () => {
    const current = resolve({
      request: { capabilities: "none", identity: "A", renderer: "markdown" },
    }).config!;
    const next = resolveAgentConfigUpdate({
      current,
      legacyCeiling,
      request: { identity: "B" },
      deployment,
      onlyNarrow: false,
      goal: false,
    });
    expect(next).toMatchObject({
      identity: "B",
      renderer: "markdown",
      capabilities: current.capabilities,
    });
  });
});

describe("workspace defaults helpers", () => {
  test("lenient read, legacy identity mapping", () => {
    expect(
      resolveWorkspaceAgentDefaults({ sessionAgentDefaults: { capabilities: "none" } }),
    ).toEqual({
      capabilities: "none",
    });
    // A value from a newer release is ignored rather than failing the bag.
    expect(resolveWorkspaceAgentDefaults({ sessionAgentDefaults: { future: 1 } })).toBeNull();
    expect(resolveWorkspaceDefaultAgentIdentity({}, "You are Acme. {{core}}")).toEqual({
      identity: "You are Acme.",
      source: "legacy_agent_instructions",
    });
    expect(
      resolveWorkspaceDefaultAgentIdentity(
        { sessionAgentDefaults: { identity: "Explicit" } },
        "Legacy",
      ),
    ).toEqual({ identity: "Explicit", source: "explicit" });
    expect(resolveWorkspaceDefaultAgentIdentity({}, null)).toEqual({
      identity: null,
      source: null,
    });
  });
});

describe("effective tools projection", () => {
  test("unresolved media never advertises guessed adapter names or claims unavailable", () => {
    const config = resolve({ request: { capabilities: { from: "none", media: true } } }).config!;
    const projection = projectAgentEffectiveTools({
      config,
      firstPartyMcpTools: [],
      mcpServerIds: [],
      productServerIds: new Set(),
      hostedToolNames: ["image_generation"],
      runtimeToolNames: ["generate_image", "generate_video"],
      environment: { media: true },
    });
    expect(projection.tools).toEqual([]);
    expect(projection.mediaToolsKnown).toBe(false);
    expect(projection.capabilities.media).toBe(true);
    expect(projection.unavailable).not.toContain("media");
    expect(resolveAgentMediaToolSurface(config, { image: null, video: false })).toEqual({
      toolsKnown: true,
      hosted: [],
      runtime: [],
    });
  });

  test("media snapshot cannot select both image transports or bypass the capability ceiling", () => {
    const enabled = resolve({ request: { capabilities: "all" } }).config!;
    const disabled = resolve({ request: { capabilities: "none" } }).config!;
    for (const image of ["native_hosted", "provider_adapter"] as const) {
      const projection = projectAgentEffectiveTools({
        config: enabled,
        firstPartyMcpTools: [],
        mcpServerIds: [],
        productServerIds: new Set(),
        mediaAttachment: { image, video: true },
        hostedToolNames: ["image_generation"],
        runtimeToolNames: ["generate_image", "generate_video", "get_video_generation_capabilities"],
      });
      const names = projection.tools.map((tool) => tool.name);
      expect(names.includes("image_generation")).toBe(image === "native_hosted");
      expect(names.includes("generate_image")).toBe(image === "provider_adapter");
      expect(names.filter((name) => name === "generate_video")).toHaveLength(1);
      expect(resolveAgentMediaToolSurface(disabled, { image, video: true })).toEqual({
        toolsKnown: true,
        hosted: [],
        runtime: [],
      });
    }
  });
  test("unknown workspace connectors cannot bypass none but explicit product tools survive", () => {
    const config = resolve({ request: { capabilities: "none" } }).config!;
    const families = resolveAgentToolFamilies(config, { productServerIds: new Set(["acme"]) });
    expect(families.allowsMcpServer("stale-workspace-connector")).toBe(false);
    expect(families.allowsMcpServer("acme")).toBe(true);
    expect(families.allowsMcpServer("files")).toBe(false);
    expect(resolveAgentToolFamilies(null).allowsMcpServer("stale-workspace-connector")).toBe(true);
    expect(families.firstPartyTools([])).toEqual([
      "wait_for_input",
      "command_read",
      "command_wait",
    ]);
  });
  test("lists capability tools and classifies servers", () => {
    const config = resolve({ request: { capabilities: { from: "none", media: true } } }).config!;
    const projection = projectAgentEffectiveTools({
      config,
      firstPartyMcpTools: ["wait_for_input"],
      mcpServerIds: ["opengeni", "acme", "github"],
      productServerIds: new Set(["acme"]),
      environment: { hasSkills: true },
      mediaAttachment: { image: "provider_adapter", video: true },
      runtimeToolNames: [
        "request_human_input",
        "skill_read",
        "generate_image",
        "generate_video",
        "get_video_generation_capabilities",
      ],
      upfrontToolNames: new Set(["request_human_input", "skill_read"]),
    });
    expect(projection.tools.map((tool) => tool.name)).toEqual([
      "opengeni__wait_for_input",
      "request_human_input",
      "skill_read",
      "generate_image",
      "generate_video",
      "get_video_generation_capabilities",
    ]);
    expect(projection.tools.find((tool) => tool.name === "skill_read")?.visibility).toBe("upfront");
    expect(projection.tools.find((tool) => tool.name === "generate_video")?.visibility).toBe(
      "search",
    );
    expect(projection.mcpServers).toEqual([
      { id: "acme", capability: "product", toolsKnown: false },
      { id: "opengeni", capability: "runtime", toolsKnown: true },
    ]);
  });
});
