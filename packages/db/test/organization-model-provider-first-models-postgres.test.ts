import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationModelProviderCustomModel,
  listOrganizationModelProviderCustomModels,
  OrganizationModelProviderConflictError,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// Connecting OpenAI or Azure OpenAI for an organization can name its first
// models (Azure deployments). They are saved with the key in one
// transaction, so a connection never exists half set up, and replaying the
// same request returns what it created.

const settings = testSettings({
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
}) as Settings;
const key = environmentsEncryptionKeyBytes(settings)!;
const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let actor: { organizationId: string; actorSubjectId: string };

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-model-provider-first-models");
  if (!shared) {
    available = false;
    console.warn("[organization-model-provider-first-models] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const owner = `user:first-models-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "First models fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "First models fixture",
    subjectId: owner,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Personal')
    returning id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${owner}, 'owner', 'active', ${personal!.id})`;
  actor = { organizationId: grant.accountId, actorSubjectId: owner };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function azure(
  apiKey: string,
  models: string[] | undefined,
  operationId: string,
  expectedVersion?: number,
) {
  return upsertOrganizationModelProviderConnection(client.db, {
    ...actor,
    providerKind: "azure_openai",
    credentialEncrypted: encryptEnvironmentValue(key, apiKey),
    credentialDigest: `digest:${apiKey}`,
    endpoint: ENDPOINT,
    ...(models ? { models } : {}),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    operationId,
  });
}

async function deployments(): Promise<string[]> {
  const models = await listOrganizationModelProviderCustomModels(client.db, {
    ...actor,
    providerKind: "azure_openai",
  });
  return models.map((model) => model.upstreamModelId).sort();
}

test("the first deployment is saved with the key, and a replay creates nothing twice", async () => {
  if (!available) return;
  const operationId = crypto.randomUUID();
  const connection = await azure("first-key", ["gpt-6-sol"], operationId);
  expect(connection).toMatchObject({ providerKind: "azure_openai", status: "active", version: 1 });
  expect(await deployments()).toEqual(["gpt-6-sol"]);

  const replay = await azure("first-key", ["gpt-6-sol"], operationId);
  expect(replay.version).toBe(connection.version);
  expect(await deployments()).toEqual(["gpt-6-sol"]);

  // The same operation with other models is another request.
  await expect(azure("first-key", ["gpt-6.1-sol"], operationId)).rejects.toBeInstanceOf(
    OrganizationModelProviderConflictError,
  );
  expect(await deployments()).toEqual(["gpt-6-sol"]);
});

test("a model the organization already offers is kept, and new ones are added", async () => {
  if (!available) return;
  await createOrganizationModelProviderCustomModel(client.db, {
    ...actor,
    providerKind: "azure_openai",
    upstreamModelId: "gpt-6-mini",
    operationId: crypto.randomUUID(),
  });
  const before = await listOrganizationModelProviderCustomModels(client.db, {
    ...actor,
    providerKind: "azure_openai",
  });
  // Replacing the key (version 1) with more models.
  await azure("second-key", ["gpt-6-mini", "gpt-6-nano"], crypto.randomUUID(), 1);
  const after = await listOrganizationModelProviderCustomModels(client.db, {
    ...actor,
    providerKind: "azure_openai",
  });
  expect(after.map((model) => model.upstreamModelId).sort()).toEqual([
    "gpt-6-mini",
    "gpt-6-nano",
    "gpt-6-sol",
  ]);
  const kept = (list: typeof after) => list.find((model) => model.upstreamModelId === "gpt-6-mini");
  expect(kept(after)!.id).toBe(kept(before)!.id);
});

test("other providers can't save models with their key", async () => {
  if (!available) return;
  await expect(
    upsertOrganizationModelProviderConnection(client.db, {
      ...actor,
      providerKind: "openrouter",
      credentialEncrypted: encryptEnvironmentValue(key, "router-key"),
      credentialDigest: "digest:router-key",
      models: ["vendor/model"],
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toThrow("only an organization OpenAI or Azure OpenAI connection saves its models");
});
