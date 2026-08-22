import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createDb,
  createSessionWithIdempotencyKeyResult,
  ensureManagedAccessForUserWithOrganizationMemberships,
  getOrganizationPrivateSessionSettings,
  getPrivateSessionCreatePolicy,
  getSessionForSubject,
  nestedPostgresSqlState,
  updateOrganizationPrivateSessionSettings,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type OwnerMigratedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const ENABLEMENT_MIGRATION = "0317_organization_private_session_enablement.sql";

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

async function applyBelow(url: string, upperBound: string): Promise<void> {
  const deferred = (await migrationFiles()).filter((file) => file >= upperBound);
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await ledger.unsafe(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    await ledger`delete from schema_migrations where name >= ${upperBound}`;
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

async function waitForOrganizationFenceWaiters(
  admin: SharedTestDatabase["admin"],
  holderPid: number,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await admin<Array<{ waiting: number }>>`
      select count(*)::int as waiting
      from pg_locks waiting
      join pg_stat_activity waiter on waiter.pid = waiting.pid
      join pg_locks held
        on held.locktype = 'advisory'
        and held.granted
        and held.classid = waiting.classid
        and held.objid = waiting.objid
        and held.objsubid = waiting.objsubid
      where waiting.locktype = 'advisory'
        and not waiting.granted
        and waiter.datname = current_database()
        and held.pid = ${holderPid}`;
    if ((row?.waiting ?? 0) >= expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${expected} organization fence waiter(s)`);
}

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0317-private-session-enablement");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("migration 0317 organization private-session enablement", () => {
  test("pins private-create authority to the configured data schema", async () => {
    const source = await readFile(join(migrationsDir, ENABLEMENT_MIGRATION), "utf8");
    expect(source).toContain("SET search_path FROM CURRENT");
    expect(source).toContain("DECLARE data_schema text := current_schema();");
    expect(source).toContain(
      "ALTER FUNCTION %I.open_private_session_create_capability(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp",
    );
    expect(source).not.toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(source).not.toContain("$user");
  });

  test("personal workspaces are private-ready without organization activation", async () => {
    if (!shared || !client) return;
    const userId = `personal-private-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Personal private",
    });
    const personalWorkspaceId = provisioned.organizationMemberships[0]?.personalWorkspaceId;
    if (!personalWorkspaceId) throw new Error("personal workspace missing");
    const personalGrant = provisioned.accessContext.workspaceGrants.find(
      (grant) => grant.workspaceId === personalWorkspaceId,
    );
    if (!personalGrant) throw new Error("personal workspace grant missing");
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: personalWorkspaceId,
        actorSubjectId: subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: true,
      platformAvailable: false,
      organizationEnabled: false,
    });

    const createIdempotencyKey = `personal-private-${crypto.randomUUID()}`;
    const input = {
      accountId: personalGrant.accountId,
      workspaceId: personalWorkspaceId,
      visibility: "user_private" as const,
      initialMessage: "private without organization activation",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId },
      subjectId,
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      createIdempotencyKey,
    };
    const created = await createSessionWithIdempotencyKeyResult(client.db, input);
    const replay = await createSessionWithIdempotencyKeyResult(client.db, input);
    expect(created).toMatchObject({
      created: true,
      denied: false,
      session: {
        tenancy: { visibility: "private", authorityEpoch: 1, ownedByCurrentUser: true },
      },
    });
    expect(replay).toMatchObject({
      created: false,
      denied: false,
      session: {
        tenancy: { visibility: "private", authorityEpoch: 1, ownedByCurrentUser: true },
      },
    });
    if (created.denied || replay.denied) throw new Error("personal private create denied");
    expect(replay.session.id).toBe(created.session.id);

    const [routine] = await shared.admin<
      Array<{ securityDefiner: boolean; settings: string[] | null }>
    >`
      select procedure.prosecdef as "securityDefiner", procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = 'open_private_session_create_capability'
        and pg_catalog.oidvectortypes(procedure.proargtypes) = 'uuid, uuid, uuid, text'`;
    expect(routine).toEqual({
      securityDefiner: true,
      settings: ["search_path=pg_catalog, public, pg_temp"],
    });
  });

  test("owner/admin enablement gates ordinary members without using member-list authority", async () => {
    if (!shared || !client) return;
    const userId = `org-private-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Organization private",
    });
    const access = provisioned.accessContext;
    const sharedGrant = access.workspaceGrants.find(
      (grant) => grant.workspaceId === access.defaultWorkspaceId,
    );
    const membershipId = provisioned.organizationMemberships[0]?.id;
    if (!sharedGrant || !membershipId) throw new Error("organization authority missing");

    await expect(
      getOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
      }),
    ).resolves.toMatchObject({ enabled: false, available: false, version: 0 });
    let readinessDenied: unknown;
    try {
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      readinessDenied = error;
    }
    expect(nestedPostgresSqlState(readinessDenied)).toBe("55000");

    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${sharedGrant.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, '0317-test'
      )`;
    const enableOperationId = crypto.randomUUID();
    const enabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: 0,
      operationId: enableOperationId,
    });
    expect(enabled).toMatchObject({ enabled: true, available: true, version: 1, changed: true });

    const createIdempotencyKey = `organization-private-${crypto.randomUUID()}`;
    const privateCreate = {
      accountId: sharedGrant.accountId,
      workspaceId: sharedGrant.workspaceId,
      visibility: "user_private" as const,
      initialMessage: "private before organization disable",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId },
      subjectId,
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      createIdempotencyKey,
    };
    const created = await createSessionWithIdempotencyKeyResult(client.db, privateCreate);
    expect(created).toMatchObject({ created: true, denied: false });

    await shared.admin`
      update organization_memberships set role = 'admin'
      where id = ${membershipId}`;
    const disableOperationId = crypto.randomUUID();
    const adminDisabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: false,
      expectedVersion: 1,
      operationId: disableOperationId,
    });
    expect(adminDisabled).toMatchObject({ enabled: false, version: 2, changed: true });
    const replay = await createSessionWithIdempotencyKeyResult(client.db, privateCreate);
    expect(replay).toMatchObject({ created: false, denied: false });
    if (created.denied || replay.denied)
      throw new Error("private session create unexpectedly denied");
    expect(replay.session.id).toBe(created.session.id);
    let freshCreateDenied: unknown;
    try {
      await createSessionWithIdempotencyKeyResult(client.db, {
        ...privateCreate,
        createIdempotencyKey: `organization-private-fresh-${crypto.randomUUID()}`,
      });
    } catch (error) {
      freshCreateDenied = error;
    }
    expect(freshCreateDenied).toBeInstanceOf(Error);
    expect(freshCreateDenied).toHaveProperty("name", "SessionTenancyNotActivatedError");
    await expect(
      getSessionForSubject(client.db, sharedGrant.workspaceId, created.session.id, subjectId),
    ).resolves.toMatchObject({
      id: created.session.id,
      tenancy: { visibility: "private", ownedByCurrentUser: true },
    });
    const adminEnabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: 2,
      operationId: crypto.randomUUID(),
    });
    expect(adminEnabled).toMatchObject({ enabled: true, version: 3, changed: true });
    await expect(
      updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: false,
        expectedVersion: 1,
        operationId: disableOperationId,
      }),
    ).resolves.toEqual(adminDisabled);

    await shared.admin`
      update organization_memberships set role = 'member'
      where id = ${membershipId}`;
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: sharedGrant.workspaceId,
        actorSubjectId: subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: false,
      platformAvailable: true,
      organizationEnabled: true,
    });
    let readDenied: unknown;
    try {
      await getOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
      });
    } catch (error) {
      readDenied = error;
    }
    expect(nestedPostgresSqlState(readDenied)).toBe("42501");
    let denied: unknown;
    try {
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: false,
        expectedVersion: 3,
        operationId: crypto.randomUUID(),
      });
    } catch (error) {
      denied = error;
    }
    expect(nestedPostgresSqlState(denied)).toBe("42501");
  }, 180_000);

  test("disablement fences a queued fresh organization-private create", async () => {
    if (!shared || !client) return;
    const userId = `org-private-fence-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Organization private fence",
    });
    const access = provisioned.accessContext;
    const sharedGrant = access.workspaceGrants.find(
      (grant) => grant.workspaceId === access.defaultWorkspaceId,
    );
    if (!sharedGrant) throw new Error("organization authority missing");
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${sharedGrant.accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, '0317-fence-test'
      )`;
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: sharedGrant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    });

    const fence = await shared.admin.reserve();
    let fenceCommitted = false;
    let disable: ReturnType<typeof updateOrganizationPrivateSessionSettings> | null = null;
    let createOutcome: Promise<
      { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown }
    > | null = null;
    try {
      await fence`begin`;
      const [backend] = await fence<Array<{ pid: number }>>`
        select pg_backend_pid()::int as pid`;
      if (!backend) throw new Error("organization fence backend missing");
      await fence`select pg_advisory_xact_lock(hashtextextended(
        ${`organization-membership:${sharedGrant.accountId}`}, 0
      ))`;

      disable = updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: sharedGrant.accountId,
        actorSubjectId: subjectId,
        enabled: false,
        expectedVersion: 1,
        operationId: crypto.randomUUID(),
      });
      await waitForOrganizationFenceWaiters(shared.admin, backend.pid, 1);

      createOutcome = createSessionWithIdempotencyKeyResult(client.db, {
        accountId: sharedGrant.accountId,
        workspaceId: sharedGrant.workspaceId,
        visibility: "user_private",
        initialMessage: "private create queued behind disable",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createIdempotencyKey: `organization-private-fenced-${crypto.randomUUID()}`,
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForOrganizationFenceWaiters(shared.admin, backend.pid, 2);

      await fence`commit`;
      fenceCommitted = true;
      await expect(disable).resolves.toMatchObject({ enabled: false, version: 2, changed: true });
      const outcome = await createOutcome;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(Error);
        expect(outcome.reason).toHaveProperty("name", "SessionTenancyNotActivatedError");
      }
    } finally {
      if (!fenceCommitted) await fence`rollback`.catch(() => undefined);
      fence.release();
      await Promise.allSettled([disable, createOutcome].filter((value) => value !== null));
    }
  }, 180_000);
});

describe("migration 0317 under a NOSUPERUSER NOBYPASSRLS migration owner", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0317-owner-migrated");
    if (!owned && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL required");
    }
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 180_000);

  test("backfills already activated organizations and restores FORCE RLS", async () => {
    if (!owned) return;
    const { admin, ownerUrl, ownerRole } = owned;
    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    await applyBelow(ownerUrl, ENABLEMENT_MIGRATION);
    const accountId = crypto.randomUUID();
    await admin`
      insert into managed_accounts (id, name, external_source, external_id)
      values (${accountId}, 'pre-0317 activated organization', 'test', ${accountId})`;
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"7".repeat(64)}, ${"8".repeat(64)}, 'pre-0317')`;

    await migrate(ownerUrl);

    const [setting] = await admin<
      Array<{ enabled: boolean; version: string; updatedByMembershipId: string | null }>
    >`
      select enabled, version::text as version,
        updated_by_membership_id as "updatedByMembershipId"
      from organization_private_session_settings where account_id = ${accountId}`;
    expect(setting).toEqual({ enabled: true, version: "1", updatedByMembershipId: null });
    const posture = await admin<Array<{ table: string; forced: boolean }>>`
      select relname as "table", relforcerowsecurity as forced
      from pg_class
      where relname in (
        'organization_private_session_settings',
        'organization_private_session_setting_events',
        'session_tenancy_activations'
      )
      order by relname`;
    expect([...posture]).toEqual([
      { table: "organization_private_session_setting_events", forced: true },
      { table: "organization_private_session_settings", forced: true },
      { table: "session_tenancy_activations", forced: true },
    ]);
  }, 900_000);
});
