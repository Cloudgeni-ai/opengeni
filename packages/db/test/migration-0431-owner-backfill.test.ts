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
import { createDb } from "../src/database";
import { listSkillDescriptors, listSkillRecords } from "../src/skills";
import { migrateLegacySkillConfigurations } from "../src/skill-config-migration";

const cutover = "0431_unified_skill_lifecycle.sql";
const windowTables = [
  "capability_plugin_installations",
  "capability_facets",
  "capability_skill_facets",
  "capability_skill_files",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "preference_registry_events",
  "skill_source_bindings",
  "skill_config_conversion_receipts",
  "sessions",
  "workspace_packs",
  "session_turns",
  "automation_triggers",
  "automation_trigger_revisions",
  "automation_runs",
  "automation_trigger_events",
  "automation_run_event_links",
  "pack_installations",
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
  } else owned = await acquireOwnerMigratedTestDatabase("skill-0426-owner");
  if (!owned && process.env.OPENGENI_REQUIRE_REAL_DB === "1")
    throw new Error("Owner-migrated PostgreSQL required");
}, 180_000);

afterAll(async () => {
  await owned?.release();
}, 120_000);

describe("0431 owner-only Skill backfill", () => {
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
        expiresAt: string | null = null,
      ) => {
        const fixture = fixtures[0]!;
        const id = crypto.randomUUID();
        const revisionId = crypto.randomUUID();
        await admin.begin(async (tx) => {
          await tx`INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,scope_subject_id,created_by_subject_id)
            VALUES(${id},${fixture.accountId},${`legacy-${id}`},${scope},${scope === "workspace" ? fixture.workspaceId : null},${scope === "user" ? "user:original" : null},'user:original')`;
          await tx`INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,conflict_strategy,provenance_source,trust,created_by_subject_id,expires_at)
            VALUES(${revisionId},${fixture.accountId},${id},${title},${legacyDescription},${content},${digest(content)},'override','human','workspace_managed','user:original',${expiresAt})`;
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
      legacyRows.push(
        await seedLegacy(
          "organization",
          yaml,
          "Stale title",
          "Stale description",
          "2000-01-01T00:00:00Z",
        ),
      );
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
      const configFixtures = [];
      for (const fixture of fixtures) {
        const sessionId = crypto.randomUUID();
        await admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${fixture.workspaceId},${fixture.accountId})`;
        const packId = crypto.randomUUID();
        const skills = [
          { name: "Original Name", description: "Original description", files },
          {
            name: "Stale cached name",
            description: "Stale cached description",
            files: [{ path: "SKILL.md", content: yaml }],
          },
        ];
        const manifest = {
          id: `legacy-${packId}`,
          name: "Legacy Pack",
          description: "Legacy registration",
          role: "agent",
          category: "test",
          version: "1",
          skills,
        };
        await admin.begin(async (tx) => {
          await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),set_config('opengeni.workspace_id',${fixture.workspaceId},true)`;
          await tx`SELECT set_config('opengeni.session_activity_gate_state','open',true),set_config('opengeni.session_activity_gate_workspace_id',${fixture.workspaceId},true),set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
          await tx`INSERT INTO sessions(id,account_id,workspace_id,sandbox_group_id,status,initial_message,model,sandbox_backend,skills,tool_policy,reasoning_effort,latency_mode)
            VALUES(${sessionId},${fixture.accountId},${fixture.workspaceId},${sessionId},'idle','fixture','test','none',${tx.json(skills)},'{"mode":"workspace_default","inheritedFromSessionId":null}', 'medium','standard')`;
          await tx`SELECT set_config('opengeni.session_activity_gate_state','preparing',true)`;
          await tx`SET CONSTRAINTS ALL IMMEDIATE`;
          await tx`SET CONSTRAINTS sessions_activity_insert_commit_guard,sessions_activity_update_commit_guard DEFERRED`;
          await tx`SELECT set_config('opengeni.session_activity_gate_state','finalizing',true)`;
          await tx`WITH advanced AS (UPDATE workspace_session_activity_revisions SET revision=revision+1 WHERE workspace_id=${fixture.workspaceId} RETURNING revision)
            UPDATE sessions SET activity_revision=advanced.revision,activity_revision_pending_xid=NULL FROM advanced WHERE id=${sessionId}`;
          await tx`SELECT set_config('opengeni.session_activity_gate_state','finalized',true)`;
        });
        await admin`INSERT INTO workspace_packs(id,account_id,workspace_id,pack_id,manifest)
          VALUES(${packId},${fixture.accountId},${fixture.workspaceId},${manifest.id},${admin.json(manifest)})`;
        configFixtures.push({ ...fixture, sessionId, packId, skills, manifest });
      }
      // An active immutable snapshot blocks the whole maintenance transaction.
      const pinnedId = crypto.randomUUID();
      const config = configFixtures[0]!;
      await admin`INSERT INTO pack_installations(id,account_id,workspace_id,pack_id,manifest_snapshot,manifest_digest)
        VALUES(${pinnedId},${config.accountId},${config.workspaceId},${config.manifest.id},${admin.json(config.manifest)},${digest(JSON.stringify(config.manifest))})`;
      await expect(migrate(ownerUrl)).rejects.toThrow("pack-installation:");
      expect(await admin`SELECT name FROM schema_migrations WHERE name=${cutover}`).toHaveLength(0);
      expect([...(await admin`SELECT skills FROM sessions WHERE id=${config.sessionId}`)]).toEqual([
        { skills: config.skills },
      ]);
      expect([
        ...(await admin`SELECT to_regclass('skill_config_conversion_receipts') AS name`),
      ]).toEqual([{ name: null }]);
      await admin`UPDATE pack_installations SET status='disabled' WHERE id=${pinnedId}`;
      // Malformed current folders and canonical collisions abort before archive
      // creation, leaving every other tenant's current configuration untouched.
      for (const skills of [
        [
          {
            ...config.skills[0]!,
            files: [{ path: "SKILL.md", content: "---\nname: [\n---\ninvalid" }],
          },
        ],
        [config.skills[0]!, { ...config.skills[0]!, name: "original-name" }],
      ]) {
        await admin`UPDATE workspace_packs SET manifest=${admin.json({ ...config.manifest, skills })} WHERE id=${config.packId}`;
        await expect(migrate(ownerUrl)).rejects.toThrow("invalid content or canonical collision");
        expect([
          ...(await admin`SELECT skills FROM sessions WHERE id=${config.sessionId}`),
        ]).toEqual([{ skills: config.skills }]);
        expect([
          ...(await admin`SELECT to_regclass('skill_config_conversion_receipts') AS name`),
        ]).toEqual([{ name: null }]);
      }
      await admin`UPDATE workspace_packs SET manifest=${admin.json(config.manifest)} WHERE id=${config.packId}`;
      const queuedTurnId = crypto.randomUUID();
      await admin.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${config.accountId},true),set_config('opengeni.workspace_id',${config.workspaceId},true),set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
        await tx`INSERT INTO session_turns(id,account_id,workspace_id,session_id,trigger_event_id,temporal_workflow_id,status,position,prompt,model,reasoning_effort,sandbox_backend)
          VALUES(${queuedTurnId},${config.accountId},${config.workspaceId},${config.sessionId},${crypto.randomUUID()},'legacy-config-fixture','queued',1,'fixture','test','medium','none')`;
      });
      await expect(migrate(ownerUrl)).rejects.toThrow("runnable accepted turn");
      await admin`UPDATE session_turns SET status='cancelled' WHERE id=${queuedTurnId}`;
      const sourceId = crypto.randomUUID();
      const triggerId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const template = { skills: config.skills };
      await admin`INSERT INTO automation_sources(id,account_id,workspace_id,name,adapter_id,webhook_secret_encrypted,created_by_subject_id)
        VALUES(${sourceId},${config.accountId},${config.workspaceId},'Legacy source','test','fixture-not-a-secret','user:original')`;
      await admin`INSERT INTO automation_triggers(id,account_id,workspace_id,source_id,name,created_by_subject_id)
        VALUES(${triggerId},${config.accountId},${config.workspaceId},${sourceId},'Legacy trigger','user:original')`;
      await admin`INSERT INTO automation_trigger_revisions(trigger_id,revision,account_id,workspace_id,adapter_id,event_types,session_template,created_by_subject_id)
        VALUES(${triggerId},1,${config.accountId},${config.workspaceId},'test','["test"]',${admin.json(template)},'user:original')`;
      await expect(migrate(ownerUrl)).rejects.toThrow("automation-current:");
      await admin`UPDATE automation_triggers SET status='disabled' WHERE id=${triggerId}`;
      await admin`INSERT INTO automation_trigger_events(id,account_id,workspace_id,source_id,source_version,source_configuration,matched_trigger_revisions,delivery_key,request_digest,adapter_id,event_type,occurrence_key,normalized_event)
        VALUES(${eventId},${config.accountId},${config.workspaceId},${sourceId},1,'{}',${admin.json([{ triggerId, revision: 1 }])},'fixture',${digest("fixture")},'test','test','fixture','{}')`;
      await expect(migrate(ownerUrl)).rejects.toThrow("automation-event:");
      await admin`INSERT INTO automation_runs(id,account_id,workspace_id,source_id,trigger_id,trigger_revision,event_id,occurrence_key,accepted_execution)
        VALUES(${runId},${config.accountId},${config.workspaceId},${sourceId},${triggerId},1,${eventId},'fixture',${admin.json({ sessionTemplate: template })})`;
      await expect(migrate(ownerUrl)).rejects.toThrow("automation-run:");
      await admin`UPDATE automation_runs SET status='skipped' WHERE id=${runId}`;
      await migrate(ownerUrl);
      expect(
        (
          await admin`SELECT session_template FROM automation_trigger_revisions WHERE trigger_id=${triggerId}`
        )[0]!.session_template,
      ).toEqual(template);
      expect(
        (await admin`SELECT accepted_execution FROM automation_runs WHERE id=${runId}`)[0]!
          .accepted_execution,
      ).toEqual({ sessionTemplate: template });
      expect(
        (
          await admin`SELECT matched_trigger_revisions FROM automation_trigger_events WHERE id=${eventId}`
        )[0]!.matched_trigger_revisions,
      ).toEqual([{ triggerId, revision: 1 }]);
      for (const convertedFixture of configFixtures) {
        const [session] =
          await admin`SELECT skills FROM sessions WHERE id=${convertedFixture.sessionId}`;
        expect(session!.skills[0].files[0].content).toBe(
          `---\nname: "original-name"\ndescription: "Original description"\n---\n${files[0]!.content}`,
        );
        expect(session!.skills[0].files[1]).toEqual(files[1]);
        expect(session!.skills[1]).toEqual(convertedFixture.skills[1]);
        const receipts =
          await admin`SELECT source_kind,original_configuration,actor FROM skill_config_conversion_receipts WHERE workspace_id=${convertedFixture.workspaceId} ORDER BY source_kind`;
        expect([...receipts]).toEqual([
          {
            source_kind: "session",
            original_configuration: convertedFixture.skills,
            actor: "service:skill-migration:0431",
          },
          {
            source_kind: "workspace-pack",
            original_configuration: convertedFixture.manifest,
            actor: "service:skill-migration:0431",
          },
        ]);
      }
      expect([
        ...(await admin`SELECT manifest_snapshot,manifest_digest FROM pack_installations WHERE id=${pinnedId}`),
      ]).toEqual([
        {
          manifest_snapshot: config.manifest,
          manifest_digest: digest(JSON.stringify(config.manifest)),
        },
      ]);
      await expect(
        admin`UPDATE skill_config_conversion_receipts SET actor=actor`.execute(),
      ).rejects.toThrow();
      expect(await owner`SELECT source_id FROM skill_config_conversion_receipts`).toHaveLength(0);
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${config.accountId},true),set_config('opengeni.workspace_id',${config.workspaceId},true)`;
        expect(await tx`SELECT source_id FROM skill_config_conversion_receipts`).toHaveLength(2);
      });
      await migrate(ownerUrl);
      expect(await admin`SELECT source_id FROM skill_config_conversion_receipts`).toHaveLength(4);
      const reader = createDb(owned!.adminUrl);
      try {
        const context = { accountId: config.accountId, workspaceId: config.workspaceId };
        const expiredId = legacyRows.find((row) => row.scope === "organization")!.id;
        expect((await listSkillDescriptors(reader.db, context)).map((row) => row.id)).not.toContain(
          expiredId,
        );
        const [expired] = await listSkillRecords(reader.db, context, { skillId: expiredId });
        expect(expired!.status).toBe("expired");
        expect(expired!.files[0]!.content).toBe(yaml);
        const [historical] = await listSkillRecords(reader.db, context, {
          skillId: expiredId,
          revisionId: legacyRows.find((row) => row.id === expiredId)!.revisionId,
        });
        expect(historical!.status).toBe("expired");
      } finally {
        await reader.close();
      }
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
        await admin`select id from preference_registry_events where actor_subject_id='service:skill-migration:0431'`,
      ).toHaveLength(7);
      const restored =
        await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relname=any(${windowTables})`;
      expect(restored).toHaveLength(windowTables.length);
      for (const table of restored)
        expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(await owner`select id from capability_plugin_installations`).toHaveLength(0);
      expect(await owner`select id from preference_registry_preferences`).toHaveLength(0);
      expect(await owner`select preference_id from skill_source_bindings`).toHaveLength(0);
      await expect(
        owner.begin(async (tx) => {
          await migrateLegacySkillConfigurations(tx);
        }),
      ).rejects.toThrow("maintenance owner window");
      // Conversion archives are private workspace-owned evidence, not a reason
      // to retain a deleted workspace or grant its runtime access to old text.
      const archiveWorkspaceId = crypto.randomUUID();
      const archiveSourceId = crypto.randomUUID();
      await admin`INSERT INTO workspaces(id,account_id,name)
        VALUES(${archiveWorkspaceId},${config.accountId},'Archive retention test')`;
      await admin`INSERT INTO skill_config_conversion_receipts(account_id,workspace_id,source_kind,source_id,original_configuration,original_hash,replacement_hash)
        VALUES(${config.accountId},${archiveWorkspaceId},'session',${archiveSourceId},'[]',${digest("[]")},${digest("[]")})`;
      await expect(
        admin`DELETE FROM skill_config_conversion_receipts WHERE workspace_id=${archiveWorkspaceId}`.execute(),
      ).rejects.toThrow("immutable");
      await expect(
        admin.begin(async (tx) => {
          await tx`SET LOCAL ROLE opengeni_app`;
          await tx`SELECT set_config('opengeni.account_id',${config.accountId},true),set_config('opengeni.workspace_id',${archiveWorkspaceId},true)`;
          await tx`SELECT original_configuration FROM skill_config_conversion_receipts`;
        }),
      ).rejects.toThrow("permission denied");
      await admin`DELETE FROM workspaces WHERE id=${archiveWorkspaceId}`;
      expect(
        await admin`SELECT source_id FROM skill_config_conversion_receipts WHERE workspace_id=${archiveWorkspaceId}`,
      ).toHaveLength(0);
    } finally {
      await owner.end();
    }
  }, 180_000);
});
