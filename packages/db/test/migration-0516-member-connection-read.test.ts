import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0516-member-connection-read");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0516 requires real PostgreSQL");
    return;
  }
  owner = postgres(owned.ownerUrl, { max: 1, prepare: false });
  await owner`create table schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  await owner`insert into schema_migrations (name)
    values ('0516_member_connection_read.sql')`;
  await migrate(owned.ownerUrl);
}, 900_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await owned?.release();
}, 180_000);

test("migration is forward-only and guards both function rewrites and the exact member backfill", () => {
  const source = readFileSync(
    new URL("../drizzle/0516_member_connection_read.sql", import.meta.url),
    "utf8",
  );
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("WHERE role = 'member' AND permissions = old_permissions;");
  expect(source).toContain(
    "IF opengeni_private.workspace_member_role_permissions('member') IS DISTINCT FROM old_permissions",
  );
  expect(source).toContain("member grant function source contract changed before 0516");
  expect(source).toContain(
    "default_member_permissions jsonb := opengeni_private.workspace_member_role_permissions(''member'');",
  );
  expect(source).not.toContain("connections:write");
  expect(source).not.toContain("workspace:admin");

  const roleSource = readFileSync(
    new URL("../drizzle/0350_organization_shared_workspace_administration.sql", import.meta.url),
    "utf8",
  );
  const invitationSource = readFileSync(
    new URL("../drizzle/0314_unregistered_organization_invitations.sql", import.meta.url),
    "utf8",
  );
  const roleFragment = source.match(/old_role_fragment text := '([^']+)';/)?.[1];
  const invitationFragment = source
    .match(/old_invitation_fragment text := '((?:''|[^'])*)';/)?.[1]
    ?.replaceAll("''", "'");
  expect(roleFragment).toBeDefined();
  expect(invitationFragment).toBeDefined();
  expect(roleSource.split(roleFragment!)).toHaveLength(2);
  expect(invitationSource.split(invitationFragment!)).toHaveLength(2);
});

test("backfills only exact named member presets and changes future member and invitation defaults", async () => {
  if (!owner || !owned) return;
  const [oldPreset] = await owner<{ permissions: string[] }[]>`
    select opengeni_private.workspace_member_role_permissions('member') as permissions`;
  expect(oldPreset!.permissions).not.toContain("connections:read");

  const [account] = await owner<{ id: string }[]>`
    insert into managed_accounts (name) values ('Member connection rollout') returning id`;
  const [workspace] = await owner<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Shared') returning id`;
  const oldDate = "2025-01-01T00:00:00.000Z";
  const fixtures = [
    { subject: "named-member", role: "member", permissions: oldPreset!.permissions },
    { subject: "custom-member", role: "member", permissions: ["workspace:read"] },
    { subject: "custom-role", role: "custom", permissions: oldPreset!.permissions },
    {
      subject: "already-extended-member",
      role: "member",
      permissions: [...oldPreset!.permissions, "connections:read"],
    },
    { subject: "named-admin", role: "admin", permissions: ["workspace:admin"] },
  ];
  for (const fixture of fixtures) {
    await owner`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions, updated_at
      ) values (
        ${account!.id}, ${workspace!.id}, ${fixture.subject}, ${fixture.role},
        ${owner.json(fixture.permissions)}::jsonb, ${oldDate}::timestamptz
      )`;
  }

  const [before] = await owner<
    {
      role: string;
      owner: string;
      securityDefiner: boolean;
      configuration: string[] | null;
      acl: string[] | null;
    }[]
  >`
    select p.proowner::regrole::text as owner, p.prosecdef as "securityDefiner",
      p.proconfig as configuration, p.proacl::text[] as acl, 'invitation'::text as role
    from pg_proc p where p.oid = 'accept_organization_invitation_v2(jsonb)'::regprocedure`;
  await owner`delete from schema_migrations where name = '0516_member_connection_read.sql'`;
  await migrate(owned.ownerUrl);

  const [after] = await owner<(typeof before)[]>`
    select p.proowner::regrole::text as owner, p.prosecdef as "securityDefiner",
      p.proconfig as configuration, p.proacl::text[] as acl, 'invitation'::text as role
    from pg_proc p where p.oid = 'accept_organization_invitation_v2(jsonb)'::regprocedure`;
  expect(after).toEqual(before);
  const [newPreset] = await owner<{ permissions: string[] }[]>`
    select opengeni_private.workspace_member_role_permissions('member') as permissions`;
  expect(newPreset!.permissions).toEqual([
    ...oldPreset!.permissions.slice(0, 11),
    "connections:read",
    ...oldPreset!.permissions.slice(11),
  ]);
  expect(newPreset!.permissions).not.toContain("connections:write");
  expect(newPreset!.permissions).not.toContain("workspace:admin");
  const rows = await owner<
    Array<{
      subject: string;
      role: string;
      permissions: string[];
      updatedAt: string;
      projectedRole: string;
    }>
  >`
    select subject_id as subject, role, permissions,
      updated_at::text as "updatedAt",
      opengeni_private.workspace_member_role(role, permissions) as "projectedRole"
    from workspace_memberships where workspace_id = ${workspace!.id}`;
  for (const fixture of fixtures) {
    const result = rows.find((row) => row.subject === fixture.subject)!;
    expect(result.role).toBe(fixture.role);
    expect(result.permissions).toEqual(
      fixture.subject === "named-member"
        ? [...fixture.permissions, "connections:read"]
        : fixture.permissions,
    );
    expect(new Date(result.updatedAt).toISOString() === oldDate).toBe(
      fixture.subject !== "named-member",
    );
  }
  expect(rows.find((row) => row.subject === "named-member")!.projectedRole).toBe("member");
  expect(rows.find((row) => row.subject === "custom-member")!.projectedRole).toBe("custom");
  const [invitation] = await owner<{ definition: string }[]>`
    select pg_get_functiondef('accept_organization_invitation_v2(jsonb)'::regprocedure)
      as definition`;
  expect(invitation!.definition).toContain(
    "default_member_permissions jsonb := opengeni_private.workspace_member_role_permissions('member');",
  );
});
