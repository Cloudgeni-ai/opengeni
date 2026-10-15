// Migrations 0788 and 0789, applied together as one release does, over data
// the previous release wrote. 0788: existing Site agent conversations count in
// the Site's windows (budget key `*`) and the platform usage tables arrive
// owner-only. 0789: retain old-reader-compatible storage with no locked backfill;
// new request-time resolution supplies the new defaults without republishing.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  putWorkspaceSiteLimitProfile,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { testSettings } from "@opengeni/testing";
import { siteLimitsForProfile } from "../../../apps/api/src/site-publishing/limits";
import { previousReleaseSiteLimitsForProfile } from "./fixtures/site-limits-2fef1581b";

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
  "0788 and 0789 preserve old readers and use request-time normalization without a locked backfill",
  async () => {
    expect(() =>
      previousReleaseSiteLimitsForProfile(testSettings(), { kind: "standard", overrides: null }),
    ).toThrow();
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
    const sites: Record<string, { before: Stored }> = {
      free: {
        before: { kind: "free", overrides: null },
      },
      credits: {
        before: { kind: "credits", overrides: null },
      },
      inherits: {
        before: { kind: null, overrides: null },
      },
      prefilledCustom: {
        before: { kind: "custom", overrides: OLD_PREFILLED },
      },
      emptyCustom: {
        before: { kind: "custom", overrides: null },
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
      },
      ownerUncapped: {
        before: {
          kind: "custom",
          overrides: { ...OLD_PREFILLED, agentMicrosPerVisitorPerDay: null },
        },
      },
      leftoverOnUnlimited: {
        before: { kind: "unlimited", overrides: { agentMicrosPerConversation: 20_000 } },
      },
      unknownField: {
        before: { kind: "custom", overrides: { agentModels: null, futureField: 7 } },
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
        ...site.before,
      });
      if (row.kind) {
        // The real previous-release switch has no standard branch. Its copied
        // reader must accept every migrated row, not just pass the SQL CHECK.
        expect(() => previousReleaseSiteLimitsForProfile(testSettings(), row)).not.toThrow();
        const limits = siteLimitsForProfile(testSettings(), row as never);
        if (name === "free" || name === "prefilledCustom") {
          expect(limits.agentMicrosPerConversation).toBe(1_000_000);
          expect(limits.agentMicrosPerVisitorPerDay).toBeNull();
          expect(limits.agentMicrosPerSitePerMonth).toBe(10_000_000);
        }
        if (name === "ownerSetCustom") expect(limits.agentMicrosPerSitePerMonth).toBe(5_000_000);
      }
    }
    const profiles = await admin<
      { workspaceId: string; kind: string; overrides: Record<string, unknown> | null }[]
    >`
      select workspace_id::text as "workspaceId", kind, overrides from site_limit_profiles
      where workspace_id in ${admin(workspaces)}`;
    const byWorkspace = Object.fromEntries(profiles.map((row) => [row.workspaceId, row]));
    expect(byWorkspace[prefilledWorkspace]).toMatchObject({
      kind: "custom",
      overrides: OLD_PREFILLED,
    });
    expect(byWorkspace[ownerSetWorkspace]).toMatchObject({
      kind: "custom",
      overrides: { ...OLD_PREFILLED, agentMicrosPerVisitorPerDay: 500_000 },
    });
    expect(byWorkspace[freeWorkspace]).toMatchObject({ kind: "free", overrides: null });
    // New writers also remain readable by the old binary, including explicit
    // owner values exactly equal to an old default.
    await putWorkspaceSiteLimitProfile(
      client!.db,
      { accountId, workspaceId: freeWorkspace },
      {
        kind: "standard",
        overrides: { agentMicrosPerConversation: 20_000 },
      },
      `user:${userId}`,
    );
    const [written] = await admin<{ kind: string; overrides: Record<string, unknown> }[]>`
      select kind, overrides from site_limit_profiles where workspace_id = ${freeWorkspace}`;
    expect(written!.kind).toBe("free");
    expect(() => previousReleaseSiteLimitsForProfile(testSettings(), written!)).not.toThrow();
    expect(siteLimitsForProfile(testSettings(), written! as never).agentMicrosPerConversation).toBe(
      20_000,
    );
    // The compatibility checkpoint neither takes table locks nor backfills.
    const migrationSql = await readFile(
      join(import.meta.dir, "../drizzle", MIGRATIONS[1]!),
      "utf8",
    );
    const statements = migrationSql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(statements).toBe("SELECT 1;");
    // Execute the migration while another connection holds exclusive locks:
    // it must complete rather than queue behind publication traffic.
    await admin.begin(async (tx) => {
      await tx`lock table site_publications, site_limit_profiles in access exclusive mode`;
      const rolling = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
      try {
        await rolling.begin(async (connection) => {
          await connection`set local lock_timeout = '100ms'`;
          await connection.unsafe(migrationSql);
        });
      } finally {
        await rolling.end();
      }
    });
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
