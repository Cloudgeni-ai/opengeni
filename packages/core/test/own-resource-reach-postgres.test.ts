import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, ensureManagedAccessForUser, type DbClient } from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  grantDeferredRuntimeAccess,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import type { AccessGrantAuthorization } from "../src/access";
import {
  getOwnResourceHere,
  OwnResourceAlwaysOnError,
  OwnResourceNotFoundError,
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
});
