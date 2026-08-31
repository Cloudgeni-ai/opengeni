import { describe, expect, test } from "bun:test";

import {
  buildApiKeyPermissionGroups,
  buildWorkspaceMemberPermissionGroups,
  fixedOrganizationApiKeyPermissions,
} from "./permissions";

describe("workspace member permission groups", () => {
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
