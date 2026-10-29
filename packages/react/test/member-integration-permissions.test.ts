import { describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/sdk";
import {
  canAddWorkspaceIntegrations,
  canConnectWorkspaceMcpFromChat,
} from "../src/app/lib/permissions";
import type { AccessContext } from "../src/app/types";
import { canFinishPreparedMcpSetup } from "../src/in-chat-connect-model";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function context(permissions: string[]): AccessContext {
  return {
    workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions }],
  } as unknown as AccessContext;
}

const member = ["workspace:read", "sessions:create", "connections:read", "connections:write"];

describe("what a member may add, as the API decides", () => {
  test("members add integrations; read-only and narrow grants do not", () => {
    expect(canAddWorkspaceIntegrations(context(member), WORKSPACE_ID)).toBe(true);
    expect(canAddWorkspaceIntegrations(context(["capabilities:manage"]), WORKSPACE_ID)).toBe(true);
    expect(canAddWorkspaceIntegrations(context(["workspace:admin"]), WORKSPACE_ID)).toBe(true);
    for (const permissions of [["connections:read"], ["connections:personal"], []])
      expect(canAddWorkspaceIntegrations(context(permissions), WORKSPACE_ID)).toBe(false);
    expect(canAddWorkspaceIntegrations(null, WORKSPACE_ID)).toBe(false);
    expect(canAddWorkspaceIntegrations(context(member), "another-workspace")).toBe(false);
  });

  test("the chat card connects a workspace-owned OAuth MCP account for members", () => {
    expect(canConnectWorkspaceMcpFromChat(context(member), WORKSPACE_ID)).toBe(true);
    expect(canConnectWorkspaceMcpFromChat(context(["workspace:admin"]), WORKSPACE_ID)).toBe(true);
    expect(
      canConnectWorkspaceMcpFromChat(
        context(["connections:read", "connections:personal"]),
        WORKSPACE_ID,
      ),
    ).toBe(false);
  });

  test("a member finishes an agent-prepared MCP key setup", () => {
    const ready = (permissions: Permission[]) =>
      ({ status: "ready", permissions: new Set(permissions), catalog: new Map() }) as const;
    expect(canFinishPreparedMcpSetup(ready(member as Permission[]))).toBe(true);
    expect(canFinishPreparedMcpSetup(ready(["connections:read", "connections:personal"]))).toBe(
      false,
    );
    expect(canFinishPreparedMcpSetup({ status: "loading" } as never)).toBe(false);
  });
});
