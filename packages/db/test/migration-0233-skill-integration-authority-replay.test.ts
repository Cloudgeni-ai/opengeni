import { describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { listSkillLibraryEntries, loadSkillLibrarySkill } from "@opengeni/runtime/skill-library";
import postgres from "postgres";

import {
  bootstrapWorkspace,
  createDb,
  listInstalledPortableSkills,
  listInstalledSkills,
} from "../src";
import { migrate } from "../src/migrate";

const migrationName = "0233_skill_and_integration_authority_cutover.sql";

describe("Skill and Integration authority migration replay", () => {
  test("preserves exact curated selection and makes the generic ledger MCP-only", async () => {
    const shared = await acquireCapabilityAuthorityDatabase();
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error(
          "[migration-0231-capability-authority] PostgreSQL is required but unavailable",
        );
      }
      return;
    }
    let app = createDb(shared.appUrl);
    try {
      const grant = (
        await bootstrapWorkspace(app.db, {
          accountExternalSource: "test",
          accountExternalId: `capability-authority-account-${crypto.randomUUID()}`,
          accountName: "Capability authority account",
          workspaceExternalSource: "test",
          workspaceExternalId: `capability-authority-workspace-${crypto.randomUUID()}`,
          workspaceName: "Capability authority workspace",
          subjectId: "user:capability-authority",
        })
      ).workspaceGrants[0]!;
      await app.close();

      const entry = listSkillLibraryEntries().find((candidate) => candidate.id === "checkov")!;
      const loaded = loadSkillLibrarySkill(entry.id, entry.version);

      await shared.admin`
        alter table capability_catalog_items
          drop constraint capability_catalog_items_kind_authority_chk
      `;
      await shared.admin`
        alter table capability_installations
          drop constraint capability_installations_kind_authority_chk
      `;
      await shared.admin`
        insert into capability_catalog_items (
          id,
          account_id,
          workspace_id,
          kind,
          source,
          name,
          description,
          category,
          tags,
          homepage_url,
          provenance,
          metadata
        ) values (
          ${`skill:${entry.id}`},
          ${grant.accountId},
          ${grant.workspaceId},
          'skill',
          'library',
          ${entry.name},
          ${entry.description},
          ${entry.category},
          ${shared.admin.json([...entry.tags])},
          ${entry.sourceUrl},
          ${entry.provenance},
          ${shared.admin.json({
            libraryId: entry.id,
            version: entry.version,
            contentSha256: entry.contentSha256,
            sourceCommit: entry.sourceCommit,
            provenance: entry.provenance,
          })}
        )
      `;
      await shared.admin`
        insert into capability_installations (
          account_id,
          workspace_id,
          capability_id,
          kind,
          status,
          config,
          metadata
        ) values (
          ${grant.accountId},
          ${grant.workspaceId},
          ${`skill:${entry.id}`},
          'skill',
          'active',
          ${shared.admin.json({ version: entry.version })},
          ${shared.admin.json({
            libraryId: entry.id,
            libraryVersion: entry.version,
            contentSha256: entry.contentSha256,
            sourceCommit: entry.sourceCommit,
            provenance: entry.provenance,
          })}
        )
      `;

      for (const kind of ["api", "plugin", "pack"] as const) {
        const capabilityId = `${kind}:obsolete-${kind}`;
        await shared.admin`
          insert into capability_catalog_items (
            id,
            account_id,
            workspace_id,
            kind,
            source,
            name,
            category
          ) values (
            ${capabilityId},
            ${grant.accountId},
            ${grant.workspaceId},
            ${kind},
            'manual',
            ${`Obsolete ${kind}`},
            'test'
          )
        `;
        await shared.admin`
          insert into capability_installations (
            account_id,
            workspace_id,
            capability_id,
            kind,
            status
          ) values (
            ${grant.accountId},
            ${grant.workspaceId},
            ${capabilityId},
            ${kind},
            'active'
          )
        `;
      }

      const mcpCapabilityId = "mcp:retained-authority";
      await shared.admin`
        insert into capability_catalog_items (
          id,
          account_id,
          workspace_id,
          kind,
          source,
          name,
          category,
          endpoint_url
        ) values (
          ${mcpCapabilityId},
          ${grant.accountId},
          ${grant.workspaceId},
          'mcp',
          'manual',
          'Retained MCP',
          'integrations',
          'https://mcp.example.com'
        )
      `;
      await shared.admin`
        insert into capability_installations (
          account_id,
          workspace_id,
          capability_id,
          kind,
          status
        ) values (
          ${grant.accountId},
          ${grant.workspaceId},
          ${mcpCapabilityId},
          'mcp',
          'active'
        )
      `;

      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);

      const [genericState] = await shared.admin<
        Array<{ catalogKinds: string[]; installationKinds: string[] }>
      >`
        select
          array(
            select distinct kind
            from capability_catalog_items
            where workspace_id = ${grant.workspaceId}
            order by kind
          ) as "catalogKinds",
          array(
            select distinct kind
            from capability_installations
            where workspace_id = ${grant.workspaceId}
            order by kind
          ) as "installationKinds"
      `;
      expect(genericState).toEqual({
        catalogKinds: ["mcp"],
        installationKinds: ["mcp"],
      });

      app = createDb(shared.appUrl);
      const summaries = await listInstalledSkills(app.db, grant.workspaceId);
      expect(summaries).toEqual([
        expect.objectContaining({
          capabilityId: `skill:${entry.id}`,
          pluginKey: `skill/library/${entry.id}`,
          source: "library",
          version: entry.version,
          provenance: entry.provenance,
          contentSha256: entry.contentSha256,
          fileCount: loaded.skill.files.length,
          owners: [
            {
              kind: "direct",
              id: `skill:${entry.id}`,
              removable: true,
            },
          ],
        }),
      ]);
      const runtime = await listInstalledPortableSkills(app.db, grant.workspaceId);
      expect(runtime).toEqual([
        expect.objectContaining({
          capabilityId: `skill:${entry.id}`,
          source: "library",
          version: entry.version,
          contentSha256: entry.contentSha256,
          files: loaded.skill.files,
        }),
      ]);
      await app.close();

      const blockedGenericSkillWrite = (async () => {
        await shared.admin`
          insert into capability_installations (
            account_id,
            workspace_id,
            capability_id,
            kind,
            status
          ) values (
            ${grant.accountId},
            ${grant.workspaceId},
            'skill:blocked-after-cutover',
            'skill',
            'active'
          )
        `;
      })();
      await expect(blockedGenericSkillWrite).rejects.toThrow();

      await shared.admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(shared.adminUrl);

      const [replayed] = await shared.admin<Array<{ skillCount: number; mcpCount: number }>>`
        select
          (
            select count(*)::int
            from capability_skill_facets
            where capability_id = ${`skill:${entry.id}`}
          ) as "skillCount",
          (
            select count(*)::int
            from capability_installations
            where workspace_id = ${grant.workspaceId}
              and capability_id = ${mcpCapabilityId}
              and kind = 'mcp'
          ) as "mcpCount"
      `;
      expect(replayed).toEqual({ skillCount: 1, mcpCount: 1 });
    } finally {
      await app.close().catch(() => undefined);
      await shared.release();
    }
  }, 180_000);
});

async function acquireCapabilityAuthorityDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_CAPABILITY_AUTHORITY_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_CAPABILITY_AUTHORITY_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_CAPABILITY_AUTHORITY_TEST_POSTGRES_ADMIN_URL and OPENGENI_CAPABILITY_AUTHORITY_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (!adminUrl || !appUrl) {
    return await acquireSharedTestDatabase("migration-0231-capability-authority");
  }
  await migrate(adminUrl);
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}
