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
const ENABLEMENT_MIGRATION = "0319_organization_private_session_enablement.sql";

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
  shared = await acquireSharedTestDatabase("migration-0319-private-session-enablement");
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

describe("migration 0319 organization private-session enablement", () => {
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
    expect(source).toContain("session_00_disabled_organization_private_create");
    expect(source).toContain("00000000-0000-0000-0000-000000000000");
    expect(source).toContain("organization_private_session_denial_reason");
    expect(source).toContain("organization_private_sessions_disabled");
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

  test("disablement fences a queued direct capability call and rolling-old keyed writer", async () => {
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

    const template = await createSessionWithIdempotencyKeyResult(client.db, {
      accountId: sharedGrant.accountId,
      workspaceId: sharedGrant.workspaceId,
      visibility: "user_private",
      initialMessage: "rolling-old private template",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId },
      subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `organization-private-template-${crypto.randomUUID()}`,
    });
    if (template.denied) throw new Error("private template unexpectedly denied");

    const oldSessionId = crypto.randomUUID();
    const oldCreateKey = `organization-private-rolling-old-${crypto.randomUUID()}`;
    const oldPool = postgres(shared.appUrl, { max: 1, onnotice: () => undefined });

    const fence = await shared.admin.reserve();
    let fenceCommitted = false;
    let disable: ReturnType<typeof updateOrganizationPrivateSessionSettings> | null = null;
    let oldWriter: Promise<{
      capabilityId: string;
      insertedSessionIds: string[];
      denial:
        | {
            code: string;
            idempotencyKey: string | null;
            organizationPrivateSessionDenialReason: string | null;
          }
        | undefined;
    }> | null = null;
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

      oldWriter = oldPool.begin(async (tx) => {
        await tx`select
          set_config('opengeni.account_id', ${sharedGrant.accountId}, true),
          set_config('opengeni.workspace_id', ${sharedGrant.workspaceId}, true),
          set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [capability] = await tx<Array<{ capabilityId: string; ownerMembershipId: string }>>`
          select capability_id as "capabilityId",
            owner_membership_id as "ownerMembershipId"
          from open_private_session_create_capability(
            ${sharedGrant.accountId}::uuid,
            ${sharedGrant.workspaceId}::uuid,
            ${oldSessionId}::uuid,
            ${subjectId}
          )`;
        if (!capability) throw new Error("rolling-old capability missing");

        // Reproduce current-main exactly where it matters: it accepts any
        // returned capability id and proceeds to the session INSERT. Clone a
        // known-good private row so the regression exercises PostgreSQL's
        // capability/trigger boundary rather than repaired TypeScript code.
        const inserted = await tx<Array<{ id: string }>>`
          insert into sessions
          select (pg_catalog.jsonb_populate_record(
            null::sessions,
            pg_catalog.to_jsonb(template_row) || pg_catalog.jsonb_build_object(
              'id', ${oldSessionId},
              'sandbox_group_id', ${oldSessionId},
              'initial_message', 'rolling-old private create after disable',
              'create_idempotency_key', ${oldCreateKey}
            )
          )).*
          from sessions template_row
          where template_row.id = ${template.session.id}::uuid
          returning id`;
        const [denial] = await tx<
          Array<{
            code: string;
            idempotencyKey: string | null;
            organizationPrivateSessionDenialReason: string | null;
          }>
        >`
          select code, idempotency_key as "idempotencyKey",
            organization_private_session_denial_reason as
              "organizationPrivateSessionDenialReason"
          from session_spawn_denials
          where workspace_id = ${sharedGrant.workspaceId}::uuid
            and idempotency_key = ${oldCreateKey}`;
        return {
          capabilityId: capability.capabilityId,
          insertedSessionIds: [...inserted].map((row) => row.id),
          denial,
        };
      });
      await waitForOrganizationFenceWaiters(shared.admin, backend.pid, 2);

      await fence`commit`;
      fenceCommitted = true;
      await expect(disable).resolves.toMatchObject({ enabled: false, version: 2, changed: true });
      await expect(oldWriter).resolves.toEqual({
        capabilityId: "00000000-0000-0000-0000-000000000000",
        insertedSessionIds: [],
        denial: {
          code: "nested_agent_depth_exceeded",
          idempotencyKey: oldCreateKey,
          organizationPrivateSessionDenialReason: "organization_private_sessions_disabled",
        },
      });
      const [persisted] = await shared.admin<Array<{ count: number }>>`
        select count(*)::int as count from sessions where id = ${oldSessionId}::uuid`;
      expect(persisted?.count).toBe(0);

      let repairedReplayDenied: unknown;
      try {
        await createSessionWithIdempotencyKeyResult(client.db, {
          accountId: sharedGrant.accountId,
          workspaceId: sharedGrant.workspaceId,
          requestedSessionId: oldSessionId,
          visibility: "user_private",
          initialMessage: "repaired retry of rolling-old denial",
          resources: [],
          metadata: {},
          createdBy: { kind: "subject", subjectId },
          subjectId,
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createIdempotencyKey: oldCreateKey,
        });
      } catch (error) {
        repairedReplayDenied = error;
      }
      expect(repairedReplayDenied).toHaveProperty("name", "SessionTenancyNotActivatedError");

      let repairedCreateDenied: unknown;
      try {
        await createSessionWithIdempotencyKeyResult(client.db, {
          accountId: sharedGrant.accountId,
          workspaceId: sharedGrant.workspaceId,
          visibility: "user_private",
          initialMessage: "repaired private create after disable",
          resources: [],
          metadata: {},
          createdBy: { kind: "subject", subjectId },
          subjectId,
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createIdempotencyKey: `organization-private-repaired-${crypto.randomUUID()}`,
        });
      } catch (error) {
        repairedCreateDenied = error;
      }
      expect(repairedCreateDenied).toHaveProperty("name", "SessionTenancyNotActivatedError");
    } finally {
      if (!fenceCommitted) await fence`rollback`.catch(() => undefined);
      fence.release();
      await Promise.allSettled([disable, oldWriter].filter((value) => value !== null));
      await oldPool.end({ timeout: 5 });
    }
  }, 180_000);
});

describe("migration 0319 under a NOSUPERUSER NOBYPASSRLS migration owner", () => {
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
