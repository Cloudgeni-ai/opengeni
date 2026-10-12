import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "../src/environment-crypto";
import {
  createDb,
  ensureManagedAccessForUser,
  readSubscriptionCoreProviderModelConnectionAccess,
  updateSubscriptionCoreProviderModelConnectionAccess,
  type DbClient,
  type ModelConnectionTarget,
} from "../src";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const credentialKey = Buffer.alloc(32, 47);
const credentialFixture = JSON.stringify({ accessToken: "fixture-only-sharing-token" });
let database: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  if (!realDb) return;
  database = await acquireSharedTestDatabase("subscription-personal-sharing-v1");
  if (!database) throw new Error("Real PostgreSQL is required");
  client = createDb(database.appUrl, { max: 6 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

async function fixture(provider: "codex" | "claude" | "xai" = "codex") {
  const userId = `sharing-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Sharing fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [owner] = await database!.admin<{ id: string }[]>`
    select id from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId}`;
  const [workspace] = await database!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Chosen workspace') returning id`;
  const id = crypto.randomUUID(),
    authorityId = crypto.randomUUID();
  await database!.admin`insert into organization_user_resource_authorities
    (id, account_id, organization_membership_id, resource_kind, resource_id, generation, status)
    values (${authorityId}::uuid, ${accountId}::uuid, ${owner!.id}::uuid,
      'subscription_connection', ${id}::uuid, 1, 'active')`;
  await database!.admin`insert into subscription_connections
    (id, account_id, provider, ownership, scope_kind, owner_organization_membership_id,
      owner_subject_id, authority_id, authority_resource_kind, authority_generation,
      credential_encrypted, provider_account_id, provider_subject_id, connected_by_subject_id)
    values (${id}::uuid, ${accountId}::uuid, ${provider}, 'personal', 'people', ${owner!.id}::uuid,
      ${subjectId}, ${authorityId}::uuid, 'subscription_connection', 1,
      ${encryptEnvironmentValue(credentialKey, credentialFixture)}, ${`upstream-${id}`}, ${`upstream-person-${id}`}, 'user:audit-only')`;
  const target: ModelConnectionTarget = {
    accountId,
    subjectId,
    workspaceId: null,
    connectionId: id,
    kind:
      provider === "xai" ? "supergrok" : provider === "claude" ? "claude_subscription" : "codex",
  };
  const policy = {
    allowedModels: null,
    allowedWorkspaces: [workspace!.id],
    allowPersonalWorkspaces: false,
    version: 1,
    sharePersonal: true as const,
  };
  const read = () => readSubscriptionCoreProviderModelConnectionAccess(client!.db, target);
  const save = (value = policy) =>
    updateSubscriptionCoreProviderModelConnectionAccess(client!.db, target, value);
  const stored = async () =>
    (
      await database!.admin`
    select c.*, r.status as resource_status from subscription_connections c
      join organization_user_resource_authorities r on r.id = ${authorityId}::uuid
      where c.id = ${id}::uuid`
    )[0]!;
  return {
    target,
    policy,
    read,
    save,
    stored,
    accountId,
    subjectId,
    id,
    authorityId,
    workspaceId: workspace!.id,
  };
}

describe.skipIf(!realDb)("explicit personal account sharing", () => {
  for (const provider of ["codex", "claude", "xai"] as const) {
    test(`SUB-OWN-06, SUB-OWN-07 ${provider}: exact owner-admin shares without rewriting credentials or audit identity`, async () => {
      const f = await fixture(provider),
        before = await f.stored();
      expect(await f.read()).toMatchObject({
        personalSharingSupported: true,
        peopleSupported: false,
        policy: { allowedWorkspaces: [], version: 1 },
      });
      expect(await f.save()).toMatchObject({ allowedWorkspaces: [f.workspaceId], version: 2 });
      const after = await f.stored();
      expect(after).toMatchObject({
        ownership: "shared",
        scope_kind: "workspaces",
        owner_subject_id: null,
        owner_organization_membership_id: null,
        authority_id: null,
        authority_generation: null,
        resource_status: "revoked",
        access_version: 2,
      });
      for (const field of [
        "id",
        "credential_encrypted",
        "provider_account_id",
        "provider_subject_id",
        "connected_by_subject_id",
        "refresh_generation",
        "created_at",
      ])
        expect(after[field]).toEqual(before[field]);
      expect(decryptEnvironmentValue(credentialKey, String(after.credential_encrypted))).toBe(
        credentialFixture,
      );
      expect((await f.read())?.personalSharingSupported).not.toBe(true);
      const rows = await database!
        .admin`select workspace_id from subscription_connection_workspaces where connection_id = ${f.id}::uuid`;
      expect(rows.map((r) => r.workspace_id)).toEqual([f.workspaceId]);
    });
  }
  test("SUB-OWN-06: omission of explicit sharing consent and stale versions change nothing", async () => {
    const f = await fixture();
    const { sharePersonal: _consent, ...ordinary } = f.policy;
    expect(
      await updateSubscriptionCoreProviderModelConnectionAccess(client!.db, f.target, ordinary),
    ).toBeNull();
    expect(await f.save({ ...f.policy, version: 999 })).toBeNull();
    expect(await f.stored()).toMatchObject({
      ownership: "personal",
      resource_status: "active",
      access_version: 1,
    });
  });
  test("SUB-OWN-06: a different organization administrator cannot read or share the owner's account", async () => {
    const f = await fixture();
    const subjectId = `user:other-admin-${crypto.randomUUID()}`;
    const [personal] = await database!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${f.accountId}::uuid, 'Other personal workspace') returning id`;
    await database!
      .admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      values (${f.accountId}::uuid, ${subjectId}, 'admin', 'active', ${personal!.id}::uuid)`;
    const target = { ...f.target, subjectId };
    expect(await readSubscriptionCoreProviderModelConnectionAccess(client!.db, target)).toBeNull();
    expect(
      await updateSubscriptionCoreProviderModelConnectionAccess(client!.db, target, f.policy),
    ).toBeNull();
    expect(await f.stored()).toMatchObject({ ownership: "personal", resource_status: "active" });
  });
  test("SUB-OWN-06: an owner without organization administration cannot widen authority", async () => {
    const f = await fixture();
    await database!.admin`update organization_memberships set role = 'member'
      where account_id = ${f.accountId}::uuid and subject_id = ${f.subjectId}`;
    await expect(f.save()).rejects.toThrow();
    expect(await f.stored()).toMatchObject({ ownership: "personal", resource_status: "active" });
  });
  test("SUB-OWN-06: invalid shared reach rolls back the conversion and resource revocation", async () => {
    const f = await fixture();
    await expect(
      f.save({ ...f.policy, allowedWorkspaces: [crypto.randomUUID()] }),
    ).rejects.toThrow();
    expect(await f.stored()).toMatchObject({
      ownership: "personal",
      resource_status: "active",
      access_version: 1,
    });
    await expect(f.save({ ...f.policy, allowedWorkspaces: [] })).rejects.toThrow();
  });
  test("SUB-OWN-06: existing shared identity is never merged, overwritten or widened", async () => {
    const f = await fixture();
    const before = await f.stored();
    await database!.admin`insert into subscription_connections
      (account_id, provider, ownership, scope_kind, credential_encrypted, provider_account_id, provider_subject_id)
      values (${f.accountId}::uuid, 'codex', 'shared', 'organization', 'other-fixture-envelope',
        ${before.provider_account_id}, ${before.provider_subject_id})`;
    await expect(f.save()).rejects.toThrow("cannot be shared");
    expect(await f.stored()).toMatchObject({ ownership: "personal", resource_status: "active" });
  });
  test("SUB-OWN-06: concurrent shares serialize and only one optimistic version commits", async () => {
    const f = await fixture();
    const results = await Promise.all([f.save(), f.save()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await f.stored()).toMatchObject({ ownership: "shared", access_version: 2 });
  });
  test("SUB-OWN-06: revoked personal authority cannot be converted", async () => {
    const f = await fixture();
    await database!
      .admin`update organization_user_resource_authorities set status = 'revoked', revoked_at = now()
      where id = ${f.authorityId}::uuid`;
    expect(await f.read()).toBeNull();
    expect(await f.save()).toBeNull();
  });
});
