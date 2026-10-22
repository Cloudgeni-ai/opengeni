// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";

import {
  createDb,
  createOrganizationModelProviderCustomModel,
  encryptEnvironmentValue,
  getOrganizationModelProviderCatalogForWorkspace,
  getWorkspaceConnectionModelRestrictions,
  loadOrganizationModelProviderCredential,
  OrganizationModelProviderConflictError,
  revokeOrganizationModelProviderConnection,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";

const migrationUrl = new URL(
  "../drizzle/0898_organization_direct_openai_model_providers.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
const OTHER_ENDPOINT = "https://fabrikam.openai.azure.com/openai/v1";
const settings = testSettings({
  environmentsEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
});
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0898-organization-direct-openai");
  if (!shared) throw new Error("migration 0898 requires real PostgreSQL");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0898 organization OpenAI and Azure OpenAI model providers", () => {
  test("is a rolling allow-list widening plus nullable endpoint columns", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    for (const table of [
      "organization_model_provider_connections",
      "organization_model_provider_connection_operations",
      "organization_model_provider_custom_models",
    ])
      expect(migration).toContain(`'${table}'`);
    // Workspace custom models keep their own list: workspace Azure stays direct.
    expect(migration).not.toContain("'workspace_gateway_custom_models'");
    expect(migration).toContain(
      "''vercel_gateway'', ''openrouter'', ''anthropic'', ''claude_subscription'', ''opper''%s, ''openai'', ''azure_openai''",
    );
    // ElevenLabs (0895) stays on connections, never on custom models.
    expect(migration).toContain("''elevenlabs''");
    expect(migration).toContain("ADD COLUMN endpoint text;");
    expect(migration).toContain("ADD COLUMN result_endpoint text;");
    expect(migration).toContain("'opper', 'elevenlabs', 'openai', 'azure_openai'");
    expect(migration).toContain("'organization-opper', 'organization-openai',");
    expect(migration).not.toContain("NO FORCE ROW LEVEL SECURITY");
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/imu);
  });

  test("binds key and endpoint, keeps personal workspaces local and fails closed on revoke", async () => {
    if (!client || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-azure-openai-test') returning id`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const owner = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;
    const key = environmentsEncryptionKeyBytes(settings)!;
    const write = (input: {
      endpoint?: string | null;
      operationId?: string;
      expectedVersion: number;
      apiKey?: string;
    }) =>
      upsertOrganizationModelProviderConnection(client!.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "azure_openai",
        credentialEncrypted: encryptEnvironmentValue(key, input.apiKey ?? "azure-key-1"),
        credentialDigest: input.apiKey ?? "azure-key-1",
        operationId: input.operationId ?? crypto.randomUUID(),
        expectedVersion: input.expectedVersion,
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      });

    // The DB layer itself refuses an Azure connection without its endpoint.
    await expect(write({ expectedVersion: 0 })).rejects.toThrow(/endpoint/u);

    // The insert fires the `model.connected` lifecycle capture with
    // `azure_openai`, which must be a valid attribute.
    const operationId = crypto.randomUUID();
    const connected = await write({ endpoint: ENDPOINT, operationId, expectedVersion: 0 });
    expect(connected).toMatchObject({
      providerKind: "azure_openai",
      status: "active",
      version: 1,
      endpoint: ENDPOINT,
    });
    // The idempotent receipt replays the endpoint; a replay naming another
    // endpoint (same key) conflicts instead of returning the first result.
    expect(await write({ endpoint: ENDPOINT, operationId, expectedVersion: 0 })).toMatchObject({
      version: 1,
      endpoint: ENDPOINT,
    });
    await expect(
      write({ endpoint: OTHER_ENDPOINT, operationId, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(OrganizationModelProviderConflictError);
    // Changing the endpoint is a new connection version.
    expect(await write({ endpoint: OTHER_ENDPOINT, expectedVersion: 1 })).toMatchObject({
      version: 2,
      endpoint: OTHER_ENDPOINT,
    });
    expect(await write({ endpoint: ENDPOINT, expectedVersion: 2 })).toMatchObject({
      version: 3,
      endpoint: ENDPOINT,
    });

    await createOrganizationModelProviderCustomModel(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "azure_openai",
      upstreamModelId: "gpt-6.1-sol",
      operationId: crypto.randomUUID(),
    });

    const sharedCatalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKinds: ["azure_openai"],
    });
    expect(sharedCatalog.azure_openai).toMatchObject({ active: true, endpoint: ENDPOINT });
    expect(sharedCatalog.azure_openai.models.map((model) => model.upstreamModelId)).toEqual([
      "gpt-6.1-sol",
    ]);
    expect(
      await loadOrganizationModelProviderCredential(client.db, settings, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "azure_openai",
      }),
    ).toEqual({ apiKey: "azure-key-1", endpoint: ENDPOINT });
    const restrictions = await getWorkspaceConnectionModelRestrictions(
      client.db,
      workspace!.id,
      owner,
    );
    expect(restrictions["organization-azure-openai/"]).toBeNull();

    // Personal workspaces stay local: no organization API-key provider row.
    const personalCatalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
      accountId: account!.id,
      workspaceId: personal!.id,
      providerKinds: ["azure_openai"],
    });
    expect(personalCatalog.azure_openai).toEqual({ active: false, models: [], endpoint: null });
    expect(
      await loadOrganizationModelProviderCredential(client.db, settings, {
        accountId: account!.id,
        workspaceId: personal!.id,
        providerKind: "azure_openai",
      }),
    ).toBeNull();

    // Revocation clears the key; the non-secret endpoint stays so the
    // deployments remain listed (not ready) and no credential is loadable.
    const revoked = await revokeOrganizationModelProviderConnection(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "azure_openai",
      operationId: crypto.randomUUID(),
      expectedVersion: 3,
    });
    expect(revoked).toMatchObject({ status: "revoked", version: 4, endpoint: ENDPOINT });
    const afterRevoke = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKinds: ["azure_openai"],
    });
    expect(afterRevoke.azure_openai).toMatchObject({ active: false, endpoint: ENDPOINT });
    expect(
      await loadOrganizationModelProviderCredential(client.db, settings, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "azure_openai",
      }),
    ).toBeNull();

    // The constraints hold the endpoint to exactly the Azure kind and origin.
    const operation = crypto.randomUUID();
    await expect(
      (async () =>
        await shared!.admin`
      insert into organization_model_provider_connections
        (account_id, provider_kind, credential_encrypted, endpoint, operation_id, request_hash,
         updated_by_subject_id)
      values (${account!.id}, 'opper', 'x', ${ENDPOINT}, ${operation}, ${"a".repeat(64)}, ${owner})`)(),
    ).rejects.toThrow(/endpoint_chk/u);
    await expect(
      (async () =>
        await shared!.admin`
      update organization_model_provider_connections
      set endpoint = 'https://proxy.example.com/openai/v1'
      where account_id = ${account!.id} and provider_kind = 'azure_openai'`)(),
    ).rejects.toThrow(/endpoint_chk/u);
    await expect(
      (async () =>
        await shared!.admin`
      update organization_model_provider_connections set endpoint = null
      where account_id = ${account!.id} and provider_kind = 'azure_openai'`)(),
    ).rejects.toThrow(/endpoint_chk/u);

    const [families] = await shared.admin<{ org: string; openai: string }[]>`
      select opengeni_private.analytics_model_provider('organization-azure-openai') as org,
        opengeni_private.analytics_model_provider('organization-openai') as openai`;
    expect(families).toEqual({ org: "organization-azure-openai", openai: "organization-openai" });
    const [lifecycle] = await shared.admin<
      { valid: boolean; openai: boolean; elevenlabs: boolean; invalid: boolean }[]
    >`
      select opengeni_private.product_lifecycle_fact_valid('model.connected', 'azure_openai') as valid,
        opengeni_private.product_lifecycle_fact_valid('model.connected', 'openai') as openai,
        opengeni_private.product_lifecycle_fact_valid('model.connected', 'elevenlabs') as elevenlabs,
        opengeni_private.product_lifecycle_fact_valid('model.connected', 'azure') as invalid`;
    expect(lifecycle).toEqual({ valid: true, openai: true, elevenlabs: true, invalid: false });
  });

  test("an organization OpenAI key has no endpoint and serves curated models in shared workspaces", async () => {
    if (!client || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-openai-test') returning id`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const owner = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;
    const key = environmentsEncryptionKeyBytes(settings)!;
    const write = (providerKind: "openai" | "elevenlabs", endpoint?: string) =>
      upsertOrganizationModelProviderConnection(client!.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind,
        credentialEncrypted: encryptEnvironmentValue(key, `${providerKind}-key`),
        credentialDigest: `${providerKind}-key`,
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        ...(endpoint === undefined ? {} : { endpoint }),
      });
    // OpenAI uses its official API: the DB layer refuses an endpoint for it.
    await expect(write("openai", ENDPOINT)).rejects.toThrow(/endpoint/u);
    expect(await write("openai")).toMatchObject({
      providerKind: "openai",
      status: "active",
      version: 1,
      endpoint: null,
    });
    await createOrganizationModelProviderCustomModel(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "openai",
      upstreamModelId: "gpt-6-sol",
      operationId: crypto.randomUUID(),
    });
    const catalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKinds: ["openai"],
    });
    expect(catalog.openai.active).toBe(true);
    expect(catalog.openai.models.map((model) => model.upstreamModelId)).toEqual(["gpt-6-sol"]);
    expect(
      await loadOrganizationModelProviderCredential(client.db, settings, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "openai",
      }),
    ).toEqual({ apiKey: "openai-key", endpoint: null });
    expect(
      await loadOrganizationModelProviderCredential(client.db, settings, {
        accountId: account!.id,
        workspaceId: personal!.id,
        providerKind: "openai",
      }),
    ).toBeNull();

    // An organization ElevenLabs key is voice only: it never stands in for
    // another provider's model restrictions.
    // Fixture only: the access-policy editor is covered elsewhere.
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`
        update organization_model_provider_connections set allowed_model_ids = ${["gpt-6-sol"]}
        where account_id = ${account!.id} and provider_kind = 'openai'`;
    });
    await write("elevenlabs");
    const restrictions = await getWorkspaceConnectionModelRestrictions(
      client.db,
      workspace!.id,
      owner,
    );
    expect(restrictions["organization-openai/"]).toEqual(["gpt-6-sol"]);
    expect(restrictions["organization-openrouter/"]).toEqual([]);
  });
});
