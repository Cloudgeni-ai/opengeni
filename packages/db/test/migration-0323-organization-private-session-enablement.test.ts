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
const ENABLEMENT_MIGRATION = "0323_organization_private_session_enablement.sql";

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

type ProvisionedOrganization = {
  subjectId: string;
  accountId: string;
  sharedWorkspaceId: string;
  personalWorkspaceId: string;
  membershipId: string;
};

async function provisionOrganization(prefix: string): Promise<ProvisionedOrganization> {
  if (!client) throw new Error("database unavailable");
  const userId = `${prefix}-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: prefix,
  });
  const access = provisioned.accessContext;
  const sharedGrant = access.workspaceGrants.find(
    (grant) => grant.workspaceId === access.defaultWorkspaceId,
  );
  const membership = provisioned.organizationMemberships[0];
  if (!sharedGrant || !membership?.personalWorkspaceId) {
    throw new Error("organization authority missing");
  }
  return {
    subjectId,
    accountId: sharedGrant.accountId,
    sharedWorkspaceId: sharedGrant.workspaceId,
    personalWorkspaceId: membership.personalWorkspaceId,
    membershipId: membership.id,
  };
}

async function insertReadinessReceipt(accountId: string, activatedBy: string): Promise<void> {
  if (!shared) throw new Error("database unavailable");
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, ${activatedBy})`;
}

function privateCreateInput(
  organization: ProvisionedOrganization,
  workspaceId: string,
  createIdempotencyKey: string,
  initialMessage: string,
) {
  return {
    accountId: organization.accountId,
    workspaceId,
    visibility: "user_private" as const,
    initialMessage,
    resources: [],
    metadata: {},
    createdBy: { kind: "subject" as const, subjectId: organization.subjectId },
    subjectId: organization.subjectId,
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    createIdempotencyKey,
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0323-private-session-enablement");
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

describe("migration 0323 organization private-session enablement", () => {
  test("pins every new definer routine to the configured data schema", async () => {
    const source = await readFile(join(migrationsDir, ENABLEMENT_MIGRATION), "utf8");
    expect(source).toContain("SET search_path FROM CURRENT");
    expect(source).toContain("DECLARE data_schema text := current_schema();");
    for (const signature of [
      "organization_private_sessions_enabled(uuid)",
      "get_private_session_create_policy(uuid,uuid,text)",
      "get_organization_private_session_settings(uuid,text)",
      "update_organization_private_session_settings(uuid,text,boolean,bigint,uuid)",
      "open_private_session_create_capability(uuid,uuid,uuid,text)",
    ]) {
      expect(source).toContain(
        `ALTER FUNCTION %I.${signature} SET search_path = pg_catalog, %I, pg_temp`,
      );
    }
    expect(source).not.toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(source).not.toContain("$user");
    expect(source).toContain("'organization-membership:' || p_account_id::text");
    // The 0303 readiness receipt remains the entry guard for every private create.
    expect(source).toContain("OR NOT session_tenancy_product_activated(p_account_id, 1)");
    // No rolling-compat trigger, reserved capability, or reused depth denial code.
    expect(source).not.toContain("CREATE TRIGGER");
    expect(source).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(source).not.toContain("nested_agent_depth_exceeded");
  });

  test("keeps the receipt-only Personal workspace rule and gates shared workspaces on the setting", async () => {
    if (!shared || !client) return;
    const organization = await provisionOrganization("receipt-vs-setting");

    // Without the receipt nothing is private-ready anywhere.
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: organization.personalWorkspaceId,
        actorSubjectId: organization.subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: true,
      platformAvailable: false,
      organizationEnabled: false,
    });
    const personalWithoutReceipt = await captureError(() =>
      createSessionWithIdempotencyKeyResult(
        client!.db,
        privateCreateInput(
          organization,
          organization.personalWorkspaceId,
          `personal-no-receipt-${crypto.randomUUID()}`,
          "private without readiness receipt",
        ),
      ),
    );
    expect(nestedPostgresSqlState(personalWithoutReceipt)).toBe("42501");

    await insertReadinessReceipt(organization.accountId, "0323-receipt-test");

    // Receipt alone: the managed human's own Personal workspace keeps the 0311 rule.
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: organization.personalWorkspaceId,
        actorSubjectId: organization.subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: true,
      platformAvailable: true,
      organizationEnabled: false,
    });
    const personalCreate = await createSessionWithIdempotencyKeyResult(
      client.db,
      privateCreateInput(
        organization,
        organization.personalWorkspaceId,
        `personal-receipt-${crypto.randomUUID()}`,
        "private personal session with receipt only",
      ),
    );
    expect(personalCreate).toMatchObject({ created: true, denied: false });
    if (personalCreate.denied) throw new Error("personal private create unexpectedly denied");
    await expect(
      getSessionForSubject(
        client.db,
        organization.personalWorkspaceId,
        personalCreate.session.id,
        organization.subjectId,
      ),
    ).resolves.toMatchObject({
      id: personalCreate.session.id,
      tenancy: { visibility: "private", authorityEpoch: 1, ownedByCurrentUser: true },
    });

    // Receipt alone is NOT enough in a shared workspace: the owner/admin setting
    // is still disabled, so the create fails closed with the typed error and
    // nothing is inserted.
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: organization.sharedWorkspaceId,
        actorSubjectId: organization.subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: false,
      platformAvailable: true,
      organizationEnabled: false,
    });
    const sharedKey = `shared-disabled-${crypto.randomUUID()}`;
    const sharedDisabled = await captureError(() =>
      createSessionWithIdempotencyKeyResult(
        client!.db,
        privateCreateInput(
          organization,
          organization.sharedWorkspaceId,
          sharedKey,
          "private shared session before enablement",
        ),
      ),
    );
    expect(sharedDisabled).toHaveProperty("name", "SessionTenancyNotActivatedError");
    const [persisted] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from sessions
      where workspace_id = ${organization.sharedWorkspaceId}::uuid
        and create_idempotency_key = ${sharedKey}`;
    expect(persisted?.count).toBe(0);
    const [capabilities] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from private_session_create_capabilities
      where account_id = ${organization.accountId}::uuid`;
    expect(capabilities?.count).toBe(0);

    const routines = await shared.admin<
      Array<{ name: string; securityDefiner: boolean; settings: string[] | null }>
    >`
      select procedure.proname as name, procedure.prosecdef as "securityDefiner",
        procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname in (
          'organization_private_sessions_enabled',
          'get_private_session_create_policy',
          'get_organization_private_session_settings',
          'update_organization_private_session_settings',
          'open_private_session_create_capability'
        )
      order by procedure.proname`;
    expect([...routines]).toEqual(
      [
        "get_organization_private_session_settings",
        "get_private_session_create_policy",
        "open_private_session_create_capability",
        "organization_private_sessions_enabled",
        "update_organization_private_session_settings",
      ].map((name) => ({
        name,
        securityDefiner: true,
        settings: ["search_path=pg_catalog, public, pg_temp"],
      })),
    );
  }, 180_000);

  test("owner/admin enablement gates ordinary members without using member-list authority", async () => {
    if (!shared || !client) return;
    const organization = await provisionOrganization("org-private");

    await expect(
      getOrganizationPrivateSessionSettings(client.db, {
        organizationId: organization.accountId,
        actorSubjectId: organization.subjectId,
      }),
    ).resolves.toMatchObject({ enabled: false, available: false, version: 0 });
    const readinessDenied = await captureError(() =>
      updateOrganizationPrivateSessionSettings(client!.db, {
        organizationId: organization.accountId,
        actorSubjectId: organization.subjectId,
        enabled: true,
        expectedVersion: 0,
        operationId: crypto.randomUUID(),
      }),
    );
    expect(nestedPostgresSqlState(readinessDenied)).toBe("55000");

    await insertReadinessReceipt(organization.accountId, "0323-test");
    const enableOperationId = crypto.randomUUID();
    const enabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: organization.accountId,
      actorSubjectId: organization.subjectId,
      enabled: true,
      expectedVersion: 0,
      operationId: enableOperationId,
    });
    expect(enabled).toMatchObject({ enabled: true, available: true, version: 1, changed: true });

    const privateCreate = privateCreateInput(
      organization,
      organization.sharedWorkspaceId,
      `organization-private-${crypto.randomUUID()}`,
      "private before organization disable",
    );
    const created = await createSessionWithIdempotencyKeyResult(client.db, privateCreate);
    expect(created).toMatchObject({ created: true, denied: false });

    await shared.admin`
      update organization_memberships set role = 'admin'
      where id = ${organization.membershipId}`;
    const disableOperationId = crypto.randomUUID();
    const adminDisabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: organization.accountId,
      actorSubjectId: organization.subjectId,
      enabled: false,
      expectedVersion: 1,
      operationId: disableOperationId,
    });
    expect(adminDisabled).toMatchObject({ enabled: false, version: 2, changed: true });
    // A committed keyed success replays after disable; a fresh key fails closed.
    const replay = await createSessionWithIdempotencyKeyResult(client.db, privateCreate);
    expect(replay).toMatchObject({ created: false, denied: false });
    if (created.denied || replay.denied)
      throw new Error("private session create unexpectedly denied");
    expect(replay.session.id).toBe(created.session.id);
    const freshCreateDenied = await captureError(() =>
      createSessionWithIdempotencyKeyResult(client!.db, {
        ...privateCreate,
        createIdempotencyKey: `organization-private-fresh-${crypto.randomUUID()}`,
      }),
    );
    expect(freshCreateDenied).toHaveProperty("name", "SessionTenancyNotActivatedError");
    await expect(
      getSessionForSubject(
        client.db,
        organization.sharedWorkspaceId,
        created.session.id,
        organization.subjectId,
      ),
    ).resolves.toMatchObject({
      id: created.session.id,
      tenancy: { visibility: "private", ownedByCurrentUser: true },
    });
    const adminEnabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: organization.accountId,
      actorSubjectId: organization.subjectId,
      enabled: true,
      expectedVersion: 2,
      operationId: crypto.randomUUID(),
    });
    expect(adminEnabled).toMatchObject({ enabled: true, version: 3, changed: true });
    // Idempotent operation receipt: the same operation id replays its result.
    await expect(
      updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: organization.accountId,
        actorSubjectId: organization.subjectId,
        enabled: false,
        expectedVersion: 1,
        operationId: disableOperationId,
      }),
    ).resolves.toEqual(adminDisabled);

    await shared.admin`
      update organization_memberships set role = 'member'
      where id = ${organization.membershipId}`;
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: organization.sharedWorkspaceId,
        actorSubjectId: organization.subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: false,
      platformAvailable: true,
      organizationEnabled: true,
    });
    const memberCreate = await createSessionWithIdempotencyKeyResult(
      client.db,
      privateCreateInput(
        organization,
        organization.sharedWorkspaceId,
        `member-private-${crypto.randomUUID()}`,
        "ordinary member uses the enabled organization feature",
      ),
    );
    expect(memberCreate).toMatchObject({ created: true, denied: false });
    const readDenied = await captureError(() =>
      getOrganizationPrivateSessionSettings(client!.db, {
        organizationId: organization.accountId,
        actorSubjectId: organization.subjectId,
      }),
    );
    expect(nestedPostgresSqlState(readDenied)).toBe("42501");
    const writeDenied = await captureError(() =>
      updateOrganizationPrivateSessionSettings(client!.db, {
        organizationId: organization.accountId,
        actorSubjectId: organization.subjectId,
        enabled: false,
        expectedVersion: 3,
        operationId: crypto.randomUUID(),
      }),
    );
    expect(nestedPostgresSqlState(writeDenied)).toBe("42501");
  }, 180_000);

  test("disablement fences a queued fenced writer while an unfenced pre-0323 caller never blocks", async () => {
    if (!shared || !client) return;
    const organization = await provisionOrganization("org-private-fence");
    await insertReadinessReceipt(organization.accountId, "0323-fence-test");
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: organization.accountId,
      actorSubjectId: organization.subjectId,
      enabled: true,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    });

    const directSessionId = crypto.randomUUID();
    const directPool = postgres(shared.appUrl, { max: 1, onnotice: () => undefined });
    const fence = await shared.admin.reserve();
    let fenceCommitted = false;
    let disable: ReturnType<typeof updateOrganizationPrivateSessionSettings> | null = null;
    let directWriter: Promise<unknown> | null = null;
    try {
      await fence`begin`;
      const [backend] = await fence<Array<{ pid: number }>>`
        select pg_backend_pid()::int as pid`;
      if (!backend) throw new Error("organization fence backend missing");
      await fence`select pg_advisory_xact_lock(hashtextextended(
        ${`organization-membership:${organization.accountId}`}, 0
      ))`;

      disable = updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: organization.accountId,
        actorSubjectId: organization.subjectId,
        enabled: false,
        expectedVersion: 1,
        operationId: crypto.randomUUID(),
      });
      await waitForOrganizationFenceWaiters(shared.admin, backend.pid, 1);

      // A pre-0323 caller (no fence of its own) must never block on the fence
      // inside the function: while the fence is held elsewhere it proceeds with
      // an unfenced read of the still-enabled setting and returns immediately.
      const unfencedPool = postgres(shared.appUrl, { max: 1, onnotice: () => undefined });
      try {
        const unfenced = await Promise.race([
          unfencedPool.begin(async (tx) => {
            await tx`select
              set_config('opengeni.account_id', ${organization.accountId}, true),
              set_config('opengeni.workspace_id', ${organization.sharedWorkspaceId}, true),
              set_config('opengeni.subject_id', ${organization.subjectId}, true)`;
            const rows = await tx<Array<{ capabilityId: string }>>`
              select capability_id as "capabilityId"
              from open_private_session_create_capability(
                ${organization.accountId}::uuid,
                ${organization.sharedWorkspaceId}::uuid,
                ${crypto.randomUUID()}::uuid,
                ${organization.subjectId}
              )`;
            throw Object.assign(new Error("rollback"), { rows });
          }),
          Bun.sleep(10_000).then(() => "blocked" as const),
        ]).catch((error: unknown) => error);
        expect(unfenced).toMatchObject({
          message: "rollback",
          rows: [{ capabilityId: expect.any(String) }],
        });
      } finally {
        await unfencedPool.end({ timeout: 5 });
      }

      // A repaired writer takes the fence first (0299 order, as the TypeScript
      // create path does); queued behind the disablement it must observe it.
      directWriter = directPool.begin(async (tx) => {
        await tx`select
          set_config('opengeni.account_id', ${organization.accountId}, true),
          set_config('opengeni.workspace_id', ${organization.sharedWorkspaceId}, true),
          set_config('opengeni.subject_id', ${organization.subjectId}, true)`;
        await tx`select pg_advisory_xact_lock(hashtextextended(
          ${`organization-membership:${organization.accountId}`}, 0
        ))`;
        return await tx`
          select capability_id as "capabilityId"
          from open_private_session_create_capability(
            ${organization.accountId}::uuid,
            ${organization.sharedWorkspaceId}::uuid,
            ${directSessionId}::uuid,
            ${organization.subjectId}
          )`;
      });
      await waitForOrganizationFenceWaiters(shared.admin, backend.pid, 2);

      await fence`commit`;
      fenceCommitted = true;
      await expect(disable).resolves.toMatchObject({ enabled: false, version: 2, changed: true });
      const directDenied = await captureError(() => directWriter!);
      expect(nestedPostgresSqlState(directDenied)).toBe("55000");
      const [capabilities] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count from private_session_create_capabilities
        where session_id = ${directSessionId}::uuid`;
      expect(capabilities?.count).toBe(0);
      const [persisted] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count from sessions where id = ${directSessionId}::uuid`;
      expect(persisted?.count).toBe(0);

      const repairedCreateDenied = await captureError(() =>
        createSessionWithIdempotencyKeyResult(
          client!.db,
          privateCreateInput(
            organization,
            organization.sharedWorkspaceId,
            `organization-private-repaired-${crypto.randomUUID()}`,
            "repaired private create after disable",
          ),
        ),
      );
      expect(repairedCreateDenied).toHaveProperty("name", "SessionTenancyNotActivatedError");
    } finally {
      if (!fenceCommitted) await fence`rollback`.catch(() => undefined);
      fence.release();
      await Promise.allSettled([disable, directWriter].filter((value) => value !== null));
      await directPool.end({ timeout: 5 });
    }
  }, 180_000);
});

describe("migration 0323 under a NOSUPERUSER NOBYPASSRLS migration owner", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0323-owner-migrated");
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
      values (${accountId}, 'pre-0323 activated organization', 'test', ${accountId})`;
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"7".repeat(64)}, ${"8".repeat(64)}, 'pre-0323')`;

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
