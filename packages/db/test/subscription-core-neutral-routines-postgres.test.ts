// Migration 0707: the provider-neutral subscription-core routines are exact
// equivalents of the provider-named routines they replace for the runtime.
// Every case runs on a database migrated by the NOSUPERUSER, NOBYPASSRLS
// owner (so FORCE RLS and the owner-only policies apply inside the routines)
// and calls the routines as the restricted application role. Each scenario
// runs once through the provider-named routines and once through the neutral
// ones on identical fixtures; the normalized outcomes must be equal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  SUBSCRIPTION_CORE_NEUTRAL_OWNER_ROUTINES,
  SUBSCRIPTION_CORE_NEUTRAL_PRIVATE_ROUTINES,
  withSubscriptionCoreAcceptedTurn,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { ownerlessRefreshFixture, ownerlessRefreshKey } from "./fixtures/ownerless-codex-refresh";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let appConnectionUrl = "";
/** Runtime posture violations right after applying 0707 to a provisioned database, before provisioning again. */
let unprovisionedPostureViolations: string[] | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-core-neutral-routines");
  if (!database) throw new Error("Real PostgreSQL is required");
  // A rolling migration must leave an older binary's runtime posture intact
  // until roles are provisioned again. Stage a provisioned database without
  // 0707 (as a deployment is before it), apply 0707 alone, and evaluate the
  // full runtime posture as the runtime role before provisioning again. 0712
  // patches routines 0707 creates and 0714 builds on 0707's registry, so both
  // are withheld and applied with it.
  const neutral = "0707_subscription_core_neutral_routines.sql";
  const withheld = [
    neutral,
    "0712_subscription_core_generic_precursor.sql",
    "0713_subscription_core_provider_keyed_reach.sql",
    "0714_subscription_authority_compat.sql",
    "0715_subscription_authority_fences.sql",
  ];
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of withheld) await owner`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
    await owner`delete from schema_migrations where name in ${owner(withheld)}`;
    await migrate(database.ownerUrl);
    const [applied] = await owner<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name in ${owner(withheld)}`;
    if (applied?.count !== withheld.length)
      throw new Error("0707, 0712 and 0714 were not applied by the second migrate");
  } finally {
    await owner.end();
  }
  const stagedUrl = new URL(database.ownerUrl);
  stagedUrl.username = "opengeni_app";
  stagedUrl.password = database.appPassword;
  const staged = createDb(stagedUrl.toString(), { max: 1 });
  try {
    const options = {
      rlsStrategy: "force" as const,
      expectedRole: "opengeni_app",
      targetSchema: "public",
    };
    unprovisionedPostureViolations = evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(staged.db, options),
      options,
    );
  } finally {
    await staged.close();
  }
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const appUrl = new URL(database.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = database.appPassword;
  appConnectionUrl = appUrl.toString();
  client = createDb(appConnectionUrl, { max: 4 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

type Family = "codex" | "core";
const FAMILIES: Family[] = ["codex", "core"];

/** The provider-named routine for the codex family, the neutral one (with the provider argument) otherwise. */
function routine(family: Family, codexName: string, coreName: string, providerFree = false) {
  return family === "codex"
    ? sql.raw(`opengeni_private.${codexName}(`)
    : sql.raw(`opengeni_private.${coreName}(${providerFree ? "" : "'codex', "}`);
}

type Person = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function person(): Promise<Person> {
  const admin = database!.admin;
  const userId = `core-neutral-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Neutral routine equivalence",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId} and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Neutral shared')
    returning id::text as id`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${subjectId}, 'owner')`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await admin`delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  await admin`insert into subscription_settings (account_id, rotation, providers,
      cross_provider_failover, fallback_order, personal_connections_allowed,
      personal_fallback_allowed)
    values (${accountId}::uuid, ${admin.json({ codex: { mode: "spread" } })}::jsonb, '{}'::jsonb,
      false, '{}'::jsonb, true, false)`;
  for (const provider of ["codex", "claude", "xai"]) {
    // Enabled cutover rows for providers without a registry row prove that
    // the registry, not the cutover row, admits a provider.
    await admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, ${provider}, true)
      on conflict (account_id, provider) do update set enabled = true`;
  }
  return {
    accountId,
    subjectId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspace!.id,
  };
}

function asOwner<T>(
  who: Person,
  workspaceId: string,
  work: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
): Promise<T> {
  return withRlsContext(client!.db, { accountId: who.accountId, workspaceId }, async (tx) => {
    await setSubjectRlsContext(tx, who.subjectId);
    return await work(tx);
  });
}

function encrypted(label: string): string {
  return encryptEnvironmentValue(
    ownerlessRefreshKey,
    JSON.stringify({ access_token: `access-${label}`, refresh_token: `refresh-${label}` }),
  );
}

/** Replace generated identifiers with stable names so two runs compare equal. */
function normalize(value: unknown, names: Map<string, string>): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== "string") return item;
      const known = names.get(item);
      if (known) return known;
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(item)) return "<time>";
      return item;
    }),
  );
}

async function writerScenario(family: Family): Promise<unknown> {
  const owner = await person();
  const other = await person();
  const names = new Map<string, string>([
    [owner.accountId, "<account>"],
    [owner.subjectId, "<owner>"],
    [owner.membershipId, "<membership>"],
    [owner.personalWorkspaceId, "<personal>"],
    [owner.sharedWorkspaceId, "<shared>"],
  ]);
  const steps: Record<string, unknown> = {};
  const connect = (who: Person, workspaceId: string, label: string, subject = `user-${label}`) =>
    asOwner(who, workspaceId, async (tx) => {
      const [row] = await rawRows<{
        outcome: string;
        connection_id: string | null;
        is_new: boolean;
      }>(
        tx,
        sql`select outcome, connection_id::text as connection_id, is_new
          from ${routine(family, "connect_subscription_codex_personal", "connect_subscription_core_personal")}
            ${who.accountId}::uuid, ${workspaceId}::uuid, ${who.subjectId},
            ${encrypted(label)}, ${`acct-${label}`}, ${subject}, 'plus',
            ${JSON.stringify({ isFedramp: false })}::jsonb, now() + interval '1 day', now(),
            ${`${label}@example.test`}, ${label}, ${who.subjectId})`,
      );
      return row;
    });
  const manage = (
    who: Person,
    connectionId: string,
    action: string,
    options: { label?: string; enabled?: boolean; expectedVersion?: number } = {},
  ) =>
    asOwner(who, who.personalWorkspaceId, async (tx) => {
      const [row] = await rawRows<{ result: unknown }>(
        tx,
        sql`select ${routine(family, "manage_subscription_codex_personal", "manage_subscription_core_personal")}
            ${who.accountId}::uuid, ${who.personalWorkspaceId}::uuid, ${who.subjectId},
            ${connectionId}::uuid, ${action}, ${options.label ?? null},
            ${options.enabled ?? null}::boolean, ${options.expectedVersion ?? null}::integer) as result`,
      );
      return row?.result ?? null;
    });
  const list = (who: Person, workspaceId: string) =>
    asOwner(who, workspaceId, async (tx) =>
      rawRows(
        tx,
        sql`select id::text as id, label, account_email, plan_type, provider_account_id, status,
            last_error, allocator_enabled, allocator_version, extra_credits_enabled,
            extra_credits_version
          from ${routine(family, "subscription_codex_personal_connections", "subscription_core_personal_connections")}
            ${who.accountId}::uuid, ${workspaceId}::uuid, ${who.subjectId})`,
      ),
    );
  const disconnect = (who: Person, workspaceId: string, connectionId: string) =>
    asOwner(who, workspaceId, async (tx) => {
      const [row] = await rawRows<{ outcome: string }>(
        tx,
        sql`select ${routine(family, "disconnect_subscription_codex_connection", "disconnect_subscription_core_connection")}
            ${who.accountId}::uuid, ${workspaceId}::uuid, ${who.subjectId}, ${connectionId}::uuid
          ) as outcome`,
      );
      return row?.outcome;
    });
  const state = async (connectionId: string) => {
    const [row] = await database!.admin`
      select connection.label, connection.status, connection.credential_encrypted = '' as scrubbed,
        connection.allocator_enabled, connection.allocator_version,
        connection.extra_credits_enabled, connection.extra_credits_version,
        connection.extra_credits_updated_by_subject_id, connection.refresh_generation::int,
        connection.version, connection.ownership, connection.scope_kind,
        connection.disconnected_at is not null as disconnected,
        authority.status as authority_status, authority.generation::int as authority_generation,
        settings.codex_primary_connection_id::text as primary_connection,
        settings.rotation as rotation
      from subscription_connections connection
      left join organization_user_resource_authorities authority on authority.id = connection.authority_id
      left join subscription_settings settings on settings.account_id = connection.account_id
        and settings.workspace_id = ${owner.personalWorkspaceId}::uuid
      where connection.id = ${connectionId}::uuid`;
    return row;
  };

  steps.outsidePersonal = await connect(owner, owner.sharedWorkspaceId, "shared-route");
  const first = await connect(owner, owner.personalWorkspaceId, "first");
  names.set(first!.connection_id!, "<first>");
  steps.connect = first;
  steps.reconnect = await connect(owner, owner.personalWorkspaceId, "first");
  steps.legacyIdentity = await connect(owner, owner.personalWorkspaceId, "first", "legacy:first");
  steps.listPersonal = await list(owner, owner.personalWorkspaceId);
  steps.listShared = await list(owner, owner.sharedWorkspaceId);
  steps.foreignList = await list(other, other.personalWorkspaceId);
  const id = first!.connection_id!;
  steps.foreignManage = await manage(other, id, "rename", { label: "stolen" });
  steps.resolve = await manage(owner, id, "resolve");
  steps.rename = await manage(owner, id, "rename", { label: "  Renamed  " });
  steps.allocatorConflict = await manage(owner, id, "allocator", {
    enabled: false,
    expectedVersion: 99,
  });
  const before = (await state(id)) as { allocator_version: number; extra_credits_version: number };
  steps.allocator = await manage(owner, id, "allocator", {
    enabled: false,
    expectedVersion: before.allocator_version,
  });
  steps.allocatorMissing = await manage(owner, id, "allocator", {});
  steps.extraCredits = await manage(owner, id, "extra_credits", {
    enabled: true,
    expectedVersion: before.extra_credits_version,
  });
  steps.badAction = await manage(owner, id, "delete");
  steps.primary = await manage(owner, id, "primary");
  steps.afterManage = await state(id);
  steps.foreignDisconnect = await disconnect(other, other.personalWorkspaceId, id);
  steps.wrongWorkspaceDisconnect = await disconnect(owner, owner.sharedWorkspaceId, id);
  steps.disconnect = await disconnect(owner, owner.personalWorkspaceId, id);
  steps.disconnectAgain = await disconnect(owner, owner.personalWorkspaceId, id);
  steps.afterDisconnect = await state(id);
  steps.manageDisconnected = await manage(owner, id, "rename", { label: "late" });
  steps.listAfterDisconnect = await list(owner, owner.personalWorkspaceId);
  const second = await connect(owner, owner.personalWorkspaceId, "second");
  names.set(second!.connection_id!, "<second>");
  steps.connectAfterDisconnect = second;
  steps.secondState = await state(second!.connection_id!);
  await database!.admin`update subscription_settings set personal_connections_allowed = false
    where account_id = ${owner.accountId}::uuid and workspace_id is null`;
  steps.personalDisabled = await connect(owner, owner.personalWorkspaceId, "third");
  return normalize(steps, names);
}

describe("provider-neutral subscription-core routines (migration 0707)", () => {
  test.skipIf(!realDb)(
    "run as the restricted application role over a NOBYPASSRLS owner, with safe posture",
    async () => {
      const [roles] = await database!.admin<
        { owner_super: boolean; owner_bypass: boolean; app_super: boolean; app_bypass: boolean }[]
      >`select owner_role.rolsuper as owner_super, owner_role.rolbypassrls as owner_bypass,
          app_role.rolsuper as app_super, app_role.rolbypassrls as app_bypass
        from pg_roles owner_role, pg_roles app_role
        where owner_role.rolname = ${database!.ownerRole} and app_role.rolname = 'opengeni_app'`;
      expect(roles).toEqual({
        owner_super: false,
        owner_bypass: false,
        app_super: false,
        app_bypass: false,
      });
      const [current] = await rawRows<{ role: string }>(
        client!.db,
        sql`select current_user as role`,
      );
      expect(current?.role).toBe("opengeni_app");
      const options = {
        rlsStrategy: "force" as const,
        expectedRole: "opengeni_app",
        targetSchema: "public",
      };
      const posture = await inspectRuntimeDatabasePosture(client!.db, options);
      expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
      for (const name of SUBSCRIPTION_CORE_NEUTRAL_PRIVATE_ROUTINES) {
        const found = posture.privateRoutines.filter((entry) => entry.name === name);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          execute: true,
          publicExecute: false,
          securityDefiner: true,
        });
      }
      for (const name of SUBSCRIPTION_CORE_NEUTRAL_OWNER_ROUTINES) {
        const found = posture.subscriptionOwnerRoutines?.filter((entry) => entry.name === name);
        expect(found).toHaveLength(1);
        expect(found![0]).toMatchObject({ execute: false, publicExecute: false });
      }
      // The registry is owner data: the runtime role cannot read or change it.
      await expect(
        rawRows(client!.db, sql`select * from opengeni_private.subscription_core_providers`),
      ).rejects.toThrow();
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "neutral routine sources name no provider and branch on no provider",
    async () => {
      const rows = await database!.admin<{ name: string; definition: string }[]>`
        select proc.proname as name, pg_get_functiondef(proc.oid) as definition
        from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
        where namespace.nspname in ('opengeni_private', 'opengeni_subscription_internal')
          and proc.proname like '%subscription_core%'`;
      expect(rows.length).toBe(
        SUBSCRIPTION_CORE_NEUTRAL_PRIVATE_ROUTINES.length +
          SUBSCRIPTION_CORE_NEUTRAL_OWNER_ROUTINES.length,
      );
      for (const row of rows) {
        expect({
          name: row.name,
          provider:
            /codex|openai|chatgpt|claude|anthropic|\bxai\b|grok/i.exec(row.definition)?.[0] ?? null,
        }).toEqual({
          name: row.name,
          provider: null,
        });
      }
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "personal writers: provider-named and neutral routines produce the same outcomes and rows",
    async () => {
      const [codex, core] = [await writerScenario("codex"), await writerScenario("core")];
      expect(core).toEqual(codex);
      // The scenario reached every branch it claims to compare.
      expect(codex).toMatchObject({
        outsidePersonal: { outcome: "not_personal_workspace" },
        connect: { outcome: "connected", is_new: true },
        reconnect: { outcome: "connected", connection_id: "<first>", is_new: false },
        legacyIdentity: { outcome: "identity_unverified" },
        foreignManage: null,
        allocatorConflict: { kind: "conflict" },
        allocator: { kind: "updated", allocatorEnabled: false },
        extraCredits: { kind: "updated", extraCreditsEnabled: true },
        badAction: null,
        afterManage: { label: "Renamed", primary_connection: "<first>" },
        disconnect: "removed",
        afterDisconnect: { scrubbed: true, disconnected: true, authority_status: "revoked" },
        connectAfterDisconnect: { outcome: "connected", is_new: true },
        personalDisabled: { outcome: "personal_connections_disabled" },
      });
    },
    600_000,
  );

  test.skipIf(!realDb)(
    "turn refresh seam: same fences and writes, and one refresh lock across both families",
    async () => {
      const results: Record<Family, unknown> = { codex: null, core: null };
      for (const family of FAMILIES) {
        const state = await ownerlessRefreshFixture(
          { admin: database!.admin, client: client! },
          false,
        );
        await database!.admin`insert into subscription_connection_quota
            (account_id, connection_id, quota, observed_refresh_generation)
          values (${state.accountId}::uuid, ${state.connectionId}::uuid,
            ${database!.admin.json({ modelCooldowns: { "gpt-5.5": "2099-01-01T00:00:00Z" } })}::jsonb, 1)
          on conflict (connection_id) do update set quota = excluded.quota`;
        const begin = (
          tx: Parameters<Parameters<typeof withRlsContext>[2]>[0],
          generation = state.lease.generation,
        ) =>
          rawRows<{ refresh_generation: string }>(
            tx,
            sql`select refresh_generation from ${routine(family, "begin_subscription_codex_refresh", "begin_subscription_core_refresh")}
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid, ${null}, ${null}, ${state.connectionId}::uuid,
              ${state.lease.holderId}, ${generation}::bigint)`,
          );
        const persist = (
          tx: Parameters<Parameters<typeof withRlsContext>[2]>[0],
          expected: number,
          plan: string,
        ) =>
          rawRows<{ ok: boolean }>(
            tx,
            sql`select ${routine(family, "persist_subscription_codex_refresh_with_plan", "persist_subscription_core_refresh_with_plan")}
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid, ${state.connectionId}::uuid, ${expected}::bigint,
              ${encrypted(`rotated-${expected}`)}, now() + interval '1 hour', now(), ${plan}) as ok`,
          );
        const fail = (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0], expected: number) =>
          rawRows<{ ok: boolean }>(
            tx,
            sql`select ${routine(family, "fail_subscription_codex_refresh", "fail_subscription_core_refresh")}
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid, ${state.connectionId}::uuid, ${expected}::bigint,
              'refresh token was revoked') as ok`,
          );
        const steps: Record<string, unknown> = {};
        const turn = async <T>(
          work: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
        ) => await withSubscriptionCoreAcceptedTurn(client!.db, state.identity, work);
        steps.wrongLease = await turn(
          async (tx) => (await begin(tx, state.lease.generation + 1)).length,
        );
        steps.persistWithoutBegin = await turn(async (tx) => (await persist(tx, 1, "team"))[0]);
        steps.refresh = await turn(async (tx) => {
          const begun = await begin(tx);
          const again = await begin(tx);
          const stale = await persist(tx, 7, "team");
          return { begun: begun.length, again: again.length, stale: stale[0] };
        });
        steps.planChange = await turn(async (tx) => {
          await begin(tx);
          return (await persist(tx, 1, "team"))[0];
        });
        steps.fail = await turn(async (tx) => {
          await begin(tx);
          return (await fail(tx, 2))[0];
        });
        const [row] = await database!.admin`
          select connection.refresh_generation::int, connection.plan_type, connection.status,
            connection.last_error, connection.provider_state ? 'planPreviousType' as plan_recorded,
            quota.quota -> 'modelCooldowns' as cooldowns
          from subscription_connections connection
          left join subscription_connection_quota quota on quota.connection_id = connection.id
          where connection.id = ${state.connectionId}::uuid`;
        steps.row = row;
        results[family] = steps;
      }
      expect(results.core).toEqual(results.codex);
      expect(results.codex).toMatchObject({
        wrongLease: { status: "completed", value: 0 },
        persistWithoutBegin: { status: "completed", value: { ok: false } },
        refresh: { status: "completed", value: { begun: 1, again: 0, stale: { ok: false } } },
        planChange: { status: "completed", value: { ok: true } },
        fail: { status: "completed", value: { ok: true } },
        row: {
          refresh_generation: 2,
          plan_type: "team",
          status: "needs_relogin",
          last_error: "refresh token was revoked",
          plan_recorded: true,
          cooldowns: {},
        },
      });

      // Both families take the same per-connection refresh key: a neutral
      // refresh holds off a provider-named one on the same connection.
      const state = await ownerlessRefreshFixture(
        { admin: database!.admin, client: client! },
        false,
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let begun!: () => void;
      const holding = new Promise<void>((resolve) => (begun = resolve));
      const holder = withSubscriptionCoreAcceptedTurn(client!.db, state.identity, async (tx) => {
        const rows = await rawRows(
          tx,
          sql`select 1 from opengeni_private.begin_subscription_core_refresh('codex',
            ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
            ${state.identity.turnId}::uuid, ${null}, ${null}, ${state.connectionId}::uuid,
            ${state.lease.holderId}, ${state.lease.generation}::bigint)`,
        );
        begun();
        await held;
        return rows.length;
      });
      await holding;
      const contender = withSubscriptionCoreAcceptedTurn(client!.db, state.identity, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        return await rawRows(
          tx,
          sql`select 1 from opengeni_private.begin_subscription_codex_refresh(
            ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
            ${state.identity.turnId}::uuid, ${null}, ${null}, ${state.connectionId}::uuid,
            ${state.lease.holderId}, ${state.lease.generation}::bigint)`,
        );
      });
      const settled = await contender.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: String((error as { cause?: unknown }).cause ?? error) }),
      );
      release();
      expect(settled).toMatchObject({ error: expect.stringMatching(/lock timeout/i) });
      expect(await holder).toEqual({ status: "completed", value: 1 });
    },
    600_000,
  );

  test.skipIf(!realDb)(
    "a provider without a registry row is refused even with an enabled cutover row",
    async () => {
      const owner = await person();
      const state = await ownerlessRefreshFixture(
        { admin: database!.admin, client: client! },
        false,
      );
      for (const provider of ["claude", "xai", "unregistered"]) {
        await database!
          .admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
          values (${state.accountId}::uuid, ${provider}, true)
          on conflict (account_id, provider) do update set enabled = true`.catch(() => undefined);
        const writer = await asOwner(owner, owner.personalWorkspaceId, async (tx) => {
          const [connected] = await rawRows<{ outcome: string }>(
            tx,
            sql`select outcome from opengeni_private.connect_subscription_core_personal(${provider},
              ${owner.accountId}::uuid, ${owner.personalWorkspaceId}::uuid, ${owner.subjectId},
              ${encrypted("unregistered")}, 'acct-unregistered', 'user-unregistered', 'plus',
              '{}'::jsonb, now() + interval '1 day', now(), null, 'unregistered', ${owner.subjectId})`,
          );
          const [managed] = await rawRows<{ result: unknown }>(
            tx,
            sql`select opengeni_private.manage_subscription_core_personal(${provider},
              ${owner.accountId}::uuid, ${owner.personalWorkspaceId}::uuid, ${owner.subjectId},
              ${crypto.randomUUID()}::uuid, 'resolve', null, null, null) as result`,
          );
          const [removed] = await rawRows<{ outcome: string }>(
            tx,
            sql`select opengeni_private.disconnect_subscription_core_connection(${provider},
              ${owner.accountId}::uuid, ${owner.personalWorkspaceId}::uuid, ${owner.subjectId},
              ${crypto.randomUUID()}::uuid) as outcome`,
          );
          const listed = await rawRows(
            tx,
            sql`select * from opengeni_private.subscription_core_personal_connections(${provider},
              ${owner.accountId}::uuid, ${owner.personalWorkspaceId}::uuid, ${owner.subjectId})`,
          );
          return { connected, managed, removed, listed: listed.length };
        });
        expect(writer).toEqual({
          connected: { outcome: "refused" },
          managed: { result: null },
          removed: { outcome: "refused" },
          listed: 0,
        });
        const turn = await withSubscriptionCoreAcceptedTurn(
          client!.db,
          state.identity,
          async (tx) => {
            const begun = await rawRows(
              tx,
              sql`select 1 from opengeni_private.begin_subscription_core_refresh(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid, ${null}, ${null}, ${state.connectionId}::uuid,
              ${state.lease.holderId}, ${state.lease.generation}::bigint)`,
            );
            const [quarantined] = await rawRows<{ ok: boolean }>(
              tx,
              sql`select opengeni_private.quarantine_subscription_core_connection(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid, ${state.connectionId}::uuid, ${state.lease.holderId},
              ${state.lease.generation}::bigint, 1, 'needs_relogin', 'x', null) as ok`,
            );
            const [recovered] = await rawRows<{ count: number }>(
              tx,
              sql`select opengeni_private.recover_subscription_core_connection_health(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid) as count`,
            );
            const [acceptance] = await rawRows<{ authority: unknown }>(
              tx,
              sql`select opengeni_private.subscription_core_acceptance_authority_v2(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.subjectId}) as authority`,
            );
            const [task] = await rawRows<{ authority: unknown }>(
              tx,
              sql`select opengeni_private.subscription_core_task_authority_v2(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, null, ${state.subjectId}) as authority`,
            );
            const credential = await rawRows(
              tx,
              sql`select * from opengeni_private.read_subscription_core_connection_credential(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.connectionId}::uuid,
              null, null, null, null)`,
            );
            const connectionRefresh = await rawRows(
              tx,
              sql`select * from opengeni_private.begin_subscription_core_connection_refresh(${provider},
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.connectionId}::uuid,
              null, null, null, null)`,
            );
            return {
              begun: begun.length,
              quarantined: quarantined?.ok,
              recovered: recovered?.count,
              acceptance: acceptance?.authority ?? null,
              task: task?.authority ?? null,
              credential: credential.length,
              connectionRefresh: connectionRefresh.length,
            };
          },
        );
        expect(turn).toEqual({
          status: "completed",
          value: {
            begun: 0,
            quarantined: false,
            recovered: 0,
            acceptance: null,
            task: null,
            credential: 0,
            connectionRefresh: 0,
          },
        });
      }
      // The registered provider reads the same shared connection; provider
      // facts stay opaque (`provider_state`), never decoded per provider.
      const registered = await withSubscriptionCoreAcceptedTurn(
        client!.db,
        state.identity,
        async (tx) => {
          const rows = await rawRows<Record<string, unknown>>(
            tx,
            sql`select * from opengeni_private.read_subscription_core_connection_credential('codex',
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.connectionId}::uuid,
              null, null, null, null)`,
          );
          return rows.map((row) => Object.keys(row).sort());
        },
      );
      expect(registered).toEqual({
        status: "completed",
        value: [
          [
            "credential_encrypted",
            "expires_at",
            "last_refresh_at",
            "ownership",
            "plan_type",
            "provider_account_id",
            "provider_state",
            "refresh_generation",
            "status",
          ],
        ],
      });
    },
    600_000,
  );

  test.skipIf(!realDb)(
    "connection health: quarantine and recover have the same fences and writes in both families",
    async () => {
      const results: Record<Family, unknown> = { codex: null, core: null };
      for (const family of FAMILIES) {
        const state = await ownerlessRefreshFixture(
          { admin: database!.admin, client: client! },
          false,
        );
        const [current] = await database!.admin<{ generation: string }[]>`
          select refresh_generation::text as generation from subscription_connections
          where id = ${state.connectionId}::uuid`;
        const generation = Number(current!.generation);
        const turn = async <T>(
          work: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
        ) => await withSubscriptionCoreAcceptedTurn(client!.db, state.identity, work);
        const quarantine = (
          tx: Parameters<Parameters<typeof withRlsContext>[2]>[0],
          input: {
            leaseGeneration?: number;
            refreshGeneration?: number;
            status: string;
            error: string;
            retryInSeconds: number | null;
          },
        ) =>
          rawRows<{ ok: boolean }>(
            tx,
            sql`select ${routine(family, "quarantine_subscription_codex_connection", "quarantine_subscription_core_connection")}
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid, ${state.connectionId}::uuid, ${state.lease.holderId},
              ${input.leaseGeneration ?? state.lease.generation}::bigint,
              ${input.refreshGeneration ?? generation}::bigint, ${input.status}, ${input.error},
              ${input.retryInSeconds === null ? null : sql`clock_timestamp() + make_interval(secs => ${input.retryInSeconds})`}) as ok`,
          );
        const recover = (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) =>
          rawRows<{ count: number }>(
            tx,
            sql`select ${routine(family, "recover_subscription_codex_connection_health", "recover_subscription_core_connection_health")}
              ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
              ${state.identity.turnId}::uuid) as count`,
          );
        const row = async () => {
          const [found] = await database!.admin`
            select status, last_error, health_retry_at is not null as retry_set
            from subscription_connections where id = ${state.connectionId}::uuid`;
          return found;
        };
        const steps: Record<string, unknown> = {};
        steps.wrongLease = await turn(
          async (tx) =>
            (
              await quarantine(tx, {
                leaseGeneration: state.lease.generation + 1,
                status: "needs_relogin",
                error: "x",
                retryInSeconds: null,
              })
            )[0],
        );
        steps.staleRefresh = await turn(
          async (tx) =>
            (
              await quarantine(tx, {
                refreshGeneration: generation + 5,
                status: "needs_relogin",
                error: "x",
                retryInSeconds: null,
              })
            )[0],
        );
        steps.badStatus = await turn(
          async (tx) =>
            (await quarantine(tx, { status: "disabled", error: "x", retryInSeconds: null }))[0],
        );
        steps.retryTooFar = await turn(
          async (tx) =>
            (await quarantine(tx, { status: "error", error: "x", retryInSeconds: 3 * 86_400 }))[0],
        );
        steps.notDue = await turn(async (tx) => (await recover(tx))[0]);
        steps.quarantine = await turn(
          async (tx) =>
            (
              await quarantine(tx, {
                status: "error",
                error: "upstream refused for now",
                retryInSeconds: 3_600,
              })
            )[0],
        );
        steps.quarantined = await row();
        steps.recoverEarly = await turn(async (tx) => (await recover(tx))[0]);
        await database!.admin`update subscription_connections
          set health_retry_at = clock_timestamp() - interval '1 second'
          where id = ${state.connectionId}::uuid`;
        steps.recover = await turn(async (tx) => (await recover(tx))[0]);
        steps.recovered = await row();
        steps.relogin = await turn(
          async (tx) =>
            (
              await quarantine(tx, {
                status: "needs_relogin",
                error: "refresh token was revoked",
                retryInSeconds: null,
              })
            )[0],
        );
        steps.reloginRow = await row();
        results[family] = steps;
      }
      expect(results.core).toEqual(results.codex);
      expect(results.codex).toMatchObject({
        wrongLease: { status: "completed", value: { ok: false } },
        staleRefresh: { status: "completed", value: { ok: false } },
        badStatus: { status: "completed", value: { ok: false } },
        retryTooFar: { status: "completed", value: { ok: false } },
        notDue: { status: "completed", value: { count: 0 } },
        quarantine: { status: "completed", value: { ok: true } },
        quarantined: { status: "error", last_error: "upstream refused for now", retry_set: true },
        recoverEarly: { status: "completed", value: { count: 0 } },
        recover: { status: "completed", value: { count: 1 } },
        recovered: { status: "active" },
        relogin: { status: "completed", value: { ok: true } },
        reloginRow: { status: "needs_relogin", last_error: "refresh token was revoked" },
      });
    },
    600_000,
  );

  test.skipIf(!realDb)(
    "applied to a provisioned database, 0707 keeps the runtime posture clean before provisioning again",
    () => {
      expect(unprovisionedPostureViolations).toEqual([]);
    },
  );

  test.skipIf(!realDb)(
    "disconnect admission still guards registered providers, and temporary tables cannot shadow it",
    async () => {
      const state = await ownerlessRefreshFixture(
        { admin: database!.admin, client: client! },
        false,
      );
      const renew = (shadow: boolean, db: DbClient["db"] = client!.db) =>
        withSubscriptionCoreAcceptedTurn(db, state.identity, async (tx) => {
          if (shadow) {
            await tx.execute(sql`create temp table subscription_connections
              (account_id uuid, id uuid, disconnected_at timestamptz, status text) on commit drop`);
            await tx.execute(sql`insert into pg_temp.subscription_connections
              values (${state.accountId}::uuid, ${state.connectionId}::uuid, null, 'active')`);
            await tx.execute(sql`grant select on pg_temp.subscription_connections to public`);
          }
          return (
            await rawRows(
              tx,
              sql`update public.subscription_leases set holder_id = holder_id
                where account_id = ${state.accountId}::uuid and turn_id = ${state.identity.turnId}::uuid
                returning 1`,
            )
          ).length;
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error: String((error as { cause?: unknown }).cause ?? error) }),
        );
      expect(await renew(false)).toEqual({ value: { status: "completed", value: 1 } });
      await database!.admin`update subscription_connections set status = 'disabled'
        where id = ${state.connectionId}::uuid`;
      const refused = { error: expect.stringMatching(/source is disconnected or unavailable/) };
      // The shadowed renewal is a fresh session's first use of the trigger, so
      // no plan cached before the temporary table existed can hide a
      // search-path defect.
      const fresh = createDb(appConnectionUrl, { max: 1 });
      const shadowed = await renew(true, fresh.db).finally(() => fresh.close());
      expect({ plain: await renew(false), shadowed }).toMatchObject({
        // Separate objects: a reused expected object is compared only once.
        plain: { ...refused },
        shadowed: { ...refused },
      });
      const paths = await database!.admin<{ name: string; config: string[] }[]>`
        select proc.proname as name, proc.proconfig as config from pg_proc proc
        where proc.oid in ('opengeni_private.guard_subscription_disconnect_admission()'::regprocedure,
          'opengeni_private.guard_subscription_designation_disconnect()'::regprocedure)
        order by proc.proname`;
      expect(paths.map((entry) => entry.config)).toEqual([
        ["search_path=pg_catalog, public, pg_temp"],
        ["search_path=pg_catalog, public, pg_temp"],
      ]);
    },
    600_000,
  );

  test.skipIf(!realDb)(
    "a second provider's capabilities admit no Codex rows; the registry is append-only",
    async () => {
      const state = await ownerlessRefreshFixture(
        { admin: database!.admin, client: client! },
        false,
      );
      const outcomes: Record<string, unknown> = {};
      const rollback = new Error("rollback");
      await database!.admin
        .begin(async (tx) => {
          const attempt = async (label: string, work: () => Promise<unknown>) => {
            await tx`savepoint probe`;
            try {
              outcomes[label] = { value: await work() };
            } catch (error) {
              outcomes[label] = { error: (error as Error).message };
            }
            await tx`rollback to savepoint probe`;
          };
          await tx`insert into opengeni_private.subscription_core_providers (provider)
            values ('neutral_probe')`;
          await tx`select set_config('opengeni.account_id', ${state.accountId}, true),
            set_config('opengeni.workspace_id', ${state.workspaceId}, true)`;
          const refreshWrite = async (provider: string | null) => {
            if (provider) {
              await tx`insert into opengeni_private.subscription_runtime_capabilities
                (backend_pid, transaction_id, capability_kind, account_id, workspace_id,
                 connection_id, provider)
                values (pg_backend_pid(), pg_current_xact_id(), 'refresh_write',
                  ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                  ${state.connectionId}::uuid, ${provider})`;
            }
            await tx`set local role opengeni_app`;
            const [role] = await tx<{ role: string; bypass: boolean }[]>`
              select current_user as role, rolbypassrls as bypass from pg_roles
              where rolname = current_user`;
            const updated = await tx`update subscription_connections set updated_at = updated_at
              where id = ${state.connectionId}::uuid returning 1`;
            return { role: role!.role, bypass: role!.bypass, updated: updated.length };
          };
          await attempt("probeCapability", () => refreshWrite("neutral_probe"));
          await attempt("codexCapability", () => refreshWrite("codex"));
          await attempt("noCapability", () => refreshWrite(null));
          await attempt("mismatchedGrant", async () => {
            for (const provider of ["codex", "neutral_probe"]) {
              await tx`select opengeni_subscription_internal.grant_subscription_core_owner_capability(
                ${provider}, 'connection_owner', ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                ${state.subjectId}, ${state.connectionId}::uuid)`;
            }
            return "granted";
          });
          await attempt("regrantSameProvider", async () => {
            for (let index = 0; index < 2; index += 1) {
              await tx`select opengeni_subscription_internal.grant_subscription_core_owner_capability(
                'codex', 'connection_owner', ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                ${state.subjectId}, ${state.connectionId}::uuid)`;
            }
            return "granted";
          });
          await attempt("badProviderKey", () =>
            tx`insert into opengeni_private.subscription_runtime_capabilities
              (backend_pid, transaction_id, capability_kind, account_id, workspace_id,
               connection_id, provider)
              values (pg_backend_pid(), pg_current_xact_id(), 'refresh_write',
                ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                ${state.connectionId}::uuid, 'Not A Provider')`.then(() => "inserted"),
          );
          await attempt("nullProviderKey", () =>
            tx`insert into opengeni_private.subscription_runtime_capabilities
              (backend_pid, transaction_id, capability_kind, account_id, workspace_id,
               connection_id, provider)
              values (pg_backend_pid(), pg_current_xact_id(), 'refresh_write',
                ${state.accountId}::uuid, ${state.workspaceId}::uuid,
                ${state.connectionId}::uuid, null)`.then(() => "inserted"),
          );
          await attempt("nullProviderGrant", () =>
            tx`select opengeni_subscription_internal.grant_subscription_core_owner_capability(
              null, 'connection_owner', ${state.accountId}::uuid, ${state.workspaceId}::uuid,
              ${state.subjectId}, ${state.connectionId}::uuid)`.then(() => "granted"),
          );
          await attempt("deleteProvider", () =>
            tx`delete from opengeni_private.subscription_core_providers where provider = 'codex'`.then(
              () => "deleted",
            ),
          );
          await attempt("renameProvider", () =>
            tx`update opengeni_private.subscription_core_providers set provider = 'renamed'
              where provider = 'codex'`.then(() => "renamed"),
          );
          await attempt("truncate", () =>
            tx`truncate opengeni_private.subscription_core_providers`.then(() => "truncated"),
          );
          // 0714's reach rows and plan-change providers reference the
          // registry, so a plain TRUNCATE is refused by those keys first;
          // with CASCADE the append-only guard still refuses it.
          await attempt("truncateCascade", () =>
            tx`truncate opengeni_private.subscription_core_providers cascade`.then(
              () => "truncated",
            ),
          );
          await attempt("missingColumn", () =>
            tx`insert into opengeni_private.subscription_core_providers
              (provider, primary_setting_column)
              values ('neutral_probe_two', 'missing_primary_connection_id')`.then(() => "inserted"),
          );
          await attempt("foreignColumn", () =>
            tx`insert into opengeni_private.subscription_core_providers
              (provider, primary_setting_column)
              values ('neutral_probe_two', 'codex_primary_connection_id')`.then(() => "inserted"),
          );
          await attempt("repointColumn", () =>
            tx`update opengeni_private.subscription_core_providers
              set primary_setting_column = 'claude_primary_connection_id'
              where provider = 'codex'`.then(() => "updated"),
          );
          await attempt("ownColumn", () =>
            tx`insert into opengeni_private.subscription_core_providers
              (provider, primary_setting_column)
              values ('claude', 'claude_primary_connection_id') returning provider`.then(
              (rows) => rows.length,
            ),
          );
          await attempt("flagUpdate", () =>
            tx`update opengeni_private.subscription_core_providers set extra_credits = extra_credits
              where provider = 'codex' returning provider`.then((rows) => rows.length),
          );
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      expect(outcomes).toEqual({
        probeCapability: { value: { role: "opengeni_app", bypass: false, updated: 0 } },
        codexCapability: { value: { role: "opengeni_app", bypass: false, updated: 1 } },
        noCapability: { value: { role: "opengeni_app", bypass: false, updated: 0 } },
        mismatchedGrant: { error: "subscription capability is held for another provider" },
        regrantSameProvider: { value: "granted" },
        badProviderKey: {
          error: expect.stringMatching(/subscription_runtime_capabilities_provider_chk/),
        },
        nullProviderKey: {
          error: expect.stringMatching(/subscription_runtime_capabilities_provider_chk/),
        },
        nullProviderGrant: {
          error: expect.stringMatching(/subscription_runtime_capabilities_provider_chk/),
        },
        deleteProvider: { error: "subscription core providers are append-only" },
        renameProvider: { error: "subscription core providers are append-only" },
        truncate: { error: "cannot truncate a table referenced in a foreign key constraint" },
        truncateCascade: { error: "subscription core providers are append-only" },
        missingColumn: { error: "subscription_settings primary column is missing" },
        foreignColumn: {
          error: expect.stringMatching(/subscription_core_providers_primary_column_chk/),
        },
        repointColumn: {
          error: expect.stringMatching(/subscription_core_providers_primary_column_chk/),
        },
        ownColumn: { value: 1 },
        flagUpdate: { value: 1 },
      });
      const [registry] = await database!.admin<{ providers: string[] }[]>`
        select array_agg(provider order by provider) as providers
        from opengeni_private.subscription_core_providers`;
      expect(registry?.providers).toEqual(["codex"]);
    },
    600_000,
  );
});
