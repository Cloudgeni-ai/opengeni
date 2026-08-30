// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createDb,
  createWorkspaceGatewayCustomModel,
  deleteWorkspaceGatewayCustomModel,
  getDeploymentModelCatalog,
  getWorkspaceGatewayCustomModelForExecution,
  listWorkspaceGatewayCustomModels,
  migrate,
  provisionRoles,
  type DbClient,
} from "../src";
import {
  FORCE_RLS_TABLES,
  NON_RLS_RUNTIME_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_ONLY_TABLES,
} from "../src/runtime-posture";

const migrationUrl = new URL(
  "../drizzle/0383_model_catalog_and_gateway_custom_models.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0383-model-catalog");
  if (!shared && requireRealDatabase) {
    throw new Error("migration 0383 requires real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0383 model catalog and Gateway custom models", () => {
  test("pins maintenance posture, runtime drain, least privilege, and secret-free storage", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("-- deployment-mode: maintenance");
    expect(migration).toContain("opengeni.migration_application_roles");
    expect(migration).toContain("model_catalog_runtime_drain_before");
    expect(migration).toContain("model_catalog_runtime_drain_after");
    expect(migration).toContain("pg_stat_activity");
    expect(migration).toContain("CREATE TABLE deployment_model_catalog");
    expect(migration).toContain("CREATE TABLE workspace_gateway_custom_models");
    expect(migration).toContain("session_command_receipts_prompt_actor_operation_idx");
    expect(migration).toContain("WHERE action IN ('prompt.send', 'prompt.steer')");
    expect(migration).toContain(
      "ALTER TABLE workspace_gateway_custom_models FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("model_catalog_table_acl_reset");
    expect(migration).toContain("pg_catalog.aclexplode");
    expect(migration).toContain("privilege.grantee <> relation.relowner");
    expect(migration).toContain("REVOKE ALL ON TABLE %I.%I FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON TABLE %I.%I FROM %I");
    expect(migration).toContain("migration_application_roles list above is drain detection only");
    expect(migration).not.toContain("DO $grants$");
    expect(migration).not.toContain("GRANT SELECT ON TABLE %I.deployment_model_catalog");
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.workspace_gateway_custom_models",
    );
    expect(migration).toContain("jsonb_array_elements_text(configured_roles)");
    expect(migration).not.toContain("TO opengeni_app");
    expect(migration).toContain("octet_length(upstream_model_id) BETWEEN 1 AND 238");
    expect(migration).toContain("upstream_model_id ~ '^[!-~]+$'");
    expect(migration).toContain("upstream_model_id !~ '[|]'");
    expect(migration).not.toContain("{1,256}");

    const catalogTable = migration.slice(
      migration.indexOf("CREATE TABLE deployment_model_catalog"),
      migration.indexOf("COMMENT ON TABLE deployment_model_catalog"),
    );
    const customTable = migration.slice(
      migration.indexOf("CREATE TABLE workspace_gateway_custom_models"),
      migration.indexOf("CREATE UNIQUE INDEX workspace_gateway_custom_models"),
    );
    for (const tableSql of [catalogTable, customTable]) {
      expect(tableSql).not.toMatch(/api[_ ]?key|billing|enabled|credential/i);
    }
  });

  test("registers the exact runtime posture", () => {
    expect(NON_RLS_RUNTIME_TABLES).toContain("deployment_model_catalog");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("deployment_model_catalog");
    expect(FORCE_RLS_TABLES).toContain("workspace_gateway_custom_models");
    expect(RUNTIME_FULL_DML_TABLES).toContain("workspace_gateway_custom_models");
  });

  test("uses the rotation role list only for drain detection", async () => {
    const rotation = await acquireSharedTestDatabase("migration-0381-role-rotation");
    if (!rotation) {
      if (requireRealDatabase) throw new Error("migration 0381 requires real PostgreSQL");
      return;
    }
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const oldRole = `og_381_old_${suffix}`;
    const newRole = `og_381_new_${suffix}`;
    const newPassword = randomUUID().replaceAll("-", "");

    const privileges = async () => {
      const [row] = await rotation.admin<
        Array<{
          oldCatalogSelect: boolean;
          oldCustomSelect: boolean;
          oldCustomInsert: boolean;
          oldCustomUpdate: boolean;
          oldCustomDelete: boolean;
          newCatalogSelect: boolean;
          newCatalogInsert: boolean;
          newCustomSelect: boolean;
          newCustomInsert: boolean;
          newCustomUpdate: boolean;
          newCustomDelete: boolean;
        }>
      >`select
          has_table_privilege(${oldRole}, 'deployment_model_catalog', 'SELECT')
            as "oldCatalogSelect",
          has_table_privilege(${oldRole}, 'workspace_gateway_custom_models', 'SELECT')
            as "oldCustomSelect",
          has_table_privilege(${oldRole}, 'workspace_gateway_custom_models', 'INSERT')
            as "oldCustomInsert",
          has_table_privilege(${oldRole}, 'workspace_gateway_custom_models', 'UPDATE')
            as "oldCustomUpdate",
          has_table_privilege(${oldRole}, 'workspace_gateway_custom_models', 'DELETE')
            as "oldCustomDelete",
          has_table_privilege(${newRole}, 'deployment_model_catalog', 'SELECT')
            as "newCatalogSelect",
          has_table_privilege(${newRole}, 'deployment_model_catalog', 'INSERT')
            as "newCatalogInsert",
          has_table_privilege(${newRole}, 'workspace_gateway_custom_models', 'SELECT')
            as "newCustomSelect",
          has_table_privilege(${newRole}, 'workspace_gateway_custom_models', 'INSERT')
            as "newCustomInsert",
          has_table_privilege(${newRole}, 'workspace_gateway_custom_models', 'UPDATE')
            as "newCustomUpdate",
          has_table_privilege(${newRole}, 'workspace_gateway_custom_models', 'DELETE')
            as "newCustomDelete"`;
      return row!;
    };

    try {
      await rotation.admin.unsafe(`
        CREATE ROLE "${oldRole}" WITH LOGIN;
        CREATE ROLE "${newRole}" WITH LOGIN;
        DROP TABLE workspace_gateway_custom_models;
        DROP TABLE deployment_model_catalog;
        DROP INDEX session_command_receipts_prompt_actor_operation_idx;
        DELETE FROM schema_migrations
        WHERE name = '0381_model_catalog_and_gateway_custom_models.sql';
      `);

      await migrate(rotation.adminUrl, undefined, {
        applicationDatabaseRoles: [oldRole, newRole],
      });
      expect(await privileges()).toEqual({
        oldCatalogSelect: false,
        oldCustomSelect: false,
        oldCustomInsert: false,
        oldCustomUpdate: false,
        oldCustomDelete: false,
        newCatalogSelect: false,
        newCatalogInsert: false,
        newCustomSelect: false,
        newCustomInsert: false,
        newCustomUpdate: false,
        newCustomDelete: false,
      });

      await provisionRoles(rotation.adminUrl, {
        appRole: newRole,
        appPassword: newPassword,
        rlsStrategy: "force",
      });
      expect(await privileges()).toEqual({
        oldCatalogSelect: false,
        oldCustomSelect: false,
        oldCustomInsert: false,
        oldCustomUpdate: false,
        oldCustomDelete: false,
        newCatalogSelect: true,
        newCatalogInsert: false,
        newCustomSelect: true,
        newCustomInsert: true,
        newCustomUpdate: true,
        newCustomDelete: true,
      });
    } finally {
      for (const role of [oldRole, newRole]) {
        await rotation.admin.unsafe(`DROP OWNED BY "${role}"`).catch(() => undefined);
        await rotation.admin.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      }
      await rotation.release();
    }
  }, 180_000);

  test("reads the singleton and isolates workspace custom slugs", async () => {
    if (!shared || !client) return;

    await shared.admin`delete from deployment_model_catalog`;
    expect(await getDeploymentModelCatalog(client.db)).toBeNull();
    await shared.admin`
      insert into deployment_model_catalog (singleton, document, version)
      values (
        true,
        ${shared.admin.json({ schemaVersion: 1, builtInModels: ["gpt-5.6-luna"] })}::jsonb,
        7
      )
    `;
    expect(await getDeploymentModelCatalog(client.db)).toMatchObject({
      document: { schemaVersion: 1, builtInModels: ["gpt-5.6-luna"] },
      version: 7,
    });

    const [account] = await shared.admin<Array<{ id: string }>>`
      insert into managed_accounts (name) values ('migration 0383 account') returning id
    `;
    const [firstWorkspace, secondWorkspace] = await shared.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration 0383 first'), (${account!.id}, 'migration 0383 second')
      returning id
    `;
    await expect(
      createWorkspaceGatewayCustomModel(client.db, {
        accountId: account!.id,
        workspaceId: firstWorkspace!.id,
        upstreamModelId: "anthropic|claude",
        createdBySubjectId: "user:migration-0383",
      }),
    ).rejects.toThrow();
    const created = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: account!.id,
      workspaceId: firstWorkspace!.id,
      upstreamModelId: "anthropic/claude-sonnet-4.6",
      createdBySubjectId: "user:migration-0383",
    });
    expect(created.upstreamModelId).toBe("anthropic/claude-sonnet-4.6");
    expect(
      await listWorkspaceGatewayCustomModels(client.db, {
        accountId: account!.id,
        workspaceId: firstWorkspace!.id,
      }),
    ).toHaveLength(1);
    expect(
      await listWorkspaceGatewayCustomModels(client.db, {
        accountId: account!.id,
        workspaceId: secondWorkspace!.id,
      }),
    ).toEqual([]);
    expect(
      await deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: account!.id,
        workspaceId: secondWorkspace!.id,
        customModelId: created.id,
      }),
    ).toBe(false);
    expect(
      await deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: account!.id,
        workspaceId: firstWorkspace!.id,
        customModelId: created.id,
      }),
    ).toBe(true);
    expect(
      await listWorkspaceGatewayCustomModels(client.db, {
        accountId: account!.id,
        workspaceId: firstWorkspace!.id,
      }),
    ).toEqual([]);
    expect(
      await getWorkspaceGatewayCustomModelForExecution(client.db, {
        accountId: account!.id,
        workspaceId: firstWorkspace!.id,
        upstreamModelId: created.upstreamModelId,
      }),
    ).toMatchObject({ id: created.id, retiredAt: expect.any(Date) });
    const restored = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: account!.id,
      workspaceId: firstWorkspace!.id,
      upstreamModelId: created.upstreamModelId,
      label: "A replacement label must not rewrite accepted definition identity",
      createdBySubjectId: "user:replacement",
    });
    expect(restored).toMatchObject({ id: created.id, label: null, retiredAt: null });
  });
});
