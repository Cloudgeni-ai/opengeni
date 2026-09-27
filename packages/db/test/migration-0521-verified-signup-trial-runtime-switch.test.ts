import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  completeSelfServiceOrganizationSetup,
  createDb,
  getBillingBalance,
  nestedPostgresSqlState,
  readVerifiedSignupTrialSwitch,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES,
} from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const SETTER = "set_verified_signup_trial_credits_enabled(boolean, text, text)";
let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;
let app: postgres.Sql | null = null;
let owner: postgres.Sql | null = null;

type SwitchResult = {
  revision: number;
  grantsEnabled: boolean;
  previousGrantsEnabled: boolean | null;
  changed: boolean;
  operator: string;
  reason: string;
  databaseRole: string;
  changedAt: string;
};

async function setSwitch(enabled: boolean, reason: string): Promise<SwitchResult> {
  if (!owner) throw new Error("test database unavailable");
  const [row] = await owner<Array<{ result: SwitchResult }>>`
    select set_verified_signup_trial_credits_enabled(
      ${enabled}, 'test-operator', ${reason}
    ) as result`;
  return row!.result;
}

async function newVerifiedSetup(trialCreditsEnabled: boolean) {
  if (!owned || !appClient) throw new Error("test database unavailable");
  const authUserId = crypto.randomUUID();
  await owned.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${authUserId}, 'Switch owner', ${`${authUserId}@example.test`}, true)`;
  const setup = completeSelfServiceOrganizationSetup(appClient.db, {
    authUserId,
    actorSubjectId: `user:${authUserId}`,
    organizationName: "Switch organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "d".repeat(64),
    trialCreditsEnabled,
  });
  return { authUserId, setup };
}

async function trialGrantCount(authUserId: string): Promise<number> {
  if (!owned) throw new Error("test database unavailable");
  const [row] = await owned.admin<Array<{ count: number }>>`
    select count(*)::int as count from credit_ledger_entries
    where source_type = 'verified_signup_trial' and source_id = ${authUserId}`;
  return row?.count ?? -1;
}

async function sqlStateOf(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (error) {
    return nestedPostgresSqlState(error) ?? null;
  }
  return null;
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0521-trial-switch");
  if (!owned) {
    if (requireRealDatabase) throw new Error("trial switch PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  appClient = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), { max: 1, prepare: false, onnotice: () => undefined });
  owner = postgres(owned.ownerUrl, { max: 2, prepare: false, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  await appClient?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("migration 0521 verified signup trial runtime switch", () => {
  test("is a rolling, operator-only switch layered after the deployment opt-in", () => {
    const migration = readFileSync(
      new URL("../drizzle/0521_verified_signup_trial_runtime_switch.sql", import.meta.url),
      "utf8",
    );
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION set_verified_signup_trial_credits_enabled(boolean, text, text) FROM PUBLIC",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.grant_verified_signup_trial_credit()",
    );
    // The deployment GUC gate stays first; the runtime switch is only consulted
    // once the API has opted this request in.
    const body = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION opengeni_private.grant_verified"),
    );
    expect(body.indexOf("opengeni.verified_signup_trial_enabled")).toBeLessThan(
      body.indexOf("pg_advisory_xact_lock_shared"),
    );
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(SETTER);
  });

  test("seeds an enabled revision so existing behavior is unchanged", async () => {
    if (!owned || !appClient) return;
    const [seed] = await owned.admin<
      Array<{ grants_enabled: boolean; previous_grants_enabled: boolean | null; operator: string }>
    >`
      select grants_enabled, previous_grants_enabled, operator
      from opengeni_private.verified_signup_trial_switch_revisions
      order by revision asc limit 1`;
    expect(seed).toEqual({
      grants_enabled: true,
      previous_grants_enabled: null,
      operator: "migration:0521",
    });
    expect((await readVerifiedSignupTrialSwitch(appClient.db))?.grantsEnabled).toBe(true);

    const { authUserId, setup } = await newVerifiedSetup(true);
    const result = await setup;
    expect(await trialGrantCount(authUserId)).toBe(1);
    expect((await getBillingBalance(appClient.db, result.organizationId)).balanceMicros).toBe(
      10_000_000,
    );

    // The deployment flag is still the master switch.
    const off = await newVerifiedSetup(false);
    await off.setup;
    expect(await trialGrantCount(off.authUserId)).toBe(0);
  });

  test("disabling stops new grants without failing setup, and re-enabling restores them", async () => {
    if (!owned || !appClient) return;
    const disabled = await setSwitch(false, "abuse response: pause signup trial");
    expect(disabled).toMatchObject({
      grantsEnabled: false,
      previousGrantsEnabled: true,
      changed: true,
      operator: "test-operator",
      reason: "abuse response: pause signup trial",
      databaseRole: owned.ownerRole,
    });
    expect((await readVerifiedSignupTrialSwitch(appClient.db))?.grantsEnabled).toBe(false);

    const blocked = await newVerifiedSetup(true);
    const blockedResult = await blocked.setup;
    expect(blockedResult.organizationId).toBeString();
    expect(await trialGrantCount(blocked.authUserId)).toBe(0);
    expect(
      (await getBillingBalance(appClient.db, blockedResult.organizationId)).balanceMicros,
    ).toBe(0);

    // A repeated disable is still audited but reports no change.
    const repeated = await setSwitch(false, "confirm signup trial stays paused");
    expect(repeated).toMatchObject({ grantsEnabled: false, changed: false });
    expect(repeated.revision).toBe(disabled.revision + 1);

    const enabled = await setSwitch(true, "abuse contained: resume signup trial");
    expect(enabled).toMatchObject({ grantsEnabled: true, previousGrantsEnabled: false });
    const allowed = await newVerifiedSetup(true);
    await allowed.setup;
    expect(await trialGrantCount(allowed.authUserId)).toBe(1);

    // Replaying the blocked setup after re-enablement never back-grants it.
    expect(await trialGrantCount(blocked.authUserId)).toBe(0);
  });

  test("a disable orders against in-flight grants through the shared advisory lock", async () => {
    if (!owned || !appClient || !owner) return;
    let pending: Awaited<ReturnType<typeof newVerifiedSetup>> | null = null;
    await owner.begin(async (tx) => {
      await tx`select set_verified_signup_trial_credits_enabled(
        false, 'test-operator', 'ordering check: disable while setup waits')`;
      pending = await newVerifiedSetup(true);
      // The setup must block on the setter's exclusive lock, not read the
      // uncommitted-but-invisible revision and grant.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [waiting] = await owned!.admin<Array<{ count: number }>>`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        if ((waiting?.count ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("setup never waited on the switch lock");
        await Bun.sleep(25);
      }
    });
    const current = pending as Awaited<ReturnType<typeof newVerifiedSetup>> | null;
    await current!.setup;
    expect(await trialGrantCount(current!.authUserId)).toBe(0);
    await setSwitch(true, "ordering check complete: resume");
  }, 60_000);

  test("revisions are append-only and inputs are validated", async () => {
    if (!owned || !owner) return;
    expect(
      await sqlStateOf(
        () => owner!`update opengeni_private.verified_signup_trial_switch_revisions
          set grants_enabled = not grants_enabled`,
      ),
    ).toBe("55000");
    expect(
      await sqlStateOf(
        () => owner!`delete from opengeni_private.verified_signup_trial_switch_revisions`,
      ),
    ).toBe("55000");
    expect(
      await sqlStateOf(
        () => owner!`truncate opengeni_private.verified_signup_trial_switch_revisions`,
      ),
    ).toBe("55000");

    for (const [enabled, operator, reason] of [
      [null, "test-operator", "valid reason text"],
      [false, " padded ", "valid reason text"],
      [false, "", "valid reason text"],
      [false, "test-operator", "short"],
      [false, "test-operator", " padded reason "],
      [false, "test-operator", null],
    ] as const) {
      expect(
        await sqlStateOf(
          () => owner!`select set_verified_signup_trial_credits_enabled(
            ${enabled}::boolean, ${operator}::text, ${reason}::text)`,
        ),
      ).toBe("22023");
    }
  });

  test("strips default-privilege grants from the switch table and setter at creation", async () => {
    if (!owned || !owner) return;
    const migration = readFileSync(
      new URL("../drizzle/0521_verified_signup_trial_runtime_switch.sql", import.meta.url),
      "utf8",
    );
    const rollback = new Error("roll back the 0521 replay");
    let probe: { probe_insert: boolean; probe_execute: boolean } | undefined;
    let grantees: { table_grantees: string[]; setter_grantees: string[] } | undefined;
    await owner
      .begin(async (tx) => {
        // Replay 0521 in a rolled-back transaction after installing default
        // privileges that grant the runtime role write and EXECUTE on new objects.
        await tx.unsafe(`
          DROP TABLE opengeni_private.verified_signup_trial_switch_revisions;
          DROP FUNCTION public.${SETTER};
          DROP FUNCTION public.reject_verified_signup_trial_switch_revision_mutation();
          ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opengeni_app;
          ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO opengeni_app;
          CREATE TABLE opengeni_private.default_acl_probe_0521 (id integer);
          CREATE FUNCTION public.default_acl_probe_0521() RETURNS integer
            LANGUAGE sql AS 'select 1';
        `);
        [probe] = await tx<Array<{ probe_insert: boolean; probe_execute: boolean }>>`
          select
            has_table_privilege('opengeni_app', 'opengeni_private.default_acl_probe_0521', 'INSERT')
              as probe_insert,
            has_function_privilege('opengeni_app', 'public.default_acl_probe_0521()', 'EXECUTE')
              as probe_execute`;
        await tx.unsafe(migration);
        [grantees] = await tx<Array<{ table_grantees: string[]; setter_grantees: string[] }>>`
          select
            coalesce((
              select array_agg(distinct acl.grantee::regrole::text)
              from pg_class c,
                aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
              where c.oid = 'opengeni_private.verified_signup_trial_switch_revisions'::regclass
                and acl.grantee <> c.relowner
            ), '{}'::text[]) as table_grantees,
            coalesce((
              select array_agg(distinct acl.grantee::regrole::text)
              from pg_proc p,
                aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where p.oid = ${`public.${SETTER}`}::text::regprocedure
                and acl.grantee <> p.proowner
            ), '{}'::text[]) as setter_grantees`;
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    // The default privileges really would have leaked to the runtime role.
    expect(probe).toEqual({ probe_insert: true, probe_execute: true });
    expect(grantees).toEqual({ table_grantees: [], setter_grantees: [] });
  }, 60_000);

  test("the runtime role can read the switch but never flip or rewrite it", async () => {
    if (!owned || !app || !appClient) return;
    const [privileges] = await owned.admin<
      Array<{
        runtime_execute: boolean;
        public_execute: boolean;
        runtime_select: boolean;
        runtime_insert: boolean;
        runtime_update: boolean;
        runtime_delete: boolean;
        public_select: boolean;
        security_definer: boolean;
        setter_config: string[];
        grant_config: string[];
      }>
    >`
      select
        has_function_privilege('opengeni_app', ${`public.${SETTER}`}::text, 'EXECUTE') as runtime_execute,
        exists (
          select 1 from pg_proc p,
            aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where p.oid = ${`public.${SETTER}`}::text::regprocedure
            and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as public_execute,
        has_table_privilege('opengeni_app', 'opengeni_private.verified_signup_trial_switch_revisions', 'SELECT') as runtime_select,
        has_table_privilege('opengeni_app', 'opengeni_private.verified_signup_trial_switch_revisions', 'INSERT') as runtime_insert,
        has_table_privilege('opengeni_app', 'opengeni_private.verified_signup_trial_switch_revisions', 'UPDATE') as runtime_update,
        has_table_privilege('opengeni_app', 'opengeni_private.verified_signup_trial_switch_revisions', 'DELETE') as runtime_delete,
        exists (
          select 1 from pg_class c,
            aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
          where c.oid = 'opengeni_private.verified_signup_trial_switch_revisions'::regclass
            and acl.grantee = 0
        ) as public_select,
        (select p.prosecdef from pg_proc p where p.oid = ${`public.${SETTER}`}::text::regprocedure)
          as security_definer,
        (select p.proconfig from pg_proc p where p.oid = ${`public.${SETTER}`}::text::regprocedure)
          as setter_config,
        (select p.proconfig from pg_proc p
          where p.oid = 'opengeni_private.grant_verified_signup_trial_credit()'::regprocedure)
          as grant_config`;
    expect(privileges).toMatchObject({
      runtime_execute: false,
      public_execute: false,
      runtime_select: true,
      runtime_insert: false,
      runtime_update: false,
      runtime_delete: false,
      public_select: false,
      security_definer: true,
    });
    expect(privileges!.setter_config).toContain("search_path=pg_catalog, public, pg_temp");
    expect(privileges!.grant_config).toContain(
      "search_path=pg_catalog, public, opengeni_private, pg_temp",
    );

    const before = await readVerifiedSignupTrialSwitch(appClient.db);
    expect(before?.grantsEnabled).toBe(true);
    expect(
      await sqlStateOf(
        () => app!`select set_verified_signup_trial_credits_enabled(
          false, 'runtime', 'forged runtime disable')`,
      ),
    ).toBe("42501");
    expect(
      await sqlStateOf(
        () => app!`insert into opengeni_private.verified_signup_trial_switch_revisions (
          grants_enabled, operator, reason) values (false, 'runtime', 'forged runtime row')`,
      ),
    ).toBe("42501");
    expect(await readVerifiedSignupTrialSwitch(appClient.db)).toEqual(before);

    // Reprovisioning repairs an accidental grant instead of preserving it.
    await owned.admin.unsafe(
      `GRANT EXECUTE ON FUNCTION public.${SETTER} TO opengeni_app, PUBLIC;
       GRANT INSERT, UPDATE ON opengeni_private.verified_signup_trial_switch_revisions TO opengeni_app`,
    );
    await provisionRoles(owned.adminUrl, {
      appPassword: owned.appPassword,
      rlsStrategy: "force",
    });
    const [repaired] = await owned.admin<
      Array<{ runtime_execute: boolean; runtime_insert: boolean; runtime_select: boolean }>
    >`
      select
        has_function_privilege('opengeni_app', ${`public.${SETTER}`}::text, 'EXECUTE') as runtime_execute,
        has_table_privilege('opengeni_app', 'opengeni_private.verified_signup_trial_switch_revisions', 'INSERT') as runtime_insert,
        has_table_privilege('opengeni_app', 'opengeni_private.verified_signup_trial_switch_revisions', 'SELECT') as runtime_select`;
    expect(repaired).toEqual({
      runtime_execute: false,
      runtime_insert: false,
      runtime_select: true,
    });

    const options = {
      expectedRole: "opengeni_app",
      targetSchema: "public",
      rlsStrategy: "force" as const,
      organizationTenancyCanonicalActivationEnabled: true,
    };
    const trialViolations = async () =>
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(appClient!.db, options),
        options,
      ).filter(
        (message) =>
          message.includes("set_verified_signup_trial_credits_enabled") ||
          message.includes("verified signup trial"),
      );
    expect(await trialViolations()).toEqual([]);
    await owned.admin.unsafe(`GRANT EXECUTE ON FUNCTION public.${SETTER} TO opengeni_app`);
    await owned.admin.unsafe(
      `GRANT INSERT ON opengeni_private.verified_signup_trial_switch_revisions TO opengeni_app`,
    );
    try {
      expect(await trialViolations()).toEqual([
        `runtime role has forbidden owner-internal helper ${SETTER}`,
        "runtime role has forbidden write authority on the verified signup trial switch",
      ]);
    } finally {
      await provisionRoles(owned.adminUrl, {
        appPassword: owned.appPassword,
        rlsStrategy: "force",
      });
    }
  }, 180_000);
});
