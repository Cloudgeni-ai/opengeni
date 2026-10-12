/**
 * A personal-only SuperGrok user on the shared core (design 5.3, "Personal
 * status and exhaustion re-read"), on real PostgreSQL as the non-owner
 * application role: the core status shows their own personal connection as
 * connected (and, in their own Personal workspace, as the effective account
 * validated by a live billing read), and a stored exhaustion of it is
 * re-read as its owner before it is trusted. Nobody else reads it.
 *
 * SuperGrok stays unregistered in production until its cutover (X3); this
 * file registers the production binding in its own process and admits it on
 * its own test database. Billing is scripted; real network is denied.
 *
 * Run this file in its own process: the registration replaces module
 * bindings for the whole process.
 */
import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { subscriptionCoreXaiProvider } from "../../../packages/db/src/subscription-core-xai-adapter";
import { encryptEnvironmentValue } from "../../../packages/db/src/environment-crypto";
import { rawRows } from "../../../packages/db/src/database";
import { installNetworkDenialGuard } from "../../../packages/db/test/fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "../../../packages/db/test/helpers/subscription-core-test-provider";

setDefaultTimeout(180_000);

const XAI = subscriptionCoreXaiProvider({
  refresh: (async () => {
    throw new Error("no token refresh is expected in this suite");
  }) as never,
});
for (const [specifier, factory] of testSubscriptionCoreProviderModules(XAI))
  mock.module(specifier, factory);

const { createDb, ensureManagedAccessForUser, subscriptionCorePersonalConnections } =
  await import("@opengeni/db");
const { readXaiCoreStatus } = await import("../src/xai-subscription-core");
type DbClient = Awaited<ReturnType<typeof createDb>>;

const key = Buffer.alloc(32, 83);
const settings = testSettings({
  environmentsEncryptionKey: key.toString("base64"),
  supergrokSubscriptionEnabled: true,
});

let shared: SharedTestDatabase;
let client: DbClient;
let network: ReturnType<typeof installNetworkDenialGuard>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("xai-core-personal-status-postgres");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  await admitTestSubscriptionCoreProvider(shared.admin, XAI);
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
  memberSubjectId: string;
};

/** An organization on the SuperGrok core route: the owner and a plain member. */
async function organization(): Promise<Org> {
  const userId = `xai-personal-status-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "SuperGrok personal status",
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
    values (${accountId}::uuid, 'SuperGrok shared workspace') returning id::text as id`;
  const memberSubjectId = `user:xai-personal-member-${crypto.randomUUID()}`;
  const [memberPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Member Personal workspace') returning id::text as id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}::uuid, ${memberSubjectId}, 'member', 'active', ${memberPersonal!.id}::uuid)`;
  for (const [workspaceId, subjectId, role] of [
    [workspace!.id, ownerSubjectId, "owner"],
    [workspace!.id, memberSubjectId, "member"],
    [memberPersonal!.id, memberSubjectId, "owner"],
  ] as const)
    await shared.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${role})
      on conflict do nothing`;
  await setCutover(accountId, true);
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspace!.id,
    memberSubjectId,
  };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'xai', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

/** The owner's own personal SuperGrok connection (a fresh, unexpired token). */
async function personalConnection(org: Org, label: string): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await shared.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  const credential = encryptEnvironmentValue(
    key,
    JSON.stringify({
      version: 1,
      accessToken: `access-${label}`,
      refreshToken: `refresh-${label}`,
    }),
  );
  await shared.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state,
      expires_at, label
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'xai', ${credential}, 'personal', 'people',
      ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId}, ${authorityId}::uuid,
      'subscription_connection', 1, ${`xai-user-${label}`}, '{}'::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label}
    )`;
  return connectionId;
}

/** Scripted SuperGrok billing: records each request and answers `usedPercent`. */
function billing(periodEnd: string) {
  const state = { usedPercent: 40, fail: false, calls: [] as string[] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/billing?format=credits")) throw new Error(`unexpected request ${url}`);
    state.calls.push(new Headers(init?.headers).get("authorization") ?? "");
    if (state.fail) return new Response("unavailable", { status: 503 });
    return Response.json({
      config: { creditUsagePercent: state.usedPercent, currentPeriod: { end: periodEnd } },
    });
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function storedQuota(connectionId: string) {
  const [row] = await shared.admin<
    { exhausted_kind: string | null; used: number | null; updated_at: Date }[]
  >`
    select quota->>'exhaustedKind' as exhausted_kind,
      (quota->'windows'->0->>'usedPercent')::float8 as used, updated_at
    from subscription_connection_quota where connection_id = ${connectionId}::uuid`;
  return row ?? null;
}

const MODELS = [{ id: "supergrok/grok-4.7" }];

function status(org: Org, workspaceId: string, subjectId: string, fetchImpl: typeof fetch) {
  return readXaiCoreStatus(
    { db: client.db, settings },
    {
      accountId: org.accountId,
      workspaceId,
      subjectId,
      models: async () => MODELS,
      fetch: fetchImpl,
    },
  );
}

describe("the test setup", () => {
  test("the application role is neither superuser nor RLS-bypassing", async () => {
    const [role] = await rawRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      client.db,
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("a personal-only SuperGrok user on the core", () => {
  test("sees connected:true; their own Personal workspace validates the personal account live", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "own");
    const upstream = billing(new Date(Date.now() + 7 * 86_400_000).toISOString());

    // Own Personal workspace: the personal account is the effective one,
    // validated by one billing read as its owner.
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toEqual({
      connected: true,
      valid: true,
      accountCount: 1,
      models: MODELS,
      activeAccount: {
        id: connectionId,
        label: "own",
        subject: "xai-user-own",
        scope: "user",
      },
    });
    expect(upstream.state.calls).toEqual(["Bearer access-own"]);
    expect((await storedQuota(connectionId))?.used).toBe(40);

    // A failed live read: still connected, not valid.
    upstream.state.fail = true;
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toMatchObject({ connected: true, valid: false, accountCount: 1, models: [] });
    upstream.state.fail = false;

    // A shared workspace: connected, but a personal account is never the
    // workspace's effective account (no live read there).
    upstream.state.calls.length = 0;
    expect(
      await status(org, org.sharedWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toEqual({ connected: true, valid: false, accountCount: 1 });
    // Another member sees nothing of it, in the shared workspace.
    expect(
      await status(org, org.sharedWorkspaceId, org.memberSubjectId, upstream.fetchImpl),
    ).toEqual({ connected: false, valid: false, accountCount: 0 });
    expect(upstream.state.calls).toEqual([]);

    // An organization held for maintenance reads and reports nothing usable.
    await setCutover(org.accountId, false);
    upstream.state.calls.length = 0;
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toEqual({ connected: false, valid: false, accountCount: 0 });
    expect(upstream.state.calls).toEqual([]);
  });

  test("their stored exhaustion is re-read as the owner before it is trusted; nobody else re-reads it", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "exhausted");
    const upstream = billing(new Date(Date.now() + 7 * 86_400_000).toISOString());
    // A status read at the limit stores the exhaustion.
    upstream.state.usedPercent = 100;
    expect(
      await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl),
    ).toMatchObject({ connected: true, valid: true });
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");

    const personal = subscriptionCorePersonalConnections(XAI);
    const refresh = (subjectId: string, minIntervalMs?: number) =>
      personal.refreshExhaustedSubscriptionCorePersonalQuota(
        client.db,
        settings,
        { accountId: org.accountId, subjectId },
        {
          fetchImpl: upstream.fetchImpl,
          ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
        },
      );
    upstream.state.usedPercent = 40;
    upstream.state.calls.length = 0;
    // Observed moments ago: not due for a re-read yet.
    expect(await refresh(org.ownerSubjectId)).toEqual([]);
    // Another member and the core's service subject read nothing.
    expect(await refresh(org.memberSubjectId, 0)).toEqual([]);
    expect(await refresh("service:subscription-core", 0)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");

    // Billing still at the limit: the stored exhaustion stands.
    upstream.state.usedPercent = 100;
    expect(await refresh(org.ownerSubjectId, 0)).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    // A failed read keeps it too.
    upstream.state.fail = true;
    expect(await refresh(org.ownerSubjectId, 0)).toEqual([]);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    upstream.state.fail = false;
    // Billing below the limit: the exhaustion ends and is reported.
    upstream.state.usedPercent = 40;
    upstream.state.calls.length = 0;
    expect(await refresh(org.ownerSubjectId, 0)).toEqual([connectionId]);
    expect(upstream.state.calls).toEqual(["Bearer access-exhausted"]);
    expect(await storedQuota(connectionId)).toMatchObject({ exhausted_kind: null, used: 40 });
    // Nothing exhausted remains to re-read.
    upstream.state.calls.length = 0;
    expect(await refresh(org.ownerSubjectId, 0)).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
  });

  test("a revoked personal authority re-reads and validates nothing", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "revoked");
    const upstream = billing(new Date(Date.now() + 7 * 86_400_000).toISOString());
    upstream.state.usedPercent = 100;
    await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl);
    await shared.admin`update organization_user_resource_authorities
      set status = 'revoked', revoked_at = now() where resource_id = ${connectionId}::uuid`;
    upstream.state.usedPercent = 40;
    upstream.state.calls.length = 0;
    expect(
      await subscriptionCorePersonalConnections(XAI).refreshExhaustedSubscriptionCorePersonalQuota(
        client.db,
        settings,
        { accountId: org.accountId, subjectId: org.ownerSubjectId },
        { fetchImpl: upstream.fetchImpl, minIntervalMs: 0 },
      ),
    ).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
    expect(
      (await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl))?.valid,
    ).not.toBe(true);
  });

  test("a paused personal connection's stored exhaustion is not re-read", async () => {
    const org = await organization();
    const connectionId = await personalConnection(org, "paused");
    const upstream = billing(new Date(Date.now() + 7 * 86_400_000).toISOString());
    upstream.state.usedPercent = 100;
    await status(org, org.personalWorkspaceId, org.ownerSubjectId, upstream.fetchImpl);
    expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    for (const paused of ["needs_relogin", "disabled"]) {
      await shared.admin`update subscription_connections set status = ${paused}
        where id = ${connectionId}::uuid`;
      upstream.state.usedPercent = 40;
      upstream.state.calls.length = 0;
      expect(
        await subscriptionCorePersonalConnections(
          XAI,
        ).refreshExhaustedSubscriptionCorePersonalQuota(
          client.db,
          settings,
          { accountId: org.accountId, subjectId: org.ownerSubjectId },
          { fetchImpl: upstream.fetchImpl, minIntervalMs: 0 },
        ),
      ).toEqual([]);
      expect(upstream.state.calls).toEqual([]);
      expect((await storedQuota(connectionId))?.exhausted_kind).toBe("quota");
    }
  });
});
