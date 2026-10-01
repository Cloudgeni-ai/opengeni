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
const rollout = [
  "0555_member_collaborator_permissions.sql",
  "0556_member_collaborator_permissions_backfill_index.sql",
  "0557_member_collaborator_permissions_backfill.sql",
] as const;
// Everything a Viewer has that the post-0516 Member lacked, plus the caller's
// own desktop consent and artifact creation/publishing for every member.
const added = [
  "stream:view",
  "stream:acknowledge",
  "rigs:use",
  "artifacts:read",
  "artifacts:publish",
];
// Admin-class or shared-work powers a named Member must never receive.
const withheld = [
  "workspace:admin",
  "members:manage",
  "api_keys:manage",
  "connections:write",
  "github:manage",
  "rigs:manage",
  "enrollments:read",
  "enrollments:manage",
  "variable-sets:manage",
  "terminal:attach",
  "files:write",
  "stream:control",
  "mcp_servers:attach",
  "codemode:call",
  "secrets:read",
];
let owned: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0555-member-collaborator");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0555 requires real PostgreSQL");
    return;
  }
  owner = postgres(owned.ownerUrl, { max: 1, prepare: false });
  await owner`create table schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  await owner`insert into schema_migrations (name) select unnest(${[...rollout]}::text[])`;
  await migrate(owned.ownerUrl);
}, 900_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await owned?.release();
}, 180_000);

const sameSet = (left: readonly string[], right: readonly string[]) =>
  expect([...left].sort()).toEqual([...right].sort());

test("migration guards every preset, replaces the 0516 writer guard, and batches the backfill", () => {
  const source = readFileSync(new URL(`../drizzle/${rollout[0]}`, import.meta.url), "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("member permission preset changed before 0555");
  expect(source).toContain("viewer permission preset changed before 0555");
  expect(source).toContain("admin permission preset changed before 0555");
  expect(source).toContain("BEFORE INSERT OR UPDATE ON workspace_memberships");
  expect(source).toContain(
    "DROP TRIGGER normalize_legacy_member_connection_read_0516 ON workspace_memberships",
  );
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION opengeni_private.normalize_legacy_member_permissions_0555() FROM PUBLIC",
  );

  const index = readFileSync(new URL(`../drizzle/${rollout[1]}`, import.meta.url), "utf8");
  expect(index.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(parseConcurrentIndexMigration(rollout[1], index)).not.toBeNull();
  const backfill = readFileSync(new URL(`../drizzle/${rollout[2]}`, import.meta.url), "utf8");
  expect(backfill.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(parseBatchedBackfillMigration(rollout[2], backfill)?.batchSize).toBe(500);
  // The backfill matches exact named sets only: containment both ways.
  expect(backfill).toContain("membership.permissions @> '[");
  expect(backfill).toContain("]'::jsonb @> membership.permissions");
});

test("named members gain collaborator reads; custom sets and old writers stay correct", async () => {
  if (!owner || !owned) return;
  const preset = async (role: string) => {
    const [row] = await owner!<{ permissions: string[] }[]>`
      select opengeni_private.workspace_member_role_permissions(${role}) as permissions`;
    return row!.permissions;
  };
  const oldPreset = await preset("member");
  const viewer = await preset("viewer");
  const admin = await preset("admin");
  for (const permission of added) expect(oldPreset).not.toContain(permission);
  const [legacy] = await owner<{ permissions: string[] }[]>`
    select opengeni_private.workspace_member_legacy_permissions_0516() as permissions`;
  const pre0516 = legacy!.permissions;
  expect(pre0516).not.toContain("connections:read");

  const [account] = await owner<{ id: string }[]>`
    insert into managed_accounts (name) values ('Member collaborator rollout') returning id`;
  const [workspace] = await owner<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'Shared') returning id`;
  const oldDate = "2025-01-01T00:00:00.000Z";
  const insert = async (subject: string, role: string, permissions: readonly string[]) => {
    await owner!`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions, updated_at
      ) values (
        ${account!.id}, ${workspace!.id}, ${subject}, ${role},
        ${owner!.json([...permissions])}::jsonb, ${oldDate}::timestamptz
      )`;
  };
  const fixtures = [
    { subject: "named-member", role: "member", permissions: oldPreset },
    { subject: "reordered-member", role: "member", permissions: [...oldPreset].reverse() },
    { subject: "custom-member", role: "member", permissions: ["workspace:read"] },
    { subject: "custom-role", role: "custom", permissions: oldPreset },
    { subject: "viewer-with-old-member-set", role: "viewer", permissions: oldPreset },
    {
      subject: "already-extended-member",
      role: "member",
      permissions: [...oldPreset, "artifacts:read"],
    },
    { subject: "named-viewer", role: "viewer", permissions: viewer },
    { subject: "named-admin", role: "admin", permissions: admin },
  ];
  for (const fixture of fixtures) await insert(fixture.subject, fixture.role, fixture.permissions);
  // A pre-0516 named row that never met the 0516 backfill or writer guard.
  await owned.admin.unsafe(
    "alter table workspace_memberships disable trigger normalize_legacy_member_connection_read_0516",
  );
  await insert("pre-0516-member", "member", pre0516);
  await owned.admin.unsafe(
    "alter table workspace_memberships enable trigger normalize_legacy_member_connection_read_0516",
  );
  // More than one runner batch is needed, independently of the fixtures above.
  await owner`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions, updated_at
    )
    select ${account!.id}, ${workspace!.id}, 'batch-member-' || n::text, 'member',
      ${owner.json(oldPreset)}::jsonb, ${oldDate}::timestamptz
    from generate_series(1, 501) as n`;

  const functionFacts = () => owner!<
    {
      name: string;
      owner: string;
      securityDefiner: boolean;
      volatility: string;
      configuration: string[] | null;
      acl: string[] | null;
    }[]
  >`
    select p.proname::text as name, p.proowner::regrole::text as owner,
      p.prosecdef as "securityDefiner", p.provolatile::text as volatility,
      p.proconfig as configuration, p.proacl::text[] as acl
    from pg_proc p
    where p.oid = 'opengeni_private.workspace_member_role_permissions(text)'::regprocedure`;
  const before = await functionFacts();
  await owner`delete from schema_migrations where name in ${owner([...rollout])}`;
  await migrate(owned.ownerUrl);
  expect(await functionFacts()).toEqual(before);

  const newPreset = await preset("member");
  sameSet(newPreset, [...oldPreset, ...added]);
  // Named presets list permissions in Admin order; the web copy mirrors it.
  expect(newPreset).toEqual(admin.filter((permission) => newPreset.includes(permission)));
  expect(new Set(newPreset).size).toBe(newPreset.length);
  // Member is a superset of Viewer and a subset of Admin, without admin powers.
  for (const permission of viewer) expect(newPreset).toContain(permission);
  for (const permission of newPreset) expect(admin).toContain(permission);
  for (const permission of withheld) expect(newPreset).not.toContain(permission);
  expect(await preset("viewer")).toEqual(viewer);
  expect(await preset("admin")).toEqual(admin);

  const triggers = await owner<{ name: string }[]>`
    select tgname::text as name from pg_trigger
    where tgrelid = 'workspace_memberships'::regclass and not tgisinternal
    order by tgname`;
  expect(triggers.map(({ name }) => name)).toEqual(["normalize_legacy_member_permissions_0555"]);

  const read = () =>
    owner!<
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
  const rows = await read();
  const row = (subject: string) => rows.find((candidate) => candidate.subject === subject)!;
  const normalized = ["named-member", "reordered-member", "pre-0516-member"];
  for (const subject of normalized) {
    sameSet(row(subject).permissions, newPreset);
    expect(row(subject).projectedRole).toBe("member");
    expect(new Date(row(subject).updatedAt).toISOString()).not.toBe(oldDate);
  }
  for (const fixture of fixtures.filter(({ subject }) => !normalized.includes(subject))) {
    expect(row(fixture.subject).role).toBe(fixture.role);
    expect(row(fixture.subject).permissions).toEqual([...fixture.permissions]);
    expect(new Date(row(fixture.subject).updatedAt).toISOString()).toBe(oldDate);
  }
  expect(row("custom-member").projectedRole).toBe("custom");
  expect(row("custom-role").projectedRole).toBe("custom");
  expect(row("already-extended-member").projectedRole).toBe("custom");
  expect(row("named-viewer").projectedRole).toBe("viewer");
  expect(row("named-admin").projectedRole).toBe("admin");
  expect(
    rows.filter(
      (candidate) =>
        candidate.subject.startsWith("batch-member-") &&
        candidate.projectedRole === "member" &&
        added.every((permission) => candidate.permissions.includes(permission)),
    ),
  ).toHaveLength(501);

  // Still-running old writers keep writing either older named Member set.
  await insert("old-writer-insert", "member", [...oldPreset].reverse());
  await insert("pre-0516-writer-insert", "member", pre0516);
  await owner`
    update workspace_memberships
    set permissions = ${owner.json(oldPreset)}::jsonb
    where workspace_id = ${workspace!.id} and subject_id = 'named-member'`;
  await owner`
    update workspace_memberships
    set permissions = ${owner.json(pre0516)}::jsonb
    where workspace_id = ${workspace!.id} and subject_id = 'reordered-member'`;
  await owner`
    update workspace_memberships
    set permissions = ${owner.json(oldPreset)}::jsonb
    where workspace_id = ${workspace!.id} and subject_id = 'custom-role'`;
  const afterOldWriter = await read();
  const afterRow = (subject: string) =>
    afterOldWriter.find((candidate) => candidate.subject === subject)!;
  for (const subject of [
    "old-writer-insert",
    "pre-0516-writer-insert",
    "named-member",
    "reordered-member",
  ]) {
    sameSet(afterRow(subject).permissions, newPreset);
    expect(afterRow(subject).projectedRole).toBe("member");
  }
  expect(afterRow("custom-role").permissions).toEqual(oldPreset);
  expect(afterRow("viewer-with-old-member-set").permissions).toEqual(oldPreset);
  expect(afterRow("custom-member").permissions).toEqual(["workspace:read"]);

  // An interrupted runner can re-enter the committed, already-drained backfill.
  await owner`delete from schema_migrations where name = ${rollout[2]}`;
  await migrate(owned.ownerUrl);
  const replayed = await read();
  expect(replayed.map(({ subject, permissions }) => ({ subject, permissions }))).toEqual(
    afterOldWriter.map(({ subject, permissions }) => ({ subject, permissions })),
  );
}, 900_000);
