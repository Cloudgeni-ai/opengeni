import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  migrate,
  parseBatchedBackfillMigration,
  parseConcurrentIndexMigration,
} from "../src/migrate";

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
    values ('0516_member_connection_read.sql'),
      ('0517_member_connection_read_backfill_index.sql'),
      ('0518_member_connection_read_backfill.sql')`;
  await migrate(owned.ownerUrl);
}, 900_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await owned?.release();
}, 180_000);

test("migration guards function rewrites, normalizes only the old named set, and batches the backfill", () => {
  const source = readFileSync(
    new URL("../drizzle/0516_member_connection_read.sql", import.meta.url),
    "utf8",
  );
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("NEW.permissions @> old_permissions");
  expect(source).toContain("old_permissions @> NEW.permissions");
  expect(source).toContain("BEFORE INSERT OR UPDATE ON workspace_memberships");
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516() FROM PUBLIC",
  );
  expect(source).toContain(
    "IF opengeni_private.workspace_member_role_permissions('member') IS DISTINCT FROM old_permissions",
  );
  expect(source).toContain("member grant function source contract changed before 0516");
  expect(source).toContain(
    "default_member_permissions jsonb := opengeni_private.workspace_member_role_permissions(''member'');",
  );
  expect(source).not.toContain("connections:write");
  expect(source).not.toContain("workspace:admin");

  const index = readFileSync(
    new URL("../drizzle/0517_member_connection_read_backfill_index.sql", import.meta.url),
    "utf8",
  );
  expect(
    parseConcurrentIndexMigration("0517_member_connection_read_backfill_index.sql", index),
  ).not.toBeNull();
  const backfill = readFileSync(
    new URL("../drizzle/0518_member_connection_read_backfill.sql", import.meta.url),
    "utf8",
  );
  expect(
    parseBatchedBackfillMigration("0518_member_connection_read_backfill.sql", backfill)?.batchSize,
  ).toBe(500);
  expect(backfill).toContain("membership.permissions @> '[");
  expect(backfill).toContain("]'::jsonb @> membership.permissions");

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

test("backfills reordered named members, preserves custom grants, protects old writers, and replays safely", async () => {
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
    {
      subject: "reordered-member",
      role: "member",
      permissions: [...oldPreset!.permissions].reverse(),
    },
    { subject: "custom-member", role: "member", permissions: ["workspace:read"] },
    { subject: "custom-role", role: "custom", permissions: oldPreset!.permissions },
    { subject: "admin-with-old-set", role: "admin", permissions: oldPreset!.permissions },
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
  // More than one runner batch is needed, independently of the fixtures above.
  await owner`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions, updated_at
    )
    select ${account!.id}, ${workspace!.id}, 'batch-member-' || n::text, 'member',
      ${owner.json(oldPreset!.permissions)}::jsonb, ${oldDate}::timestamptz
    from generate_series(1, 501) as n`;

  const before = await owner<
    {
      role: string;
      owner: string;
      securityDefiner: boolean;
      configuration: string[] | null;
      acl: string[] | null;
    }[]
  >`
    select p.proowner::regrole::text as owner, p.prosecdef as "securityDefiner",
      p.proconfig as configuration, p.proacl::text[] as acl, p.proname::text as role
    from pg_proc p where p.oid in (
      'accept_organization_invitation_v2(jsonb)'::regprocedure,
      'opengeni_private.workspace_member_role_permissions(text)'::regprocedure
    ) order by p.proname`;
  await owner`delete from schema_migrations where name in (
    '0516_member_connection_read.sql',
    '0517_member_connection_read_backfill_index.sql',
    '0518_member_connection_read_backfill.sql'
  )`;
  await migrate(owned.ownerUrl);

  const after = await owner<(typeof before)[number][]>`
    select p.proowner::regrole::text as owner, p.prosecdef as "securityDefiner",
      p.proconfig as configuration, p.proacl::text[] as acl, p.proname::text as role
    from pg_proc p where p.oid in (
      'accept_organization_invitation_v2(jsonb)'::regprocedure,
      'opengeni_private.workspace_member_role_permissions(text)'::regprocedure
    ) order by p.proname`;
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
    from workspace_memberships where workspace_id = ${workspace!.id}
    order by subject_id`;
  for (const fixture of fixtures) {
    const result = rows.find((row) => row.subject === fixture.subject)!;
    expect(result.role).toBe(fixture.role);
    expect(result.permissions).toEqual(
      fixture.subject === "named-member" || fixture.subject === "reordered-member"
        ? [...fixture.permissions, "connections:read"]
        : fixture.permissions,
    );
    expect(new Date(result.updatedAt).toISOString() === oldDate).toBe(
      fixture.subject !== "named-member" && fixture.subject !== "reordered-member",
    );
  }
  expect(rows.find((row) => row.subject === "named-member")!.projectedRole).toBe("member");
  // The classifier compares the updated named set, not the pre-migration one.
  expect(rows.find((row) => row.subject === "already-extended-member")!.projectedRole).toBe(
    "member",
  );
  expect(rows.find((row) => row.subject === "reordered-member")!.projectedRole).toBe("member");
  expect(rows.find((row) => row.subject === "custom-member")!.projectedRole).toBe("custom");
  expect(
    rows.filter(
      (row) =>
        row.subject.startsWith("batch-member-") &&
        row.projectedRole === "member" &&
        row.permissions.includes("connections:read"),
    ),
  ).toHaveLength(501);
  const [invitation] = await owner<{ definition: string }[]>`
    select pg_get_functiondef('accept_organization_invitation_v2(jsonb)'::regprocedure)
      as definition`;
  expect(invitation!.definition).toContain(
    "default_member_permissions jsonb := opengeni_private.workspace_member_role_permissions('member');",
  );

  // A still-running old client writes the old grant after the backfill is done.
  await owner`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${account!.id}, ${workspace!.id}, 'old-writer-insert', 'member',
      ${owner.json([...oldPreset!.permissions].reverse())}::jsonb)`;
  await owner`
    update workspace_memberships
    set permissions = ${owner.json(oldPreset!.permissions)}::jsonb
    where workspace_id = ${workspace!.id} and subject_id = 'named-member'`;
  await owner`
    update workspace_memberships
    set permissions = ${owner.json(oldPreset!.permissions)}::jsonb
    where workspace_id = ${workspace!.id} and subject_id = 'custom-role'`;
  const afterOldWriter = await owner<
    { subject: string; permissions: string[]; projectedRole: string }[]
  >`
    select subject_id as subject, permissions,
      opengeni_private.workspace_member_role(role, permissions) as "projectedRole"
    from workspace_memberships where workspace_id = ${workspace!.id}
    order by subject_id`;
  for (const subject of ["old-writer-insert", "named-member"]) {
    const result = afterOldWriter.find((row) => row.subject === subject)!;
    expect(result.permissions).toContain("connections:read");
    expect(result.projectedRole).toBe("member");
  }
  expect(afterOldWriter.find((row) => row.subject === "custom-role")!.permissions).not.toContain(
    "connections:read",
  );
  expect(afterOldWriter.find((row) => row.subject === "custom-member")!.permissions).toEqual([
    "workspace:read",
  ]);

  // An interrupted runner can re-enter the committed, already-drained backfill.
  await owner`delete from schema_migrations where name = '0518_member_connection_read_backfill.sql'`;
  await migrate(owned.ownerUrl);
  const replayed = await owner<{ subject: string; permissions: string[] }[]>`
    select subject_id as subject, permissions
    from workspace_memberships where workspace_id = ${workspace!.id}
    order by subject_id`;
  expect(replayed.map(({ subject, permissions }) => ({ subject, permissions }))).toEqual(
    afterOldWriter.map(({ subject, permissions }) => ({ subject, permissions })),
  );
});
