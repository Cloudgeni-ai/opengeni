import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { CapabilityPack, stableJson } from "@opengeni/contracts";
import { listSkillLibraryEntries, loadSkillLibrarySkill } from "@opengeni/runtime/skill-library";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import { bootstrapWorkspace, createDb, installPortableSkill } from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0247_terraform_stacks_provenance_repair.sql";
const resolutionFenceMigrationName = "0248_terraform_stacks_component_resolution_fence.sql";
const oldUrl =
  "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-stacks";
const newUrl =
  "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/terraform-stacks";
const oldDigest = "d484ccc1279954e5dbcdd9b8b57bc21e6a0fa47d38dc11854ffcf8e61289e883";
const newDigest = "3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809";
const oldManifest = {
  schemaVersion: 1,
  kind: "skill",
  source: "library",
  sourceUrl: oldUrl,
  repositoryUrl: "https://github.com/hashicorp/agent-skills",
  version: "0.0.1",
  sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
  sourcePath: "terraform-stacks",
  sourceProvenance: "Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.",
  contentSha256: "0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35",
  fileCount: 7,
  totalBytes: 104793,
};

const migration = await Bun.file(new URL(`../drizzle/${migrationName}`, import.meta.url)).text();
const resolutionFenceMigration = await Bun.file(
  new URL(`../drizzle/${resolutionFenceMigrationName}`, import.meta.url),
).text();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("migration 0247 Terraform Stacks provenance repair", () => {
  test("is a maintenance-only exact immutable projection repair", () => {
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(migration).toContain("all opengeni_app sessions to be stopped");
    expect(migration).toContain("LOCK TABLE workspace_packs IN ACCESS EXCLUSIVE MODE");
    expect(migration).toContain("LOCK TABLE pack_installations IN ACCESS EXCLUSIVE MODE");
    expect(migration).toContain("DISABLE TRIGGER capability_skill_facets_immutable");
    expect(migration).toContain("DISABLE TRIGGER capability_plugin_versions_restrict_update");
    expect(migration).toContain("ENABLE TRIGGER capability_plugin_versions_restrict_update");
    expect(migration).toContain("ENABLE TRIGGER capability_skill_facets_immutable");
    expect(migration).toContain("skill.name <> 'terraform-stacks'");
    expect(migration).toContain(oldUrl);
    expect(migration).toContain(newUrl);
    expect(migration).toContain(oldDigest);
    expect(migration).toContain(newDigest);
    expect(migration).toContain("found unexpected immutable state");
    expect(migration).toContain("found unexpected Pack state");
    expect(migration).toContain("cannot reproduce the stored runtime Pack digest");
    expect(migration).toContain("repair did not converge");
    expect(migration).toContain("terraform_stacks_provenance_js_en_us");
    expect(migration).toContain(
      "DROP FUNCTION opengeni_private.terraform_stacks_provenance_rewrite_pack(jsonb)",
    );
    expect(resolutionFenceMigration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(resolutionFenceMigration).toContain("all opengeni_app sessions to be stopped");
    expect(resolutionFenceMigration).toContain(
      "LOCK TABLE capability_plugin_installations IN ACCESS EXCLUSIVE MODE",
    );
    expect(resolutionFenceMigration).toContain("installation.account_id = component.account_id");
    expect(resolutionFenceMigration).toContain(
      "installation.workspace_id = component.workspace_id",
    );
    expect(resolutionFenceMigration).toContain("installation.status = 'active'");
    expect(resolutionFenceMigration).toContain("version.manifest_digest = component.digest");
    expect(resolutionFenceMigration).toContain(
      "component resolution fence found unexpected Pack state",
    );
  });

  test("repairs exact Skill and Pack projections, replays runtime installation, and fails closed", async () => {
    const adminUrl = process.env.OPENGENI_MIGRATION_0247_TEST_POSTGRES_ADMIN_URL;
    const appUrl = process.env.OPENGENI_MIGRATION_0247_TEST_POSTGRES_APP_URL;
    if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
      throw new Error(
        "OPENGENI_MIGRATION_0247_TEST_POSTGRES_ADMIN_URL and OPENGENI_MIGRATION_0247_TEST_POSTGRES_APP_URL must be set together",
      );
    }
    const shared =
      adminUrl && appUrl
        ? await (async () => {
            await migrate(adminUrl);
            const admin = postgres(adminUrl, { max: 4 });
            return {
              admin,
              adminUrl,
              appUrl,
              release: async () => await admin.end().catch(() => undefined),
            };
          })()
        : await acquireSharedTestDatabase("migration-0247-terraform-stacks-provenance");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error(
          "[migration-0247-terraform-stacks-provenance] PostgreSQL is required but unavailable",
        );
      }
      return;
    }
    let app: ReturnType<typeof createDb> | null = createDb(shared.appUrl);
    try {
      const suffix = crypto.randomUUID();
      const grant = (
        await bootstrapWorkspace(app.db, {
          accountExternalSource: "test",
          accountExternalId: `terraform-stacks-repair-account-${suffix}`,
          accountName: "Terraform Stacks repair account",
          workspaceExternalSource: "test",
          workspaceExternalId: `terraform-stacks-repair-workspace-${suffix}`,
          workspaceName: "Terraform Stacks repair workspace",
          subjectId: `user:terraform-stacks-repair-${suffix}`,
        })
      ).workspaceGrants[0]!;
      await app.close();
      app = null;

      const entry = listSkillLibraryEntries().find(
        (candidate) => candidate.id === "terraform-stacks",
      )!;
      const loaded = loadSkillLibrarySkill(entry.id, entry.version);
      const files = loaded.skill.files.map((file) => ({
        path: file.path,
        content: file.content,
        byteSize: Buffer.byteLength(file.content),
        contentSha256: sha256(file.content),
      }));
      const totalBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
      expect(entry.sourceUrl).toBe(newUrl);
      expect(entry.contentSha256).toBe(oldManifest.contentSha256);
      expect(files).toHaveLength(oldManifest.fileCount);
      expect(totalBytes).toBe(oldManifest.totalBytes);

      const packId = `terraform-stacks-provenance-${suffix}`;
      const oldPackManifest = CapabilityPack.parse({
        id: packId,
        name: "Terraform Stacks provenance fixture",
        description: "Exercises exact Skill Plugin digest references in Pack state.",
        role: "test",
        category: "test",
        version: "1.0.0",
        components: [
          {
            key: "skills/terraform-stacks",
            kind: "plugin",
            pluginKey: "skill/library/terraform-stacks",
            version: "0.0.1",
            manifestDigest: oldDigest,
            required: true,
          },
        ],
        metadata: { A: 1, a: 2 },
      });
      const newPackManifest = CapabilityPack.parse({
        ...oldPackManifest,
        components: oldPackManifest.components.map((component) => ({
          ...component,
          manifestDigest: newDigest,
        })),
      });
      const oldPackJson = JSON.parse(stableJson(oldPackManifest)) as postgres.JSONValue;
      const newPackJson = JSON.parse(stableJson(newPackManifest)) as postgres.JSONValue;
      const oldPackDigest = sha256(stableJson(oldPackManifest));
      const newPackDigest = sha256(stableJson(newPackManifest));

      const [plugin] = await shared.admin<Array<{ id: string }>>`
        insert into capability_plugins (
          plugin_key, account_id, workspace_id, name, description, category, tags, provenance
        ) values (
          'skill/library/terraform-stacks',
          ${grant.accountId},
          ${grant.workspaceId},
          ${entry.name},
          ${entry.description},
          ${entry.category},
          ${shared.admin.json([...entry.tags])},
          'platform'
        )
        returning id
      `;
      const [version] = await shared.admin<Array<{ id: string }>>`
        insert into capability_plugin_versions (
          plugin_id, version, manifest_digest, manifest, status
        ) values (
          ${plugin!.id},
          ${entry.version},
          ${oldDigest},
          ${shared.admin.json(oldManifest)},
          'published'
        )
        returning id
      `;
      const [facet] = await shared.admin<Array<{ id: string }>>`
        insert into capability_facets (
          plugin_version_id, facet_key, kind, activation_mode, required
        ) values (${version!.id}, 'skill', 'skill', 'workspace_managed', true)
        returning id
      `;
      await shared.admin`
        insert into capability_skill_facets (
          facet_id, capability_id, name, description, source_url, source_commit,
          source_path, content_sha256, file_count, total_bytes, license
        ) values (
          ${facet!.id},
          'skill:terraform-stacks',
          ${entry.name},
          ${entry.description},
          ${oldUrl},
          ${entry.sourceCommit},
          ${entry.relativePath},
          ${entry.contentSha256},
          ${files.length},
          ${totalBytes},
          ${entry.license}
        )
      `;
      for (const file of files) {
        await shared.admin`
          insert into capability_skill_files (
            skill_facet_id, path, content, byte_size, content_sha256
          ) values (
            ${facet!.id}, ${file.path}, ${file.content}, ${file.byteSize}, ${file.contentSha256}
          )
        `;
      }
      const [pluginInstallation] = await shared.admin<Array<{ id: string; version: number }>>`
        insert into capability_plugin_installations (
          account_id, workspace_id, plugin_id, plugin_version_id, status, version,
          installed_by_subject_id
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${plugin!.id}, ${version!.id}, 'active', 3,
          ${grant.subjectId}
        )
        returning id, version
      `;
      const decoyManifest = {
        schemaVersion: 1,
        kind: "plugin",
        version: "9.9.9",
        source: "review-fixture",
      };
      const decoyDigest = sha256(stableJson(decoyManifest));
      const [decoyPlugin] = await shared.admin<Array<{ id: string }>>`
        insert into capability_plugins (
          plugin_key, account_id, workspace_id, name, description, category, tags, provenance
        ) values (
          ${`review/resolved-id-decoy/${suffix}`},
          ${grant.accountId},
          ${grant.workspaceId},
          'Resolved id decoy',
          'Valid unrelated Plugin installation for the migration resolution fence regression.',
          'review',
          '[]'::jsonb,
          'workspace'
        )
        returning id
      `;
      const [decoyVersion] = await shared.admin<Array<{ id: string }>>`
        insert into capability_plugin_versions (
          plugin_id, version, manifest_digest, manifest, status
        ) values (
          ${decoyPlugin!.id},
          '9.9.9',
          ${decoyDigest},
          ${shared.admin.json(decoyManifest)},
          'published'
        )
        returning id
      `;
      const [decoyPluginInstallation] = await shared.admin<Array<{ id: string }>>`
        insert into capability_plugin_installations (
          account_id, workspace_id, plugin_id, plugin_version_id, status, version,
          installed_by_subject_id
        ) values (
          ${grant.accountId},
          ${grant.workspaceId},
          ${decoyPlugin!.id},
          ${decoyVersion!.id},
          'active',
          1,
          ${grant.subjectId}
        )
        returning id
      `;
      const [facetInstallation] = await shared.admin<Array<{ id: string; version: number }>>`
        insert into capability_facet_installations (
          account_id, workspace_id, plugin_installation_id, facet_id, status, config, version
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${pluginInstallation!.id}, ${facet!.id},
          'active', '{}'::jsonb, 4
        )
        returning id, version
      `;
      const [directOwner] = await shared.admin<Array<{ id: string }>>`
        insert into capability_component_owners (
          account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${facetInstallation!.id},
          'direct', 'skill:terraform-stacks', true
        )
        returning id
      `;
      const [workspacePack] = await shared.admin<Array<{ id: string }>>`
        insert into workspace_packs (account_id, workspace_id, pack_id, manifest)
        values (
          ${grant.accountId}, ${grant.workspaceId}, ${packId},
          ${shared.admin.json(oldPackJson)}
        )
        returning id
      `;
      const [packInstallation] = await shared.admin<Array<{ id: string; version: number }>>`
        insert into pack_installations (
          account_id, workspace_id, pack_id, status, version, manifest_snapshot,
          manifest_digest, installed_by_subject_id, metadata
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${packId}, 'active', 5,
          ${shared.admin.json(oldPackJson)}, ${oldPackDigest}, ${grant.subjectId},
          '{"fixture":"migration-0247"}'::jsonb
        )
        returning id, version
      `;
      const [packOwner] = await shared.admin<Array<{ id: string }>>`
        insert into capability_component_owners (
          account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${facetInstallation!.id},
          'pack', ${packInstallation!.id}, false
        )
        returning id
      `;
      const [packComponent] = await shared.admin<Array<{ id: string }>>`
        insert into pack_installation_components (
          account_id, workspace_id, pack_installation_id, component_key, kind,
          capability_id, resolved_id, digest, metadata
        ) values (
          ${grant.accountId}, ${grant.workspaceId}, ${packInstallation!.id},
          'skills/terraform-stacks', 'plugin', 'plugin:skill/library/terraform-stacks',
          ${pluginInstallation!.id}, ${oldDigest},
          ${shared.admin.json({
            pluginKey: "skill/library/terraform-stacks",
            version: entry.version,
            facetInstallationIds: [facetInstallation!.id],
            bindingIds: [],
          })}
        )
        returning id
      `;

      const identityBefore = {
        pluginId: plugin!.id,
        pluginVersionId: version!.id,
        facetId: facet!.id,
        pluginInstallationId: pluginInstallation!.id,
        pluginInstallationVersion: pluginInstallation!.version,
        facetInstallationId: facetInstallation!.id,
        facetInstallationVersion: facetInstallation!.version,
        directOwnerId: directOwner!.id,
        workspacePackId: workspacePack!.id,
        packInstallationId: packInstallation!.id,
        packInstallationVersion: packInstallation!.version,
        packOwnerId: packOwner!.id,
        packComponentId: packComponent!.id,
      };
      const filesBefore = await shared.admin<
        Array<{
          id: string;
          path: string;
          content: string;
          byteSize: number;
          contentSha256: string;
        }>
      >`
        select id, path, content, byte_size as "byteSize", content_sha256 as "contentSha256"
        from capability_skill_files
        where skill_facet_id = ${facet!.id}
        order by path
      `;

      await shared.admin`
        update pack_installations
        set manifest_digest = ${"e".repeat(64)}
        where id = ${packInstallation!.id}
      `;
      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await expect(migrate(shared.adminUrl)).rejects.toThrow(
        "cannot reproduce the stored runtime Pack digest",
      );
      const [rolledBack] = await shared.admin<
        Array<{ sourceUrl: string; componentDigest: string }>
      >`
          select
            skill.source_url as "sourceUrl",
            component.digest as "componentDigest"
          from capability_skill_facets skill
          join pack_installation_components component on component.id = ${packComponent!.id}
          where skill.facet_id = ${facet!.id}
        `;
      expect(rolledBack).toEqual({ sourceUrl: oldUrl, componentDigest: oldDigest });
      await shared.admin`
        update pack_installations
        set manifest_digest = ${oldPackDigest}
        where id = ${packInstallation!.id}
      `;

      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);

      const [repaired] = await shared.admin<
        Array<{
          sourceUrl: string;
          manifestSourceUrl: string;
          manifestDigest: string;
          workspaceManifest: postgres.JSONValue;
          installationManifest: postgres.JSONValue;
          installationManifestDigest: string;
          componentDigest: string;
        }>
      >`
        select
          skill.source_url as "sourceUrl",
          version.manifest ->> 'sourceUrl' as "manifestSourceUrl",
          version.manifest_digest as "manifestDigest",
          workspace_pack.manifest as "workspaceManifest",
          pack_installation.manifest_snapshot as "installationManifest",
          pack_installation.manifest_digest as "installationManifestDigest",
          pack_component.digest as "componentDigest"
        from capability_skill_facets skill
        join capability_facets facet on facet.id = skill.facet_id
        join capability_plugin_versions version on version.id = facet.plugin_version_id
        join workspace_packs workspace_pack on workspace_pack.id = ${workspacePack!.id}
        join pack_installations pack_installation on pack_installation.id = ${packInstallation!.id}
        join pack_installation_components pack_component on pack_component.id = ${packComponent!.id}
        where skill.facet_id = ${facet!.id}
      `;
      expect(repaired).toEqual({
        sourceUrl: newUrl,
        manifestSourceUrl: newUrl,
        manifestDigest: newDigest,
        workspaceManifest: newPackJson,
        installationManifest: newPackJson,
        installationManifestDigest: newPackDigest,
        componentDigest: newDigest,
      });

      const [identityAfter] = await shared.admin<
        Array<{
          pluginId: string;
          pluginVersionId: string;
          facetId: string;
          pluginInstallationId: string;
          pluginInstallationVersion: number;
          facetInstallationId: string;
          facetInstallationVersion: number;
          directOwnerId: string;
          workspacePackId: string;
          packInstallationId: string;
          packInstallationVersion: number;
          packOwnerId: string;
          packComponentId: string;
        }>
      >`
        select
          plugin.id as "pluginId",
          version.id as "pluginVersionId",
          facet.id as "facetId",
          plugin_installation.id as "pluginInstallationId",
          plugin_installation.version as "pluginInstallationVersion",
          facet_installation.id as "facetInstallationId",
          facet_installation.version as "facetInstallationVersion",
          direct_owner.id as "directOwnerId",
          workspace_pack.id as "workspacePackId",
          pack_installation.id as "packInstallationId",
          pack_installation.version as "packInstallationVersion",
          pack_owner.id as "packOwnerId",
          pack_component.id as "packComponentId"
        from capability_plugins plugin
        join capability_plugin_versions version on version.plugin_id = plugin.id
        join capability_facets facet on facet.plugin_version_id = version.id
        join capability_plugin_installations plugin_installation
          on plugin_installation.plugin_id = plugin.id
        join capability_facet_installations facet_installation
          on facet_installation.plugin_installation_id = plugin_installation.id
        join capability_component_owners direct_owner
          on direct_owner.facet_installation_id = facet_installation.id
          and direct_owner.owner_kind = 'direct'
        join capability_component_owners pack_owner
          on pack_owner.facet_installation_id = facet_installation.id
          and pack_owner.owner_kind = 'pack'
        join workspace_packs workspace_pack on workspace_pack.id = ${workspacePack!.id}
        join pack_installations pack_installation on pack_installation.id = ${packInstallation!.id}
        join pack_installation_components pack_component on pack_component.id = ${packComponent!.id}
        where plugin.id = ${plugin!.id}
      `;
      expect(identityAfter).toEqual(identityBefore);
      expect(
        await shared.admin<
          Array<{
            id: string;
            path: string;
            content: string;
            byteSize: number;
            contentSha256: string;
          }>
        >`
          select id, path, content, byte_size as "byteSize", content_sha256 as "contentSha256"
          from capability_skill_files
          where skill_facet_id = ${facet!.id}
          order by path
        `,
      ).toEqual(filesBefore);

      app = createDb(shared.appUrl);
      expect(
        await installPortableSkill(app.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          capabilityId: "skill:terraform-stacks",
          pluginKey: "skill/library/terraform-stacks",
          source: "library",
          sourceUrl: entry.sourceUrl,
          repositoryUrl: "https://github.com/hashicorp/agent-skills",
          version: entry.version,
          sourceCommit: entry.sourceCommit,
          sourcePath: entry.relativePath,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          tags: [...entry.tags],
          provenance: "platform",
          sourceProvenance: entry.provenance,
          contentSha256: entry.contentSha256,
          totalBytes,
          license: entry.license,
          files,
        }),
      ).toEqual({
        created: false,
        capabilityId: "skill:terraform-stacks",
        pluginId: plugin!.id,
        pluginVersionId: version!.id,
        facetId: facet!.id,
        pluginInstallationId: pluginInstallation!.id,
        facetInstallationId: facetInstallation!.id,
        installationVersion: pluginInstallation!.version,
        source: "library",
        version: entry.version,
        sourceUrl: entry.sourceUrl,
        sourceCommit: entry.sourceCommit,
        contentSha256: entry.contentSha256,
        name: entry.name,
      });
      await app.close();
      app = null;

      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);

      const tamperedDigest = "f".repeat(64);
      await shared.admin`
        update pack_installation_components
        set digest = ${tamperedDigest}
        where id = ${packComponent!.id}
      `;
      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await expect(migrate(shared.adminUrl)).rejects.toThrow("unexpected Pack state");
      await shared.admin`
        update pack_installation_components
        set digest = ${newDigest}
        where id = ${packComponent!.id}
      `;
      await migrate(shared.adminUrl);

      await shared.admin`
        update pack_installation_components
        set metadata = jsonb_set(metadata, '{pluginKey}', '"tampered"'::jsonb)
        where id = ${packComponent!.id}
      `;
      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await expect(migrate(shared.adminUrl)).rejects.toThrow("unexpected Pack state");
      await shared.admin`
        update pack_installation_components
        set metadata = jsonb_set(
          metadata,
          '{pluginKey}',
          to_jsonb('skill/library/terraform-stacks'::text)
        )
        where id = ${packComponent!.id}
      `;
      await migrate(shared.adminUrl);

      await shared.admin`
        update pack_installation_components
        set resolved_id = ${decoyPluginInstallation!.id}
        where id = ${packComponent!.id}
      `;
      await shared.admin`
        delete from schema_migrations where name = ${resolutionFenceMigrationName}
      `;
      await expect(migrate(shared.adminUrl)).rejects.toThrow(
        "component resolution fence found unexpected Pack state",
      );
      const [rejectedResolution] = await shared.admin<
        Array<{ resolvedId: string; migrationRecorded: boolean }>
      >`
        select
          component.resolved_id as "resolvedId",
          exists (
            select 1 from schema_migrations
            where name = ${resolutionFenceMigrationName}
          ) as "migrationRecorded"
        from pack_installation_components component
        where component.id = ${packComponent!.id}
      `;
      expect(rejectedResolution).toEqual({
        resolvedId: decoyPluginInstallation!.id,
        migrationRecorded: false,
      });
      await shared.admin`
        update pack_installation_components
        set resolved_id = ${pluginInstallation!.id}
        where id = ${packComponent!.id}
      `;
      await migrate(shared.adminUrl);
      const [acceptedResolution] = await shared.admin<Array<{ migrationRecorded: boolean }>>`
        select exists (
          select 1 from schema_migrations
          where name = ${resolutionFenceMigrationName}
        ) as "migrationRecorded"
      `;
      expect(acceptedResolution).toEqual({ migrationRecorded: true });
    } finally {
      await app?.close();
      await shared.release();
    }
  }, 180_000);
});
