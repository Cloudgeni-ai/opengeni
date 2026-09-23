import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_MCP_TOOL_NAMES,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  codemodeSessionProxyPermissions,
  CODEMODE_SESSION_PROXY_PERMISSION_CEILING,
} from "../src/codemode";
import {
  FIRST_PARTY_TOOL_AUTHORIZATION,
  permissionsRequiredByFirstPartyTools,
} from "../src/mcp/first-party-tool-permissions";

describe("permissionsRequiredByFirstPartyTools", () => {
  test("derives the union of every selected tool's registration permissions", () => {
    expect(permissionsRequiredByFirstPartyTools([])).toEqual([]);
    expect(permissionsRequiredByFirstPartyTools(["set_session_title"])).toEqual([
      "sessions:control",
    ]);
    expect(permissionsRequiredByFirstPartyTools(["sessions_list", "session_get"])).toEqual([
      "sessions:read",
    ]);
    expect(
      permissionsRequiredByFirstPartyTools(["sessions_list", "session_create", "session_steer"]),
    ).toEqual(["sessions:read", "sessions:create", "sessions:control"]);
    // anyOf alternatives both count: either could be the one the session holds.
    expect(permissionsRequiredByFirstPartyTools(["scheduled_tasks_list"])).toEqual([
      "scheduled_tasks:manage",
      "scheduled_tasks:run",
    ]);
  });

  test("covers the complete catalog from the same authorization data as the MCP surface", () => {
    for (const tool of FIRST_PARTY_MCP_TOOL_NAMES) {
      const policy = FIRST_PARTY_TOOL_AUTHORIZATION[tool];
      expect(permissionsRequiredByFirstPartyTools([tool]).sort()).toEqual(
        [...new Set([...(policy.allOf ?? []), ...(policy.anyOf ?? [])])].sort(),
      );
    }
  });
});

describe("codemodeSessionProxyPermissions", () => {
  const settings = testSettings();

  test("a selection without session tools yields only workspace:read", () => {
    // The hole: the proxy used to hand every session the whole four-permission
    // allowlist from its permission set alone, so a session whose model could
    // not see sessions_list/session_create/session_steer still proxied REST
    // list/create/control calls through the SDK.
    for (const tools of [
      [] as FirstPartyMcpToolName[],
      ["memory_search"] as FirstPartyMcpToolName[],
      ["goal_set", "goal_progress"] as FirstPartyMcpToolName[],
    ]) {
      expect(
        codemodeSessionProxyPermissions(settings, {
          firstPartyMcpTools: tools,
          firstPartyMcpPermissions: null,
        }),
      ).toEqual(["workspace:read"]);
    }
  });

  test("session tools admit exactly the permission they register with", () => {
    expect(
      codemodeSessionProxyPermissions(settings, {
        firstPartyMcpTools: ["set_session_title"],
        firstPartyMcpPermissions: null,
      }),
    ).toEqual(["workspace:read", "sessions:control"]);
    expect(
      codemodeSessionProxyPermissions(settings, {
        firstPartyMcpTools: ["sessions_list"],
        firstPartyMcpPermissions: null,
      }),
    ).toEqual(["workspace:read", "sessions:read"]);
    expect(
      codemodeSessionProxyPermissions(settings, {
        firstPartyMcpTools: ["session_create"],
        firstPartyMcpPermissions: null,
      }),
    ).toEqual(["workspace:read", "sessions:create"]);
  });

  test("the session permission set and the fixed ceiling still cap the result", () => {
    expect(DEFAULT_FIRST_PARTY_MCP_PERMISSIONS).toEqual(
      expect.arrayContaining([...CODEMODE_SESSION_PROXY_PERMISSION_CEILING]),
    );
    expect(
      codemodeSessionProxyPermissions(settings, {
        firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
        firstPartyMcpPermissions: null,
      }),
    ).toEqual([...CODEMODE_SESSION_PROXY_PERMISSION_CEILING]);
    expect(
      codemodeSessionProxyPermissions(settings, {
        firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
        firstPartyMcpPermissions: ["sessions:read", "goals:manage"],
      }),
    ).toEqual(["sessions:read"]);
    expect(
      codemodeSessionProxyPermissions(settings, {
        firstPartyMcpTools: ["session_create", "sessions_list"],
        firstPartyMcpPermissions: ["workspace:read", "sessions:control"],
      }),
    ).toEqual(["workspace:read"]);
  });

  test("the deployment ceiling removes a disabled tool before it can admit a permission", () => {
    expect(
      codemodeSessionProxyPermissions(
        testSettings({ allowedFirstPartyMcpTools: ["set_session_title"] }),
        {
          firstPartyMcpTools: ["set_session_title", "sessions_list"],
          firstPartyMcpPermissions: null,
        },
      ),
    ).toEqual(["workspace:read", "sessions:control"]);
  });
});
