/**
 * Live usage reads outside a workspace pool (design 5.3, C2c), for any
 * provider: an organization administrator's read of an organization-pool
 * connection, and an owner's read of their own personal connection in their
 * own Personal workspace (migration 0735's owner-only routines). Driven
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
const { rawRows, setSubjectRlsContext, withRlsContext } = await import("../src/database");
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

/**
 * The scripted usage endpoint: records each bearer and the redirect mode it
 * was asked with, and answers `respond()`. An injected transport aborts and
 * joins its work for a signal (`abortAndJoin`), as the custody requires.
 */
function scriptedUsage(
  respond: (bearer: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  const joined: AbortSignal[] = [];
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== USAGE_URL) throw new Error(`unexpected request ${url}`);
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      calls.push(bearer);
      redirects.push(init?.redirect);
      return await respond(bearer, init);
    },
    {
      abortAndJoin: async (signal: AbortSignal) => {
        joined.push(signal);
      },
    },
  ) as unknown as typeof fetch;
  return { calls, redirects, joined, fetchImpl };
}

const spent = (spentCents: number, resetsAt: number | null = Date.now() + 3_600_000) =>
  scriptedUsage(() => Response.json({ data: { spentCents, limitCents: 10_000, resetsAt } }));

const administered = () => subscriptionCoreAdministeredConnections(USAGE_PROVIDER);

const orgProbe = (accountId: string, subjectId: string, id: string, fetchImpl: typeof fetch) =>
  administered().probeSubscriptionCoreAdministeredConnectionUsage(
    client.db,
    settings,
    { kind: "organization_administrator", accountId, subjectId },
    id,
    { fetchImpl },
  );

const ownerProbe = (
  accountId: string,
  workspaceId: string,
  subjectId: string,
  id: string,
  fetchImpl: typeof fetch,
) =>
  administered().probeSubscriptionCoreAdministeredConnectionUsage(
    client.db,
    settings,
    { kind: "personal_owner", accountId, workspaceId, subjectId },
    id,
    { fetchImpl },
  );

async function connectionState(id: string) {
  const [row] = await shared.admin<{ status: string; version: number }[]>`
    select status, version::int as version from subscription_connections where id = ${id}::uuid`;
  return row!;
}

async function quotaRevision(id: string) {
  const [row] = await shared.admin<{ revision: number }[]>`
    select revision::int as revision from subscription_connection_quota
    where connection_id = ${id}::uuid`;
  return row?.revision ?? null;
}

/** A usage endpoint that never answers until the request is aborted. */
const stalled = () =>
  scriptedUsage(
    (_bearer, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );

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

  test("the application role owns none of the tables these reads touch, and row security is forced on the connection and quota tables", async () => {
    const rows = await rawRows<{ relname: string; owned: boolean; forced: boolean }>(
      client.db,
      sql`select class.relname::text as relname,
          pg_get_userbyid(class.relowner) = current_user as owned,
          class.relforcerowsecurity as forced
        from pg_class class
        where class.relkind = 'r'
          and class.relnamespace = (select oid from pg_namespace where nspname = current_schema())
          and class.relname in ('subscription_connections', 'subscription_connection_quota',
            'organization_memberships', 'organization_user_resource_authorities')
        order by class.relname`,
    );
    expect(rows.map((row) => [row.relname, row.owned])).toEqual([
      ["organization_memberships", false],
      ["organization_user_resource_authorities", false],
      ["subscription_connection_quota", false],
      ["subscription_connections", false],
    ]);
    expect(
      rows
        .filter((row) => row.relname.startsWith("subscription_connection"))
        .map((row) => row.forced),
    ).toEqual([true, true]);
  });
});

describe("the owner-only routines' predicates (0735)", () => {
  // Exact full-body baselines, not a bag of authorization fragments. This
  // deliberately rejects even a connector-only change, an added overload or
  // a moved check. Any change requires re-review against the behavioral
  // settings/context matrix below before updating these fingerprints.
  // Sources: live 0707 routines (including their 0715/0727 repairs and both
  // 0728 connect overloads), and the three routines introduced by 0735.
  // The 0736 shared-chat exception changes only acceptance's body here;
  // subscription-shared-personal-choice-postgres.test.ts pins its restricted
  // human/session/connection and mixed-runtime behavior. Administered routines
  // retain the exact original fingerprints and Personal-workspace-only rules.
  const expectedBodies: Record<string, string> = {
    "opengeni_private.begin_subscription_core_owned_connection_refresh(text, uuid, uuid, text, uuid)":
      "ae583ca6bf31f1ef2ac97f8be27bfde5daec12c7cd16fba9d5e5d2507926585d",
    "opengeni_private.begin_subscription_core_refresh(text, uuid, uuid, uuid, uuid, text, text, uuid, text, bigint)":
      "5a29f278a4dfe1f8cf96afe72692d3fcb2aee14b4f43c52706ba25311b9067dd",
    "opengeni_private.connect_subscription_core_personal(text, uuid, uuid, text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone, text, text, text)":
      "26f859c3d1bf85c7793cf94754823129951408b7baace816c712e37dae837442",
    "opengeni_private.connect_subscription_core_personal(text, uuid, uuid, text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone, text, text, text, text)":
      "b26a9716de2154cdb0f41f8a84951a390f5ddda08e779c9c4b3e7e1e5ce93e84",
    "opengeni_private.manage_subscription_core_personal(text, uuid, uuid, text, uuid, text, text, boolean, integer)":
      "a38170ff55a80dd2cb7e2bce62c99e9dba02ce35805e3bd9ae17d03aca49fa2e",
    "opengeni_private.read_subscription_core_owned_connection_credential(text, uuid, uuid, text, uuid)":
      "b0c1bcfe4b5749e4cf3bffda07c4406db582ec575bc2c75db064785d33652919",
    "opengeni_private.record_subscription_core_owned_connection_quota(text, uuid, uuid, text, uuid, bigint, bigint, jsonb, timestamp with time zone)":
      "dadb5ac909e2986a96f665f317f3c41f576e3b38c2b2ca4216162d12ffd86b2f",
    "opengeni_private.subscription_core_acceptance_authority_v2(text, uuid, uuid, uuid, text)":
      "9765ac89bbe2cb5a403999d7bd1494787fb9e502a36ceb790a136d99d7c6058b",
    "opengeni_subscription_internal.subscription_core_connection_target(text, uuid, uuid, uuid, uuid, uuid, text, bigint)":
      "91fd89de0908ef747007c9213dfc9e7939ece79261527e03e4176b8a9e8c1235",
  };
  type Routine = { identity: string; name: string; body: string };
  const liveRoutines = () => shared.admin<Routine[]>`
      select namespace.nspname || '.' || proc.proname || '(' ||
        pg_catalog.oidvectortypes(proc.proargtypes) || ')' as identity,
        proc.proname as name, proc.prosrc as body
      from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname in ('opengeni_private', 'opengeni_subscription_internal')
        and proc.proname in ('subscription_core_connection_target',
          'begin_subscription_core_refresh', 'connect_subscription_core_personal',
          'manage_subscription_core_personal', 'subscription_core_acceptance_authority_v2',
          'read_subscription_core_owned_connection_credential',
          'begin_subscription_core_owned_connection_refresh',
          'record_subscription_core_owned_connection_quota')
      order by identity`;
  const drift = (rows: Routine[]) => {
    const bodies = new Map(
      rows.map((row) => [
        row.identity,
        new Bun.CryptoHasher("sha256").update(row.body).digest("hex"),
      ]),
    );
    return [...new Set([...Object.keys(expectedBodies), ...bodies.keys()])].filter(
      (identity) => bodies.get(identity) !== expectedBodies[identity],
    );
  };

  test("pins complete live authorization bodies by schema and identity arguments, including both connect overloads", async () => {
    const rows = await liveRoutines();
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.name === "connect_subscription_core_personal")).toHaveLength(2);
    expect(drift(rows)).toEqual([]);
  });

  test("the exact drift guard rejects AND-to-OR bypasses in every owner routine and both connect overloads", async () => {
    const rows = await liveRoutines();
    expect(drift(rows)).toEqual([]);
    const targets = rows.filter(
      (row) =>
        row.name.includes("owned_connection") || row.name === "connect_subscription_core_personal",
    );
    expect(targets).toHaveLength(5);
    for (const target of targets) {
      const body = target.name.includes("owned_connection")
        ? target.body.replace("owned := FOUND AND", "owned := FOUND OR")
        : target.body.replace(
            "membership.status = 'active' AND",
            "membership.status = 'active' OR",
          );
      expect(body).not.toBe(target.body);
      expect(
        drift(rows.map((row) => (row.identity === target.identity ? { ...row, body } : row))),
      ).toEqual([target.identity]);
    }
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

describe("the organization's personal-connections rule (owner scope)", () => {
  async function setOrganization(org: Org, allowed: boolean, locked: boolean) {
    await shared.admin`
      insert into subscription_settings (account_id, workspace_id, rotation, providers,
        cross_provider_failover, fallback_order, personal_connections_allowed,
        personal_fallback_allowed, locked_settings)
      values (${org.accountId}::uuid, null, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb,
        ${allowed}, false, ${locked ? "{personalConnectionsAllowed}" : "{}"}::text[])
      on conflict (account_id, workspace_id) do update
        set personal_connections_allowed = excluded.personal_connections_allowed,
            locked_settings = excluded.locked_settings`;
  }
  /** The Personal-workspace override; `bypassLock` plants one the lock guard would refuse. */
  async function setOverride(org: Org, allowed: boolean | null, bypassLock = false) {
    await shared.admin.begin(async (tx) => {
      if (bypassLock) await tx`set local session_replication_role = replica`;
      await tx`
        insert into subscription_settings (account_id, workspace_id, personal_connections_allowed)
        values (${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid, ${allowed})
        on conflict (account_id, workspace_id) do update
          set personal_connections_allowed = excluded.personal_connections_allowed`;
    });
  }
  async function effective(org: Org) {
    const [row] = await shared.admin<{ allowed: string | null }[]>`
      select subscription_effective_settings(${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid)
        #>> '{values,personalConnectionsAllowed}' as allowed`;
    return row?.allowed ?? null;
  }

  test("off refuses; off and locked ignores a Personal-workspace override; off and unlocked follows it", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "own-setting");
    const upstream = spent(1_500);
    const probe = () =>
      ownerProbe(
        org.accountId,
        org.personalWorkspaceId,
        org.ownerSubjectId,
        personal,
        upstream.fetchImpl,
      );

    await setOrganization(org, false, false);
    expect(await effective(org)).toBe("false");
    expect(await probe()).toEqual({ kind: "not_visible" });

    await setOrganization(org, false, true);
    await setOverride(org, true, true);
    expect(await effective(org)).toBe("false");
    expect(await probe()).toEqual({ kind: "not_visible" });
    expect(upstream.calls).toEqual([]);
    expect(await storedQuota(personal)).toBeNull();

    await setOverride(org, null, true);
    await setOrganization(org, false, false);
    await setOverride(org, true);
    expect(await effective(org)).toBe("true");
    expect(await probe()).toMatchObject({ kind: "read", applied: true });
    expect(upstream.calls).toEqual(["Bearer sk-own-setting"]);
  });

  test("the owner-only routines refuse every other context, leave the app role no row, and fence the quota write", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "own-direct");
    const other = await member(org);
    const otherOrg = await organization();
    const owner = {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId as string | null,
    };
    type Call = {
      context?: Partial<typeof owner>;
      provider?: string;
      accountId?: string;
      workspaceId?: string;
      subjectId?: string;
      generation?: number;
      expected?: number | null;
    };
    const observation = {
      windows: [],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
      revision: 0,
      observedAt: Date.now(),
      observedRefreshGeneration: 1,
      source: "usage_endpoint",
    };
    const call = (input: Call = {}) => {
      const context = { ...owner, ...input.context };
      return withRlsContext(
        client.db,
        { accountId: context.accountId, workspaceId: context.workspaceId },
        async (tx) => {
          if (context.subjectId) await setSubjectRlsContext(tx, context.subjectId);
          const args = sql`${input.provider ?? FAKE_API_KEY_PROVIDER},
            ${input.accountId ?? context.accountId}::uuid,
            ${input.workspaceId ?? context.workspaceId}::uuid,
            ${input.subjectId ?? context.subjectId}, ${personal}::uuid`;
          const read = await rawRows<{ credential_encrypted: string | null }>(
            tx,
            sql`select credential_encrypted
              from opengeni_private.read_subscription_core_owned_connection_credential(${args})`,
          );
          const begin = await rawRows(
            tx,
            sql`select refresh_generation
              from opengeni_private.begin_subscription_core_owned_connection_refresh(${args})`,
          );
          const [record] = await rawRows<{ recorded: boolean }>(
            tx,
            sql`select opengeni_private.record_subscription_core_owned_connection_quota(${args},
              ${input.generation ?? 1}::bigint, ${input.expected ?? null}::bigint,
              ${JSON.stringify(observation)}::jsonb, now()) as recorded`,
          );
          // What the application role itself reaches afterwards, in the
          // same transaction (no capability outlives a routine).
          const reached = [
            ...(await rawRows(
              tx,
              sql`select id from subscription_connections where id = ${personal}::uuid`,
            )),
            ...(await rawRows(
              tx,
              sql`update subscription_connections set label = label
                where id = ${personal}::uuid returning id`,
            )),
            ...(await rawRows(
              tx,
              sql`select connection_id from subscription_connection_quota
                where connection_id = ${personal}::uuid`,
            )),
          ];
          return {
            read: read.length,
            credential: read.some((row) => row.credential_encrypted !== null),
            begin: begin.length,
            recorded: record?.recorded === true,
            reached: reached.length,
          };
        },
      );
    };
    const refused = { read: 0, credential: false, begin: 0, recorded: false, reached: 0 };
    const cases: Array<[string, Call]> = [
      ["a shared workspace", { context: { workspaceId: org.sharedWorkspaceId } }],
      ["a shared workspace argument", { workspaceId: org.sharedWorkspaceId }],
      [
        "another member in their Personal workspace",
        { context: { workspaceId: other.personalWorkspaceId, subjectId: other.subjectId } },
      ],
      ["another member in the owner's", { context: { subjectId: other.subjectId } }],
      ["another subject argument", { subjectId: other.subjectId }],
      ["no subject", { context: { subjectId: null } }],
      ["a service subject", { context: { subjectId: "service:subscription-core" } }],
      [
        "another organization",
        {
          context: {
            accountId: otherOrg.accountId,
            workspaceId: otherOrg.personalWorkspaceId,
            subjectId: otherOrg.ownerSubjectId,
          },
        },
      ],
      ["another organization argument", { accountId: otherOrg.accountId }],
      ["another provider", { provider: "another_provider" }],
    ];
    for (const [label, input] of cases)
      expect({ label, result: await call(input) }).toEqual({ label, result: refused });

    // Suspended, then revoked: the owner's own membership no longer admits.
    const suspended = await member(org);
    const theirs = await personalConnection(org, "own-suspended", suspended);
    const theirCall = () =>
      withRlsContext(
        client.db,
        { accountId: org.accountId, workspaceId: suspended.personalWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, suspended.subjectId);
          return (
            await rawRows(
              tx,
              sql`select 1 from opengeni_private.read_subscription_core_owned_connection_credential(
                ${FAKE_API_KEY_PROVIDER}, ${org.accountId}::uuid,
                ${suspended.personalWorkspaceId}::uuid, ${suspended.subjectId}, ${theirs}::uuid)`,
            )
          ).length;
        },
      );
    expect(await theirCall()).toBe(1);
    await shared.admin`update organization_memberships set status = 'suspended'
      where id = ${suspended.membershipId}::uuid`;
    expect(await theirCall()).toBe(0);
    await shared.admin`update organization_memberships set status = 'revoked', revoked_at = now()
      where id = ${suspended.membershipId}::uuid`;
    expect(await theirCall()).toBe(0);

    // The owner: all three admit; the app role still reaches nothing.
    expect(await call()).toEqual({
      read: 1,
      credential: true,
      begin: 1,
      recorded: true,
      reached: 0,
    });
    expect(await quotaRevision(personal)).toBe(1);
    // Record fences: another generation, a stale or absent expected
    // revision; then the current one applies.
    expect((await call({ generation: 2, expected: 1 })).recorded).toBe(false);
    expect((await call({ expected: null })).recorded).toBe(false);
    expect((await call({ expected: 1 })).recorded).toBe(true);
    expect((await call({ expected: 1 })).recorded).toBe(false);
    expect(await quotaRevision(personal)).toBe(2);

    // The organization switches personal connections off: all three refuse.
    await setOrganization(org, false, false);
    expect(await call({ expected: 2 })).toEqual(refused);
    expect(await quotaRevision(personal)).toBe(2);
  });
});

describe("refresh writers and request custody of both scopes", () => {
  test("an expired credential is marked for sign-in by its own scope only", async () => {
    const org = await organization();
    const sharedId = await sharedConnection(org, "org-expired");
    const personal = await personalConnection(org, "own-expired");
    const plain = await member(org);
    await shared.admin`update subscription_connections
      set expires_at = now() - interval '1 minute'
      where id in (${sharedId}::uuid, ${personal}::uuid)`;
    const upstream = spent(1_000);
    const before = {
      shared: await connectionState(sharedId),
      personal: await connectionState(personal),
    };
    expect(before.shared.status).toBe("active");
    expect(before.personal.status).toBe("active");
    // Callers of the other scope, or without authority: nothing is marked.
    for (const result of [
      await orgProbe(org.accountId, plain.subjectId, sharedId, upstream.fetchImpl),
      await orgProbe(org.accountId, org.ownerSubjectId, personal, upstream.fetchImpl),
      await ownerProbe(
        org.accountId,
        org.personalWorkspaceId,
        org.ownerSubjectId,
        sharedId,
        upstream.fetchImpl,
      ),
      await ownerProbe(
        org.accountId,
        plain.personalWorkspaceId,
        plain.subjectId,
        personal,
        upstream.fetchImpl,
      ),
    ])
      expect(result).toEqual({ kind: "not_visible" });
    expect(await connectionState(sharedId)).toEqual(before.shared);
    expect(await connectionState(personal)).toEqual(before.personal);
    // Each connection's own scope: a relogin, recorded on the connection.
    expect(await orgProbe(org.accountId, org.ownerSubjectId, sharedId, upstream.fetchImpl)).toEqual(
      { kind: "relogin" },
    );
    expect(
      await ownerProbe(
        org.accountId,
        org.personalWorkspaceId,
        org.ownerSubjectId,
        personal,
        upstream.fetchImpl,
      ),
    ).toEqual({ kind: "relogin" });
    for (const [id, previous] of [
      [sharedId, before.shared],
      [personal, before.personal],
    ] as const) {
      const after = await connectionState(id);
      expect(after.status).toBe("needs_relogin");
      expect(after.version).toBeGreaterThan(previous.version);
    }
    expect(upstream.calls).toEqual([]);
  });

  test("an undecodable credential is a token error, and a transport that cannot join is refused before any credential is loaded", async () => {
    const org = await organization();
    const sharedId = await sharedConnection(org, "org-undecodable");
    const personal = await personalConnection(org, "own-undecodable");
    const corrupt = encryptEnvironmentValue(key, "not a credential");
    await shared.admin`update subscription_connections set credential_encrypted = ${corrupt}
      where id in (${sharedId}::uuid, ${personal}::uuid)`;
    const upstream = spent(1_000);
    const orgRun = () => orgProbe(org.accountId, org.ownerSubjectId, sharedId, upstream.fetchImpl);
    const own = () =>
      ownerProbe(
        org.accountId,
        org.personalWorkspaceId,
        org.ownerSubjectId,
        personal,
        upstream.fetchImpl,
      );
    expect((await orgRun()).kind).toBe("token_error");
    expect((await own()).kind).toBe("token_error");
    // A plain callback (no abort-and-join) fails before the load would.
    const plainFetch = (async () => Response.json({})) as unknown as typeof fetch;
    for (const result of [
      await orgProbe(org.accountId, org.ownerSubjectId, sharedId, plainFetch),
      await ownerProbe(
        org.accountId,
        org.personalWorkspaceId,
        org.ownerSubjectId,
        personal,
        plainFetch,
      ),
    ]) {
      expect(result.kind).toBe("fetch_error");
      expect(String((result as { error: unknown }).error)).toContain("abort-and-join");
    }
    expect(upstream.calls).toEqual([]);
  });

  test("requests refuse redirects, cap the body at 1 MiB and stop at the scope's deadline; nothing is stored", async () => {
    const org = await organization();
    const sharedId = await sharedConnection(org, "org-bounded");
    const personal = await personalConnection(org, "own-bounded");
    const both = (fetchImpl: typeof fetch) => [
      () => orgProbe(org.accountId, org.ownerSubjectId, sharedId, fetchImpl),
      () =>
        ownerProbe(org.accountId, org.personalWorkspaceId, org.ownerSubjectId, personal, fetchImpl),
    ];
    // A redirect: the transport is asked to refuse it, and the refusal is a fetch error.
    const redirecting = scriptedUsage((_bearer, init) => {
      if (init?.redirect === "error") throw new TypeError("redirect mode is set to error");
      return Response.redirect("https://elsewhere.test/usage", 302);
    });
    for (const run of both(redirecting.fetchImpl)) expect((await run()).kind).toBe("fetch_error");
    expect(redirecting.redirects).toEqual(["error", "error"]);
    // An oversized body.
    const oversized = scriptedUsage(
      () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }),
    );
    for (const run of both(oversized.fetchImpl)) {
      const result = await run();
      expect(result.kind).toBe("fetch_error");
      expect(String((result as { error: unknown }).error)).toContain("byte limit");
    }
    expect(oversized.joined).toHaveLength(2);
    // A stalled endpoint: five seconds on the organization route, ten for the owner.
    const stall = stalled();
    const [organizationRun, ownerRun] = both(stall.fetchImpl);
    for (const [run, deadline] of [
      [organizationRun!, 5_000],
      [ownerRun!, 10_000],
    ] as const) {
      const started = performance.now();
      const result = await run();
      const elapsed = performance.now() - started;
      expect(result.kind).toBe("fetch_error");
      expect(String((result as { error: unknown }).error)).toContain("deadline");
      expect(elapsed).toBeGreaterThanOrEqual(deadline - 100);
      expect(elapsed).toBeLessThan(deadline + 3_000);
    }
    expect(stall.joined).toHaveLength(2);
    expect(stall.joined.every((signal) => signal.aborted)).toBe(true);
    expect(await storedQuota(sharedId)).toBeNull();
    expect(await storedQuota(personal)).toBeNull();
  });

  test("abort starts the injected join at the deadline and custody awaits that exact teardown", async () => {
    const org = await organization();
    const sharedId = await sharedConnection(org, "join-only-org");
    const personal = await personalConnection(org, "join-only-own");
    for (const [connectionId, deadline, probe] of [
      [
        sharedId,
        5_000,
        (transport: typeof fetch) =>
          orgProbe(org.accountId, org.ownerSubjectId, sharedId, transport),
      ],
      [
        personal,
        10_000,
        (transport: typeof fetch) =>
          ownerProbe(
            org.accountId,
            org.personalWorkspaceId,
            org.ownerSubjectId,
            personal,
            transport,
          ),
      ],
    ] as const) {
      const request = Promise.withResolvers<Response>();
      const joined = Promise.withResolvers<AbortSignal>();
      const teardown = Promise.withResolvers<void>();
      let joinCalls = 0;
      // No signal listener: only abortAndJoin can release this fetch.
      const transport = Object.assign(() => request.promise, {
        abortAndJoin(signal: AbortSignal) {
          joinCalls++;
          joined.resolve(signal);
          request.reject(signal.reason);
          return teardown.promise;
        },
      }) as unknown as typeof fetch;
      let settled = false;
      const started = performance.now();
      const result = probe(transport).finally(() => {
        settled = true;
      });
      const watchdog = setTimeout(
        () => joined.reject(new Error("join never started at abort")),
        deadline + 3_000,
      );
      try {
        const signal = await joined.promise;
        expect(signal.aborted).toBe(true);
        expect(performance.now() - started).toBeLessThan(deadline + 3_000);
        expect(joinCalls).toBe(1);
        // Fetch has rejected, but the exact join promise is still pending.
        const [held] = await shared.admin<{ acquired: boolean }[]>`
          select pg_try_advisory_xact_lock(hashtextextended(
            ${`subscription-refresh:${connectionId}`}, 0)) as acquired`;
        expect(held!.acquired).toBe(false);
        expect(settled).toBe(false);
        teardown.resolve();
        expect((await result).kind).toBe("fetch_error");
        const [released] = await shared.admin<{ acquired: boolean }[]>`
          select pg_try_advisory_xact_lock(hashtextextended(
            ${`subscription-refresh:${connectionId}`}, 0)) as acquired`;
        expect(released!.acquired).toBe(true);
        expect(await storedQuota(connectionId)).toBeNull();
      } finally {
        clearTimeout(watchdog);
        // Always release the fixture, even if a regression delays abortAndJoin.
        request.reject(new Error("fixture cleanup"));
        teardown.resolve();
        await result;
      }
    }
  });

  test("a rejected injected teardown is observed and reported, not swallowed as quiescence", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "rejected-join");
    const cleanupError = new Error("injected teardown failed");
    let joins = 0;
    const transport = Object.assign(
      async () => {
        throw new Error("request failed");
      },
      {
        abortAndJoin: () => {
          joins++;
          return Promise.reject(cleanupError);
        },
      },
    ) as unknown as typeof fetch;
    const result = await orgProbe(org.accountId, org.ownerSubjectId, connectionId, transport);
    expect(result).toEqual({ kind: "fetch_error", error: cleanupError });
    expect(joins).toBe(1);
    expect(await storedQuota(connectionId)).toBeNull();
  });

  test("an owner's request whose generation moves or whose authority is revoked mid-request is not applied", async () => {
    const org = await organization();
    const moved = await personalConnection(org, "own-moved");
    const revoked = await personalConnection(org, "own-revoked");
    const reading = () =>
      Response.json({ data: { spentCents: 100, limitCents: 10_000, resetsAt: null } });
    const moving = scriptedUsage(async () => {
      await shared.admin`update subscription_connections
        set refresh_generation = refresh_generation + 1 where id = ${moved}::uuid`;
      return reading();
    });
    const revoking = scriptedUsage(async () => {
      await shared.admin`update organization_user_resource_authorities
        set status = 'revoked', revoked_at = now() where resource_id = ${revoked}::uuid`;
      return reading();
    });
    for (const [id, upstream] of [
      [moved, moving],
      [revoked, revoking],
    ] as const) {
      expect(
        await ownerProbe(
          org.accountId,
          org.personalWorkspaceId,
          org.ownerSubjectId,
          id,
          upstream.fetchImpl,
        ),
      ).toMatchObject({ kind: "read", applied: false, recovered: false });
      expect(upstream.calls).toHaveLength(1);
      expect(await storedQuota(id)).toBeNull();
    }
  });

  test("an owner's reading that raced another quota write re-merges once and applies", async () => {
    const org = await organization();
    const personal = await personalConnection(org, "own-raced");
    const probe = (fetchImpl: typeof fetch) =>
      ownerProbe(org.accountId, org.personalWorkspaceId, org.ownerSubjectId, personal, fetchImpl);
    expect(await probe(spent(1_000).fetchImpl)).toMatchObject({ kind: "read", applied: true });
    expect(await quotaRevision(personal)).toBe(1);
    // Another writer holds the quota row with a newer revision while the
    // owner's write (merged from revision 1) waits for it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const writer = shared.admin.begin(async (tx) => {
      await tx`update subscription_connection_quota set revision = revision + 1
        where connection_id = ${personal}::uuid`;
      holding();
      await gate;
    });
    await held;
    const result = probe(spent(2_000).fetchImpl);
    let waited = false;
    for (let attempt = 0; attempt < 400 && !waited; attempt += 1) {
      const [row] = await shared.admin<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks where not granted`;
      waited = row!.waiting > 0;
      if (!waited) await Bun.sleep(25);
    }
    expect(waited).toBe(true);
    release();
    await writer;
    expect(await result).toMatchObject({ kind: "read", applied: true });
    expect(await quotaRevision(personal)).toBe(3);
    expect((await storedQuota(personal))!.windows).toMatchObject([
      { id: "spend_budget", usedPercent: 20 },
    ]);
  });

  test("the organization route waits at most five seconds for the membership lock, then reads nothing", async () => {
    const org = await organization();
    const connectionId = await sharedConnection(org, "org-locked");
    const upstream = spent(1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const lifecycle = shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${org.accountId}`}, 0))`;
      holding();
      await gate;
    });
    await held;
    const started = performance.now();
    const result = await orgProbe(
      org.accountId,
      org.ownerSubjectId,
      connectionId,
      upstream.fetchImpl,
    );
    const elapsed = performance.now() - started;
    release();
    await lifecycle;
    expect(result).toEqual({ kind: "not_visible" });
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(9_000);
    expect(upstream.calls).toEqual([]);
    expect(await storedQuota(connectionId)).toBeNull();
  });
});
