import { describe, expect, test } from "bun:test";
import {
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
  type Permission,
} from "@opengeni/contracts";

import { lastUsedOrganizationId } from "@/routes/connect-agent";
import { ORGANIZATION_PERMISSION_GROUPS, connectedAgentDefaultPolicy } from "./organization-access";

describe("connected agent sign-in defaults", () => {
  test("starts with Read only plus exactly the everyday-work set", () => {
    const policy = connectedAgentDefaultPolicy();
    expect(policy.preset).toBe("custom");
    expect(policy.workspaceScope).toEqual({ kind: "all" });
    const readOnly = new Set<string>(organizationAccessPresetPermissions("read_only"));
    expect(
      (policy.permissions as string[]).filter((permission) => !readOnly.has(permission)).sort(),
    ).toEqual(
      [
        "artifacts:publish",
        "documents:manage",
        "files:upload",
        "files:write",
        "github:use",
        "goals:manage",
        "rigs:use",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
        "secrets:use",
        "sessions:control",
        "sessions:create",
        "stream:acknowledge",
        "stream:control",
      ].filter((permission) => !readOnly.has(permission)),
    );
    for (const permission of [
      "secrets:read",
      "secrets:write",
      "connections:write",
      "capabilities:manage",
      "github:manage",
      "enrollments:manage",
      "rigs:manage",
      "terminal:attach",
      "codemode:call",
      "mcp_servers:attach",
      "workspace:admin",
      "agents:read",
      "billing:manage",
      "members:manage",
      "api_keys:manage",
      "account:admin",
      "billing:manage",
      "usage_allowances:manage",
    ])
      expect(policy.permissions).not.toContain(permission as Permission);
    // The server keeps it as given: a valid Custom set, nothing added.
    const normalized = normalizeOrganizationAccessPolicy(
      policy as Parameters<typeof normalizeOrganizationAccessPolicy>[0],
    );
    expect([...normalized.permissions].sort() as string[]).toEqual(
      [...policy.permissions].sort() as string[],
    );
  });

  test("nothing beyond the person's own access starts checked", () => {
    const policy = connectedAgentDefaultPolicy(new Set(["sessions:read", "artifacts:read"]));
    expect(policy.permissions.sort()).toEqual(["artifacts:read", "sessions:read"]);
  });

  test("app data has its own group in the permission list", () => {
    const apps = ORGANIZATION_PERMISSION_GROUPS.find(
      (group) => group.label === "Apps and artifacts",
    );
    expect(apps?.permissions).toEqual(["artifacts:read", "artifacts:publish"]);
  });

  test("picks the organization of the workspace last used, else none", () => {
    const request = {
      organizations: [
        { id: "personal", workspaces: [{ id: "w-personal" }] },
        { id: "team", workspaces: [{ id: "w-team" }] },
      ],
    } as unknown as Parameters<typeof lastUsedOrganizationId>[0];
    expect(lastUsedOrganizationId(request, "w-team")).toBe("team");
    expect(lastUsedOrganizationId(request, "gone")).toBeNull();
    expect(lastUsedOrganizationId(request, null)).toBeNull();
  });
});
