import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connectSubscriptionCoreCodexConnection,
  createDb,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  grantDeferredRuntimeAccess,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import type { AccessGrantAuthorization } from "../src/access";
import {
  getOwnResourceHere,
  listOwnResourcesHere,
  nameOwnResources,
  OwnResourceAlwaysOnError,
  OwnResourceNotFoundError,
  ownResourceKey,
  setOwnResourceHere,
} from "../src/application/user-resource-grants";

// The production posture: a non-superuser migration owner, FORCE RLS, a named
// schema and the restricted runtime login.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("own-resource-reach");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await grantDeferredRuntimeAccess(shared.admin);
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  app = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    connection: { search_path: shared.schema },
    onnotice: () => undefined,
  });
}, 900_000);
afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const MEMBER_PERMISSIONS = [
  "workspace:read",
  "connections:read",
  "connections:personal",
  "enrollments:read",
  "sessions:create",
];

async function fixture() {
  const userId = `own-reach-${crypto.randomUUID()}`;
  const owner = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Own reach owner",
  });
  const home = access.workspaceGrants.find(
    (grant) => grant.workspaceId === access.defaultWorkspaceId,
  )!;
  const accountId = home.accountId;
  const [membership] = await shared.admin<{ personal: string }[]>`
    select personal_workspace_id as personal from organization_memberships
    where account_id = ${accountId} and subject_id = ${owner}`;
  const personal = membership!.personal;
  // A second shared workspace the owner belongs to.
  const [other] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, 'Other team') returning id`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${other!.id}, ${accountId})`;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}, ${other!.id}, ${owner}, 'member')`;
  const authorization = (workspaceId: string, permissions = MEMBER_PERMISSIONS) =>
    ({
      grant: { ...home, workspaceId, permissions: permissions as never },
      accountGrant: access.accountGrants[0] ?? null,
      authenticatedSubjectId: owner,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    }) satisfies AccessGrantAuthorization;
  return { accountId, owner, origin: home.workspaceId, other: other!.id, personal, authorization };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function connectMachine(f: Fixture) {
  const [machine] = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${f.accountId}, true),
      set_config('opengeni.workspace_id', ${f.origin}, true),
      set_config('opengeni.subject_id', ${f.owner}, true)`;
    return await tx<Array<{ enrollmentId: string }>>`
      select enrollment_id as "enrollmentId"
      from finalize_scoped_enrollment(${f.accountId}::uuid, ${f.origin}::uuid, 'user',
        ${`ed25519:reach-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64', 'Laptop', false)`;
  });
  return machine!.enrollmentId;
}

async function addLogin(f: Fixture, workspaceId: string) {
  const [row] = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${f.accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${f.owner}, true)`;
    return await tx<{ id: string }[]>`
      insert into connections (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
      values (${f.accountId}, ${workspaceId}, ${f.owner}, 'linear.app', 'oauth2', 'ciphertext')
      returning id`;
  });
  return row!.id;
}

async function connectPlan(f: Fixture) {
  await shared.admin`delete from subscription_settings
    where account_id = ${f.accountId}::uuid and workspace_id is null`;
  await shared.admin`insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed)
    values (${f.accountId}::uuid, ${shared.admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true)`;
  await shared.admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${f.accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = true`;
  const connected = await withSessionRlsActorContext({ subjectId: f.owner }, () =>
    connectSubscriptionCoreCodexConnection(client.db, {
      accountId: f.accountId,
      workspaceId: f.personal,
      subjectId: f.owner,
      credentialEncrypted: encryptEnvironmentValue(
        Buffer.alloc(32, 41),
        JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
      ),
      providerAccountId: `reach-${crypto.randomUUID()}`,
      providerSubjectId: `reach-${crypto.randomUUID()}`,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      lastRefreshAt: new Date(),
      accountEmail: "owner@example.test",
      label: "Own account",
    }),
  );
  if (connected.kind !== "connected") throw new Error(`connect refused: ${connected.reason}`);
  return connected.id;
}

/** What turn admission decides (1142), read as the migration owner. */
async function sqlMachineOn(f: Fixture, enrollmentId: string, workspaceId: string) {
  const [row] = await shared.admin<{ on: boolean }[]>`
    select opengeni_private.personal_machine_on_in_workspace_v1(
      ${f.accountId}::uuid, ${enrollmentId}::uuid, ${workspaceId}::uuid
    ) as on`;
  return row!.on;
}

const deps = () => ({ db: client.db });

async function reach(
  f: Fixture,
  workspaceId: string,
  resource: Parameters<typeof getOwnResourceHere>[3],
) {
  return await getOwnResourceHere(deps(), f.authorization(workspaceId), workspaceId, resource);
}

describe("where your own things work (real PostgreSQL)", () => {
  test("a machine is on where admission lets it run, before and after each switch", async () => {
    const f = await fixture();
    const resourceId = await connectMachine(f);
    const resource = { resourceKind: "connected_machine" as const, resourceId };
    const places = [f.personal, f.origin, f.other];
    const agree = async (expected: Record<string, boolean>) => {
      for (const workspaceId of places) {
        const here = await reach(f, workspaceId, resource);
        expect({ workspaceId, on: here?.on }).toEqual({ workspaceId, on: expected[workspaceId] });
        expect(await sqlMachineOn(f, resourceId, workspaceId)).toBe(expected[workspaceId]!);
        expect(here?.alwaysOn).toBe(false);
        expect(here?.personal).toBe(workspaceId === f.personal);
      }
    };

    // On where it was connected and in the Personal workspace, off elsewhere.
    await agree({ [f.personal]: true, [f.origin]: true, [f.other]: false });

    const set = (workspaceId: string, on: boolean) =>
      setOwnResourceHere(deps(), f.authorization(workspaceId), workspaceId, { ...resource, on });
    expect(await set(f.other, true)).toMatchObject({ on: true, canChange: true });
    await agree({ [f.personal]: true, [f.origin]: true, [f.other]: true });
    // Off where it was on by default, with nothing recorded there yet.
    expect(await set(f.origin, false)).toMatchObject({ on: false });
    expect(await set(f.personal, false)).toMatchObject({ on: false });
    await agree({ [f.personal]: false, [f.origin]: false, [f.other]: true });
    // Off stays off; back on where it was off.
    expect(await set(f.origin, false)).toMatchObject({ on: false });
    expect(await set(f.origin, true)).toMatchObject({ on: true });
    expect(await set(f.other, false)).toMatchObject({ on: false });
    await agree({ [f.personal]: false, [f.origin]: true, [f.other]: false });
  }, 180_000);

  test("a login is always on in Personal and on in a shared workspace where it is turned on", async () => {
    const f = await fixture();
    const resourceId = await addLogin(f, f.origin);
    const resource = { resourceKind: "connection" as const, resourceId };

    expect(await reach(f, f.personal, resource)).toEqual({
      personal: true,
      on: true,
      alwaysOn: true,
      canChange: false,
    });
    // It starts on where it was added (1152).
    expect(await reach(f, f.origin, resource)).toMatchObject({ on: true, canChange: true });
    expect(await reach(f, f.other, resource)).toMatchObject({ on: false, canChange: true });

    const set = (workspaceId: string, on: boolean) =>
      setOwnResourceHere(deps(), f.authorization(workspaceId), workspaceId, { ...resource, on });
    expect(await set(f.other, true)).toMatchObject({ on: true });
    expect(await set(f.other, true)).toMatchObject({ on: true });
    const grants = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from organization_user_resource_grants grant_value
      join connections connection on connection.authority_id = grant_value.authority_id
      where connection.id = ${resourceId} and grant_value.workspace_id = ${f.other}
        and grant_value.status = 'active'`;
    expect(grants[0]!.count).toBe(1);
    expect(await set(f.origin, false)).toMatchObject({ on: false });
    expect(await reach(f, f.origin, resource)).toMatchObject({ on: false });
    await expect(set(f.personal, false)).rejects.toBeInstanceOf(OwnResourceAlwaysOnError);
    // Turning on in Personal is a no-op.
    expect(await set(f.personal, true)).toMatchObject({ on: true, alwaysOn: true });
  }, 180_000);

  test("turning on needs the permission to add your own; turning off needs none", async () => {
    const f = await fixture();
    const resourceId = await addLogin(f, f.origin);
    const resource = { resourceKind: "connection" as const, resourceId };
    const readOnly = ["workspace:read", "connections:read"];

    expect(
      await getOwnResourceHere(deps(), f.authorization(f.other, readOnly), f.other, resource),
    ).toMatchObject({ on: false, canChange: false });
    await expect(
      setOwnResourceHere(deps(), f.authorization(f.other, readOnly), f.other, {
        ...resource,
        on: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await getOwnResourceHere(deps(), f.authorization(f.origin, readOnly), f.origin, resource),
    ).toMatchObject({ on: true, canChange: true });
    expect(
      await setOwnResourceHere(deps(), f.authorization(f.origin, []), f.origin, {
        ...resource,
        on: false,
      }),
    ).toMatchObject({ on: false, canChange: false });
  }, 180_000);

  test("someone else's thing isn't yours anywhere", async () => {
    const f = await fixture();
    const g = await fixture();
    const resourceId = await addLogin(g, g.origin);
    const resource = { resourceKind: "connection" as const, resourceId };
    expect(await reach(f, f.origin, resource)).toBeNull();
    await expect(
      setOwnResourceHere(deps(), f.authorization(f.origin), f.origin, { ...resource, on: true }),
    ).rejects.toBeInstanceOf(OwnResourceNotFoundError);
  }, 180_000);

  test("My things lists each of your own things with where it works and its name", async () => {
    const f = await fixture();
    const login = await addLogin(f, f.origin);
    const machine = await connectMachine(f);
    const plan = await connectPlan(f);
    const g = await fixture();
    await addLogin(g, g.origin);

    const state = async (workspaceId: string) =>
      Object.fromEntries(
        (await listOwnResourcesHere(deps(), f.authorization(workspaceId), workspaceId)).map(
          (entry) => [entry.resourceId, { on: entry.on, alwaysOn: entry.alwaysOn }],
        ),
      );
    expect(await state(f.personal)).toEqual({
      [login]: { on: true, alwaysOn: true },
      [plan]: { on: true, alwaysOn: true },
      [machine]: { on: true, alwaysOn: false },
    });
    expect(await state(f.origin)).toMatchObject({
      [login]: { on: true, alwaysOn: false },
      [machine]: { on: true, alwaysOn: false },
    });
    expect(await state(f.other)).toMatchObject({
      [login]: { on: false },
      [machine]: { on: false },
    });

    // A kind you may not list here is left out.
    const withoutMachines = await listOwnResourcesHere(
      deps(),
      f.authorization(f.other, ["workspace:read", "connections:read"]),
      f.other,
    );
    expect(new Set(withoutMachines.map((entry) => entry.resourceKind))).toEqual(
      new Set(["connection", "subscription_connection"]),
    );

    const everything = await listOwnResourcesHere(deps(), f.authorization(f.personal), f.personal);
    const names = await nameOwnResources(deps(), f.authorization(f.other), f.other, everything);
    expect(names.get(ownResourceKey({ resourceKind: "connection", resourceId: login }))).toEqual({
      name: "linear.app",
      provider: "linear.app",
      plan: null,
    });
    expect(
      names.get(ownResourceKey({ resourceKind: "subscription_connection", resourceId: plan })),
    ).toEqual({ name: "owner@example.test", provider: "codex", plan: "pro" });
    expect(
      names.get(ownResourceKey({ resourceKind: "connected_machine", resourceId: machine })),
    ).toEqual({ name: "Laptop", provider: null, plan: null });
    expect(names.size).toBe(3);
  }, 180_000);
});
