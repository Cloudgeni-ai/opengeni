import { describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/sdk";
import {
  canAddWorkspaceIntegrations,
  canChangeWorkspaceIntegrations,
  canConnectWorkspaceMcpFromChat,
  canManageWorkspaceIntegrations,
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

  test("members add only when the organization lets them, remove either way, and never change", () => {
    expect(canAddWorkspaceIntegrations(context(member), WORKSPACE_ID, "admins")).toBe(false);
    expect(canAddWorkspaceIntegrations(context(member), WORKSPACE_ID, "members")).toBe(true);
    expect(canAddWorkspaceIntegrations(context(["workspace:admin"]), WORKSPACE_ID, "admins")).toBe(
      true,
    );
    expect(canManageWorkspaceIntegrations(context(member), WORKSPACE_ID)).toBe(true);
    expect(canManageWorkspaceIntegrations(context(["connections:personal"]), WORKSPACE_ID)).toBe(
      false,
    );
    expect(canChangeWorkspaceIntegrations(context(member), WORKSPACE_ID)).toBe(false);
    expect(canChangeWorkspaceIntegrations(context(["capabilities:manage"]), WORKSPACE_ID)).toBe(
      true,
    );
    expect(canChangeWorkspaceIntegrations(context(["workspace:admin"]), WORKSPACE_ID)).toBe(true);
  });

  test("the chat card connects a workspace-owned OAuth MCP account for members", () => {
    const off = { enabled: false };
    const on = { enabled: true };
    expect(canConnectWorkspaceMcpFromChat(context(member), WORKSPACE_ID, off)).toBe(true);
    expect(canConnectWorkspaceMcpFromChat(context(member), WORKSPACE_ID, undefined)).toBe(true);
    expect(canConnectWorkspaceMcpFromChat(context(["workspace:admin"]), WORKSPACE_ID, off)).toBe(
      true,
    );
    expect(
      canConnectWorkspaceMcpFromChat(
        context(["connections:read", "connections:personal"]),
        WORKSPACE_ID,
        off,
      ),
    ).toBe(false);
    // A member's setup never changes a server that is already on, so a new
    // shared account for it would go unused; admins can still replace it.
    expect(canConnectWorkspaceMcpFromChat(context(member), WORKSPACE_ID, on)).toBe(false);
    expect(canConnectWorkspaceMcpFromChat(context(["workspace:admin"]), WORKSPACE_ID, on)).toBe(
      true,
    );
    expect(canConnectWorkspaceMcpFromChat(context(member), WORKSPACE_ID, off, "admins")).toBe(
      false,
    );
    expect(
      canConnectWorkspaceMcpFromChat(context(["workspace:admin"]), WORKSPACE_ID, off, "admins"),
    ).toBe(true);
  });

  test("a member finishes an agent-prepared MCP key setup", () => {
    const ready = (permissions: Permission[]) =>
      ({ status: "ready", permissions: new Set(permissions), catalog: new Map() }) as const;
    expect(canFinishPreparedMcpSetup(ready(member as Permission[]))).toBe(true);
    expect(canFinishPreparedMcpSetup(ready(["connections:read", "connections:personal"]))).toBe(
      false,
    );
    expect(canFinishPreparedMcpSetup({ status: "loading" } as never)).toBe(false);
    const keptForAdmins = (permissions: Permission[]) =>
      ({ ...ready(permissions), memberIntegrationSetup: "admins" }) as const;
    expect(canFinishPreparedMcpSetup(keptForAdmins(member as Permission[]))).toBe(false);
    expect(canFinishPreparedMcpSetup(keptForAdmins(["workspace:admin"]))).toBe(true);
  });
});
