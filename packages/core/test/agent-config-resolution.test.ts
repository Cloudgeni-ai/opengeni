import { describe, expect, test } from "bun:test";
import {
  AgentConfigError,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type Session,
  type ToolRef,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import {
  applySessionAgentConfigWriteThrough,
  legacySessionAgentCapabilities,
  requireAgentConfigAdmission,
  resolveSessionAgentConfigForCreate,
  scheduledTaskAgentInput,
} from "../src/domain/agent-config-resolution";

const on = testSettings({ agentConfigAdmissionEnabled: true });
const off = testSettings();

function failure(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof HTTPException && error.cause instanceof AgentConfigError) {
      return { status: error.status, code: error.cause.code };
    }
    throw error;
  }
  return null;
}

function parentSession(overrides: Partial<Session>): Session {
  return {
    agent: null,
    firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    tools: [],
    toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
    ...overrides,
  } as Session;
}

describe("resolveSessionAgentConfigForCreate", () => {
  const base = {
    request: undefined,
    instructions: undefined,
    workspaceSettings: {},
    parent: null,
    goal: false,
  };

  test("switches off and no agent: legacy for every creator", () => {
    for (const creator of [
      "api",
      "slack",
      "scheduled",
      "automation",
      "site_auth_maintenance",
    ] as const) {
      expect(
        resolveSessionAgentConfigForCreate({ ...base, settings: off, creator }).config,
      ).toBeNull();
    }
  });

  test("admission off turns an agent input into a typed 422", () => {
    expect(
      failure(() =>
        resolveSessionAgentConfigForCreate({
          ...base,
          settings: off,
          creator: "api",
          request: { capabilities: "none" },
        }),
      ),
    ).toEqual({ status: 422, code: "agent_config_not_enabled" });
  });

  test("Slack defaults to the markdown renderer, other creators to opengeni", () => {
    const slack = resolveSessionAgentConfigForCreate({
      ...base,
      settings: on,
      creator: "slack",
      request: { capabilities: "all" },
    }).config!;
    expect(slack.renderer).toBe("markdown");
    const api = resolveSessionAgentConfigForCreate({
      ...base,
      settings: on,
      creator: "api",
      request: { capabilities: "all" },
    }).config!;
    expect(api.renderer).toBe("opengeni");
  });

  test("default-for-new-sessions applies to every creator except site-auth maintenance", () => {
    const settings = testSettings({ agentConfigDefaultForNewSessions: true });
    for (const creator of ["api", "slack", "scheduled", "automation"] as const) {
      expect(
        resolveSessionAgentConfigForCreate({ ...base, settings, creator }).config?.source,
      ).toBe("deployment_default");
    }
    expect(
      resolveSessionAgentConfigForCreate({ ...base, settings, creator: "site_auth_maintenance" })
        .config,
    ).toBeNull();
  });

  test("hosted web search off on the deployment reports webSearch unavailable", () => {
    const config = resolveSessionAgentConfigForCreate({
      ...base,
      settings: testSettings({ agentConfigAdmissionEnabled: true, webSearchEnabled: false }),
      creator: "api",
      request: { capabilities: "all" },
    }).config!;
    expect(config.capabilities.webSearch).toBe(false);
    expect(config.unavailable).toEqual(["webSearch"]);
  });

  test("workspace legacy human-input switch and stored defaults", () => {
    const config = resolveSessionAgentConfigForCreate({
      ...base,
      settings: on,
      creator: "api",
      workspaceSettings: {
        agentHumanInputEnabled: false,
        sessionAgentDefaults: { capabilities: "all", renderer: "markdown" },
      },
    }).config!;
    expect(config).toMatchObject({ source: "workspace_default", renderer: "markdown" });
    expect(config.capabilities.humanInput).toBe(false);
  });

  test("children: configured parents are inherited, legacy parents keep the tree legacy", () => {
    const configuredParent = parentSession({
      agent: resolveSessionAgentConfigForCreate({
        ...base,
        settings: on,
        creator: "api",
        request: { capabilities: "none" },
      }).config!,
    });
    expect(
      resolveSessionAgentConfigForCreate({
        ...base,
        settings: off,
        creator: "api",
        parent: configuredParent,
      }).config?.source,
    ).toBe("inherited");
    expect(
      resolveSessionAgentConfigForCreate({
        ...base,
        settings: testSettings({ agentConfigDefaultForNewSessions: true }),
        creator: "api",
        parent: parentSession({}),
      }).config,
    ).toBeNull();
    const legacyNarrowParent = parentSession({
      firstPartyMcpTools: ["wait_for_input", "goal_set"],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    });
    expect(
      failure(() =>
        resolveSessionAgentConfigForCreate({
          ...base,
          settings: on,
          creator: "api",
          parent: legacyNarrowParent,
          request: { capabilities: { from: "none", schedules: true } },
        }),
      ),
    ).toEqual({ status: 422, code: "agent_config_widening" });
  });
});

describe("applySessionAgentConfigWriteThrough", () => {
  test("null configuration returns the creator's exact legacy values", () => {
    const tools: ToolRef[] = [{ kind: "mcp", id: "files", optional: true }];
    const input = {
      config: null,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      tools,
      toolPolicy: { mode: "workspace_default" as const, inheritedFromSessionId: null },
      productServerIds: [],
    };
    const result = applySessionAgentConfigWriteThrough(input);
    expect(result.firstPartyMcpTools).toBe(input.firstPartyMcpTools);
    expect(result.tools).toBe(tools);
    expect(result.toolPolicy).toBe(input.toolPolicy);
  });

  test("conflicts surface as typed 422s", () => {
    const none = resolveSessionAgentConfigForCreate({
      request: { capabilities: "none" },
      instructions: undefined,
      workspaceSettings: {},
      parent: null,
      goal: false,
      settings: on,
      creator: "api",
    }).config;
    expect(
      failure(() =>
        applySessionAgentConfigWriteThrough({
          config: none,
          firstPartyMcpTools: ["goal_set"],
          explicitFirstPartyMcpTools: ["goal_set"],
          tools: [],
          toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
          productServerIds: [],
        }),
      ),
    ).toEqual({ status: 422, code: "agent_config_conflict" });
  });
});

describe("legacy ceilings and stored-input admission", () => {
  test("workspace-default legacy sessions only count servers that are defaults", () => {
    const session = parentSession({});
    const withoutDocs = legacySessionAgentCapabilities(off, session, {}, ["github"]);
    expect(withoutDocs.knowledge).toBe(true); // default selection includes knowledge tools
    expect(withoutDocs.workspaceFiles).toBe(false);
    expect(withoutDocs.workspaceConnectors).toBe(true);
    const onlyBuiltins = legacySessionAgentCapabilities(
      off,
      parentSession({ firstPartyMcpTools: ["wait_for_input"] }),
      {},
      ["files"],
    );
    expect(onlyBuiltins).toMatchObject({
      workspaceFiles: true,
      workspaceConnectors: false,
      knowledge: false,
      goals: false,
    });
  });

  test("stored agent inputs require admission", () => {
    expect(failure(() => requireAgentConfigAdmission(off, { capabilities: "all" }))).toEqual({
      status: 422,
      code: "agent_config_not_enabled",
    });
    expect(failure(() => requireAgentConfigAdmission(off, undefined))).toBeNull();
    expect(failure(() => requireAgentConfigAdmission(on, { capabilities: "all" }))).toBeNull();
    expect(scheduledTaskAgentInput({ agentConfig: { agent: { capabilities: "none" } } })).toEqual({
      capabilities: "none",
    });
    expect(scheduledTaskAgentInput({ name: "x" })).toBeUndefined();
  });
});
