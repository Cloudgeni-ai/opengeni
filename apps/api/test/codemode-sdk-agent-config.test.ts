import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_MCP_TOOL_NAMES,
  resolveAgentConfig,
  type AgentConfigRequest,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import {
  assertConfiguredCodemodeSessionProxyPath,
  configuredCodemodeSessionProxyTools,
} from "../src/app";
import { codemodeSessionProxyPermissions } from "../src/codemode";

const settings = testSettings({ allowedFirstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES] });
const sessionId = "00000000-0000-4000-8000-000000000001";

function config(capabilities: AgentConfigRequest["capabilities"]): ResolvedAgentConfig {
  return resolveAgentConfig({
    creator: "api",
    request: { capabilities },
    deployment: { unavailable: {} },
    workspace: { defaults: null, humanInputEnabled: true },
    goal: false,
  }).config!;
}

function proxyTools(agentConfig: ResolvedAgentConfig) {
  return configuredCodemodeSessionProxyTools(settings, { agent: agentConfig })!;
}

function checkPath(agentConfig: ResolvedAgentConfig | null, path: string, method = "GET") {
  assertConfiguredCodemodeSessionProxyPath(
    { id: sessionId, agent: agentConfig },
    `/v1/workspaces/site-host${path}`,
    method,
  );
}

function expectForbidden(action: () => void) {
  try {
    action();
    throw new Error("expected configured proxy denial");
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(403);
  }
}

describe("configured Codemode SDK proxy ceiling", () => {
  test("stale widened live tools cannot restore subagent permissions (AC9)", () => {
    const agentConfig = config({
      from: "all",
      subagents: false,
      workspaceAdmin: false,
      browser: false,
    });
    const tools = proxyTools(agentConfig);
    expect(tools).not.toContain("session_create");
    expect(tools).not.toContain("sessions_list");
    expect(tools).not.toContain("session_steer");
    const permissions = codemodeSessionProxyPermissions(
      { ...settings, allowedFirstPartyMcpTools: tools },
      { firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES], firstPartyMcpPermissions: null },
    );
    expect(permissions).not.toContain("sessions:create");
    // Runtime tools still admit control; that never enables subagent endpoints.
    expect(permissions).toContain("sessions:control");
    expectForbidden(() => checkPath(agentConfig, "/sessions", "POST"));
    expectForbidden(() => checkPath(agentConfig, "/sessions"));
    expectForbidden(() => checkPath(agentConfig, `/sessions/${sessionId}/control`, "POST"));
    expectForbidden(() =>
      checkPath(agentConfig, "/sessions/00000000-0000-4000-8000-000000000002", "PATCH"),
    );
  });

  test("project permissions cannot bypass the session-create capability gate", () => {
    const agentConfig = config({ from: "none", workspaceAdmin: true });
    const permissions = codemodeSessionProxyPermissions(
      { ...settings, allowedFirstPartyMcpTools: proxyTools(agentConfig) },
      { firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES], firstPartyMcpPermissions: null },
    );
    expect(permissions).toContain("sessions:create");
    expect(() => checkPath(agentConfig, "/projects", "POST")).not.toThrow();
    expectForbidden(() => checkPath(agentConfig, "/sessions", "POST"));
  });

  test("configured unavailable capabilities stay unavailable even when requested on", () => {
    const agentConfig = config("all");
    agentConfig.unavailable = ["subagents"];
    expect(proxyTools(agentConfig)).not.toContain("session_create");
    expectForbidden(() => checkPath(agentConfig, "/sessions", "POST"));
  });

  test("deployment selection and explicit empty permission ceilings still narrow the result", () => {
    const agentConfig = config("all");
    expect(
      configuredCodemodeSessionProxyTools(
        { defaultFirstPartyMcpTools: ["set_session_title"], allowedFirstPartyMcpTools: undefined },
        { agent: agentConfig },
      ),
    ).toContain("session_create");
    const tools = configuredCodemodeSessionProxyTools(
      testSettings({ allowedFirstPartyMcpTools: ["set_session_title"] }),
      { agent: agentConfig },
    )!;
    expect(tools).toEqual(["set_session_title"]);
    expect(
      codemodeSessionProxyPermissions(
        { ...settings, allowedFirstPartyMcpTools: tools },
        { firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES], firstPartyMcpPermissions: [] },
      ),
    ).toEqual([]);
  });

  test("minimal configured sessions keep context and own runtime operations only", () => {
    const agentConfig = config({ from: "none" });
    expect(proxyTools(agentConfig)).toEqual(
      expect.arrayContaining([
        "set_session_title",
        "wait_for_input",
        "command_read",
        "command_wait",
      ]),
    );
    expect(() => checkPath(agentConfig, "")).not.toThrow();
    expect(() => checkPath(agentConfig, `/sessions/${sessionId}`)).not.toThrow();
    expect(() => checkPath(agentConfig, `/sessions/${sessionId}`, "PATCH")).not.toThrow();
    expect(() =>
      checkPath(agentConfig, `/sessions/${sessionId}/background-commands`),
    ).not.toThrow();
    expectForbidden(() => checkPath(agentConfig, `/sessions/${sessionId}/goal`, "PATCH"));
    expectForbidden(() => checkPath(agentConfig, `/sessions/${sessionId}/browser`, "POST"));
    expectForbidden(() => checkPath(agentConfig, "/capabilities"));
    expect(() => checkPath(agentConfig, "/skills")).not.toThrow();
    expectForbidden(() => checkPath(agentConfig, "/skills", "POST"));
    const runtimeOnly = config({ from: "none", skills: false, humanInput: false });
    expectForbidden(() => checkPath(runtimeOnly, "/skills"));
    expectForbidden(() => checkPath(runtimeOnly, `/sessions/${sessionId}/human-input-requests`));
    expectForbidden(() => checkPath(agentConfig, "/unknown-surface"));
  });

  test("enabled families keep their own operations without admitting peer-session access", () => {
    const agentConfig = config({ from: "none", goals: true, browser: true });
    expect(() => checkPath(agentConfig, `/sessions/${sessionId}/goal`, "PATCH")).not.toThrow();
    expect(() => checkPath(agentConfig, "/browser-sessions", "POST")).not.toThrow();
    expect(() => checkPath(agentConfig, "/computer-sessions", "POST")).not.toThrow();
    expectForbidden(() =>
      checkPath(agentConfig, "/sessions/00000000-0000-4000-8000-000000000002/goal", "PATCH"),
    );
    expect(() => checkPath(config("all"), "/sessions", "POST")).not.toThrow();
  });

  test("null config preserves the exact old credential settings and route behavior", () => {
    expect(configuredCodemodeSessionProxyTools(settings, { agent: null })).toBeNull();
    for (const path of ["/sessions", "/sessions/other/control", "/unknown-surface"]) {
      expect(() => checkPath(null, path, "POST")).not.toThrow();
    }
  });
});
