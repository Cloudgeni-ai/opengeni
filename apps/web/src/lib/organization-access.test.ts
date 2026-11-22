import { describe, expect, test } from "bun:test";
import { normalizeOrganizationAccessPolicy, type Permission } from "@opengeni/contracts";

import { lastUsedOrganizationId } from "@/routes/connect-agent";
import { ORGANIZATION_PERMISSION_GROUPS, connectedAgentDefaultPolicy } from "./organization-access";

describe("connected agent sign-in defaults", () => {
  test("starts with everyday work, never administration, billing or secret values", () => {
    const policy = connectedAgentDefaultPolicy();
    expect(policy.preset).toBe("custom");
    expect(policy.workspaceScope).toEqual({ kind: "all" });
    for (const permission of [
      "sessions:create",
      "files:write",
      "artifacts:read",
      "artifacts:publish",
      "scheduled_tasks:manage",
      "secrets:use",
    ])
      expect(policy.permissions).toContain(permission as Permission);
    for (const permission of [
      "secrets:read",
      "workspace:admin",
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
    const apps = ORGANIZATION_PERMISSION_GROUPS.find((group) => group.label === "Apps");
    expect(apps?.permissions).toEqual(["artifacts:read", "artifacts:publish"]);
  });

  test("picks the organization of the workspace last used, else the last one switched to", () => {
    const request = {
      organizations: [
        { id: "personal", workspaces: [{ id: "w-personal" }] },
        { id: "team", workspaces: [{ id: "w-team" }] },
      ],
    } as unknown as Parameters<typeof lastUsedOrganizationId>[0];
    expect(lastUsedOrganizationId(request, { workspaceId: "w-team", byOrganization: {} })).toBe(
      "team",
    );
    expect(
      lastUsedOrganizationId(request, {
        workspaceId: "gone",
        byOrganization: { personal: "w-personal", team: "w-team", other: "x" },
      }),
    ).toBe("team");
    expect(lastUsedOrganizationId(request, { workspaceId: null, byOrganization: {} })).toBeNull();
  });
});
