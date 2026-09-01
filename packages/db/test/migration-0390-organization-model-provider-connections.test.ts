// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

import {
  createDb,
  createOrganizationModelProviderCustomModel,
  getOrganizationModelProviderConnection,
  getOrganizationModelProviderCustomModelForExecution,
  listOrganizationModelProviderCustomModels,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  organizationModelProviderConnectionActiveForWorkspace,
  OrganizationModelProviderConflictError,
  retireOrganizationModelProviderCustomModel,
  revokeOrganizationModelProviderConnection,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationUrl = new URL(
  "../drizzle/0390_organization_model_provider_connections.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof postgres> | null = null;
let client: DbClient | null = null;

async function context(accountId: string, workspaceId: string | null, subjectId = "") {
  await app!`select set_config('opengeni.account_id', ${accountId}, false)`;
  await app!`select set_config('opengeni.workspace_id', ${workspaceId ?? ""}, false)`;
  await app!`select set_config('opengeni.subject_id', ${subjectId}, false)`;
}

beforeAll(async () => {
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0390-organization-model-providers");
  if (!shared) throw new Error("migration 0390 requires real PostgreSQL");
  app = postgres(shared.appUrl, { max: 4 });
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0390 organization model providers", () => {
  test("declares encrypted organization storage with FORCE RLS and shared-only visibility", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("-- deployment-mode: maintenance");
    expect(migration).toContain("organization_model_provider_connections");
    expect(migration).toContain("organization_model_provider_connection_operations");
    expect(migration).toContain("organization_model_provider_custom_models");
    expect(migration).toContain("credential_encrypted text NOT NULL");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("personal_workspace_id = workspace_value");
    expect(migration).not.toContain("api_key");
    expect(FORCE_RLS_TABLES).toContain("organization_model_provider_connections");
    expect(FORCE_RLS_TABLES).toContain("organization_model_provider_connection_operations");
    expect(FORCE_RLS_TABLES).toContain("organization_model_provider_custom_models");
    expect(RUNTIME_FULL_DML_TABLES).toContain("organization_model_provider_connections");
    expect(RUNTIME_FULL_DML_TABLES).toContain("organization_model_provider_connection_operations");
    expect(RUNTIME_FULL_DML_TABLES).toContain("organization_model_provider_custom_models");
  });

  test("admits admin management and shared runtime but excludes personal and foreign scope", async () => {
    if (!app || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-model-provider-test') returning id`;
    const [foreign] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-model-provider-foreign') returning id`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const owner = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;

    await context(account!.id, null, owner);
    await app`
      insert into organization_model_provider_connections
        (account_id, provider_kind, credential_encrypted, operation_id, request_hash, updated_by_subject_id)
      values (${account!.id}, 'openrouter', 'ciphertext-only', ${crypto.randomUUID()}, ${"a".repeat(64)}, ${owner})`;
    await app`
      insert into organization_model_provider_custom_models
        (account_id, provider_kind, upstream_model_id, create_operation_id, create_request_hash, created_by_subject_id)
      values (${account!.id}, 'openrouter', 'openai/gpt-org', ${crypto.randomUUID()}, ${"b".repeat(64)}, ${owner})`;

    await context(account!.id, workspace!.id);
    const sharedRows = await app<{ upstream_model_id: string }[]>`
      select upstream_model_id from organization_model_provider_custom_models`;
    expect(sharedRows.map((row) => row.upstream_model_id)).toEqual(["openai/gpt-org"]);

    await context(account!.id, personal!.id);
    expect(await app`select id from organization_model_provider_connections`).toHaveLength(0);
    expect(await app`select id from organization_model_provider_custom_models`).toHaveLength(0);

    await context(foreign!.id, workspace!.id);
    expect(await app`select id from organization_model_provider_connections`).toHaveLength(0);
  });

  test("fences durable connection and custom-model lifecycle operations", async () => {
    if (!client || !shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-provider-lifecycle') returning id`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const owner = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
      values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;

    const connectOperationId = crypto.randomUUID();
    const connected = await upsertOrganizationModelProviderConnection(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "openrouter",
      credentialEncrypted: "encrypted-test-key",
      credentialDigest: "credential-digest",
      operationId: connectOperationId,
      expectedVersion: 0,
    });
    expect(connected).toMatchObject({ providerKind: "openrouter", status: "active", version: 1 });
    expect(
      await upsertOrganizationModelProviderConnection(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
        credentialEncrypted: "different-ciphertext-same-secret",
        credentialDigest: "credential-digest",
        operationId: connectOperationId,
        expectedVersion: 0,
      }),
    ).toEqual(connected);
    await expect(
      upsertOrganizationModelProviderConnection(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
        credentialEncrypted: "other-key",
        credentialDigest: "different-secret",
        operationId: connectOperationId,
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(OrganizationModelProviderConflictError);
    expect(
      await organizationModelProviderConnectionActiveForWorkspace(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "openrouter",
      }),
    ).toBe(true);
    expect(
      await organizationModelProviderConnectionActiveForWorkspace(client.db, {
        accountId: account!.id,
        workspaceId: personal!.id,
        providerKind: "openrouter",
      }),
    ).toBe(false);

    const createOperationId = crypto.randomUUID();
    const model = await createOrganizationModelProviderCustomModel(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "openrouter",
      upstreamModelId: "openai/gpt-org-lifecycle",
      operationId: createOperationId,
    });
    expect(
      await createOrganizationModelProviderCustomModel(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
        upstreamModelId: model.upstreamModelId,
        operationId: createOperationId,
      }),
    ).toEqual(model);
    await expect(
      createOrganizationModelProviderCustomModel(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
        upstreamModelId: model.upstreamModelId,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(OrganizationModelProviderConflictError);
    expect(
      await listOrganizationModelProviderCustomModels(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
      }),
    ).toHaveLength(1);
    expect(
      await lockActiveOrganizationModelProviderCustomModelForAdmission(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "openrouter",
        upstreamModelId: model.upstreamModelId,
      }),
    ).toMatchObject({ id: model.id });

    const revoked = await revokeOrganizationModelProviderConnection(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "openrouter",
      operationId: crypto.randomUUID(),
      expectedVersion: connected.version,
    });
    expect(revoked).toMatchObject({ status: "revoked", version: 2 });
    expect(
      await lockActiveOrganizationModelProviderCustomModelForAdmission(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "openrouter",
        upstreamModelId: model.upstreamModelId,
      }),
    ).toBeNull();
    expect(
      await getOrganizationModelProviderCustomModelForExecution(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        providerKind: "openrouter",
        upstreamModelId: model.upstreamModelId,
      }),
    ).toMatchObject({ id: model.id });

    const deleteOperationId = crypto.randomUUID();
    const retired = await retireOrganizationModelProviderCustomModel(client.db, {
      organizationId: account!.id,
      actorSubjectId: owner,
      providerKind: "openrouter",
      customModelId: model.id,
      expectedVersion: model.version,
      operationId: deleteOperationId,
    });
    expect(retired.retiredAt).toBeInstanceOf(Date);
    expect(
      await retireOrganizationModelProviderCustomModel(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
        customModelId: model.id,
        expectedVersion: model.version,
        operationId: deleteOperationId,
      }),
    ).toEqual(retired);
    expect(
      await getOrganizationModelProviderConnection(client.db, {
        organizationId: account!.id,
        actorSubjectId: owner,
        providerKind: "openrouter",
      }),
    ).toEqual(revoked);
    const [stored] = await shared.admin<{ credential_encrypted: string }[]>`
      select credential_encrypted from organization_model_provider_connections
      where account_id = ${account!.id} and provider_kind = 'openrouter'`;
    expect(stored!.credential_encrypted).toBe("");
  });
});
