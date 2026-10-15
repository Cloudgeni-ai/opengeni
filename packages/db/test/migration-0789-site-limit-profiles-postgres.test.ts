// Migrations 0788 and 0789, applied together as one release does, over data
// the previous release wrote. 0788: existing Site agent conversations count in
// the Site's windows (budget key `*`) and the platform usage tables arrive
// owner-only. 0789: stored Site limit profiles move to the new limits model, so
// existing Sites pick up the new defaults without a republish. Fields equal to
// the old free defaults are dropped
// (the old custom form prefilled all of them), a custom profile left with no
// field of its own becomes standard, `free` becomes standard, and fields an
// owner set to other values are kept.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, ensureManagedAccessForUser, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const FIRST = "0788_site_limits_and_platform_usage.sql";
const MIGRATIONS = [FIRST, "0789_site_limit_profiles_new_defaults.sql"];

/** The previous release's custom form saved every field, prefilled with these. */
const OLD_PREFILLED = {
  conversationsPerVisitorPerDay: 10,
  conversationsPerSitePerDay: 50,
  turnsPerConversation: 20,
  agentMicrosPerConversation: 20_000,
  agentMicrosPerVisitorPerDay: 200_000,
  agentMicrosPerSitePerMonth: 2_000_000,
};

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("site-limit-profiles-migration");
  if (!database) throw new Error("Real PostgreSQL is required");
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= FIRST)
    .sort();
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 2 });
});

afterAll(async () => {
  await client?.close();
  await database?.release();
});

test.skipIf(!realDb)(
  "0788 and 0789 keep existing conversations and move old-default limit profiles to the new model",
  async () => {
    const admin = database!.admin;
    const userId = `site-limit-profiles-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Site limit profiles",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const workspaces: string[] = [];
    for (const name of ["prefilled", "owner-set", "free"]) {
      const [row] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}::uuid, ${`Site limits ${name}`}) returning id::text as id`;
      workspaces.push(row!.id);
    }
    const [prefilledWorkspace, ownerSetWorkspace, freeWorkspace] = workspaces as [
      string,
      string,
      string,
    ];

    type Stored = { kind: string | null; overrides: Record<string, unknown> | null };
    const sites: Record<string, { before: Stored; after: Stored }> = {
      free: {
        before: { kind: "free", overrides: null },
        after: { kind: "standard", overrides: null },
      },
      credits: {
        before: { kind: "credits", overrides: null },
        after: { kind: "credits", overrides: null },
      },
      inherits: {
        before: { kind: null, overrides: null },
        after: { kind: null, overrides: null },
      },
      prefilledCustom: {
        before: { kind: "custom", overrides: OLD_PREFILLED },
        after: { kind: "standard", overrides: null },
      },
      emptyCustom: {
        before: { kind: "custom", overrides: null },
        after: { kind: "standard", overrides: null },
      },
      ownerSetCustom: {
        before: {
          kind: "custom",
          overrides: {
            ...OLD_PREFILLED,
            agentMicrosPerSitePerMonth: 5_000_000,
            turnsPerConversation: 40,
          },
        },
        after: {
          kind: "custom",
          overrides: { agentMicrosPerSitePerMonth: 5_000_000, turnsPerConversation: 40 },
        },
      },
      ownerUncapped: {
        before: {
          kind: "custom",
          overrides: { ...OLD_PREFILLED, agentMicrosPerVisitorPerDay: null },
        },
        after: { kind: "custom", overrides: { agentMicrosPerVisitorPerDay: null } },
      },
      leftoverOnUnlimited: {
        before: { kind: "unlimited", overrides: { agentMicrosPerConversation: 20_000 } },
        after: { kind: "unlimited", overrides: null },
      },
      unknownField: {
        before: { kind: "custom", overrides: { agentModels: null, futureField: 7 } },
        after: { kind: "custom", overrides: { futureField: 7 } },
      },
    };
    const siteIds = Object.fromEntries(
      Object.keys(sites).map((name) => [name, crypto.randomUUID()]),
    );
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const [name, site] of Object.entries(sites)) {
        const siteId = siteIds[name]!;
        const versionId = crypto.randomUUID();
        await tx`insert into workspace_artifacts (id, account_id, workspace_id, slug, title, current_version_id, created_by_subject_id)
          values (${siteId}, ${accountId}, ${prefilledWorkspace}, ${`site-${siteId.slice(0, 8)}`}, 'Site', ${versionId}, ${`user:${userId}`})`;
        await tx`insert into workspace_artifact_versions (id, account_id, workspace_id, artifact_id, revision, content_key, content_sha256, size_bytes, operation_key, created_by_subject_id)
          values (${versionId}, ${accountId}, ${prefilledWorkspace}, ${siteId}, 1, ${`blob-${siteId}`}, ${"a".repeat(64)}, 10, ${`op-${siteId}`}, ${`user:${userId}`})`;
        await tx`
          insert into site_publications (
            site_id, account_id, workspace_id, label, limit_profile_kind, limit_overrides,
            created_by, updated_by
          ) values (
            ${siteId}::uuid, ${accountId}::uuid, ${prefilledWorkspace}::uuid,
            ${`limits-${siteId.slice(0, 8)}`}, ${site.before.kind},
            ${site.before.overrides === null ? null : tx.json(site.before.overrides as never)}::jsonb,
            ${`user:${userId}`}, ${`user:${userId}`}
          )`;
      }
      for (const [workspaceId, kind, overrides] of [
        [prefilledWorkspace, "custom", OLD_PREFILLED],
        [ownerSetWorkspace, "custom", { ...OLD_PREFILLED, agentMicrosPerVisitorPerDay: 500_000 }],
        [freeWorkspace, "free", null],
      ] as const)
        await tx`
          insert into site_limit_profiles (workspace_id, account_id, kind, overrides, updated_by)
          values (
            ${workspaceId}::uuid, ${accountId}::uuid, ${kind},
            ${overrides === null ? null : tx.json(overrides as never)}::jsonb, ${`user:${userId}`}
          )`;
    });
    // A conversation the previous release started.
    const conversationId = crypto.randomUUID();
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into site_runtime_conversations (
          session_id, account_id, workspace_id, site_id, viewer_principal, viewer_kind,
          limit_micros, reserved_micros
        ) values (
          ${conversationId}::uuid, ${accountId}::uuid, ${prefilledWorkspace}::uuid,
          ${siteIds.free!}::uuid, ${`user:${userId}`}, 'member', 20000, 20000
        )`;
    });
    const forcedRls = async () =>
      await admin<{ relname: string; forced: boolean }[]>`
        select relname, relforcerowsecurity as forced from pg_class
        where relname in ('site_publications', 'site_limit_profiles')
          and relnamespace = 'public'::regnamespace order by relname`;
    expect((await forcedRls()).every((row) => row.forced)).toBe(true);

    const applying = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      await applying`delete from schema_migrations where name in ${applying(MIGRATIONS)}`;
    } finally {
      await applying.end();
    }
    await migrate(database!.ownerUrl);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });

    const publications = await admin<
      { siteId: string; kind: string | null; overrides: Record<string, unknown> | null }[]
    >`
      select site_id::text as "siteId", limit_profile_kind as kind, limit_overrides as overrides
      from site_publications where workspace_id = ${prefilledWorkspace}::uuid`;
    const bySite = Object.fromEntries(publications.map((row) => [row.siteId, row]));
    for (const [name, site] of Object.entries(sites)) {
      const row = bySite[siteIds[name]!]!;
      expect({ name, kind: row.kind, overrides: row.overrides }).toEqual({
        name,
        ...site.after,
      });
    }
    const profiles = await admin<
      { workspaceId: string; kind: string; overrides: Record<string, unknown> | null }[]
    >`
      select workspace_id::text as "workspaceId", kind, overrides from site_limit_profiles
      where workspace_id in ${admin(workspaces)}`;
    const byWorkspace = Object.fromEntries(profiles.map((row) => [row.workspaceId, row]));
    expect(byWorkspace[prefilledWorkspace]).toMatchObject({ kind: "standard", overrides: null });
    expect(byWorkspace[ownerSetWorkspace]).toMatchObject({
      kind: "custom",
      overrides: { agentMicrosPerVisitorPerDay: 500_000 },
    });
    expect(byWorkspace[freeWorkspace]).toMatchObject({ kind: "standard", overrides: null });
    // The owner-only posture of both tables is restored.
    expect((await forcedRls()).every((row) => row.forced)).toBe(true);
    // The old conversation keeps its row and counts in the Site's windows.
    const [conversation] = await admin<{ budgetKey: string; limit: string; complete: boolean }[]>`
      select budget_key as "budgetKey", limit_micros::text as limit, reservation_windows_complete as complete
      from site_runtime_conversations where session_id = ${conversationId}::uuid`;
    expect(conversation).toEqual({ budgetKey: "*", limit: "20000", complete: false });
    const platform = await admin<{ relname: string; forced: boolean }[]>`
      select relname, relforcerowsecurity as forced from pg_class
      where relname like 'site_platform_%' and relkind = 'r'
        and relnamespace = 'public'::regnamespace
      order by relname`;
    expect([...platform]).toEqual([
      { relname: "site_platform_brake", forced: true },
      { relname: "site_platform_storage", forced: true },
      { relname: "site_platform_totals", forced: true },
      { relname: "site_platform_usage", forced: true },
    ]);
  },
);
