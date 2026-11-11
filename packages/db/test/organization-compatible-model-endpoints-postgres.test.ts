import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationCompatibleEndpoint,
  createOrganizationCompatibleEndpointModel,
  getModelConnectionAccess,
  getOrganizationModelProviderCatalogForWorkspace,
  listOrganizationCompatibleEndpoints,
  listOrganizationCompatibleEndpointsForWorkspace,
  loadOrganizationCompatibleEndpointApiKey,
  OrganizationModelProviderConflictError,
  replaceOrganizationCompatibleEndpointKey,
  retireOrganizationCompatibleEndpointModel,
  revokeOrganizationCompatibleEndpoint,
  setOrganizationCompatibleEndpointModelReasoning,
  updateModelConnectionAccess,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// An organization's OpenAI-compatible endpoints are organization model
// accounts like its OpenAI key, except that it can connect several. Each is a
// connection row with its base URL; its models hang off that row. Workspaces
// read them through the same "Available in" policy (allowed_workspace_ids) as
// every other organization key, under FORCE RLS as the opengeni_app role.

const settings = testSettings({
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
}) as Settings;
const key = environmentsEncryptionKeyBytes(settings)!;

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
type Org = { accountId: string; sharedId: string; otherSharedId: string; owner: string };
let one: Org;
let two: Org;

async function seedOrganization(admin: postgres.Sql, label: string): Promise<Org> {
  const owner = `user:compatible-endpoints-${label}-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: `Endpoints fixture ${label}`,
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: `Endpoints fixture ${label}`,
    subjectId: owner,
  });
  const grant = access.workspaceGrants[0]!;
  const [otherShared, personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Other shared'), (${grant.accountId}, 'Personal')
    returning id`;
  await admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${owner}, 'owner', 'active', ${personal!.id})`;
  return {
    accountId: grant.accountId,
    sharedId: grant.workspaceId,
    otherSharedId: otherShared!.id,
    owner,
  };
}

function actor(org: Org) {
  return { organizationId: org.accountId, actorSubjectId: org.owner };
}

async function connect(
  org: Org,
  input: { baseUrl: string; apiKey: string; model: string; label?: string },
  operationId: string = crypto.randomUUID(),
) {
  return await createOrganizationCompatibleEndpoint(client.db, {
    ...actor(org),
    credentialEncrypted: encryptEnvironmentValue(key, input.apiKey),
    credentialDigest: `digest:${input.apiKey}`,
    baseUrl: input.baseUrl,
    api: "chat",
    label: input.label ?? null,
    upstreamModelId: input.model,
    operationId,
  });
}

async function visible(org: Org, workspaceId: string) {
  const endpoints = await listOrganizationCompatibleEndpointsForWorkspace(client.db, {
    accountId: org.accountId,
    workspaceId,
  });
  for (const endpoint of endpoints) expect("credentialEncrypted" in endpoint).toBe(false);
  return endpoints.map((endpoint) => ({
    baseUrl: endpoint.baseUrl,
    models: endpoint.models.map((model) => model.upstreamModelId),
  }));
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-compatible-endpoints");
  if (!shared) {
    available = false;
    console.warn("[organization-compatible-endpoints] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  one = await seedOrganization(shared.admin, "one");
  two = await seedOrganization(shared.admin, "two");
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("an organization connects several endpoints, each with its own models", async () => {
  if (!available) return;
  const first = await connect(one, {
    baseUrl: "https://api.alpha.example/v1",
    apiKey: "alpha-key",
    model: "shared/model",
    label: "Alpha",
  });
  const second = await connect(one, {
    baseUrl: "https://api.beta.example/v1",
    apiKey: "beta-key",
    model: "shared/model",
  });
  expect(first.endpoint.id).not.toBe(second.endpoint.id);
  expect(first.endpoint).toMatchObject({ status: "active", version: 1, label: "Alpha" });
  // The same model ID on two endpoints is two models.
  await createOrganizationCompatibleEndpointModel(client.db, {
    ...actor(one),
    connectionId: first.endpoint.id,
    upstreamModelId: "alpha/large",
    operationId: crypto.randomUUID(),
  });
  const listed = await listOrganizationCompatibleEndpoints(client.db, actor(one));
  expect(
    listed.map(({ endpoint, models }) => [endpoint.baseUrl, models.map((m) => m.upstreamModelId)]),
  ).toEqual([
    ["https://api.alpha.example/v1", ["shared/model", "alpha/large"]],
    ["https://api.beta.example/v1", ["shared/model"]],
  ]);
  // Another organization sees none of them.
  expect(await listOrganizationCompatibleEndpoints(client.db, actor(two))).toEqual([]);
  expect(await visible(two, two.sharedId)).toEqual([]);
});

test("a replayed connect returns what it created; a changed request under its id conflicts", async () => {
  if (!available) return;
  const operationId = crypto.randomUUID();
  const request = { baseUrl: "https://replay.example/v1", apiKey: "replay-key", model: "m-1" };
  const created = await connect(two, request, operationId);
  const replayed = await connect(two, request, operationId);
  expect(replayed.endpoint.id).toBe(created.endpoint.id);
  expect(replayed.model.id).toBe(created.model.id);
  await expect(connect(two, { ...request, model: "m-2" }, operationId)).rejects.toBeInstanceOf(
    OrganizationModelProviderConflictError,
  );
  const endpoints = await listOrganizationCompatibleEndpoints(client.db, actor(two));
  expect(endpoints.filter(({ endpoint }) => endpoint.baseUrl === request.baseUrl)).toHaveLength(1);
});

test("Available in limits which workspaces read an endpoint and its key", async () => {
  if (!available) return;
  const limited = await connect(one, {
    baseUrl: "https://limited.example/v1",
    apiKey: "limited-key",
    model: "limited/model",
  });
  // The same "Available in" editor as every other organization key.
  const target = {
    accountId: one.accountId,
    workspaceId: null,
    subjectId: one.owner,
    kind: "openai_compatible" as const,
    connectionId: limited.endpoint.id,
  };
  const access = await getModelConnectionAccess(client.db, target);
  expect(access).toMatchObject({ allowedWorkspaces: null, allowPersonalWorkspaces: true });
  await updateModelConnectionAccess(client.db, target, {
    allowedModels: null,
    allowedWorkspaces: [one.sharedId],
    allowPersonalWorkspaces: false,
    version: access!.version,
  });
  expect(await visible(one, one.sharedId)).toContainEqual({
    baseUrl: "https://limited.example/v1",
    models: ["limited/model"],
  });
  expect(await visible(one, one.otherSharedId)).not.toContainEqual(
    expect.objectContaining({ baseUrl: "https://limited.example/v1" }),
  );
  const readKey = (workspaceId: string) =>
    loadOrganizationCompatibleEndpointApiKey(client.db, settings, {
      accountId: one.accountId,
      workspaceId,
      connectionId: limited.endpoint.id,
    });
  expect(await readKey(one.sharedId)).toBe("limited-key");
  expect(await readKey(one.otherSharedId)).toBeNull();
  // Credentials are read only when asked for.
  const withCredentials = await listOrganizationCompatibleEndpointsForWorkspace(client.db, {
    accountId: one.accountId,
    workspaceId: one.sharedId,
    includeCredentials: true,
  });
  expect(
    withCredentials.find((endpoint) => endpoint.id === limited.endpoint.id)?.credentialEncrypted,
  ).toBeString();
});

test("replacing a key is versioned; revoking hides the endpoint and its models", async () => {
  if (!available) return;
  const created = await connect(one, {
    baseUrl: "https://rotate.example/v1",
    apiKey: "old-key",
    model: "rotate/model",
  });
  const operationId = crypto.randomUUID();
  const replace = () =>
    replaceOrganizationCompatibleEndpointKey(client.db, {
      ...actor(one),
      connectionId: created.endpoint.id,
      credentialEncrypted: encryptEnvironmentValue(key, "new-key"),
      credentialDigest: "digest:new-key",
      operationId,
      expectedVersion: 1,
    });
  expect((await replace()).version).toBe(2);
  // The same operation again is a replay, not a second change.
  expect((await replace()).version).toBe(2);
  expect(
    await loadOrganizationCompatibleEndpointApiKey(client.db, settings, {
      accountId: one.accountId,
      workspaceId: one.sharedId,
      connectionId: created.endpoint.id,
    }),
  ).toBe("new-key");
  // A stale version conflicts.
  await expect(
    revokeOrganizationCompatibleEndpoint(client.db, {
      ...actor(one),
      connectionId: created.endpoint.id,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
    }),
  ).rejects.toBeInstanceOf(OrganizationModelProviderConflictError);
  const model = created.model;
  const retired = await retireOrganizationCompatibleEndpointModel(client.db, {
    ...actor(one),
    connectionId: created.endpoint.id,
    customModelId: model.id,
    expectedVersion: model.version,
    operationId: crypto.randomUUID(),
  });
  expect(retired.retiredAt).not.toBeNull();
  const revoked = await revokeOrganizationCompatibleEndpoint(client.db, {
    ...actor(one),
    connectionId: created.endpoint.id,
    operationId: crypto.randomUUID(),
    expectedVersion: 2,
  });
  expect(revoked.status).toBe("revoked");
  expect(await visible(one, one.sharedId)).not.toContainEqual(
    expect.objectContaining({ baseUrl: "https://rotate.example/v1" }),
  );
  expect(
    await loadOrganizationCompatibleEndpointApiKey(client.db, settings, {
      accountId: one.accountId,
      workspaceId: one.sharedId,
      connectionId: created.endpoint.id,
    }),
  ).toBeNull();
  const listed = await listOrganizationCompatibleEndpoints(client.db, actor(one));
  expect(listed.map(({ endpoint }) => endpoint.id)).not.toContain(created.endpoint.id);
});

test("other organization keys stay one per kind, and the catalog ignores endpoints", async () => {
  if (!available) return;
  await upsertOrganizationModelProviderConnection(client.db, {
    ...actor(two),
    providerKind: "openrouter",
    credentialEncrypted: encryptEnvironmentValue(key, "openrouter-key"),
    credentialDigest: "digest:openrouter",
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
  });
  await expect(
    shared!.admin`
      insert into organization_model_provider_connections
        (account_id, provider_kind, credential_encrypted, operation_id, request_hash,
         updated_by_subject_id)
      values (${two.accountId}, 'openrouter', 'x', ${crypto.randomUUID()}, ${"a".repeat(64)},
        ${two.owner})`,
  ).rejects.toThrow();
  // An endpoint without a public HTTPS base URL, or a model without its endpoint, is refused.
  await expect(
    shared!.admin`
      insert into organization_model_provider_connections
        (account_id, provider_kind, credential_encrypted, operation_id, request_hash,
         updated_by_subject_id, endpoint, compatible_api)
      values (${two.accountId}, 'openai_compatible', 'x', ${crypto.randomUUID()},
        ${"a".repeat(64)}, ${two.owner}, 'http://insecure.example/v1', 'chat')`,
  ).rejects.toThrow();
  await expect(
    shared!.admin`
      insert into organization_model_provider_custom_models
        (account_id, provider_kind, upstream_model_id, create_operation_id,
         create_request_hash, created_by_subject_id)
      values (${two.accountId}, 'openai_compatible', 'orphan', ${crypto.randomUUID()},
        ${"a".repeat(64)}, ${two.owner})`,
  ).rejects.toThrow();
  const catalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
    accountId: two.accountId,
    workspaceId: two.sharedId,
    providerKinds: ["openrouter"],
  });
  expect(catalog.openrouter.active).toBe(true);
});

test("a model's reasoning levels are saved with it, versioned, and read by workspaces", async () => {
  if (!available) return;
  const reasoning = {
    efforts: ["none", "low", "high", "max"] as const,
    defaultEffort: "high" as const,
  };
  const created = await createOrganizationCompatibleEndpoint(client.db, {
    ...actor(two),
    credentialEncrypted: encryptEnvironmentValue(key, "reasoning-key"),
    credentialDigest: "digest:reasoning-key",
    baseUrl: "https://api.reasoning.example/v1",
    api: "chat",
    label: null,
    upstreamModelId: "acme/thinker",
    reasoning: { ...reasoning, efforts: [...reasoning.efforts] },
    operationId: crypto.randomUUID(),
  });
  expect(created.model.reasoning).toEqual({
    efforts: ["none", "low", "high", "max"],
    defaultEffort: "high",
  });
  const plain = await createOrganizationCompatibleEndpointModel(client.db, {
    ...actor(two),
    connectionId: created.endpoint.id,
    upstreamModelId: "acme/plain",
    operationId: crypto.randomUUID(),
  });
  expect(plain.reasoning).toBeNull();

  const input = {
    ...actor(two),
    connectionId: created.endpoint.id,
    customModelId: plain.id,
    expectedVersion: plain.version,
    reasoning: { efforts: ["low", "high"] as ("low" | "high")[], defaultEffort: "low" as const },
  };
  const changed = await setOrganizationCompatibleEndpointModelReasoning(client.db, input);
  expect(changed).toMatchObject({ version: plain.version + 1, reasoning: input.reasoning });
  // A replay whose answer was lost returns the saved model; a stale change conflicts.
  expect(await setOrganizationCompatibleEndpointModelReasoning(client.db, input)).toEqual(changed);
  await expect(
    setOrganizationCompatibleEndpointModelReasoning(client.db, { ...input, reasoning: null }),
  ).rejects.toBeInstanceOf(OrganizationModelProviderConflictError);
  const cleared = await setOrganizationCompatibleEndpointModelReasoning(client.db, {
    ...input,
    expectedVersion: changed.version,
    reasoning: null,
  });
  expect(cleared).toMatchObject({ version: changed.version + 1, reasoning: null });

  // Workspaces the endpoint is available in see the same levels in their catalog read.
  const [seen] = (
    await listOrganizationCompatibleEndpointsForWorkspace(client.db, {
      accountId: two.accountId,
      workspaceId: two.sharedId,
    })
  ).filter((endpoint) => endpoint.id === created.endpoint.id);
  expect(
    Object.fromEntries(seen!.models.map((model) => [model.upstreamModelId, model.reasoning])),
  ).toEqual({ "acme/thinker": created.model.reasoning, "acme/plain": null });

  // The database refuses a default outside the saved levels.
  await expect(
    shared!.admin`
      update organization_model_provider_custom_models
      set reasoning_efforts = array['low']::text[], default_reasoning_effort = 'high'
      where id = ${plain.id}`,
  ).rejects.toThrow("organization_model_provider_custom_models_reasoning_chk");
});
