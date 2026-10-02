import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  createDb,
  nestedPostgresSqlState,
  readManagedAuthNewSignupsSwitch,
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
const SETTER = "set_managed_auth_new_signups_enabled(boolean, text, text)";
const TABLE = "opengeni_private.managed_auth_new_signups_switch_revisions";
const MIGRATION = "0585_managed_auth_new_signups_switch.sql";
let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;
let app: postgres.Sql | null = null;
let owner: postgres.Sql | null = null;

type SwitchResult = {
  revision: number;
  signupsEnabled: boolean;
  previousSignupsEnabled: boolean | null;
  changed: boolean;
  operator: string;
  reason: string;
  databaseRole: string;
  changedAt: string;
};

async function setSwitch(enabled: boolean, reason: string): Promise<SwitchResult> {
  if (!owner) throw new Error("test database unavailable");
  const [row] = await owner<Array<{ result: SwitchResult }>>`
    select set_managed_auth_new_signups_enabled(
      ${enabled}, 'test-operator', ${reason}
    ) as result`;
  return row!.result;
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
  owned = await acquireOwnerMigratedTestDatabase("migration-0585-new-signups-switch");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("new signups switch PostgreSQL fixture is unavailable");
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

describe("migration 0585 managed auth new signups switch", () => {
  test("is a rolling, operator-only switch", () => {
    const migration = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${SETTER} FROM PUBLIC`);
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(SETTER);
  });

  test("seeds an open revision so existing behavior is unchanged", async () => {
    if (!owned || !appClient) return;
    const [seed] = await owned.admin<
      Array<{
        signups_enabled: boolean;
        previous_signups_enabled: boolean | null;
        operator: string;
      }>
    >`
      select signups_enabled, previous_signups_enabled, operator
      from opengeni_private.managed_auth_new_signups_switch_revisions
      order by revision asc limit 1`;
    expect(seed).toEqual({
      signups_enabled: true,
      previous_signups_enabled: null,
      operator: "migration:0585",
    });
    expect((await readManagedAuthNewSignupsSwitch(appClient.db))?.signupsEnabled).toBe(true);
  });

  test("the audited setter flips the state the runtime reads, recording who and why", async () => {
    if (!owned || !appClient) return;
    const closed = await setSwitch(false, "launch load: pause new sign-ups");
    expect(closed).toMatchObject({
      signupsEnabled: false,
      previousSignupsEnabled: true,
      changed: true,
      operator: "test-operator",
      reason: "launch load: pause new sign-ups",
      databaseRole: owned.ownerRole,
    });
    expect(await readManagedAuthNewSignupsSwitch(appClient.db)).toMatchObject({
      revision: closed.revision,
      signupsEnabled: false,
    });

    // A repeated close is still audited but reports no change.
    const repeated = await setSwitch(false, "confirm sign-ups stay paused");
    expect(repeated).toMatchObject({ signupsEnabled: false, changed: false });
    expect(repeated.revision).toBe(closed.revision + 1);

    const reopened = await setSwitch(true, "load recovered: reopen sign-ups");
    expect(reopened).toMatchObject({ signupsEnabled: true, previousSignupsEnabled: false });
    expect((await readManagedAuthNewSignupsSwitch(appClient.db))?.signupsEnabled).toBe(true);
  });

  test("revisions are append-only and inputs are validated", async () => {
    if (!owned || !owner) return;
    expect(
      await sqlStateOf(() =>
        owner!.unsafe(`update ${TABLE} set signups_enabled = not signups_enabled`),
      ),
    ).toBe("55000");
    expect(await sqlStateOf(() => owner!.unsafe(`delete from ${TABLE}`))).toBe("55000");
    expect(await sqlStateOf(() => owner!.unsafe(`truncate ${TABLE}`))).toBe("55000");

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
          () => owner!`select set_managed_auth_new_signups_enabled(
            ${enabled}::boolean, ${operator}::text, ${reason}::text)`,
        ),
      ).toBe("22023");
    }
  });

  test("strips default-privilege grants from the switch table and setter at creation", async () => {
    if (!owned || !owner) return;
    const migration = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    const rollback = new Error("roll back the 0585 replay");
    let grantees: { table_grantees: string[]; setter_grantees: string[] } | undefined;
    await owner
      .begin(async (tx) => {
        await tx.unsafe(`
          DROP TABLE ${TABLE};
          DROP FUNCTION public.${SETTER};
          DROP FUNCTION public.reject_managed_auth_new_signups_switch_revision_mutation();
          ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opengeni_app;
          ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO opengeni_app;
        `);
        await tx.unsafe(migration);
        [grantees] = await tx<Array<{ table_grantees: string[]; setter_grantees: string[] }>>`
          select
            coalesce((
              select array_agg(distinct acl.grantee::regrole::text)
              from pg_class c,
                aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
              where c.oid = ${TABLE}::text::regclass
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
    expect(grantees).toEqual({ table_grantees: [], setter_grantees: [] });
  }, 60_000);

  test("the runtime role can read the switch but never flip or rewrite it", async () => {
    if (!owned || !app || !appClient) return;
    const [privileges] = await owned.admin<
      Array<{
        runtime_execute: boolean;
        runtime_select: boolean;
        runtime_insert: boolean;
        runtime_update: boolean;
        runtime_delete: boolean;
        security_definer: boolean;
        setter_config: string[];
      }>
    >`
      select
        has_function_privilege('opengeni_app', ${`public.${SETTER}`}::text, 'EXECUTE') as runtime_execute,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'SELECT') as runtime_select,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'INSERT') as runtime_insert,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'UPDATE') as runtime_update,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'DELETE') as runtime_delete,
        (select p.prosecdef from pg_proc p where p.oid = ${`public.${SETTER}`}::text::regprocedure)
          as security_definer,
        (select p.proconfig from pg_proc p where p.oid = ${`public.${SETTER}`}::text::regprocedure)
          as setter_config`;
    expect(privileges).toMatchObject({
      runtime_execute: false,
      runtime_select: true,
      runtime_insert: false,
      runtime_update: false,
      runtime_delete: false,
      security_definer: true,
    });
    expect(privileges!.setter_config).toContain("search_path=pg_catalog, public, pg_temp");

    const before = await readManagedAuthNewSignupsSwitch(appClient.db);
    expect(
      await sqlStateOf(
        () => app!`select set_managed_auth_new_signups_enabled(
          false, 'runtime', 'forged runtime close')`,
      ),
    ).toBe("42501");
    expect(
      await sqlStateOf(() =>
        app!.unsafe(
          `insert into ${TABLE} (signups_enabled, operator, reason)
           values (false, 'runtime', 'forged runtime row')`,
        ),
      ),
    ).toBe("42501");
    expect(await readManagedAuthNewSignupsSwitch(appClient.db)).toEqual(before);

    // Reprovisioning repairs an accidental grant, and runtime posture names it.
    const options = {
      expectedRole: "opengeni_app",
      targetSchema: "public",
      rlsStrategy: "force" as const,
      organizationTenancyCanonicalActivationEnabled: true,
    };
    const switchViolations = async () =>
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(appClient!.db, options),
        options,
      ).filter(
        (message) =>
          message.includes("set_managed_auth_new_signups_enabled") ||
          message.includes("managed auth new signups"),
      );
    expect(await switchViolations()).toEqual([]);
    await owned.admin.unsafe(
      `GRANT EXECUTE ON FUNCTION public.${SETTER} TO opengeni_app;
       GRANT INSERT ON ${TABLE} TO opengeni_app`,
    );
    try {
      expect(await switchViolations()).toEqual([
        `runtime role has forbidden owner-internal helper ${SETTER}`,
        "runtime role has forbidden write authority on the managed auth new signups switch",
      ]);
    } finally {
      await provisionRoles(owned.adminUrl, {
        appPassword: owned.appPassword,
        rlsStrategy: "force",
      });
    }
    const [repaired] = await owned.admin<
      Array<{ runtime_execute: boolean; runtime_insert: boolean; runtime_select: boolean }>
    >`
      select
        has_function_privilege('opengeni_app', ${`public.${SETTER}`}::text, 'EXECUTE') as runtime_execute,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'INSERT') as runtime_insert,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'SELECT') as runtime_select`;
    expect(repaired).toEqual({
      runtime_execute: false,
      runtime_insert: false,
      runtime_select: true,
    });
  }, 180_000);
});
