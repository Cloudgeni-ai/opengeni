import { describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/contracts";
import { managedPersonalWorkspacePermissions } from "../src/index";

describe("managedPersonalWorkspacePermissions", () => {
  test("lets the owner view and take over their own live sessions", () => {
    const live: Permission[] = [
      "stream:view",
      "stream:control",
      "stream:acknowledge",
      "terminal:attach",
      "files:write",
    ];
    for (const permission of live) {
      expect(managedPersonalWorkspacePermissions).toContain(permission);
    }
  });

  test("still grants no delegation that could create another principal", () => {
    const delegation: Permission[] = ["workspace:admin", "members:manage", "api_keys:manage"];
    for (const permission of delegation) {
      expect(managedPersonalWorkspacePermissions).not.toContain(permission);
    }
  });
});
