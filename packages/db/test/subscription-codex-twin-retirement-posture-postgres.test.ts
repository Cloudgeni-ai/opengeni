// The Codex-named twins of the migration 0707 neutral routines (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "R. Retirement"). No
// runtime code calls them and no retained policy, trigger, view or routine
// depends on them, so the retirement migration may drop them while this
// release runs. On a real, fully migrated database whose owner is NOSUPERUSER
// and NOBYPASSRLS, this test checks that inventory, then drops the twins as
// the owner and evaluates the runtime posture as the restricted application
// role: the drop must not break readiness, and the owner-implementation checks
// must keep running without the Codex twin writers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const options = {
  rlsStrategy: "force" as const,
  expectedRole: "opengeni_app",
  targetSchema: "public",
};
/** The twins' owner-only internals, called only by the twins themselves. */
const TWIN_OWNER_ROUTINES = [
  "opengeni_subscription_internal.subscription_codex_writer_context(uuid, uuid, text)",
  "opengeni_private.subscription_codex_connection_target(uuid, uuid, uuid, uuid, uuid, text, bigint)",
] as const;
const twinSignatures = [
  ...SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES.map((name) => `opengeni_private.${name}`),
  ...TWIN_OWNER_ROUTINES,
];

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;
let owner: postgres.Sql | null = null;

async function postureViolations(): Promise<string[]> {
  return evaluateRuntimeDatabasePosture(
    await inspectRuntimeDatabasePosture(client!.db, options),
    options,
  );
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-codex-twin-posture");
  if (!database) throw new Error("Real PostgreSQL is required");
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const appUrl = new URL(database.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = database.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  app = postgres(appUrl.toString(), { max: 1, onnotice: () => undefined });
  owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await app?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("retiring the Codex twin routines (M4 step R)", () => {
  test("the posture is evaluated as the restricted application role over a NOBYPASSRLS owner", async () => {
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
    const [session] = await app!<{ role: string; superuser: string }[]>`
      select current_user as role, current_setting('is_superuser') as superuser`;
    expect(session).toEqual({ role: "opengeni_app", superuser: "off" });
    expect(await postureViolations()).toEqual([]);
  }, 180_000);

  test("every twin exists today and nothing retained depends on one", async () => {
    for (const signature of twinSignatures) {
      const [found] = await database!.admin<{ present: boolean }[]>`
        select to_regprocedure(${signature}) is not null as present`;
      expect({ signature, ...found }).toEqual({ signature, present: true });
    }
    const names = twinSignatures.map((signature) =>
      signature.slice(signature.indexOf(".") + 1, signature.indexOf("(")),
    );
    // Catalog dependencies (SQL-standard bodies, views, policies, triggers,
    // defaults) on any twin from an object that is not itself a twin.
    const catalogDependents = await database!.admin<{ dependent: string; twin: string }[]>`
      select pg_describe_object(d.classid, d.objid, d.objsubid) as dependent,
        d.refobjid::regprocedure::text as twin
      from pg_depend d
      join pg_proc p on p.oid = d.refobjid
      where d.refclassid = 'pg_proc'::regclass
        and p.proname = any(${names}::text[])
        and d.deptype = 'n'
        and not (d.classid = 'pg_proc'::regclass
          and (select proname from pg_proc where oid = d.objid) = any(${names}::text[]))`;
    expect([...catalogDependents]).toEqual([]);
    // PL/pgSQL bodies, policy expressions and trigger functions are not in
    // pg_depend: search them by name.
    const textualDependents = await database!.admin<{ dependent: string }[]>`
      select 'routine ' || p.oid::regprocedure::text as dependent
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and not (p.proname = any(${names}::text[]))
        and exists (
          select 1 from unnest(${names}::text[]) as twin
          where p.prosrc ~ ('\\m' || twin || '\\M'))
      union all
      select 'policy ' || pol.tablename || '.' || pol.policyname
      from pg_policies pol
      where exists (
        select 1 from unnest(${names}::text[]) as twin
        where coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, '') ~ ('\\m' || twin || '\\M'))
      union all
      select 'trigger ' || t.tgname
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.proname = any(${names}::text[])`;
    expect([...textualDependents]).toEqual([]);
  }, 180_000);

  test("a present twin is still held to the precursor hardening", async () => {
    const twin = SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES[0];
    await owner!.unsafe(`GRANT EXECUTE ON FUNCTION opengeni_private.${twin} TO PUBLIC`);
    try {
      expect(await postureViolations()).toContain(
        `retiring Codex twin private routine ${twin} is unsafe`,
      );
    } finally {
      await owner!.unsafe(`REVOKE EXECUTE ON FUNCTION opengeni_private.${twin} FROM PUBLIC`);
    }
    expect(await postureViolations()).toEqual([]);
  }, 180_000);

  test("dropping the twins keeps the runtime posture and its owner-implementation checks", async () => {
    // Exact signatures, no CASCADE: the writers before their owner-only
    // internals, as the retirement migration will.
    for (const signature of twinSignatures) {
      await owner!.unsafe(`DROP FUNCTION ${signature}`);
    }
    for (const signature of twinSignatures) {
      const [found] = await database!.admin<{ present: boolean }[]>`
        select to_regprocedure(${signature}) is not null as present`;
      expect({ signature, ...found }).toEqual({ signature, present: false });
    }
    // Readiness of this release, before and after provisioning roles again.
    expect(await postureViolations()).toEqual([]);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });
    expect(await postureViolations()).toEqual([]);

    // The neutral writers' owner-only internals are still checked for their
    // fixed search path (only the owner-implementation check looks at it),
    // even though the Codex twin writers are gone.
    const neutralInternal =
      "opengeni_subscription_internal.subscription_core_writer_context(text, uuid, uuid, text)";
    const [configured] = await owner!<{ search_path: string }[]>`
      select substring(setting from length('search_path=') + 1) as search_path
      from pg_proc, unnest(proconfig) as setting
      where oid = ${neutralInternal}::regprocedure and setting like 'search_path=%'`;
    expect(configured?.search_path).toContain("pg_temp");
    await owner!.unsafe(`ALTER FUNCTION ${neutralInternal} SET search_path = public`);
    try {
      expect(await postureViolations()).toContain(
        "subscription owner implementation subscription_core_writer_context(text, uuid, uuid, text) is missing or unsafe",
      );
    } finally {
      await owner!.unsafe(
        `ALTER FUNCTION ${neutralInternal} SET search_path = ${configured!.search_path}`,
      );
    }
    expect(await postureViolations()).toEqual([]);
  }, 180_000);
});
