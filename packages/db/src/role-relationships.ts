export type RoleRelationshipDirection = "inherits" | "member";

export type RoleRelationshipCatalogRow = {
  relationship: string;
  direction: RoleRelationshipDirection;
  server_version_num: number;
  admin_option: boolean | null;
  inherit_option: boolean | null;
  set_option: boolean | null;
  member_is_superuser: boolean | null;
  member_can_create_role: boolean | null;
  grantor_role: string | null;
  grantor_is_superuser: boolean | null;
};

export type ClassifiedRoleRelationships = {
  relationships: string[];
  managementOnlyRelationships: string[];
  unsafeRelationships: string[];
};

type RoleTargetExpression = "current_user" | "$1";

/**
 * One PostgreSQL 15-compatible catalog query for both provisioning and runtime
 * posture. PostgreSQL 16 added per-membership INHERIT and SET columns; reading
 * the catalog row through to_jsonb keeps this statement parseable on 15 while
 * leaving the missing options null and therefore fail-closed.
 */
export function roleRelationshipsCatalogQuery(targetRole: RoleTargetExpression): string {
  return `
with recursive target_role(oid, rolname) as (
  select oid, rolname
  from pg_roles
  where rolname = ${targetRole}
), inherited_roles(oid, rolname) as (
  select parent.oid, parent.rolname
  from pg_auth_members membership
  join target_role target on target.oid = membership.member
  join pg_roles parent on parent.oid = membership.roleid
  union
  select parent.oid, parent.rolname
  from inherited_roles inherited
  join pg_auth_members membership on membership.member = inherited.oid
  join pg_roles parent on parent.oid = membership.roleid
), relationships as (
  select
    ('inherits:' || inherited.rolname)::text as relationship,
    'inherits'::text as direction,
    null::boolean as admin_option,
    null::boolean as inherit_option,
    null::boolean as set_option,
    null::boolean as member_is_superuser,
    null::boolean as member_can_create_role,
    null::text as grantor_role,
    null::boolean as grantor_is_superuser
  from inherited_roles inherited
  union all
  select
    ('member:' || member.rolname)::text as relationship,
    'member'::text as direction,
    membership.admin_option,
    case
      when current_setting('server_version_num')::integer >= 160000
        then (to_jsonb(membership) ->> 'inherit_option')::boolean
      else null::boolean
    end as inherit_option,
    case
      when current_setting('server_version_num')::integer >= 160000
        then (to_jsonb(membership) ->> 'set_option')::boolean
      else null::boolean
    end as set_option,
    member.rolsuper as member_is_superuser,
    member.rolcreaterole as member_can_create_role,
    grantor.rolname::text as grantor_role,
    grantor.rolsuper as grantor_is_superuser
  from pg_auth_members membership
  join target_role target on target.oid = membership.roleid
  join pg_roles member on member.oid = membership.member
  left join pg_roles grantor on grantor.oid = membership.grantor
)
select
  relationship,
  direction,
  current_setting('server_version_num')::integer as server_version_num,
  admin_option,
  inherit_option,
  set_option,
  member_is_superuser,
  member_can_create_role,
  grantor_role,
  grantor_is_superuser
from relationships
order by relationship, direction, grantor_role nulls first
`;
}

/**
 * PostgreSQL 16+ automatically gives a non-superuser CREATEROLE principal an
 * ADMIN-only grant on a role it creates. The exact edge below permits role
 * management but cannot inherit the app role's privileges or SET ROLE into it.
 */
export function isManagementOnlyRoleRelationship(row: RoleRelationshipCatalogRow): boolean {
  return (
    row.direction === "member" &&
    row.server_version_num >= 160000 &&
    row.admin_option === true &&
    row.inherit_option === false &&
    row.set_option === false &&
    row.member_is_superuser === false &&
    row.member_can_create_role === true &&
    row.grantor_is_superuser === true
  );
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** Classify exact management-only reverse grants while rejecting every other edge. */
export function classifyRoleRelationships(
  rows: readonly RoleRelationshipCatalogRow[],
): ClassifiedRoleRelationships {
  const managementOnlyRows = rows.filter(isManagementOnlyRoleRelationship);
  const unsafeRows = rows.filter((row) => !isManagementOnlyRoleRelationship(row));

  return {
    relationships: sortedUnique(rows.map((row) => row.relationship)),
    managementOnlyRelationships: sortedUnique(managementOnlyRows.map((row) => row.relationship)),
    unsafeRelationships: sortedUnique(unsafeRows.map((row) => row.relationship)),
  };
}
