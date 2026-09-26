import { describe, expect, test } from "bun:test";

import {
  canManageWorkspaceSettings,
  hasWorkspacePermission,
  buildApiKeyPermissionGroups,
  buildWorkspaceMemberPermissionGroups,
  delegableApiKeyPermissions,
  fixedOrganizationApiKeyPermissions,
  workspaceAccessLevels,
  isWorkspacePermissionDenied,
} from "./permissions";

describe("workspace member permission groups", () => {
  test("members can discover connections without gaining connection administration", () => {
    const member = workspaceAccessLevels.find((level) => level.role === "member")!;
    expect(member.permissions).toContain("connections:read");
    expect(member.permissions).not.toContain("connections:write");
    expect(member.permissions).not.toContain("capabilities:manage");
  });

  test("distinguishes access denial from transient connection failures", () => {
    expect(isWorkspacePermissionDenied({ status: 403 })).toBe(true);
    expect(isWorkspacePermissionDenied({ status: 503 })).toBe(false);
    expect(isWorkspacePermissionDenied(new Error("network unavailable"))).toBe(false);
  });
  test("keeps baseline workspace visibility out of the fine-grained editor", () => {
    const permissions = buildWorkspaceMemberPermissionGroups().flatMap(
      (group) => group.permissions,
    );

    expect(permissions).not.toContain("workspace:read");
    expect(buildWorkspaceMemberPermissionGroups().map((group) => group.label)).not.toContain(
      "Workspace",
    );
    expect(buildApiKeyPermissionGroups().flatMap((group) => group.permissions)).toContain(
      "workspace:read",
    );
  });
});

describe("organization API key delegation", () => {
  test("pins the immutable organization-key permission contract", () => {
    expect(fixedOrganizationApiKeyPermissions).toEqual([
      "account:read",
      "workspace:create",
      "workspace:read",
      "workspace:admin",
      "api_keys:manage",
    ]);
    expect(fixedOrganizationApiKeyPermissions).not.toContain("secrets:read");
  });
});

describe("workspace API key delegation", () => {
  test("workspace admin cannot delegate missing literal organization or workspace powers", () => {
    const delegable = delegableApiKeyPermissions(["workspace:admin", "api_keys:manage"]);
    for (const permission of [
      "account:read",
      "account:admin",
      "workspace:create",
      "billing:read",
      "billing:manage",
      "members:manage",
      "secrets:read",
    ]) {
      expect(delegable.has(permission)).toBe(false);
    }
    expect(delegable.has("files:read")).toBe(true);
  });

  test("only literal grants from the matching authorities enable high-trust permissions", () => {
    const delegable = delegableApiKeyPermissions(
      ["workspace:admin", "members:manage"],
      ["account:read", "billing:manage"],
    );
    expect(delegable.has("members:manage")).toBe(true);
    expect(delegable.has("billing:manage")).toBe(true);
    expect(delegable.has("account:read")).toBe(true);
    expect(delegable.has("account:admin")).toBe(false);
    expect(delegable.has("billing:read")).toBe(false);
    expect(delegable.has("secrets:read")).toBe(false);
  });

  test("a non-admin grant cannot borrow the organization's permissions", () => {
    expect(delegableApiKeyPermissions(["api_keys:manage"], ["billing:manage"])).toEqual(
      new Set(["api_keys:manage"]),
    );
  });
});

describe("Personal workspace settings", () => {
  test("uses the current owner's active membership without expanding admin powers", () => {
    const workspace = { id: "personal", accountId: "org", kind: "personal" as const };
    const context = {
      mode: "managed" as const,
      subjectId: "user:owner",
      defaultAccountId: "org",
      defaultWorkspaceId: "personal",
      accountGrants: [],
      workspaceGrants: [
        {
          workspaceId: "personal",
          accountId: "org",
          subjectId: "user:owner",
          permissions: ["workspace:read"],
        },
      ],
    };
    const self = {
      identity: { credentialGeneration: 1, managedUserId: "owner", subjectId: "user:owner" },
      memberships: [
        {
          id: "membership",
          organizationId: "org",
          status: "active" as const,
          personalWorkspaceId: "personal",
        },
      ],
    };
    expect(canManageWorkspaceSettings(context, workspace, self)).toBe(true);
    for (const permission of ["workspace:admin", "members:manage", "api_keys:manage"]) {
      expect(hasWorkspacePermission(context, workspace.id, permission)).toBe(false);
    }
    expect(canManageWorkspaceSettings(context, workspace, null)).toBe(false);
    expect(canManageWorkspaceSettings(context, workspace, { ...self, memberships: [] })).toBe(
      false,
    );
    expect(
      canManageWorkspaceSettings({ ...context, subjectId: "user:other" }, workspace, self),
    ).toBe(false);
    expect(canManageWorkspaceSettings({ ...context, workspaceGrants: [] }, workspace, self)).toBe(
      false,
    );
    expect(
      canManageWorkspaceSettings(context, { ...workspace, accountId: "other-org" }, self),
    ).toBe(false);
    expect(canManageWorkspaceSettings(context, { ...workspace, kind: "shared" }, self)).toBe(false);
    expect(
      canManageWorkspaceSettings(context, workspace, {
        ...self,
        memberships: [{ ...self.memberships[0]!, personalWorkspaceId: "different-workspace" }],
      }),
    ).toBe(false);
  });
});
