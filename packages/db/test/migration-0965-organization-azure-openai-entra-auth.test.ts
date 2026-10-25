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
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  loadOrganizationModelProviderApiKey,
  loadOrganizationModelProviderCredential,
  organizationModelProviderCredentialPlaintext,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";

const migrationUrl = new URL(
  "../drizzle/0965_organization_azure_openai_entra_auth.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
// Fake credentials only.
const APP = {
  method: "entra_client_secret" as const,
  tenantId: "11111111-2222-4333-8444-555555555555",
  clientId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  clientSecret: "fake-entra-client-secret",
};
const settings = testSettings({
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0957-organization-azure-openai-entra");
  if (!shared) throw new Error("migration 0965 requires real PostgreSQL");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0965 organization Azure OpenAI Microsoft Entra ID sign-in", () => {
  test("is a rolling, metadata-only column add with Azure-only Entra methods", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain("ADD COLUMN auth_method text NOT NULL DEFAULT 'api_key';");
    expect(migration).toContain("ADD COLUMN result_auth_method text NOT NULL DEFAULT 'api_key';");
    expect(migration).toContain("OR provider_kind = 'azure_openai'");
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\b/imu);
    expect(migration).not.toContain("ROW LEVEL SECURITY");
  });

  test("an Entra app is stored encrypted as a versioned document, a key as itself", () => {
    expect(
      organizationModelProviderCredentialPlaintext({ method: "api_key", apiKey: "k" }),
    ).toEqual({ authMethod: "api_key", plaintext: "k" });
    const stored = organizationModelProviderCredentialPlaintext(APP);
    expect(stored.authMethod).toBe("entra_client_secret");
    expect(JSON.parse(stored.plaintext)).toEqual({
      version: 1,
      tenantId: APP.tenantId,
      clientId: APP.clientId,
      clientSecret: APP.clientSecret,
    });
    // The deployment identity stores no secret at all.
    expect(
      organizationModelProviderCredentialPlaintext({ method: "entra_deployment_identity" }),
    ).toEqual({ authMethod: "entra_deployment_identity", plaintext: '{"version":1}' });
  });

  test("loads an Entra connection as Entra, never as a key, and fails closed on a bad document", async () => {
    if (!client || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-azure-entra-test') returning id`;
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
    const scope = {
      accountId: account!.id,
      workspaceId: workspace!.id,
      providerKind: "azure_openai" as const,
    };
    const stored = organizationModelProviderCredentialPlaintext(APP);
    const connected = await upsertOrganizationModelProviderConnection(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "azure_openai",
      credentialEncrypted: encryptEnvironmentValue(key, stored.plaintext),
      credentialDigest: stored.plaintext,
      authMethod: stored.authMethod,
      endpoint: ENDPOINT,
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
    });
    expect(connected).toMatchObject({ authMethod: "entra_client_secret", version: 1 });
    // The secret is only ever in the encrypted column.
    const [row] = await shared.admin<{ credential_encrypted: string; auth_method: string }[]>`
      select credential_encrypted, auth_method from organization_model_provider_connections
      where account_id = ${account!.id} and provider_kind = 'azure_openai'`;
    expect(row!.auth_method).toBe("entra_client_secret");
    expect(row!.credential_encrypted).not.toContain(APP.clientSecret);
    expect(decryptEnvironmentValue(key, row!.credential_encrypted)).toBe(stored.plaintext);

    expect(await loadOrganizationModelProviderCredential(client.db, settings, scope)).toEqual({
      azureEntra: {
        source: "client_secret",
        tenantId: APP.tenantId,
        clientId: APP.clientId,
        clientSecret: APP.clientSecret,
      },
      endpoint: ENDPOINT,
    });
    // Nothing that wants a key gets the Entra document as one.
    expect(await loadOrganizationModelProviderApiKey(client.db, settings, scope)).toBeNull();

    // An unreadable Entra document fails closed instead of becoming a key.
    await shared.admin`
      update organization_model_provider_connections
      set credential_encrypted = ${encryptEnvironmentValue(key, "not-json")}
      where account_id = ${account!.id} and provider_kind = 'azure_openai'`;
    expect(await loadOrganizationModelProviderCredential(client.db, settings, scope)).toBeNull();

    // The database admits Entra methods for Azure OpenAI only.
    await expect(
      (async () =>
        await shared!.admin`
      insert into organization_model_provider_connections
        (account_id, provider_kind, credential_encrypted, auth_method, operation_id, request_hash,
         updated_by_subject_id)
      values (${account!.id}, 'openai', 'x', 'entra_client_secret', ${crypto.randomUUID()},
        ${"a".repeat(64)}, ${owner})`)(),
    ).rejects.toThrow(/auth_method_chk/u);
    await expect(
      (async () =>
        await shared!.admin`
      update organization_model_provider_connections set auth_method = 'password'
      where account_id = ${account!.id} and provider_kind = 'azure_openai'`)(),
    ).rejects.toThrow(/auth_method_chk/u);
  });
});
