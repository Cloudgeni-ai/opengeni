import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { readSkillMetadata } from "@opengeni/contracts";

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
      const description = "d".repeat(1024);
      const files = [
        { path: "SKILL.md", content: "Original installed Skill" },
        { path: "references/context.txt", content: "Keep supporting text" },
      ];
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const legacyRows: Array<{
        id: string;
        revisionId: string;
        content: string;
        scope: string;
        title: string;
        description: string;
      }> = [];
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
          values(${facetId},${ownerId},'same-name',${description},'https://example.test/upstream',${"a".repeat(40)},'skill',${digest(files[0]!.content)},2,${files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)})`;
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
      const seedLegacy = async (
        scope: string,
        content: string,
        title: string,
        legacyDescription: string,
      ) => {
        const fixture = fixtures[0]!;
        const id = crypto.randomUUID();
        const revisionId = crypto.randomUUID();
        await admin.begin(async (tx) => {
          await tx`INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,scope_subject_id,created_by_subject_id)
            VALUES(${id},${fixture.accountId},${`legacy-${id}`},${scope},${scope === "workspace" ? fixture.workspaceId : null},${scope === "user" ? "user:original" : null},'user:original')`;
          await tx`INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,conflict_strategy,provenance_source,trust,created_by_subject_id)
            VALUES(${revisionId},${fixture.accountId},${id},${title},${legacyDescription},${content},${digest(content)},'override','human','workspace_managed','user:original')`;
          await tx`INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,new_subject_id,actor_subject_id,reason)
            VALUES(${fixture.accountId},${id},'proposal_created',1,${revisionId},${scope},${scope === "workspace" ? fixture.workspaceId : null},${scope === "user" ? "user:original" : null},'user:original','Legacy fixture')`;
          await tx`SELECT set_config('opengeni.preference_lifecycle_head_id',${id},true),set_config('opengeni.preference_lifecycle_operation','activate',true)`;
          await tx`UPDATE preference_registry_preferences h SET status='active',active_revision_id=${revisionId},
            active_revision=r.revision,active_content_hash=r.content_hash,activation_version=1
            FROM preference_registry_revisions r WHERE h.id=${id} AND r.id=${revisionId}`;
          await tx`INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,actor_subject_id,reason)
            VALUES(${fixture.accountId},${id},'activated',2,${revisionId},'user:original','Legacy activation')`;
        });
        return { id, revisionId, content, scope, title, description: legacyDescription };
      };
      legacyRows.push(
        await seedLegacy(
          "workspace",
          "Original legacy body\n\nTrailing spaces  \n",
          "Legacy Authored",
          "Preserve this description",
        ),
      );
      const yaml =
        "---\r\nname: yaml-original\r\ndescription: |-\r\n  First line\r\n  Second line\r\n---\r\nBody\r\n";
      legacyRows.push(await seedLegacy("organization", yaml, "Stale title", "Stale description"));
      legacyRows.push(
        await seedLegacy("user", yaml, "Other stale title", "Other stale description"),
      );
      const invalid = await seedLegacy(
        "workspace",
        "---\nname: [\ndescription: invalid\n---\nBody",
        "Invalid Header",
        "Explicit repair required",
      );
      expect(await owner`select id from capability_plugin_installations`).toHaveLength(0);
      const rawMigration = await readFile(
        new URL(`../drizzle/${cutover}`, import.meta.url),
        "utf8",
      );
      await expect(
        owner.begin(async (tx) => {
          await tx.unsafe(rawMigration);
        }),
      ).rejects.toThrow("requires the parser-backed TypeScript migration runner");
      await expect(migrate(ownerUrl)).rejects.toThrow("needs explicit frontmatter repair");
      expect(await admin`select name from schema_migrations where name=${cutover}`).toHaveLength(0);
      expect(
        await admin`select column_name from information_schema.columns where table_name='preference_registry_revisions' and column_name='skill_files'`,
      ).toHaveLength(0);
      expect(
        await admin`select id from preference_registry_preferences where status='active'`,
      ).toHaveLength(4);
      // Explicit operator repair archives the bad head, never edits its immutable
      // content and never lets the migration silently drop it.
      await admin.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.preference_lifecycle_head_id',${invalid.id},true),set_config('opengeni.preference_lifecycle_operation','deactivate',true)`;
        await tx`UPDATE preference_registry_preferences SET status='inactive',active_revision_id=NULL,active_revision=NULL,active_content_hash=NULL,activation_version=2 WHERE id=${invalid.id}`;
        await tx`INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,actor_subject_id,reason)
          VALUES(${fixtures[0]!.accountId},${invalid.id},'deactivated',3,${invalid.revisionId},'user:original','Explicitly archive invalid fixture after cutover rejection')`;
      });
      await migrate(ownerUrl);
      const migratedFiles = [
        {
          path: "SKILL.md",
          content: `---\nname: "same-name"\ndescription: "${description}"\n---\n${files[0]!.content}`,
        },
        files[1]!,
      ];
      const heads =
        await admin`select b.account_id,b.workspace_id,b.plugin_id,b.skill_facet_id,h.id,h.status,r.skill_files,r.content_hash,r.description
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
          skill_files: migratedFiles,
          description,
          content_hash: digest(migratedFiles[0]!.content),
        });
        expect([
          ...(await admin`select owner_id from capability_component_owners where workspace_id=${fixture.workspaceId}`),
        ]).toEqual([{ owner_id: fixture.ownerId }]);
        expect([
          ...(await admin`select source_commit from capability_skill_facets where facet_id=${fixture.facetId}`),
        ]).toEqual([{ source_commit: "a".repeat(40) }]);
      }
      for (const legacy of legacyRows) {
        const [current] =
          await admin`SELECT h.scope,h.scope_workspace_id,h.scope_subject_id,r.id,r.content,r.title,r.description,r.corrects_revision_id,r.skill_files
          FROM preference_registry_preferences h JOIN preference_registry_revisions r ON r.id=h.active_revision_id WHERE h.id=${legacy.id}`;
        expect(current!.id).not.toBe(legacy.revisionId);
        expect(current!.corrects_revision_id).toBe(legacy.revisionId);
        expect(current!.scope).toBe(legacy.scope);
        const metadata = readSkillMetadata(current!.content);
        expect(current!.title).toBe(metadata.name);
        expect(current!.description).toBe(metadata.description);
        if (legacy.scope === "workspace") {
          expect(current!.content).toBe(
            `---\nname: "legacy-authored"\ndescription: "Preserve this description"\n---\n${legacy.content}`,
          );
          expect(current!.scope_workspace_id).toBe(fixtures[0]!.workspaceId);
        } else {
          expect(current!.content).toBe(yaml);
          expect(current!.description).toBe("First line\nSecond line");
        }
        const [historical] =
          await admin`SELECT content,content_hash,skill_files FROM preference_registry_revisions WHERE id=${legacy.revisionId}`;
        expect(historical!.content).toBe(legacy.content);
        expect(historical!.content_hash).toBe(digest(legacy.content));
        expect(historical!.skill_files).toBeNull();
        await expect(
          admin.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.preference_lifecycle_head_id',${legacy.id},true),set_config('opengeni.preference_lifecycle_operation','activate',true)`;
            await tx`UPDATE preference_registry_preferences h SET active_revision_id=${legacy.revisionId},active_revision=r.revision,active_content_hash=r.content_hash,activation_version=h.activation_version+1
            FROM preference_registry_revisions r WHERE h.id=${legacy.id} AND r.id=${legacy.revisionId}`;
          }),
        ).rejects.toThrow("files-bearing revision");
      }
      expect(
        await admin`select id from preference_registry_events where actor_subject_id='service:skill-migration:0423'`,
      ).toHaveLength(7);
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
