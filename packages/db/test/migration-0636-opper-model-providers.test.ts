// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

import {
  createDb,
  createOrganizationModelProviderCustomModel,
  createWorkspaceProviderCustomModel,
  getOrganizationModelProviderCatalogForWorkspace,
  listWorkspaceProviderCustomModelsByKind,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";

const migrationUrl = new URL("../drizzle/0636_opper_model_providers.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0636-opper-model-providers");
  if (!shared) throw new Error("migration 0636 requires real PostgreSQL");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0636 Opper model providers", () => {
  test("is a rolling allow-list widening with no row rewrite or RLS window", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    for (const table of [
      "workspace_gateway_custom_models",
      "organization_model_provider_connections",
      "organization_model_provider_connection_operations",
      "organization_model_provider_custom_models",
    ])
      expect(migration).toContain(`'${table}'`);
    expect(migration).toContain(
      "''vercel_gateway'', ''openrouter'', ''anthropic'', ''claude_subscription'', ''opper''",
    );
    expect(migration).toContain("'opper', 'workspace-opper', 'organization-opper', 'registry'");
    expect(migration).toContain("'codex', 'supergrok', 'vercel_gateway', 'openrouter'");
    expect(migration).not.toContain("NO FORCE ROW LEVEL SECURITY");
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/imu);
  });

  test("admits Opper organization and workspace rows and exports the Opper analytics families", async () => {
    if (!client || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('opper-provider-test') returning id`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const owner = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;

    // The organization insert fires the `model.connected` lifecycle capture,
    // which rejects an attribute outside product_lifecycle_fact_valid.
    const connected = await upsertOrganizationModelProviderConnection(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "opper",
      credentialEncrypted: "encrypted-test-key",
      credentialDigest: "credential-digest",
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    expect(connected).toMatchObject({ providerKind: "opper", status: "active", version: 1 });
    await createOrganizationModelProviderCustomModel(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "opper",
      upstreamModelId: "mistral/mistral-large-eu",
      operationId: crypto.randomUUID(),
    });
    const organizationCatalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKinds: ["opper"],
    });
    expect(organizationCatalog.opper.active).toBe(true);
    expect(organizationCatalog.opper.models.map((model) => model.upstreamModelId)).toEqual([
      "mistral/mistral-large-eu",
    ]);

    await createWorkspaceProviderCustomModel(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKind: "opper",
      upstreamModelId: "gemini-3.8-flash",
      label: "Gemini pool",
      operationId: crypto.randomUUID(),
      requestHash: "c".repeat(64),
      createdBySubjectId: owner,
    });
    const workspaceModels = await listWorkspaceProviderCustomModelsByKind(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKinds: ["openrouter", "opper"],
    });
    expect(workspaceModels.opper.map((model) => model.upstreamModelId)).toEqual([
      "gemini-3.8-flash",
    ]);
    expect(workspaceModels.openrouter).toEqual([]);

    const [families] = await shared.admin<{ managed: string; workspace: string; org: string }[]>`
      select opengeni_private.analytics_model_provider('opper') as managed,
        opengeni_private.analytics_model_provider('workspace-opper') as workspace,
        opengeni_private.analytics_model_provider('organization-opper') as org`;
    expect(families).toEqual({
      managed: "opper",
      workspace: "workspace-opper",
      org: "organization-opper",
    });
    const [lifecycle] = await shared.admin<{ valid: boolean; invalid: boolean }[]>`
      select opengeni_private.product_lifecycle_fact_valid('model.connected', 'opper') as valid,
        opengeni_private.product_lifecycle_fact_valid('model.connected', 'opper-x') as invalid`;
    expect(lifecycle).toEqual({ valid: true, invalid: false });
  });
});
