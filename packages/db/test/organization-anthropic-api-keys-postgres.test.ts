import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import {
  addOrganizationAnthropicApiKey,
  bootstrapWorkspace,
  clearOrganizationAnthropicApiKeyCreditRefusal,
  createDb,
  listOrganizationAnthropicApiKeys,
  loadModelProviderExecutionInputs,
  loadOrganizationAnthropicApiKeysForExecution,
  markOrganizationAnthropicApiKeyCreditRefused,
  OrganizationModelProviderConflictError,
  relabelOrganizationAnthropicApiKey,
  removeOrganizationAnthropicApiKey,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// An organization's Anthropic API connection can hold several API keys. Its
// own key is the first member; the others sit beside it on the same row. A
// workspace's turn records a key Anthropic refused for lack of credits, and
// later turns leave it out until an administrator lets it serve again.
// Everything runs under FORCE RLS as the opengeni_app role.

const settings = testSettings({
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
}) as Settings;
const key = environmentsEncryptionKeyBytes(settings)!;

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
type Org = { accountId: string; workspaceId: string; owner: string };
let one: Org;

async function seedOrganization(admin: postgres.Sql, label: string): Promise<Org> {
  const owner = `user:anthropic-api-keys-${label}-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: `API keys fixture ${label}`,
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: `API keys fixture ${label}`,
    subjectId: owner,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal') returning id`;
  await admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${owner}, 'owner', 'active', ${personal!.id})`;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId, owner };
}

function actor(org: Org) {
  return { organizationId: org.accountId, actorSubjectId: org.owner };
}

function scope(org: Org) {
  return { accountId: org.accountId, workspaceId: org.workspaceId };
}

async function connect(org: Org, apiKey: string, expectedVersion?: number) {
  return await upsertOrganizationModelProviderConnection(client.db, {
    ...actor(org),
    providerKind: "anthropic",
    credentialEncrypted: encryptEnvironmentValue(key, apiKey),
    credentialDigest: `digest:${apiKey}`,
    operationId: crypto.randomUUID(),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
}

async function add(org: Org, apiKey: string, label: string) {
  return await addOrganizationAnthropicApiKey(client.db, {
    ...actor(org),
    label,
    credentialEncrypted: encryptEnvironmentValue(key, apiKey),
    credentialDigest: `digest:${apiKey}`,
    anthropicOrganizationId: `org-${label.toLowerCase()}`,
  });
}

async function served(org: Org) {
  const keys = await loadOrganizationAnthropicApiKeysForExecution(client.db, settings, scope(org));
  return keys === null ? null : keys.map((member) => member.apiKey);
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-anthropic-api-keys");
  if (!shared) {
    available = false;
    console.warn("[organization-anthropic-api-keys] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  one = await seedOrganization(shared.admin, "one");
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("MP-KEYS-04: a connection holds several keys; its own key is the first member", async () => {
  if (!available) return;
  // No connection: there is nothing to add a key to.
  expect(await add(one, "key-early", "Early")).toBeNull();
  await connect(one, "key-one");
  // One key is a single-key connection, exactly as before.
  expect(await served(one)).toBeNull();
  const single = await listOrganizationAnthropicApiKeys(client.db, actor(one));
  expect(single?.keys.map((member) => member.id)).toEqual(["primary-v1"]);

  const two = await add(one, "key-two", "Second");
  const three = await add(one, "key-three", "Third");
  expect(two).toMatchObject({ added: true, key: { label: "Second", connectionKey: false } });
  expect(three?.key.anthropicOrganizationId).toBe("org-third");
  // The same key again is the same member.
  const again = await add(one, "key-two", "Renamed");
  expect(again).toMatchObject({ added: false, key: { id: two!.key.id, label: "Second" } });

  expect(await served(one)).toEqual(["key-one", "key-two", "key-three"]);
  const listed = await listOrganizationAnthropicApiKeys(client.db, actor(one));
  expect(listed?.keys.map((member) => [member.id, member.label, member.creditRefusedAt])).toEqual([
    ["primary-v1", null, null],
    [two!.key.id, "Second", null],
    [three!.key.id, "Third", null],
  ]);
  // Never a key value or its ciphertext.
  expect(JSON.stringify(listed)).not.toContain("credential");
  expect(JSON.stringify(listed)).not.toContain("key-two");

  // The prepared execution read gives the same pool, still encrypted.
  const prepared = await loadModelProviderExecutionInputs(client.db, {
    ...scope(one),
    claudeSubscriptionEnabled: false,
    loadOrganizationCredentials: true,
  });
  expect(prepared.organizationAnthropicApiKeys?.map((member) => member.id)).toEqual([
    "primary-v1",
    two!.key.id,
    three!.key.id,
  ]);
  expect(
    (
      await loadOrganizationAnthropicApiKeysForExecution(client.db, settings, scope(one), prepared)
    )?.map((member) => member.apiKey),
  ).toEqual(["key-one", "key-two", "key-three"]);
  const withoutCredentials = await loadModelProviderExecutionInputs(client.db, {
    ...scope(one),
    claudeSubscriptionEnabled: false,
    loadOrganizationCredentials: false,
  });
  expect(withoutCredentials.organizationAnthropicApiKeys).toBeNull();
}, 60_000);

test("MP-KEYS-05: a key out of credits stays out until an administrator lets it serve again", async () => {
  if (!available) return;
  const listed = (await listOrganizationAnthropicApiKeys(client.db, actor(one)))!;
  const second = listed.keys[1]!.id;
  // A workspace's turn records the refusal, once.
  expect(
    await markOrganizationAnthropicApiKeyCreditRefused(client.db, { ...scope(one), keyId: second }),
  ).toBe(true);
  expect(
    await markOrganizationAnthropicApiKeyCreditRefused(client.db, { ...scope(one), keyId: second }),
  ).toBe(false);
  // An id that is no member is ignored.
  expect(
    await markOrganizationAnthropicApiKeyCreditRefused(client.db, {
      ...scope(one),
      keyId: "primary-v99",
    }),
  ).toBe(false);
  expect(await served(one)).toEqual(["key-one", "key-three"]);
  const marked = await listOrganizationAnthropicApiKeys(client.db, actor(one));
  expect(marked?.keys[1]?.creditRefusedAt).toBeInstanceOf(Date);
  // Recording a refusal never changes the connection itself.
  expect(marked?.connectionVersion).toBe(1);

  const cleared = await clearOrganizationAnthropicApiKeyCreditRefusal(client.db, {
    ...actor(one),
    keyId: second,
  });
  expect(cleared?.creditRefusedAt).toBeNull();
  expect(await served(one)).toEqual(["key-one", "key-two", "key-three"]);

  // Every key refused: an empty pool, so requests fail without sending.
  for (const member of listed.keys)
    await markOrganizationAnthropicApiKeyCreditRefused(client.db, {
      ...scope(one),
      keyId: member.id,
    });
  expect(await served(one)).toEqual([]);
  for (const member of listed.keys)
    await clearOrganizationAnthropicApiKeyCreditRefusal(client.db, {
      ...actor(one),
      keyId: member.id,
    });
  expect(await served(one)).toEqual(["key-one", "key-two", "key-three"]);
}, 60_000);

test("MP-KEYS-06: replacing the connection's key starts it fresh; keys are renamed and removed", async () => {
  if (!available) return;
  await markOrganizationAnthropicApiKeyCreditRefused(client.db, {
    ...scope(one),
    keyId: "primary-v1",
  });
  expect(await served(one)).toEqual(["key-two", "key-three"]);
  // A new key for the connection is a new member id, with no refusal.
  await connect(one, "key-one-new", 1);
  expect(await served(one)).toEqual(["key-one-new", "key-two", "key-three"]);
  const listed = (await listOrganizationAnthropicApiKeys(client.db, actor(one)))!;
  expect(listed.keys[0]).toMatchObject({ id: "primary-v2", connectionKey: true });

  const third = listed.keys[2]!.id;
  expect(
    await relabelOrganizationAnthropicApiKey(client.db, {
      ...actor(one),
      keyId: third,
      label: "  Third, renamed ",
    }),
  ).toMatchObject({ id: third, label: "Third, renamed" });
  await expect(
    relabelOrganizationAnthropicApiKey(client.db, { ...actor(one), keyId: third, label: "a\nb" }),
  ).rejects.toThrow();
  await expect(
    removeOrganizationAnthropicApiKey(client.db, { ...actor(one), keyId: "primary-v2" }),
  ).rejects.toBeInstanceOf(OrganizationModelProviderConflictError);
  expect(await removeOrganizationAnthropicApiKey(client.db, { ...actor(one), keyId: third })).toBe(
    true,
  );
  expect(await removeOrganizationAnthropicApiKey(client.db, { ...actor(one), keyId: third })).toBe(
    false,
  );
  expect(await served(one)).toEqual(["key-one-new", "key-two"]);
  // Removing the last further key is a single-key connection again.
  await removeOrganizationAnthropicApiKey(client.db, { ...actor(one), keyId: listed.keys[1]!.id });
  expect(await served(one)).toBeNull();
}, 60_000);

test("MP-KEYS-07: only organization administrators read or change the keys", async () => {
  if (!available) return;
  const stranger = { organizationId: one.accountId, actorSubjectId: "user:not-a-member" };
  await expect(listOrganizationAnthropicApiKeys(client.db, stranger)).rejects.toThrow();
  await expect(
    addOrganizationAnthropicApiKey(client.db, {
      ...stranger,
      label: "Mine",
      credentialEncrypted: encryptEnvironmentValue(key, "key-stranger"),
      credentialDigest: "digest:key-stranger",
      anthropicOrganizationId: null,
    }),
  ).rejects.toThrow();
}, 60_000);

test("MP-KEYS-08: other kinds can't hold further keys", async () => {
  if (!available) return;
  await upsertOrganizationModelProviderConnection(client.db, {
    ...actor(one),
    providerKind: "openrouter",
    credentialEncrypted: encryptEnvironmentValue(key, "router-key"),
    credentialDigest: "digest:router-key",
    operationId: crypto.randomUUID(),
  });
  await expect(
    shared!.admin`
      update organization_model_provider_connections
      set api_key_members = '[]'::jsonb
      where account_id = ${one.accountId} and provider_kind = 'openrouter'`,
  ).rejects.toThrow(/api_key_members_chk/);
}, 60_000);
