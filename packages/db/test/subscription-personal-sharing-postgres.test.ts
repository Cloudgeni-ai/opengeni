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
import { failoverFixture } from "./helpers/subscription-core-failover-fixture";
import { subscriptionCoreCodexProvider } from "../src/subscription-core-codex-adapter";
import { subscriptionCoreTurns } from "../src/subscription-core/turns";
import { subscriptionCoreRequests } from "../src/subscription-core/requests";

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
  test("SUB-OWN-06 SUB-ACCESS-05: sharing preserves pins, leases and quota but fences the next private request outside its new reach", async () => {
    const provider = subscriptionCoreCodexProvider();
    const harness = failoverFixture(
      database!,
      [provider],
      [
        {
          id: "codex/gpt-6-sol",
          provider: "codex",
          upstreamModelId: "gpt-6-sol",
          reasoningLevels: ["high"],
        },
      ],
    );
    try {
      const org = await harness.organization();
      const connectionId = await harness.connection(org, provider, { personal: true });
      await harness.exhausted(org.accountId, connectionId, Date.now() - 1_000);
      const work = await harness.turn(org, { private: true });
      await harness.pin(org, work, "codex", connectionId, "codex/gpt-6-sol");
      const placed = await subscriptionCoreTurns(provider).placeSubscriptionCoreTurn(
        harness.client.db,
        work,
      );
      expect(placed).toMatchObject({ kind: "run", connectionId });
      const ref = { connectionId, holderId: work.holderId, generation: work.executionGeneration };
      const requests = subscriptionCoreRequests(provider);
      const reserve = () =>
        requests.reserveSubscriptionCoreRequest(harness.client.db, work.identity, ref, {
          attemptId: work.attemptId,
          executionGeneration: work.executionGeneration,
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
        });
      await reserve();
      const snapshot = async () => {
        const [rows] = await database!.admin`select
          (select jsonb_agg(to_jsonb(b)) from subscription_session_bindings b where session_id = ${work.identity.sessionId}::uuid) as bindings,
          (select jsonb_agg(to_jsonb(l)) from subscription_leases l where turn_id = ${work.identity.turnId}::uuid) as leases,
          (select jsonb_agg(to_jsonb(q)) from subscription_connection_quota q where connection_id = ${connectionId}::uuid) as quota,
          (select subscription_authority from session_turns where id = ${work.identity.turnId}::uuid) as authority`;
        return rows;
      };
      const before = await snapshot();
      expect(before!.bindings).toHaveLength(1);
      expect(before!.leases).toHaveLength(1);
      expect(before!.quota).toHaveLength(1);
      const [other] = await database!.admin<
        { id: string }[]
      >`insert into workspaces(account_id, name)
        values (${org.accountId}::uuid, 'New shared reach') returning id`;
      const target: ModelConnectionTarget = {
        accountId: org.accountId,
        subjectId: org.subjectId,
        workspaceId: null,
        connectionId,
        kind: "codex",
      };
      const access = await readSubscriptionCoreProviderModelConnectionAccess(
        harness.client.db,
        target,
      );
      expect(
        await updateSubscriptionCoreProviderModelConnectionAccess(harness.client.db, target, {
          allowedModels: null,
          allowedWorkspaces: [other!.id],
          allowPersonalWorkspaces: false,
          version: access!.policy.version,
          sharePersonal: true,
        }),
      ).not.toBeNull();
      expect(await snapshot()).toEqual(before);
      await expect(reserve()).rejects.toThrow();
      // Refused reservation is atomic: it cannot create another request row.
      const [count] = await database!
        .admin`select count(*)::int as n from subscription_operation_leases
        where turn_id = ${work.identity.turnId}::uuid`;
      expect(count!.n).toBe(1);
    } finally {
      await harness.client.close();
    }
  });
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
  test.each(["refresh", "disconnect", "management_revoked"] as const)(
    "SUB-OWN-06: sharing rechecks after concurrent %s commits",
    async (change) => {
      const f = await fixture();
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const refreshed = encryptEnvironmentValue(credentialKey, "refreshed-sharing-fixture");
      const holder = database!.admin.begin(async (tx) => {
        const key =
          change === "management_revoked"
            ? `organization-membership:${f.accountId}`
            : `subscription-refresh:${f.id}`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        locked.resolve();
        await release.promise;
        if (change === "refresh")
          await tx`update subscription_connections set credential_encrypted = ${refreshed},
            refresh_generation = refresh_generation + 1 where id = ${f.id}::uuid`;
        else if (change === "disconnect")
          await tx`update subscription_connections set disconnected_at = now(), status = 'disabled',
              credential_encrypted = '', provider_account_id = null, allocator_enabled = false where id = ${f.id}::uuid`;
        else
          await tx`update organization_memberships set role = 'member' where account_id = ${f.accountId}::uuid and subject_id = ${f.subjectId}`;
      });
      let saving: ReturnType<typeof f.save> | undefined;
      try {
        await Promise.race([locked.promise, holder]);
        saving = f.save();
        void saving.catch(() => {});
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (!blocked && Date.now() < deadline) {
          const [row] = await database!.admin`select exists (
            select 1 from pg_stat_activity where datname = current_database()
              and pid <> pg_backend_pid() and wait_event_type = 'Lock'
                and (query like '%subscription_core_personal_sharing%' or query like '%pg_advisory_xact_lock_shared%')
          ) as blocked`;
          blocked = row!.blocked === true;
          if (!blocked) await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
      } finally {
        release.resolve();
        await holder;
      }
      if (change === "management_revoked") {
        await expect(saving!).rejects.toThrow();
        expect(await f.stored()).toMatchObject({
          ownership: "personal",
          resource_status: "active",
          access_version: 1,
        });
        return;
      }
      const saved = await saving;
      const after = await f.stored();
      if (change === "refresh") {
        expect(saved).not.toBeNull();
        expect(after).toMatchObject({
          ownership: "shared",
          credential_encrypted: refreshed,
        });
        expect(Number(after.refresh_generation)).toBe(2);
      } else {
        expect(saved).toBeNull();
        expect(after).toMatchObject({
          ownership: "personal",
          resource_status: "active",
          access_version: 1,
        });
      }
    },
  );
});
