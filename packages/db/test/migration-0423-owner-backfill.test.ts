import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const cutover = "0423_unified_skill_lifecycle.sql";
const windowTables = [
  "capability_plugin_installations",
  "capability_facets",
  "capability_skill_facets",
  "capability_skill_files",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "preference_registry_events",
  "skill_source_bindings",
];
let owned: OwnerMigratedTestDatabase | null = null;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_SKILL_BACKFILL_TEST_ADMIN_URL;
  const ownerUrl = process.env.OPENGENI_SKILL_BACKFILL_TEST_OWNER_URL;
  if (Boolean(adminUrl) !== Boolean(ownerUrl))
    throw new Error("Provide both Skill backfill admin and owner URLs");
  if (adminUrl && ownerUrl) {
    const admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
    const [identity] = await owner`select current_user as role`;
    await owner.end();
    owned = {
      admin,
      adminUrl,
      ownerUrl,
      ownerRole: identity!.role,
      appPassword: "unused",
      release: async () => {
        await admin.end();
      },
    };
  } else owned = await acquireOwnerMigratedTestDatabase("skill-0423-owner");
  if (!owned && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("Owner-migrated PostgreSQL required");
}, 180_000);

afterAll(async () => {
  await owned?.release();
}, 120_000);

describe("0423 owner-only Skill backfill", () => {
  test("migrates populated tenants as NOSUPERUSER NOBYPASSRLS and restores every FORCE policy", async () => {
    if (!owned) return;
    const { admin, ownerUrl, ownerRole } = owned;
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
    try {
      const [posture] =
        await admin`select rolsuper,rolbypassrls from pg_roles where rolname=${ownerRole}`;
      expect(posture).toEqual({ rolsuper: false, rolbypassrls: false });
      // Exercise migrate() and its per-file maintenance preamble, holding only
      // this cutover/later files until populated pre-cutover state is seeded.
      await owner`create table schema_migrations(name text primary key,applied_at timestamptz not null default now())`;
      const deferred = (await readdir(new URL("../drizzle", import.meta.url))).filter(
        (name) => name.endsWith(".sql") && name >= cutover,
      );
      for (const name of deferred) await owner`insert into schema_migrations(name) values(${name})`;
      await migrate(ownerUrl);
      await owner`delete from schema_migrations where name >= ${cutover}`;

      const fixtures: Array<{
        accountId: string;
        workspaceId: string;
        pluginId: string;
        facetId: string;
        installationId: string;
        ownerId: string;
      }> = [];
      const files = [
        { path: "SKILL.md", content: "Original installed Skill" },
        { path: "references/context.txt", content: "Keep supporting text" },
      ];
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      for (let index = 0; index < 2; index++) {
        const accountId = crypto.randomUUID();
        const workspaceId = crypto.randomUUID();
        const pluginId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const facetId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        const facetInstallationId = crypto.randomUUID();
        const ownerId = `skill:original-${index}`;
        await admin`insert into managed_accounts(id,name) values(${accountId},'Backfill account')`;
        await admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Backfill workspace')`;
        await admin`insert into capability_plugins(id,plugin_key,account_id,workspace_id,name,category,provenance)
          values(${pluginId},'skill/backfill/original',${accountId},${workspaceId},'same-name','skills','workspace')`;
        await admin`insert into capability_plugin_versions(id,plugin_id,version,manifest_digest)
          values(${versionId},${pluginId},'original',${digest("original")})`;
        await admin`insert into capability_facets(id,plugin_version_id,facet_key,kind,activation_mode)
          values(${facetId},${versionId},'skill','skill','workspace_managed')`;
        await admin`insert into capability_skill_facets(facet_id,capability_id,name,description,source_url,source_commit,source_path,content_sha256,file_count,total_bytes)
          values(${facetId},${ownerId},'same-name','Original description','https://example.test/upstream',${"a".repeat(40)},'skill',${digest(files[0]!.content)},2,${files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)})`;
        for (const file of files)
          await admin`insert into capability_skill_files(skill_facet_id,path,content,byte_size,content_sha256)
          values(${facetId},${file.path},${file.content},${Buffer.byteLength(file.content)},${digest(file.content)})`;
        await admin`insert into capability_plugin_installations(id,account_id,workspace_id,plugin_id,plugin_version_id,status,installed_by_subject_id)
          values(${installationId},${accountId},${workspaceId},${pluginId},${versionId},'active','user:original')`;
        await admin`insert into capability_facet_installations(id,account_id,workspace_id,plugin_installation_id,facet_id,status)
          values(${facetInstallationId},${accountId},${workspaceId},${installationId},${facetId},'active')`;
        await admin`insert into capability_component_owners(account_id,workspace_id,facet_installation_id,owner_kind,owner_id,removable)
          values(${accountId},${workspaceId},${facetInstallationId},'direct',${ownerId},true)`;
        fixtures.push({ accountId, workspaceId, pluginId, facetId, installationId, ownerId });
      }
      expect(await owner`select id from capability_plugin_installations`).toHaveLength(0);
      await migrate(ownerUrl);
      const heads =
        await admin`select b.account_id,b.workspace_id,b.plugin_id,b.skill_facet_id,h.id,h.status,r.skill_files,r.content_hash
        from skill_source_bindings b join preference_registry_preferences h on h.id=b.preference_id
        join preference_registry_revisions r on r.id=h.active_revision_id order by b.workspace_id`;
      expect(heads).toHaveLength(2);
      expect(new Set(heads.map((head) => head.id)).size).toBe(2);
      for (const fixture of fixtures) {
        expect(heads.find((head) => head.workspace_id === fixture.workspaceId)).toMatchObject({
          account_id: fixture.accountId,
          plugin_id: fixture.pluginId,
          skill_facet_id: fixture.facetId,
          status: "active",
          skill_files: files,
          content_hash: digest(files[0]!.content),
        });
        expect([
          ...(await admin`select owner_id from capability_component_owners where workspace_id=${fixture.workspaceId}`),
        ]).toEqual([{ owner_id: fixture.ownerId }]);
        expect([
          ...(await admin`select source_commit from capability_skill_facets where facet_id=${fixture.facetId}`),
        ]).toEqual([{ source_commit: "a".repeat(40) }]);
      }
      expect(await admin`select id from preference_registry_events`).toHaveLength(4);
      const restored =
        await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname=any(${windowTables})`;
      expect(restored).toHaveLength(windowTables.length);
      for (const table of restored)
        expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(await owner`select id from capability_plugin_installations`).toHaveLength(0);
      expect(await owner`select id from preference_registry_preferences`).toHaveLength(0);
      expect(await owner`select preference_id from skill_source_bindings`).toHaveLength(0);
    } finally {
      await owner.end();
    }
  }, 180_000);
});
