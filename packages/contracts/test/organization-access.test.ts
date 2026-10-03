import { describe, expect, test } from "bun:test";
import {
  OrganizationAccessPolicy,
  OrganizationAccessPreset,
  OrganizationActor,
  OrganizationWorkspaceScope,
  Permission,
  isReadOnlyPermissionSet,
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
} from "../src";

const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("organization access policy", () => {
  test("exports the stable presets and actors", () => {
    expect(OrganizationAccessPreset.options).toEqual(["read_only", "full", "custom"]);
    expect(OrganizationActor.options).toEqual(["user", "organization"]);
  });

  test("read-only includes every read/list/view/search scope except secret values", () => {
    const permissions = organizationAccessPresetPermissions("read_only");
    expect(permissions).toEqual(
      Permission.options.filter(
        (permission) =>
          /:(read|list|view|search)$/.test(permission) &&
          permission !== "secrets:read" &&
          permission !== "variable-sets:read",
      ),
    );
    for (const permission of [
      "account:read",
      "stream:view",
      "documents:search",
      "secrets:list",
      "billing:read",
    ] as const)
      expect(permissions).toContain(permission);
    expect(permissions).not.toContain("secrets:read");
    expect(permissions).not.toContain("variable-sets:read");
    // Reading secret values changes nothing, so Custom can add it and stay read-only.
    expect(isReadOnlyPermissionSet([...permissions, "secrets:read", "variable-sets:read"])).toBe(
      true,
    );
    expect(isReadOnlyPermissionSet(permissions)).toBe(true);
    expect(isReadOnlyPermissionSet([])).toBe(true);
    expect(isReadOnlyPermissionSet(["sessions:read"])).toBe(true);
    expect(isReadOnlyPermissionSet(["sessions:control"])).toBe(false);
    expect(isReadOnlyPermissionSet(["environments:use"])).toBe(false);
  });

  test("full contains every nondeprecated scope and custom is never implicitly expanded", () => {
    expect(organizationAccessPresetPermissions("full")).toEqual(
      Permission.options.filter((p) => !p.startsWith("environments:")),
    );
    expect(organizationAccessPresetPermissions("custom")).toEqual([]);
    const permissions = organizationAccessPresetPermissions("full");
    permissions.pop();
    expect(organizationAccessPresetPermissions("full").length).toBe(Permission.options.length - 2);
  });

  test("normalization maps aliases, deduplicates, orders and recomputes preset without granting", () => {
    const input = {
      preset: "full" as const,
      permissions: [
        "environments:use",
        "sessions:read",
        "variable-sets:use",
        "sessions:read",
      ] as const,
      workspaceScope: { kind: "selected" as const, workspaceIds: [second, first] },
    };
    const policy = normalizeOrganizationAccessPolicy({
      ...input,
      permissions: [...input.permissions],
    });
    expect(policy).toEqual({
      preset: "custom",
      permissions: ["sessions:read", "variable-sets:use"],
      workspaceScope: { kind: "selected", workspaceIds: [first, second] },
    });
    expect(input.workspaceScope.workspaceIds).toEqual([second, first]);
    expect(OrganizationAccessPolicy.parse(policy)).toEqual(policy);
    for (const preset of ["read_only", "full"] as const) {
      expect(
        normalizeOrganizationAccessPolicy({
          preset: "custom",
          permissions: organizationAccessPresetPermissions(preset),
          workspaceScope: { kind: "all" },
        }).preset,
      ).toBe(preset);
    }
    expect(
      normalizeOrganizationAccessPolicy({
        preset: "read_only",
        permissions: ["files:write"],
        workspaceScope: { kind: "all" },
      }).preset,
    ).toBe("custom");
  });

  test("selected scope validates unique normalized UUIDs, up to 500; empty reaches nothing", () => {
    expect(
      OrganizationWorkspaceScope.safeParse({ kind: "selected", workspaceIds: [] }).success,
    ).toBe(true);
    expect(
      OrganizationWorkspaceScope.safeParse({
        kind: "selected",
        workspaceIds: [first, first.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(
      OrganizationWorkspaceScope.safeParse({ kind: "selected", workspaceIds: ["other"] }).success,
    ).toBe(false);
    expect(
      OrganizationWorkspaceScope.safeParse({ kind: "all", workspaceIds: [first] }).success,
    ).toBe(false);
    expect(
      OrganizationWorkspaceScope.safeParse({
        kind: "selected",
        workspaceIds: Array.from({ length: 501 }, () => crypto.randomUUID()),
      }).success,
    ).toBe(false);
    expect(
      OrganizationWorkspaceScope.parse({ kind: "selected", workspaceIds: [first.toUpperCase()] }),
    ).toEqual({ kind: "selected", workspaceIds: [first] });
  });

  test("permissions are required even when the caller chooses a preset", () => {
    expect(
      OrganizationAccessPolicy.safeParse({ preset: "full", workspaceScope: { kind: "all" } })
        .success,
    ).toBe(false);
    expect(
      OrganizationAccessPolicy.safeParse({
        preset: "custom",
        permissions: ["unknown:read"],
        workspaceScope: { kind: "all" },
      }).success,
    ).toBe(false);
  });
});
