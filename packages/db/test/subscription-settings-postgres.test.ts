// Organization settings with lockable workspace overrides (design 3.3,
// contract SUB-SET-01..05, migration 0716) on real PostgreSQL. Every check of
// authority runs as the restricted application role (NOSUPERUSER,
// NOBYPASSRLS); the superuser handle only seeds rows and reads ground truth.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase, type OwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  SUBSCRIPTION_SETTING_KEYS,
  settingsView,
  type SubscriptionSettingKey,
  type SubscriptionSettingsPolicy,
} from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  readOrganizationSubscriptionSettings,
  readSubscriptionSettingsOverview,
  readWorkspaceSubscriptionSettings,
  SubscriptionSettingsForbiddenError,
  SubscriptionSettingsInvalidError,
  SubscriptionSettingsLockedError,
  SubscriptionSettingsPersonalWorkspaceError,
  SubscriptionSettingsVersionConflictError,
  updateOrganizationSubscriptionSettings,
  updateWorkspaceSubscriptionSettings,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
const LOCKS_MIGRATION = "0716_subscription_settings_locks.sql";
/** Rolling-migration evidence gathered in beforeAll (asserted in its own test). */
let rolling: {
  postureViolations: string[];
  before: unknown;
  after: unknown;
} | null = null;

function appUrl(database: OwnerMigratedTestDatabase): string {
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  return url.toString();
}

/** Every listed workspace's effective values and sources, as the overview reads them. */
async function effectiveSnapshot(db: Database, f: Fixture) {
  const overview = await readSubscriptionSettingsOverview(db, organization(f));
  return overview.workspaces
    .map((row) => ({ id: row.workspaceId, values: row.values, sources: row.sources }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

beforeAll(async () => {
  if (!realDb) return;
  // A database owned by a NOSUPERUSER NOBYPASSRLS role, as in production, so
  // FORCE ROW LEVEL SECURITY engages for the guard's own (owner) read.
  shared = await acquireOwnerMigratedTestDatabase("subscription-settings-locks");
  if (!shared) throw new Error("Real PostgreSQL is required");
  // Stage the deployment before 0716: every other migration applied and roles
  // provisioned, with existing workspace overrides in place.
  const owner = postgres(shared.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${LOCKS_MIGRATION})`;
    await migrate(shared.ownerUrl);
    await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword });
    await owner`delete from schema_migrations where name = ${LOCKS_MIGRATION}`;
  } finally {
    await owner.end();
  }
  const staged = createDb(appUrl(shared), { max: 2 });
  try {
    client = staged;
    const f = await fixture();
    await shared.admin`update subscription_settings set fallback_order = '{"codex/a":["codex/b"]}'::jsonb,
        personal_fallback_allowed = true
      where account_id = ${f.accountId}::uuid and workspace_id is null`;
    await shared.admin`insert into subscription_settings (
        account_id, workspace_id, rotation, cross_provider_failover, personal_connections_allowed
      ) values (${f.accountId}::uuid, ${f.alphaId}::uuid, '{"codex":{"mode":"spread"}}'::jsonb, true, false)`;
    await shared.admin`insert into subscription_settings (account_id, workspace_id, fallback_order)
      values (${f.accountId}::uuid, ${f.betaId}::uuid, '{"codex/b":[]}'::jsonb)`;
    const before = await effectiveSnapshot(staged.db, f);
    // The rolling step: 0716 alone, while the older binary still runs.
    await migrate(shared.ownerUrl);
    const options = {
      rlsStrategy: "force" as const,
      expectedRole: "opengeni_app",
      targetSchema: "public",
    };
    const postureViolations = evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(staged.db, options),
      options,
    );
    rolling = { postureViolations, before, after: await effectiveSnapshot(staged.db, f) };
  } finally {
    client = null;
    await staged.close();
  }
  await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword });
  client = createDb(appUrl(shared), { max: 6 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Fixture = {
  accountId: string;
  ownerSubjectId: string;
  workspaceAdminSubjectId: string;
  alphaId: string;
  betaId: string;
  personalId: string;
};

async function fixture(): Promise<Fixture> {
  const admin = shared!.admin;
  const userId = `settings-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Settings fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const workspaceIds: string[] = [];
  for (const name of ["Alpha", "Beta"]) {
    const [row] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}::uuid, ${name})
      returning id::text as id`;
    workspaceIds.push(row!.id);
  }
  // A workspace administrator of Alpha who is an ordinary organization member.
  const workspaceAdminSubjectId = `user:settings-workspace-admin-${crypto.randomUUID()}`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
    returning id::text as id`;
  await admin`insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, role
    ) values (${accountId}::uuid, ${workspaceAdminSubjectId}, 'active', ${personal!.id}::uuid, 'member')`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspaceIds[0]!}::uuid, ${workspaceAdminSubjectId}, 'admin')`;
  return {
    accountId,
    ownerSubjectId: `user:${userId}`,
    workspaceAdminSubjectId,
    alphaId: workspaceIds[0]!,
    betaId: workspaceIds[1]!,
    personalId: personal!.id,
  };
}

function organization(f: Fixture, subjectId = f.ownerSubjectId) {
  return { organizationId: f.accountId, actorSubjectId: subjectId };
}

function workspace(f: Fixture, workspaceId: string, subjectId: string) {
  return { accountId: f.accountId, workspaceId, subjectId };
}

/** Raw SQL as the application role in a workspace context; the SQLSTATE and detail, if refused. */
async function asApp(
  f: Fixture,
  workspaceId: string | null,
  subjectId: string,
  run: (tx: Database) => Promise<unknown>,
): Promise<{ code: string; detail: string | null } | null> {
  try {
    await withRlsContext(client!.db, { accountId: f.accountId, workspaceId }, async (tx) => {
      await setSubjectRlsContext(tx, subjectId);
      await run(tx);
    });
    return null;
  } catch (error) {
    let current = error as { code?: string; detail?: string; cause?: unknown } | undefined;
    while (current && !current.code && current.cause) current = current.cause as typeof current;
    return { code: current?.code ?? "unknown", detail: current?.detail ?? null };
  }
}

async function workspaceRow(f: Fixture, workspaceId: string) {
  const [row] = await shared!.admin<
    {
      cross_provider_failover: boolean | null;
      personal_fallback_allowed: boolean | null;
      personal_connections_allowed: boolean | null;
      fallback_order: Record<string, string[]> | null;
      rotation: Record<string, unknown> | null;
    }[]
  >`select cross_provider_failover, personal_fallback_allowed, personal_connections_allowed,
      fallback_order, rotation
    from subscription_settings where account_id = ${f.accountId}::uuid
      and workspace_id = ${workspaceId}::uuid`;
  return row ?? null;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!realDb)("subscription settings with lockable workspace overrides", () => {
  test("authority is checked as the restricted application role", async () => {
    const [role] = await rawRows<{ role: string; superuser: boolean; bypass: boolean }>(
      client!.db,
      sql`select current_user::text as role, rolsuper as superuser, rolbypassrls as bypass
        from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ role: "opengeni_app", superuser: false, bypass: false });
    const [owner] = await shared!.admin<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = ${shared!.ownerRole}`;
    expect(owner).toEqual({ superuser: false, bypass: false });
    const [table] = await shared!.admin<{ forced: boolean; owner: string }[]>`
      select relforcerowsecurity as forced, pg_get_userbyid(relowner)::text as owner
      from pg_class where oid = 'subscription_settings'::regclass`;
    expect(table).toEqual({ forced: true, owner: shared!.ownerRole });
  });

  test("rolling: 0716 keeps every effective setting and the older binary's runtime posture", () => {
    expect(rolling).not.toBeNull();
    expect(rolling!.postureViolations).toEqual([]);
    expect(rolling!.after).toEqual(rolling!.before);
    // The staged data really had workspace overrides to preserve.
    expect(JSON.stringify(rolling!.before)).toContain('"workspace"');
  });

  test("SUB-SET-01: organization administrators read and change organization defaults", async () => {
    const f = await fixture();
    const initial = await readOrganizationSubscriptionSettings(client!.db, organization(f));
    expect(initial.locked).toEqual([]);
    expect(initial.values.personalConnectionsAllowed).toBe(true);
    expect(initial.values.personalFallbackAllowed).toBe(false);

    const { settings } = await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: {
        crossProviderFailover: true,
        fallbackOrder: { "codex/gpt-5.5": ["claude/claude-opus-4", "codex/gpt-5.4"] },
        personalFallbackAllowed: true,
        rotation: { codex: { mode: "primary_first" } },
      },
      expectedVersion: initial.version,
    });
    expect(settings.values.crossProviderFailover).toBe(true);
    expect(settings.values.fallbackOrder).toEqual({
      "codex/gpt-5.5": ["claude/claude-opus-4", "codex/gpt-5.4"],
    });
    expect(settings.values.personalFallbackAllowed).toBe(true);
    expect(settings.values.rotation.codex).toEqual({
      mode: "primary_first",
      primaryConnectionId: null,
    });
    expect(settings.version).toBe(initial.version + 1);

    // A workspace administrator is not an organization administrator.
    expect(
      await rejected(
        readOrganizationSubscriptionSettings(client!.db, organization(f, f.workspaceAdminSubjectId)),
      ),
    ).toBeInstanceOf(SubscriptionSettingsForbiddenError);
    expect(
      await rejected(
        updateOrganizationSubscriptionSettings(client!.db, {
          ...organization(f, f.workspaceAdminSubjectId),
          patch: { locked: [] },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsForbiddenError);
    // ...and the database agrees: the organization row is not writable by them.
    const refused = await asApp(f, f.alphaId, f.workspaceAdminSubjectId, async (tx) => {
      const rows = await rawRows<{ id: string }>(
        tx,
        sql`update subscription_settings set locked_settings = '{}', cross_provider_failover = false
          where account_id = ${f.accountId}::uuid and workspace_id is null returning id::text as id`,
      );
      if (rows.length > 0) throw new Error("organization row was writable");
    });
    expect(refused).toBeNull();
    const after = await readOrganizationSubscriptionSettings(client!.db, organization(f));
    expect(after.values.crossProviderFailover).toBe(true);

    expect(
      await rejected(
        updateOrganizationSubscriptionSettings(client!.db, {
          ...organization(f),
          patch: { personalConnectionsAllowed: false },
          expectedVersion: initial.version,
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsVersionConflictError);
    expect(
      await rejected(
        updateOrganizationSubscriptionSettings(client!.db, {
          ...organization(f),
          patch: { fallbackOrder: { "codex/a": ["codex/a"] } },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsInvalidError);
    // Rotation is written only for providers whose accounts run on the shared core.
    expect(
      await rejected(
        updateOrganizationSubscriptionSettings(client!.db, {
          ...organization(f),
          patch: { rotation: { notaprovider: { mode: "spread" } } },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsInvalidError);
  });

  test("SUB-SET-02/03: workspace overrides resolve per setting and reset to the organization value", async () => {
    const f = await fixture();
    await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: {
        crossProviderFailover: true,
        fallbackOrder: { "codex/a": ["claude/b"], "claude/b": ["codex/a"] },
      },
    });
    const { settings } = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
      patch: {
        crossProviderFailover: false,
        personalFallbackAllowed: true,
        fallbackOrder: { "codex/a": ["xai/c"] },
      },
      expectedVersion: 0,
    });
    expect(settings.canEdit).toBe(true);
    expect(settings.values.crossProviderFailover).toBe(false);
    expect(settings.values.personalFallbackAllowed).toBe(true);
    expect(settings.values.fallbackOrder).toEqual({ "codex/a": ["xai/c"], "claude/b": ["codex/a"] });
    expect(settings.sources).toMatchObject({
      crossProviderFailover: "workspace",
      personalFallbackAllowed: "workspace",
      personalConnectionsAllowed: "organization",
      fallbackOrder: "workspace",
    });
    expect(settings.entrySources.fallbackOrder).toEqual({
      "codex/a": "workspace",
      "claude/b": "organization",
    });

    // Beta inherits everything; Alpha's administrator cannot write it.
    const beta = await readWorkspaceSubscriptionSettings(
      client!.db,
      workspace(f, f.betaId, f.workspaceAdminSubjectId),
    );
    expect(beta.canEdit).toBe(false);
    expect(new Set(Object.values(beta.sources))).toEqual(new Set(["organization"]));
    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...workspace(f, f.betaId, f.workspaceAdminSubjectId),
          patch: { crossProviderFailover: false },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsForbiddenError);
    expect(await workspaceRow(f, f.betaId)).toBeNull();

    // One-step reset (SUB-SET-04): null inherits again; a null entry resets one model.
    const reset = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
      patch: { crossProviderFailover: null, fallbackOrder: { "codex/a": null } },
    });
    expect(reset.settings.values.crossProviderFailover).toBe(true);
    expect(reset.settings.sources.crossProviderFailover).toBe("organization");
    expect(reset.settings.sources.fallbackOrder).toBe("organization");
    expect(reset.settings.overrides.fallbackOrder).toBeNull();
    expect(reset.settings.sources.personalFallbackAllowed).toBe("workspace");

    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
          patch: { personalFallbackAllowed: false },
          expectedVersion: 1,
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsVersionConflictError);
  });

  test("SUB-SET-02: a locked setting cannot be overridden by anyone, in the API or the database", async () => {
    const f = await fixture();
    await updateWorkspaceSubscriptionSettings(client!.db, {
      ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
      patch: { personalFallbackAllowed: true, crossProviderFailover: true },
    });
    const { settings: org } = await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { personalFallbackAllowed: false, locked: ["personalFallbackAllowed"] },
    });
    expect(org.locked).toEqual(["personalFallbackAllowed"]);
    // Locking cleared the override in the same transaction; the other one stays.
    expect(await workspaceRow(f, f.alphaId)).toMatchObject({
      personal_fallback_allowed: null,
      cross_provider_failover: true,
    });
    const alpha = await readWorkspaceSubscriptionSettings(
      client!.db,
      workspace(f, f.alphaId, f.workspaceAdminSubjectId),
    );
    expect(alpha.values.personalFallbackAllowed).toBe(false);
    expect(alpha.sources.personalFallbackAllowed).toBe("locked");
    expect(alpha.sources.crossProviderFailover).toBe("workspace");

    // API: the workspace administrator and an organization administrator are both refused.
    for (const subjectId of [f.workspaceAdminSubjectId, f.ownerSubjectId]) {
      const error = await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...workspace(f, f.alphaId, subjectId),
          patch: { personalFallbackAllowed: true },
        }),
      );
      expect(error).toBeInstanceOf(SubscriptionSettingsLockedError);
      expect((error as SubscriptionSettingsLockedError).settings).toEqual([
        "personalFallbackAllowed",
      ]);
    }
    // Database: raw writes as the application role are refused by the guard.
    const update = await asApp(f, f.alphaId, f.workspaceAdminSubjectId, (tx) =>
      rawRows(
        tx,
        sql`update subscription_settings set personal_fallback_allowed = true
          where account_id = ${f.accountId}::uuid and workspace_id = ${f.alphaId}::uuid`,
      ),
    );
    expect(update).toEqual({
      code: "42501",
      detail: "subscription_setting_locked:personalFallbackAllowed",
    });
    const insert = await asApp(f, f.betaId, f.ownerSubjectId, (tx) =>
      rawRows(
        tx,
        sql`insert into subscription_settings (account_id, workspace_id, personal_fallback_allowed)
          values (${f.accountId}::uuid, ${f.betaId}::uuid, true)`,
      ),
    );
    expect(insert).toEqual({
      code: "42501",
      detail: "subscription_setting_locked:personalFallbackAllowed",
    });
    // An upsert's proposed row is checked too, even when it would conflict.
    const upsert = await asApp(f, f.alphaId, f.workspaceAdminSubjectId, (tx) =>
      rawRows(
        tx,
        sql`insert into subscription_settings (account_id, workspace_id, personal_fallback_allowed)
          values (${f.accountId}::uuid, ${f.alphaId}::uuid, true)
          on conflict (account_id, workspace_id) do update set cross_provider_failover = false`,
      ),
    );
    expect(upsert?.code).toBe("42501");

    // Unlocked settings and resets remain writable.
    const { settings } = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
      patch: { personalFallbackAllowed: null, crossProviderFailover: false },
    });
    expect(settings.values.crossProviderFailover).toBe(false);
    expect(
      await asApp(f, f.alphaId, f.workspaceAdminSubjectId, (tx) =>
        rawRows(
          tx,
          sql`update subscription_settings set personal_fallback_allowed = null,
            personal_connections_allowed = false
            where account_id = ${f.accountId}::uuid and workspace_id = ${f.alphaId}::uuid`,
        ),
      ),
    ).toBeNull();

    // Unlocking does not bring back the cleared override.
    const unlocked = await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { locked: [] },
    });
    expect(unlocked.settings.locked).toEqual([]);
    const reread = await readWorkspaceSubscriptionSettings(
      client!.db,
      workspace(f, f.alphaId, f.workspaceAdminSubjectId),
    );
    expect(reread.sources.personalFallbackAllowed).toBe("organization");
  });

  test("map-valued locks: fallback order and rotation (with the workspace primary)", async () => {
    const f = await fixture();
    const [connection] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, provider_account_id, credential_encrypted, scope_kind
      ) values (
        ${f.accountId}, 'codex', ${`provider-account-${crypto.randomUUID()}`}, 'v1:test', 'organization'
      ) returning id::text as id`;
    await shared!.admin`update subscription_settings set codex_primary_connection_id = ${connection!.id}::uuid
      where account_id = ${f.accountId}::uuid and workspace_id is null`;

    // A new workspace rotation entry carries the organization's primary.
    const rotated = await updateWorkspaceSubscriptionSettings(client!.db, {
      ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
      patch: { rotation: { codex: { mode: "primary_first" } }, fallbackOrder: { "codex/a": ["codex/b"] } },
    });
    expect(rotated.settings.values.rotation.codex).toEqual({
      mode: "primary_first",
      primaryConnectionId: connection!.id,
    });
    expect(rotated.settings.entrySources.rotation.codex).toBe("workspace");
    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
          patch: { rotation: { notaprovider: { mode: "spread" } } },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsInvalidError);

    await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { locked: ["rotation", "fallbackOrder"] },
    });
    expect(await workspaceRow(f, f.alphaId)).toMatchObject({ rotation: null, fallback_order: null });
    const locked = await readWorkspaceSubscriptionSettings(
      client!.db,
      workspace(f, f.alphaId, f.workspaceAdminSubjectId),
    );
    expect(locked.sources.rotation).toBe("locked");
    expect(locked.sources.fallbackOrder).toBe("locked");

    for (const statement of [
      sql`update subscription_settings set rotation = '{"codex":{"mode":"spread"}}'::jsonb
        where account_id = ${f.accountId}::uuid and workspace_id = ${f.alphaId}::uuid`,
      sql`update subscription_settings set fallback_order = '{"codex/a":[]}'::jsonb
        where account_id = ${f.accountId}::uuid and workspace_id = ${f.alphaId}::uuid`,
      // The workspace primary is part of rotation: a different one is refused.
      sql`update subscription_settings set codex_primary_connection_id = null,
          xai_primary_connection_id = null,
          claude_primary_connection_id = (select id from subscription_connections
            where account_id = ${f.accountId}::uuid limit 1)
        where account_id = ${f.accountId}::uuid and workspace_id = ${f.alphaId}::uuid`,
    ]) {
      const refused = await asApp(f, f.alphaId, f.workspaceAdminSubjectId, (tx) =>
        rawRows(tx, statement),
      );
      expect(refused?.code).toBe("42501");
    }
    expect(
      await rejected(
        updateWorkspaceSubscriptionSettings(client!.db, {
          ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
          patch: { rotation: { codex: { mode: "spread" } } },
        }),
      ),
    ).toBeInstanceOf(SubscriptionSettingsLockedError);

    // The stored shapes are checked by the table, whoever writes.
    const shape = await rejected(
      shared!.admin`update subscription_settings set fallback_order = '{"codex/a":"codex/b"}'::jsonb
        where account_id = ${f.accountId}::uuid and workspace_id is null`,
    );
    expect((shape as { code?: string }).code).toBe("23514");
    const lockKey = await rejected(
      shared!.admin`update subscription_settings set locked_settings = '{models}'
        where account_id = ${f.accountId}::uuid and workspace_id is null`,
    );
    expect((lockKey as { code?: string }).code).toBe("23514");
  });

  test("a Personal workspace follows the organization and holds no overrides", async () => {
    const f = await fixture();
    await shared!.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${f.accountId}::uuid, ${f.personalId}::uuid, ${f.workspaceAdminSubjectId}, 'admin')`;
    const read = await readWorkspaceSubscriptionSettings(
      client!.db,
      workspace(f, f.personalId, f.workspaceAdminSubjectId),
    );
    expect(read.canEdit).toBe(false);
    for (const subjectId of [f.workspaceAdminSubjectId, f.ownerSubjectId]) {
      expect(
        await rejected(
          updateWorkspaceSubscriptionSettings(client!.db, {
            ...workspace(f, f.personalId, subjectId),
            patch: { personalFallbackAllowed: true },
          }),
        ),
      ).toBeInstanceOf(SubscriptionSettingsPersonalWorkspaceError);
    }
    const [row] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_settings where workspace_id = ${f.personalId}::uuid`;
    expect(row?.count).toBe(0);
  });

  test("SUB-SET-05: the overview lists every shared workspace with each source", async () => {
    const f = await fixture();
    await updateWorkspaceSubscriptionSettings(client!.db, {
      ...workspace(f, f.alphaId, f.workspaceAdminSubjectId),
      patch: { personalConnectionsAllowed: false },
    });
    await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { locked: ["crossProviderFailover"] },
    });
    const overview = await readSubscriptionSettingsOverview(client!.db, organization(f));
    expect(overview.organization.locked).toEqual(["crossProviderFailover"]);
    expect(overview.nextCursor).toBeNull();
    // Shared workspaces only (the owner's default workspace is shared; the member's Personal workspace is not listed).
    expect(overview.workspaces.map((row) => row.name).sort()).toEqual(["Alpha", "Beta", "Default workspace"]);
    const alpha = overview.workspaces.find((row) => row.workspaceId === f.alphaId)!;
    const beta = overview.workspaces.find((row) => row.workspaceId === f.betaId)!;
    expect(alpha.values.personalConnectionsAllowed).toBe(false);
    expect(alpha.sources.personalConnectionsAllowed).toBe("workspace");
    expect(alpha.sources.crossProviderFailover).toBe("locked");
    expect(beta.sources.personalConnectionsAllowed).toBe("organization");
    expect(beta.sources.crossProviderFailover).toBe("locked");

    // Paging one workspace at a time visits each shared workspace once, in id order.
    const paged: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const current: Awaited<ReturnType<typeof readSubscriptionSettingsOverview>> =
        await readSubscriptionSettingsOverview(client!.db, { ...organization(f), limit: 1, after });
      expect(current.workspaces).toHaveLength(1);
      paged.push(current.workspaces[0]!.workspaceId);
      after = current.nextCursor;
      if (after === null) break;
      expect(after).toBe(current.workspaces[0]!.workspaceId);
    }
    expect(after).toBeNull();
    expect(paged).toEqual(overview.workspaces.map((row) => row.workspaceId));
    expect([...paged].sort()).toEqual(paged);

    expect(
      await rejected(
        readSubscriptionSettingsOverview(client!.db, organization(f, f.workspaceAdminSubjectId)),
      ),
    ).toBeInstanceOf(SubscriptionSettingsForbiddenError);
  });

  test("SUB-SET-03/05: SQL resolution and the TypeScript mirror agree on random settings", async () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const bool = () => random() < 0.5;
    const rotation = () =>
      Object.fromEntries(
        ["codex", "claude", "xai"]
          .filter(() => bool())
          .map((provider) => [
            provider,
            bool() ? { mode: "spread" } : { mode: "primary_first", primaryConnectionId: null },
          ]),
      );
    const providers = () =>
      Object.fromEntries(
        ["codex", "claude"]
          .filter(() => bool())
          .map((provider) => [
            provider,
            { useOrganizationAccounts: true, enabled: bool(), inferenceSource: pick(["automatic", "workspace", "organization"] as const) },
          ]),
      );
    const fallback = () =>
      Object.fromEntries(
        ["codex/a", "claude/b", "xai/c"]
          .filter(() => bool())
          .map((model) => [model, ["codex/a", "claude/b", "xai/c"].filter((other) => other !== model && bool())]),
      );
    const stored = (value: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            entry && typeof entry === "object" && "primaryConnectionId" in entry
              ? { mode: (entry as unknown as { mode: string }).mode }
              : entry,
          ]),
        ),
      );
    for (let round = 0; round < 12; round += 1) {
      const f = await fixture();
      const policy: SubscriptionSettingsPolicy = {
        organization: {
          rotation: rotation() as SubscriptionSettingsPolicy["organization"]["rotation"],
          providers: providers() as SubscriptionSettingsPolicy["organization"]["providers"],
          crossProviderFailover: bool(),
          fallbackOrder: fallback(),
          personalConnectionsAllowed: bool(),
          personalFallbackAllowed: bool(),
        },
        locked: SUBSCRIPTION_SETTING_KEYS.filter(() => random() < 0.3),
        workspaces: {},
      };
      for (const workspaceId of [f.alphaId, f.betaId]) {
        const overrides: Record<string, unknown> = {};
        if (bool()) overrides.rotation = rotation();
        if (bool()) overrides.providers = providers();
        if (bool()) overrides.fallbackOrder = fallback();
        for (const key of ["crossProviderFailover", "personalConnectionsAllowed", "personalFallbackAllowed"]) {
          if (bool()) overrides[key] = bool();
        }
        (policy.workspaces as Record<string, unknown>)[workspaceId] = overrides;
        await shared!.admin`
          insert into subscription_settings (
            account_id, workspace_id, rotation, providers, fallback_order, cross_provider_failover,
            personal_connections_allowed, personal_fallback_allowed
          ) values (
            ${f.accountId}::uuid, ${workspaceId}::uuid,
            ${overrides.rotation ? stored(overrides.rotation as Record<string, unknown>) : null}::text::jsonb,
            ${overrides.providers ? JSON.stringify(overrides.providers) : null}::text::jsonb,
            ${overrides.fallbackOrder ? JSON.stringify(overrides.fallbackOrder) : null}::text::jsonb,
            ${(overrides.crossProviderFailover as boolean | undefined) ?? null},
            ${(overrides.personalConnectionsAllowed as boolean | undefined) ?? null},
            ${(overrides.personalFallbackAllowed as boolean | undefined) ?? null}
          )`;
      }
      // The organization row last: its locks clear the locked overrides above,
      // which the mirror ignores, so both must still agree.
      const o = policy.organization;
      await shared!.admin`
        update subscription_settings set rotation = ${stored(o.rotation)}::text::jsonb,
          providers = ${JSON.stringify(o.providers)}::text::jsonb,
          fallback_order = ${JSON.stringify(o.fallbackOrder)}::text::jsonb,
          cross_provider_failover = ${o.crossProviderFailover},
          personal_connections_allowed = ${o.personalConnectionsAllowed},
          personal_fallback_allowed = ${o.personalFallbackAllowed},
          codex_primary_connection_id = null, claude_primary_connection_id = null,
          xai_primary_connection_id = null,
          locked_settings = ${policy.locked as SubscriptionSettingKey[]}::text[]
        where account_id = ${f.accountId}::uuid and workspace_id is null`;
      const overview = await readSubscriptionSettingsOverview(client!.db, organization(f));
      for (const row of overview.workspaces) {
        expect({ round, view: { values: row.values, sources: row.sources, entrySources: row.entrySources } }).toEqual({
          round,
          view: settingsView(policy, row.workspaceId),
        });
      }
      expect(overview.workspaces).toHaveLength(3);
    }
  });

  test("concurrency: a lock and a workspace override never leave a locked override behind", async () => {
    const f = await fixture();
    // 1. The workspace write holds its row first: the lock writer waits, then clears it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let written!: () => void;
    const wrote = new Promise<void>((resolve) => (written = resolve));
    const workspaceWrite = withRlsContext(
      client!.db,
      { accountId: f.accountId, workspaceId: f.alphaId },
      async (tx) => {
        await setSubjectRlsContext(tx, f.workspaceAdminSubjectId);
        await rawRows(
          tx,
          sql`insert into subscription_settings (account_id, workspace_id, cross_provider_failover)
            values (${f.accountId}::uuid, ${f.alphaId}::uuid, true)`,
        );
        written();
        await gate;
      },
    );
    await wrote;
    let lockDone = false;
    const lock = updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { locked: ["crossProviderFailover"] },
    }).then((result) => {
      lockDone = true;
      return result;
    });
    await Bun.sleep(300);
    expect(lockDone).toBe(false);
    release();
    await workspaceWrite;
    await lock;
    expect((await workspaceRow(f, f.alphaId))?.cross_provider_failover).toBeNull();

    // 2. The lock commits while a workspace write is admitted: the write sees it.
    await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { locked: [] },
    });
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => (lockHeld = resolve));
    let commit!: () => void;
    const commitGate = new Promise<void>((resolve) => (commit = resolve));
    const rawLock = withRlsContext(client!.db, { accountId: f.accountId, workspaceId: null }, async (tx) => {
      await setSubjectRlsContext(tx, f.ownerSubjectId);
      await rawRows(
        tx,
        sql`select id from subscription_settings where account_id = ${f.accountId}::uuid
          and workspace_id is not null order by id for update`,
      );
      await rawRows(
        tx,
        sql`update subscription_settings set locked_settings = '{personalConnectionsAllowed}'
          where account_id = ${f.accountId}::uuid and workspace_id is null`,
      );
      lockHeld();
      await commitGate;
    });
    await held;
    const writes = [f.alphaId, f.betaId].map((workspaceId) =>
      updateWorkspaceSubscriptionSettings(client!.db, {
        ...workspace(f, workspaceId, f.ownerSubjectId),
        patch: { personalConnectionsAllowed: false },
      }).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    await Bun.sleep(300);
    commit();
    await rawLock;
    // Alpha's row existed (the writer waited on its row lock), Beta's did not
    // (it waited on the lock writer's advisory lock): both see the lock.
    for (const outcome of await Promise.all(writes)) {
      expect(outcome).toBeInstanceOf(SubscriptionSettingsLockedError);
    }
    expect((await workspaceRow(f, f.alphaId))?.personal_connections_allowed ?? null).toBeNull();
    expect((await workspaceRow(f, f.betaId))?.personal_connections_allowed ?? null).toBeNull();

    // 3. Free races: no deadlock, and no override of a locked setting survives.
    for (let round = 0; round < 15; round += 1) {
      const key = round % 2 === 0 ? "personalFallbackAllowed" : "crossProviderFailover";
      await updateOrganizationSubscriptionSettings(client!.db, { ...organization(f), patch: { locked: [] } });
      const outcomes = await Promise.allSettled([
        updateOrganizationSubscriptionSettings(client!.db, {
          ...organization(f),
          patch: { locked: [key] },
        }),
        ...[f.alphaId, f.betaId].map((workspaceId) =>
          updateWorkspaceSubscriptionSettings(client!.db, {
            ...workspace(f, workspaceId, f.ownerSubjectId),
            patch: { [key]: round % 3 === 0 },
          }),
        ),
      ]);
      expect(outcomes[0]!.status).toBe("fulfilled");
      for (const outcome of outcomes.slice(1)) {
        if (outcome.status === "rejected") {
          expect(outcome.reason).toBeInstanceOf(SubscriptionSettingsLockedError);
        }
      }
      const column = key === "personalFallbackAllowed" ? "personal_fallback_allowed" : "cross_provider_failover";
      for (const workspaceId of [f.alphaId, f.betaId]) {
        const row = await workspaceRow(f, workspaceId);
        expect({ round, value: (row as Record<string, unknown> | null)?.[column] ?? null }).toEqual({
          round,
          value: null,
        });
      }
    }
  });

  test("the guard cannot be shadowed by a temporary table", async () => {
    const f = await fixture();
    await updateOrganizationSubscriptionSettings(client!.db, {
      ...organization(f),
      patch: { locked: ["personalFallbackAllowed"] },
    });
    const refused = await asApp(f, f.alphaId, f.workspaceAdminSubjectId, async (tx) => {
      await rawRows(
        tx,
        sql`create temporary table subscription_settings (
          account_id uuid, workspace_id uuid, locked_settings text[]) on commit drop`,
      );
      await rawRows(
        tx,
        sql`insert into pg_temp.subscription_settings values (${f.accountId}::uuid, null, '{}')`,
      );
      await rawRows(
        tx,
        sql`insert into public.subscription_settings (account_id, workspace_id, personal_fallback_allowed)
          values (${f.accountId}::uuid, ${f.alphaId}::uuid, true)`,
      );
    });
    expect(refused?.code).toBe("42501");
  });
});
