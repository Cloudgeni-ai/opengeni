import { describe, expect, spyOn, test } from "bun:test";
import { configuredModels, withXaiSubscriptionCatalogProvider } from "@opengeni/config";
import {
  AgentEffectiveTools,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  resolveAgentConfig,
  type AgentCapabilities,
  type Session,
} from "@opengeni/contracts";
import * as db from "@opengeni/db";
import * as catalog from "../src/model-catalog";
import { testSettings } from "@opengeni/testing";
import {
  sessionEffectiveToolProjectionInput,
  sessionWithEffectiveToolPolicy,
  workspaceSessionEffectiveToolsContext,
  type SessionEffectiveToolsContext,
} from "../src/domain/session-tool-policy";

const settings = testSettings({ openaiModel: "gpt-6-astra", lazyToolSearchEnabled: true });

function session(capabilities: AgentCapabilities = "all", overrides: Partial<Session> = {}) {
  const agent = resolveAgentConfig({
    creator: "api",
    request: { capabilities },
    deployment: { unavailable: {} },
    workspace: { defaults: null, humanInputEnabled: true },
    goal: false,
  }).config!;
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    agent,
    model: settings.openaiModel,
    sandboxBackend: "none",
    sandboxOs: "linux",
    codeSearchEnabled: false,
    activeSandboxId: null,
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    tools: [],
    toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
    skills: [],
    bundledSkillIds: [],
    resources: [],
    mcpServers: [],
    ...overrides,
  } as Session & { agent: NonNullable<Session["agent"]> };
}

function context(
  overrides: Partial<SessionEffectiveToolsContext> = {},
): SessionEffectiveToolsContext {
  return {
    settings,
    humanInputEnabled: true,
    hasWorkspaceSkills: false,
    objectStorageAvailable: false,
    ...overrides,
  };
}

function projected(row = session(), env = context()) {
  return sessionWithEffectiveToolPolicy(
    row,
    ["opengeni", "files", "connector"],
    ["files", "connector"],
    env,
  );
}

describe("server effectiveTools environment projection", () => {
  test("browser downloads follow capability selection and both save permissions", () => {
    for (const permissions of [
      ["sessions:read"],
      ["sessions:read", "sessions:control"],
      ["sessions:read", "sessions:control", "files:upload"],
    ] as NonNullable<Session["firstPartyMcpPermissions"]>[]) {
      const row = session("all", {
        firstPartyMcpTools: ["browser_downloads", "browser_download_save"],
        firstPartyMcpPermissions: permissions,
      });
      const input = sessionEffectiveToolProjectionInput(row, [], context());
      expect(input.firstPartyMcpTools).toContain("browser_downloads");
      expect(input.firstPartyMcpTools.includes("browser_download_save")).toBe(
        permissions.includes("files:upload"),
      );
    }
    const disabled = session("none", {
      firstPartyMcpTools: ["browser_downloads", "browser_download_save"],
    });
    expect(sessionEffectiveToolProjectionInput(disabled, [], context()).firstPartyMcpTools).toEqual(
      [],
    );
  });
  test.each(["codex/gpt-5.6-sol", "supergrok/grok-4.6", "gpt-6-astra"])(
    "%s metadata does not infer media attachment from model or pool readiness",
    async (model) => {
      const row = session("all", { model });
      const envSettings = withXaiSubscriptionCatalogProvider(settings);
      const workspace = spyOn(db, "requireWorkspace").mockResolvedValue({
        settings: {},
      } as Awaited<ReturnType<typeof db.requireWorkspace>>);
      const models = spyOn(catalog, "resolveWorkspaceCatalogSettings").mockResolvedValue({
        settings: envSettings,
        source: "code",
        version: null,
        modelNotes: {},
      });
      const history = spyOn(db, "sessionHasToolRouterHistory").mockResolvedValue(false);
      const codexPool = spyOn(db, "workspaceCodexSubscriptionActive").mockResolvedValue(true);
      const xaiPool = spyOn(db, "workspaceXaiSubscriptionActiveForAuthority").mockResolvedValue(
        true,
      );
      const credentials = spyOn(db, "loadWorkspaceVercelAiGatewayApiKey");
      const policy = spyOn(db, "getWorkspaceVideoGenerationPolicy");
      const authority = spyOn(db, "getLatestStartedSessionTurn");
      try {
        const env = await workspaceSessionEffectiveToolsContext(
          {
            db: {} as db.Database,
            settings: envSettings,
            objectStorage: {},
          },
          row.workspaceId,
          "reader-not-turn-actor",
          [row],
        );
        const result = projected(row, env).effectiveTools!;
        expect(result.mediaToolsKnown).toBe(false);
        expect(result.tools.some((tool) => tool.capability === "media")).toBe(false);
        expect(result.unavailable).not.toContain("media");
        expect(AgentEffectiveTools.safeParse(result).success).toBe(true);
        for (const spy of [codexPool, xaiPool, credentials, policy, authority]) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        for (const spy of [
          workspace,
          models,
          history,
          codexPool,
          xaiPool,
          credentials,
          policy,
          authority,
        ]) {
          spy.mockRestore();
        }
      }
    },
  );

  test("exact attachment snapshots do not leak across sessions and disabled media is known absent", () => {
    const row = session();
    const env = context({
      objectStorageAvailable: true,
      mediaAttachments: new Map([
        ["different-session", { image: "provider_adapter", video: true }],
      ]),
    });
    expect(projected(row, env).effectiveTools!.mediaToolsKnown).toBe(false);
    expect(
      projected(row, env).effectiveTools!.tools.some((tool) => tool.capability === "media"),
    ).toBe(false);
    const disabled = projected(session("none"), env).effectiveTools!;
    expect(disabled.mediaToolsKnown).toBe(true);
    expect(disabled.tools.some((tool) => tool.capability === "media")).toBe(false);
  });

  test("subscription adapters require an exact attachment snapshot for this session", () => {
    const row = session("all", { model: "supergrok/grok-4.6", sandboxBackend: "local" });
    const result = projected(
      row,
      context({
        objectStorageAvailable: true,
        mediaAttachments: new Map([[row.id, { image: "provider_adapter", video: true }]]),
      }),
    );
    const names = result.effectiveTools!.tools.map((tool) => tool.name);
    expect(names).toContain("generate_image");
    expect(names).toContain("generate_video");
    const absent = projected(
      { ...row, sandboxBackend: "none" },
      context({
        objectStorageAvailable: true,
        mediaAttachments: new Map([[row.id, { image: null, video: false }]]),
      }),
    );
    expect(absent.effectiveTools!.tools.map((tool) => tool.name)).not.toContain("generate_video");
  });
  test("bundled artifact Skills cannot leak a reader from disabled legacy columns", () => {
    const result = projected(session("none", { bundledSkillIds: ["builtin:opengeni-documents"] }));
    expect(result.effectiveTools!.tools.map((tool) => tool.name)).not.toContain("skill_read");
  });
  test("null config preserves the exact legacy projection and skips metadata reads", async () => {
    const row = { ...session(), agent: null };
    const legacy = sessionWithEffectiveToolPolicy(row, ["opengeni"], []);
    expect(Object.hasOwn(legacy, "effectiveTools")).toBe(false);
    expect(sessionWithEffectiveToolPolicy(row, ["opengeni"], [], context())).toEqual(legacy);
    const workspace = spyOn(db, "requireWorkspace");
    try {
      await workspaceSessionEffectiveToolsContext(
        { db: {} as db.Database, settings },
        row.workspaceId,
        "human",
        [row],
      );
      expect(workspace).not.toHaveBeenCalled();
    } finally {
      workspace.mockRestore();
    }
  });

  test("metadata context shares catalog, workspace settings, and scoped sandbox reads", async () => {
    const sandboxId = "44444444-4444-4444-8444-444444444444";
    const row = session("none", { activeSandboxId: sandboxId });
    const envSettings = { ...settings, sandboxSelfhostedEnabled: true };
    const workspace = spyOn(db, "requireWorkspace").mockResolvedValue({
      settings: { agentHumanInputEnabled: false },
    } as Awaited<ReturnType<typeof db.requireWorkspace>>);
    const models = spyOn(catalog, "resolveWorkspaceCatalogSettings").mockResolvedValue({
      settings: envSettings,
      source: "code",
      version: null,
      modelNotes: {},
    });
    const skills = spyOn(db, "listSkillDescriptors").mockResolvedValue([
      { activationMode: "session_selected" },
      { activationMode: "workspace_managed" },
    ] as Awaited<ReturnType<typeof db.listSkillDescriptors>>);
    const sandbox = spyOn(db, "getSandbox").mockResolvedValue({
      kind: "selfhosted",
    } as NonNullable<Awaited<ReturnType<typeof db.getSandbox>>>);
    const history = spyOn(db, "sessionHasToolRouterHistory").mockResolvedValue(true);
    try {
      const result = await workspaceSessionEffectiveToolsContext(
        { db: {} as db.Database, settings: envSettings, objectStorage: {} },
        row.workspaceId,
        "human",
        [row, row],
      );
      expect(result.humanInputEnabled).toBe(false);
      expect(result.hasWorkspaceSkills).toBe(true);
      expect(result.objectStorageAvailable).toBe(true);
      expect(result.activeSandboxBackends?.get(sandboxId)).toBe("selfhosted");
      expect(result.routerHistorySessionIds?.has(row.id)).toBe(true);
      expect(models).toHaveBeenCalledTimes(1);
      expect(sandbox).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledTimes(1);
      expect(sandbox.mock.calls[0]?.[1]).toEqual({
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        subjectId: "human",
      });
    } finally {
      history.mockRestore();
      sandbox.mockRestore();
      skills.mockRestore();
      models.mockRestore();
      workspace.mockRestore();
    }
  });

  test("configured all reports availability without inventing media or sandbox tools", () => {
    const result = projected();
    const names = result.effectiveTools!.tools.map((tool) => tool.name);
    expect(names).not.toContain("generate_image");
    expect(names).not.toContain("generate_video");
    expect(names).not.toContain("image_generation");
    expect(names).not.toContain("exec_command");
    expect(names).toContain("skill_checkout");
    expect(names).toContain("skill_publish");
    expect(names).toContain("request_human_input");
    expect(names).toContain("skill_save");
    expect(names).toContain("tool_search");
    expect(names).toContain("tool_list");
    expect(AgentEffectiveTools.safeParse(result.effectiveTools).success).toBe(true);
  });

  test("missing environment never guesses hosted, Skill, sandbox or router tools", () => {
    const result = sessionWithEffectiveToolPolicy(session(), ["opengeni"], []);
    expect(result.effectiveTools!.tools).toEqual([]);
  });

  test("none/read has no reader without selected or managed Skills", () => {
    const row = session("none");
    const empty = projected(row);
    expect(empty.effectiveTools!.tools.map((tool) => tool.name)).not.toContain("skill_read");
    const managed = projected(row, context({ hasWorkspaceSkills: true }));
    expect(managed.effectiveTools!.tools.map((tool) => tool.name)).toContain("skill_read");
    expect(managed.effectiveTools!.tools.map((tool) => tool.name)).not.toContain("skill_search");
    const bundled = projected(session("none", { bundledSkillIds: ["builtin:opengeni-help"] }));
    expect(bundled.effectiveTools!.tools.map((tool) => tool.name)).toContain("skill_read");
  });

  test("explicit empty bundles differ from the worker's omitted bundled defaults", () => {
    const absent = sessionEffectiveToolProjectionInput(
      session("none", { bundledSkillIds: undefined }),
      [],
      context(),
    );
    const empty = sessionEffectiveToolProjectionInput(session("none"), [], context());
    expect(absent.environment.hasSkills).toBe(true);
    expect(empty.environment.hasSkills).toBe(false);
  });

  test("model flags and workspace human-input switch narrow the all config", () => {
    const result = projected(
      session(),
      context({
        settings: { ...settings, webSearchEnabled: false },
        humanInputEnabled: false,
      }),
    );
    const names = result.effectiveTools!.tools.map((tool) => tool.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("request_human_input");
    expect(result.effectiveTools!.capabilities.webSearch).toBe(false);
    expect(result.effectiveTools!.capabilities.humanInput).toBe(false);
  });

  test("sandbox tools survive none and managed/machine routing does not require media", () => {
    const row = session("none", { sandboxBackend: "local" });
    const input = sessionEffectiveToolProjectionInput(row, [], context());
    expect(input.sandboxToolNames).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
    ]);
    const result = projected(row);
    const names = result.effectiveTools!.tools.map((tool) => tool.name);
    expect(names).toContain("exec_command");
    expect(names).toContain("view_image");
    const sandboxId = "44444444-4444-4444-8444-444444444444";
    const machine = sessionEffectiveToolProjectionInput(
      session("none", { activeSandboxId: sandboxId }),
      [],
      context({ activeSandboxBackends: new Map([[sandboxId, "selfhosted"]]) }),
    );
    expect(machine.sandboxToolNames).toEqual(input.sandboxToolNames);
  });

  test("unresolved provider never advertises hosted web search or image viewing", () => {
    const input = sessionEffectiveToolProjectionInput(
      session("all", { model: "removed-model", sandboxBackend: "local" }),
      [],
      context(),
    );
    expect(input.hostedToolNames).toEqual([]);
    expect(input.sandboxToolNames).not.toContain("view_image");
  });

  test("verified adapters expose only their exact names and remain capability gated", () => {
    const env = context({
      mediaAttachments: new Map([[session().id, { image: null, video: true }]]),
    });
    const all = projected(session(), env).effectiveTools!.tools.map((tool) => tool.name);
    expect(all).toContain("generate_video");
    expect(all).not.toContain("generate_image");
    const none = projected(session("none"), env).effectiveTools!.tools.map((tool) => tool.name);
    expect(none).not.toContain("generate_video");
  });

  test("first-party eager visibility and unknown MCPs use executable, not truncated ids", () => {
    const row = session("all", {
      tools: [
        { kind: "mcp", id: "opengeni", eager: true },
        { kind: "mcp", id: "retired" },
      ],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      mcpServers: [],
    });
    const input = sessionEffectiveToolProjectionInput(row, row.tools.slice(0, 1), context());
    expect(input.upfrontToolNames.has("goal_set")).toBe(true);
    const result = projected(row);
    expect(result.effectiveTools!.mcpServers.map((server) => server.id)).not.toContain("retired");
    const many = Array.from({ length: 70 }, (_, index) => `connector-${index}`);
    const complete = sessionWithEffectiveToolPolicy(
      session(),
      ["opengeni", ...many],
      many,
      context(),
    );
    expect(complete.effectiveToolPolicy!.counts.configured).toBe(71);
    expect(complete.effectiveTools!.mcpServers).toHaveLength(71);
    expect(
      complete
        .effectiveTools!.mcpServers.filter((server) => server.id !== "opengeni")
        .every((server) => server.toolsKnown === false),
    ).toBe(true);
  });

  test("generic router advertises invocation while native transport does not", () => {
    const native = sessionEffectiveToolProjectionInput(
      session(),
      [{ kind: "mcp", id: "opengeni" }],
      context(),
    );
    expect(native.routerToolNames).toEqual(["tool_search", "tool_list"]);
    const generic = sessionEffectiveToolProjectionInput(
      session(),
      [{ kind: "mcp", id: "opengeni" }],
      context({ settings: { ...settings, openaiBaseUrl: "https://example.invalid/v1" } }),
    );
    expect(generic.routerToolNames).toEqual(["tool_search", "tool_list", "tool_invoke"]);
    const off = sessionEffectiveToolProjectionInput(
      session(),
      [{ kind: "mcp", id: "opengeni" }],
      context({ settings: { ...settings, lazyToolSearchEnabled: false } }),
    );
    expect(off.routerToolNames).toEqual([]);
    expect(off.upfrontToolNames.has("goal_set")).toBe(true);
  });

  test("model-facing names and visibility match progressive disclosure", () => {
    const tools = projected().effectiveTools!.tools;
    const named = (name: string) => tools.find((tool) => tool.name === name);
    expect(named("opengeni__goal_set")?.visibility).toBe("search");
    expect(named("request_human_input")?.visibility).toBe("upfront");
    expect(named("skill_read")?.visibility).toBe("upfront");
    expect(named("skill_save")?.visibility).toBe("search");
    expect(named("tool_search")?.visibility).toBe("upfront");
    expect(named("opengeni__set_session_title")).toBeUndefined();
    const eager = projected(
      session("all", {
        tools: [{ kind: "mcp", id: "opengeni", eager: true }],
      }),
    ).effectiveTools!.tools;
    expect(eager.find((tool) => tool.name === "opengeni__goal_set")?.visibility).toBe("upfront");
  });

  test("no router for none without deferred enabled MCPs or retained router", () => {
    const row = session(
      { from: "none", humanInput: false, skills: false },
      {
        firstPartyMcpTools: [],
      },
    );
    const input = sessionEffectiveToolProjectionInput(
      row,
      [
        { kind: "mcp", id: "opengeni", eager: true },
        { kind: "mcp", id: "files" },
      ],
      context(),
    );
    expect(input.environment.hasDeferredTools).toBe(false);
    expect(input.routerToolNames).toEqual([]);
    expect(
      sessionEffectiveToolProjectionInput(row, [], context({ routerInHistory: true }))
        .routerToolNames,
    ).toEqual(["tool_search", "tool_list"]);
    const history = context({ routerHistorySessionIds: new Set([row.id]) });
    expect(sessionEffectiveToolProjectionInput(row, [], history).routerToolNames).toEqual([
      "tool_search",
      "tool_list",
    ]);
    expect(
      sessionEffectiveToolProjectionInput(
        { ...row, id: "55555555-5555-4555-8555-555555555555" },
        [],
        history,
      ).routerToolNames,
    ).toEqual([]);
  });

  test("configured recovery tools exist even with no first-party selection", () => {
    const row = session("none", { firstPartyMcpTools: [] });
    const names = projected(row).effectiveTools!.tools.map((tool) => tool.name);
    expect(names).toContain("opengeni__wait_for_input");
    expect(names).toContain("opengeni__command_read");
    expect(names).toContain("opengeni__command_wait");
    expect(names).not.toContain("opengeni__set_session_title");
  });

  test("code search follows frozen session, deployment key, workspace off and sandbox", () => {
    const row = session("none", { sandboxBackend: "local", codeSearchEnabled: true });
    const env = context({
      settings: { ...settings, codeSearchMode: "opt_in", jevApiKey: "test-code-search" },
    });
    const input = sessionEffectiveToolProjectionInput(row, [], env);
    expect(input.sandboxToolNames).toContain("code_search");
    expect(input.upfrontToolNames.has("code_search")).toBe(true);
    for (const [current, disabled] of [
      [{ ...row, codeSearchEnabled: false }, env],
      [{ ...row, sandboxBackend: "none" as const }, env],
      [row, { ...env, workspaceSettings: { codeSearchEnabled: false } }],
      [row, { ...env, settings: { ...env.settings, jevApiKey: undefined } }],
    ] as const) {
      expect(
        sessionEffectiveToolProjectionInput(current, [], disabled).sandboxToolNames,
      ).not.toContain("code_search");
    }
  });

  test("SuperGrok hosted web and X search follow deployment flags", () => {
    const env = context({ settings: { ...settings, supergrokSubscriptionEnabled: true } });
    const model = configuredModels(withXaiSubscriptionCatalogProvider(env.settings)).find(
      (candidate) => candidate.id.startsWith("supergrok/"),
    )!;
    const row = session("all", { model: model.id });
    const input = sessionEffectiveToolProjectionInput(row, [], env);
    expect(input.hostedToolNames).toEqual(["web_search", "x_search"]);
    expect(
      sessionEffectiveToolProjectionInput(row, [], {
        ...env,
        settings: { ...env.settings, webSearchEnabled: false },
      }).hostedToolNames,
    ).toEqual([]);
  });
});
