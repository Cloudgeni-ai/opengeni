/**
 * Live usage reads outside a workspace pool (design 5.3, C2c), for any
 * provider: an organization administrator's read of an organization-pool
 * connection, and an owner's read of their own personal connection in their
 * own Personal workspace (migration 0729's owner-only routines). Driven
 * through the test-only API-key connector with a scripted usage endpoint, on
 * real PostgreSQL as the application role; no provider name of production
 * appears here, and production registers nothing (asserted below).
 *
 * Run this file in its own process: the registration below replaces module
 * bindings for the whole process.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import type { SubscriptionCoreConnectionRead, SubscriptionQuota } from "@opengeni/subscriptions";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import type { SubscriptionCoreProvider } from "../src/subscription-core/provider";
import {
  FAKE_API_KEY_PROVIDER,
  fakeApiKeyAdapter,
  fakeApiKeyProvider,
  installNetworkDenialGuard,
  type FakeApiKeyCredential,
} from "./fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "./helpers/subscription-core-test-provider";

setDefaultTimeout(180_000);
// Read before the test registration: what production registers.
const productionProviderIds = subscriptionCoreProviderIds();

/** The scripted spend-budget usage endpoint (never a real network origin). */
const USAGE_URL = "https://usage.conformance.test/v1/usage";

/**
 * The fake API-key connector with an out-of-turn usage probe: the
 * spend-budget endpoint, read through the core's request custody and decoded
 * into the shared quota model.
 */
const USAGE_PROVIDER: SubscriptionCoreProvider<FakeApiKeyCredential> = Object.freeze({
  ...fakeApiKeyProvider,
  adapter: Object.freeze({
    ...fakeApiKeyAdapter,
    async fetchUsage(read: SubscriptionCoreConnectionRead<FakeApiKeyCredential>) {
      const token = await read.getToken();
      const response = await read.fetch(USAGE_URL, {
        headers: { authorization: `Bearer ${token.credential.apiKey}` },
      });
      if (!response.ok) throw new Error(`usage read failed (${response.status})`);
      return (await response.json()) as unknown;
    },
    decodeQuota(input: {
      response: unknown;
      observedAt: number;
      refreshGeneration: number;
    }): SubscriptionQuota | null {
      const data = (input.response as { data?: { spentCents: number; limitCents: number } }).data;
      if (!data) return null;
      const resetsAt = (input.response as { data: { resetsAt: number | null } }).data.resetsAt;
      const usedPercent = Math.min(100, (data.spentCents / data.limitCents) * 100);
      return {
        windows: [
          {
            id: "spend_budget",
            usedPercent,
            resetsAt,
            status: usedPercent >= 100 ? "exhausted" : usedPercent >= 80 ? "warning" : "ok",
          },
        ],
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        revision: 0,
        observedAt: input.observedAt,
        observedRefreshGeneration: input.refreshGeneration,
        source: "usage_endpoint",
      };
    },
  }),
});

for (const [specifier, factory] of testSubscriptionCoreProviderModules(USAGE_PROVIDER))
  mock.module(specifier, factory);
const { createDb, ensureManagedAccessForUser, subscriptionCoreAdministeredConnections } =
  await import("../src");
const { listSubscriptionCorePersonalConnectionRowsInTransaction } =
  await import("../src/subscription-core/administration");
const { rawRows, withRlsContext } = await import("../src/database");
type DbClient = Awaited<ReturnType<typeof createDb>>;

const key = Buffer.alloc(32, 71);
const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;

let shared: SharedTestDatabase;
let client: DbClient;
let network: ReturnType<typeof installNetworkDenialGuard>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("subscription-core-administered-reads-v1");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  await admitTestSubscriptionCoreProvider(shared.admin, USAGE_PROVIDER);
  client = createDb(shared.appUrl, { max: 6 });
  network = installNetworkDenialGuard(() => []);
}, 180_000);

afterAll(async () => {
  network?.restore();
  network?.assertNoEscapes();
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `administered-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Administered reads",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Administered shared workspace') returning id::text as id`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await setCutover(accountId, true);
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspace!.id,
  };
}

/** Another active member with their own Personal workspace, also in the shared workspace. */
async function member(org: Org, role: "member" | "admin" = "member") {
  const subjectId = `user:administered-member-${crypto.randomUUID()}`;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${org.accountId}::uuid, 'Administered member Personal workspace')
    returning id::text as id`;
  const [membership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}::uuid, ${subjectId}, ${role}, 'active', ${personal!.id}::uuid)
    returning id::text as id`;
  for (const workspaceId of [personal!.id, org.sharedWorkspaceId])
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${workspaceId}::uuid, ${subjectId},
        ${workspaceId === personal!.id ? "owner" : "member"})
      on conflict do nothing`;
  return { subjectId, membershipId: membership!.id, personalWorkspaceId: personal!.id };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, ${FAKE_API_KEY_PROVIDER}, ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

function credential(apiKey: string): string {
  return encryptEnvironmentValue(key, fakeApiKeyAdapter.credential.encode({ apiKey }));
}

async function sharedConnection(
  org: Org,
  label: string,
  options: { managedByWorkspaceId?: string } = {},
): Promise<string> {
  const [row] = await shared.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, provider_subject_id, label,
      managed_by_workspace_id
    ) values (
      ${org.accountId}::uuid, ${FAKE_API_KEY_PROVIDER}, 'api_key', ${credential(`sk-${label}`)},
      'shared', 'organization', true, ${`${label}-${crypto.randomUUID()}`}, ${label}, ${label},
      ${options.managedByWorkspaceId ?? null}::uuid
    ) returning id::text as id`;
  return row!.id;
}

async function personalConnection(
  org: Org,
  label: string,
  owner: { subjectId: string; membershipId: string } = {
    subjectId: org.ownerSubjectId,
    membershipId: org.ownerMembershipId,
  },
): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${owner.membershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  await shared.admin`
    insert into subscription_connections (
      id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id,
      provider_subject_id, label
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, ${FAKE_API_KEY_PROVIDER}, 'api_key',
      ${credential(`sk-${label}`)}, 'personal', 'people', ${owner.membershipId}::uuid,
      ${owner.subjectId}, ${authorityId}::uuid, 'subscription_connection', 1,
      ${`${label}-${connectionId}`}, ${label}, ${label}
    )`;
  return connectionId;
}

async function storedQuota(connectionId: string) {
  const [row] = await shared.admin<{ quota: SubscriptionQuota | null }[]>`
    select quota from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
  return row?.quota ?? null;
}

/** The scripted usage endpoint: records each bearer and answers `respond()`. */
function scriptedUsage(respond: (bearer: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== USAGE_URL) throw new Error(`unexpected request ${url}`);
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(bearer);
    return await respond(bearer);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const spent = (spentCents: number, resetsAt: number | null = Date.now() + 3_600_000) =>
  scriptedUsage(() => Response.json({ data: { spentCents, limitCents: 10_000, resetsAt } }));

const administered = () => subscriptionCoreAdministeredConnections(USAGE_PROVIDER);

describe("the test registration", () => {
  test("production registers no test provider", () => {
    expect(productionProviderIds).not.toContain(FAKE_API_KEY_PROVIDER);
  });

  test("the application role is neither superuser nor RLS-bypassing", async () => {
    const [role] = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      client.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("an organization administrator's read (organization route)", () => {
  test("reads an organization-pool connection live; a member, another organization, a workspace-managed or personal connection and maintenance read nothing", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "org-live");
    const managed = await sharedConnection(org, "org-managed", {
      managedByWorkspaceId: org.sharedWorkspaceId,
    });
    const personal = await personalConnection(org, "org-personal");
    const plain = await member(org);
    const otherOrg = await organization();
    const upstream = spent(4_000);
    const probe = (accountId: string, subjectId: string, id: string) =>
      administered().probeSubscriptionCoreAdministeredConnectionUsage(
        client.db,
        settings,
        { kind: "organization_administrator", accountId, subjectId },
        id,
        { fetchImpl: upstream.fetchImpl },
      );
    for (const [accountId, subjectId, id] of [
      // A member who is not an administrator.
      [org.accountId, plain.subjectId, connectionId],
      // Another organization's administrator, for this organization or on their own.
      [org.accountId, otherOrg.ownerSubjectId, connectionId],
      [otherOrg.accountId, otherOrg.ownerSubjectId, connectionId],
      // A connection a workspace manages, and a personal connection.
      [org.accountId, org.ownerSubjectId, managed],
      [org.accountId, org.ownerSubjectId, personal],
    ] as const)
      expect(await probe(accountId, subjectId, id)).toEqual({ kind: "not_visible" });
    await setCutover(org.accountId, false);
    expect(await probe(org.accountId, org.ownerSubjectId, connectionId)).toEqual({
      kind: "not_visible",
    });
    await setCutover(org.accountId, true);
    expect(upstream.calls).toEqual([]);
    for (const id of [connectionId, managed, personal]) expect(await storedQuota(id)).toBeNull();

    // The administrator (also an organization `admin` member): a live read, stored.
    const admin = await member(org, "admin");
    const result = await probe(org.accountId, admin.subjectId, connectionId);
    expect(result).toMatchObject({ kind: "read", applied: true, recovered: false });
    expect(upstream.calls).toEqual(["Bearer sk-org-live"]);
    const quota = (await storedQuota(connectionId))!;
    expect(quota.source).toBe("usage_endpoint");
    expect(quota.windows).toMatchObject([{ id: "spend_budget", usedPercent: 40, status: "ok" }]);
  });

  test("a failed provider read is reported, never thrown, and stores nothing", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "org-failing");
    const failing = scriptedUsage(() => new Response("refused", { status: 401 }));
    const result = await administered().probeSubscriptionCoreAdministeredConnectionUsage(
      client.db,
      settings,
      {
        kind: "organization_administrator",
        accountId: org.accountId,
        subjectId: org.ownerSubjectId,
      },
      connectionId,
      { fetchImpl: failing.fetchImpl },
    );
    expect(result.kind).toBe("fetch_error");
    expect(failing.calls).toHaveLength(1);
    expect(await storedQuota(connectionId)).toBeNull();
  });

  test("a reading whose bearer generation moved during the request is not applied", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "org-fenced");
    const upstream = scriptedUsage(async () => {
      // A reconnect or refresh commits while the request is in flight.
      await shared.admin`
        update subscription_connections set refresh_generation = refresh_generation + 1
        where id = ${connectionId}::uuid`;
      return Response.json({ data: { spentCents: 100, limitCents: 10_000, resetsAt: null } });
    });
    const result = await administered().probeSubscriptionCoreAdministeredConnectionUsage(
      client.db,
      settings,
      {
        kind: "organization_administrator",
        accountId: org.accountId,
        subjectId: org.ownerSubjectId,
      },
      connectionId,
      { fetchImpl: upstream.fetchImpl },
    );
    expect(result).toMatchObject({ kind: "read", applied: false, recovered: false });
    expect(await storedQuota(connectionId)).toBeNull();
  });
});

describe("a personal connection's owner (own Personal workspace)", () => {
  test("the owner reads it live only in their own Personal workspace; nobody else and nothing else reaches it", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "own-live");
    const sharedId = await sharedConnection(org, "own-shared");
    const other = await member(org);
    const upstream = spent(2_500);
    const probe = (workspaceId: string, subjectId: string, id = personal) =>
      administered().probeSubscriptionCoreAdministeredConnectionUsage(
        client.db,
        settings,
        { kind: "personal_owner", accountId: org.accountId, workspaceId, subjectId },
        id,
        { fetchImpl: upstream.fetchImpl },
      );
    const refused = async (workspaceId: string, subjectId: string, id = personal) =>
      expect((await probe(workspaceId, subjectId, id)).kind).toBe("not_visible");
    // Another member, in their own Personal workspace or the owner's; the
    // owner in a shared workspace; a service actor with no person; a shared
    // connection through the owner scope.
    await refused(other.personalWorkspaceId, other.subjectId);
    await refused(org.personalWorkspaceId, other.subjectId);
    await refused(org.sharedWorkspaceId, org.ownerSubjectId);
    await refused(org.personalWorkspaceId, "service:subscription-core");
    await refused(org.personalWorkspaceId, org.ownerSubjectId, sharedId);
    // A revoked authority, a stale authority generation, maintenance.
    await shared.admin`update organization_user_resource_authorities
      set status = 'revoked', revoked_at = now() where resource_id = ${personal}::uuid`;
    await refused(org.personalWorkspaceId, org.ownerSubjectId);
    await shared.admin`update organization_user_resource_authorities
      set status = 'active', revoked_at = null, generation = 2
      where resource_id = ${personal}::uuid`;
    await refused(org.personalWorkspaceId, org.ownerSubjectId);
    await shared.admin`update organization_user_resource_authorities
      set generation = 1 where resource_id = ${personal}::uuid`;
    await setCutover(org.accountId, false);
    await refused(org.personalWorkspaceId, org.ownerSubjectId);
    await setCutover(org.accountId, true);
    expect(upstream.calls).toEqual([]);
    expect(await storedQuota(personal)).toBeNull();
    expect(await storedQuota(sharedId)).toBeNull();

    // The owner, in their own Personal workspace: a live read, stored.
    const result = await probe(org.personalWorkspaceId, org.ownerSubjectId);
    expect(result).toMatchObject({ kind: "read", applied: true, recovered: false });
    expect(upstream.calls).toEqual(["Bearer sk-own-live"]);
    expect((await storedQuota(personal))!.windows).toMatchObject([
      { id: "spend_budget", usedPercent: 25, status: "ok" },
    ]);
  });

  test("the owner's stored exhaustion and status re-read through the owner-only reader; a recovery is reported", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "own-exhausted");
    const other = await member(org);
    const resetsAt = Date.now() + 3_600_000;
    const probe = (fetchImpl: typeof fetch) =>
      administered().probeSubscriptionCoreAdministeredConnectionUsage(
        client.db,
        settings,
        {
          kind: "personal_owner",
          accountId: org.accountId,
          workspaceId: org.personalWorkspaceId,
          subjectId: org.ownerSubjectId,
        },
        personal,
        { fetchImpl },
      );
    expect(await probe(spent(10_000, resetsAt).fetchImpl)).toMatchObject({
      kind: "read",
      applied: true,
      recovered: false,
    });
    // The stored state, without a credential read: the owner sees their own
    // connection's status and exhausted window in their Personal workspace
    // and in a shared workspace they belong to; another member sees nothing.
    const rows = (workspaceId: string, subjectId: string) =>
      withRlsContext(client.db, { accountId: org.accountId, workspaceId }, (tx) =>
        listSubscriptionCorePersonalConnectionRowsInTransaction(tx, USAGE_PROVIDER, {
          accountId: org.accountId,
          workspaceId,
          subjectId,
        }),
      );
    for (const workspaceId of [org.personalWorkspaceId, org.sharedWorkspaceId]) {
      const [row] = await rows(workspaceId, org.ownerSubjectId);
      expect(row?.id).toBe(personal);
      expect(row?.status).toBe("active");
      expect((row!.quota as SubscriptionQuota).windows).toMatchObject([
        { id: "spend_budget", usedPercent: 100, status: "exhausted", resetsAt },
      ]);
    }
    expect(await rows(other.personalWorkspaceId, other.subjectId)).toEqual([]);
    expect(await rows(org.sharedWorkspaceId, other.subjectId)).toEqual([]);

    // A later reading under the reset reports recovered capacity.
    expect(await probe(spent(1_000, resetsAt).fetchImpl)).toMatchObject({
      kind: "read",
      applied: true,
      recovered: true,
    });
  });
});
