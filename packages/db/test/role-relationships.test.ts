import { describe, expect, test } from "bun:test";
import {
  classifyRoleRelationships,
  type RoleRelationshipCatalogRow,
} from "../src/role-relationships";

function relationship(
  overrides: Partial<RoleRelationshipCatalogRow> = {},
): RoleRelationshipCatalogRow {
  return {
    relationship: "member:managed_admin",
    direction: "member",
    server_version_num: 170000,
    admin_option: true,
    inherit_option: false,
    set_option: false,
    member_is_superuser: false,
    member_can_create_role: true,
    grantor_role: "postgres",
    grantor_is_superuser: true,
    ...overrides,
  };
}

describe("PostgreSQL role relationship classification", () => {
  test("accepts only the exact PostgreSQL 16+ creator-management edge", () => {
    expect(classifyRoleRelationships([relationship()])).toEqual({
      relationships: ["member:managed_admin"],
      managementOnlyRelationships: ["member:managed_admin"],
      unsafeRelationships: [],
    });
  });

  test("keeps PostgreSQL 15 and uncertain grantors fail-closed", () => {
    const result = classifyRoleRelationships([
      relationship({ server_version_num: 150000, inherit_option: null, set_option: null }),
      relationship({ relationship: "member:unknown_grantor", grantor_is_superuser: null }),
    ]);

    expect(result.managementOnlyRelationships).toEqual([]);
    expect(result.unsafeRelationships).toEqual(["member:managed_admin", "member:unknown_grantor"]);
  });

  test("rejects privilege-bearing reverse grants and every outbound relationship", () => {
    const result = classifyRoleRelationships([
      relationship({ relationship: "member:can_set", set_option: true }),
      relationship({ relationship: "member:can_inherit", inherit_option: true }),
      relationship({ relationship: "member:no_admin", admin_option: false }),
      relationship({ relationship: "member:not_creator", member_can_create_role: false }),
      relationship({ relationship: "member:superuser", member_is_superuser: true }),
      relationship({
        relationship: "inherits:database_admin",
        direction: "inherits",
        admin_option: null,
        inherit_option: null,
        set_option: null,
        member_is_superuser: null,
        member_can_create_role: null,
        grantor_role: null,
        grantor_is_superuser: null,
      }),
    ]);

    expect(result.managementOnlyRelationships).toEqual([]);
    expect(result.unsafeRelationships).toEqual([
      "inherits:database_admin",
      "member:can_inherit",
      "member:can_set",
      "member:no_admin",
      "member:not_creator",
      "member:superuser",
    ]);
  });
});
