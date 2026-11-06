import { describe, expect, test } from "bun:test";

import {
  WORKSPACE_ADMIN_ROLE_PERMISSIONS,
  WORKSPACE_OWNER_PERMISSIONS,
  workspaceAdminDelegates,
  workspaceKeyCreator,
  workspaceKeyCreatorSentence,
} from "../src/api-key-delegation";

describe("who can create a workspace API key", () => {
  test("a Workspace admin delegates everything but reading secret values and organization powers", () => {
    const admin = (permission: string) =>
      workspaceAdminDelegates(WORKSPACE_ADMIN_ROLE_PERMISSIONS, ["account:read"], permission);
    expect(admin("members:manage")).toBe(true);
    expect(admin("api_keys:manage")).toBe(true);
    expect(admin("terminal:attach")).toBe(true);
    expect(admin("secrets:read")).toBe(false);
    expect(admin("billing:read")).toBe(false);
  });

  test("names the least workspace role that can create it", () => {
    expect(workspaceKeyCreator(["sessions:read", "members:manage"])).toBe("workspace_admin");
    expect(workspaceKeyCreator(["sessions:read", "secrets:read"])).toBe("workspace_owner");
    expect(workspaceKeyCreator(["billing:manage"])).toBeNull();
  });

  test("says it in one sentence", () => {
    expect(workspaceKeyCreatorSentence(["api_keys:manage"])).toBe(
      "A workspace admin can create it.",
    );
    expect(workspaceKeyCreatorSentence(["members:manage", "secrets:read"])).toBe(
      "Only a workspace owner can create a key that reads secret values.",
    );
    expect(workspaceKeyCreatorSentence(["account:admin"])).toBeNull();
  });

  test("a Workspace owner holds every workspace-literal power", () => {
    expect(WORKSPACE_OWNER_PERMISSIONS).toContain("members:manage");
    expect(WORKSPACE_OWNER_PERMISSIONS).toContain("secrets:read");
    expect(WORKSPACE_ADMIN_ROLE_PERMISSIONS).not.toContain("secrets:read");
  });
});
