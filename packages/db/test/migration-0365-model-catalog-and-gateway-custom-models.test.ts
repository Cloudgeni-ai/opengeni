import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import {
  createDb,
  createWorkspaceGatewayCustomModel,
  deleteWorkspaceGatewayCustomModel,
  getDeploymentModelCatalog,
  listWorkspaceGatewayCustomModels,
  type DbClient,
} from "../src";
import {
  FORCE_RLS_TABLES,
  NON_RLS_RUNTIME_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_ONLY_TABLES,
} from "../src/runtime-posture";

const migrationUrl = new URL(
  "../drizzle/0365_model_catalog_and_gateway_custom_models.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0365-model-catalog");
  if (!shared && requireRealDatabase) {
    throw new Error("migration 0365 requires real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0365 model catalog and Gateway custom models", () => {
  test("pins rolling posture, least privilege, and secret-free storage", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("-- deployment-mode: rolling");
    expect(migration).toContain("CREATE TABLE deployment_model_catalog");
    expect(migration).toContain("CREATE TABLE workspace_gateway_custom_models");
    expect(migration).toContain(
      "ALTER TABLE workspace_gateway_custom_models FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("GRANT SELECT ON TABLE %I.deployment_model_catalog");
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.workspace_gateway_custom_models",
    );

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
      insert into managed_accounts (name) values ('migration 0365 account') returning id
    `;
    const [firstWorkspace, secondWorkspace] = await shared.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration 0365 first'), (${account!.id}, 'migration 0365 second')
      returning id
    `;
    const created = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: account!.id,
      workspaceId: firstWorkspace!.id,
      upstreamModelId: "anthropic/claude-sonnet-4.6",
      createdBySubjectId: "user:migration-0365",
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
  });
});
