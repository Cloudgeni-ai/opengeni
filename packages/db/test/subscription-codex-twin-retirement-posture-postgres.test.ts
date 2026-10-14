// The Codex-named twins of the migration 0707 neutral routines after the
// drained retirement (design docs/design/subscription-core-2026-10-07.md, 5.3
// "R. Retirement"; migration SUBSCRIPTION_RETIREMENT_MIGRATION). On a real,
// fully migrated database whose owner is NOSUPERUSER and NOBYPASSRLS, the
// twins and the owner-only internals only they called are gone, the runtime
// posture of this release requires them absent and is clean as the restricted
// application role, and the owner-implementation checks keep running without
// the Codex twin writers.
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
  retiredSubscriptionObjectViolation,
  SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { SUBSCRIPTION_M3_PRECURSOR_PRIVATE_ROUTINES } from "../src/runtime-posture";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const options = {
  rlsStrategy: "force" as const,
  expectedRole: "opengeni_app",
  targetSchema: "public",
};
/**
 * The twins' owner-only internals (the writer context four twins called and
 * the connection target) and 0689's Codex auto-assignment apply path, which
 * nothing called after 0713.
 */
const TWIN_OWNER_ROUTINES = [
  "opengeni_subscription_internal.subscription_codex_writer_context(uuid, uuid, text)",
  "opengeni_private.subscription_codex_connection_target(uuid, uuid, uuid, uuid, uuid, text, bigint)",
  "opengeni_private.apply_subscription_codex_auto_assignments(uuid, uuid, boolean)",
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

describe.skipIf(!realDb)("the retired Codex twin routines (M4 step R)", () => {
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

  test("the retirement dropped every twin, its owner-only internals and every overload of their names", async () => {
    for (const signature of twinSignatures) {
      const [found] = await database!.admin<{ present: boolean }[]>`
        select to_regprocedure(${signature}) is not null as present`;
      expect({ signature, ...found }).toEqual({ signature, present: false });
    }
    const names = twinSignatures.map((signature) =>
      signature.slice(signature.indexOf(".") + 1, signature.indexOf("(")),
    );
    const [left] = await database!.admin<{ total: number }[]>`
      select count(*)::int as total from pg_proc where proname = any(${names}::text[])`;
    expect(left!.total).toBe(0);
  }, 180_000);

  test("every subscription_codex private routine the application role can execute is still required", async () => {
    // With the twins gone, a runtime-executable M3 Codex routine is one the
    // posture requires: none goes unchecked. The pre-core Codex factory
    // helpers (every Codex-named routine without "subscription_codex" in its
    // name) belong to the retained legacy Codex tables and are outside this
    // step.
    const executable = await app!<{ name: string }[]>`
      select p.proname || '(' || array_to_string(array(
          select format_type(argument.type, null)
          from unnest(p.proargtypes::oid[]) with ordinality as argument(type, position)
          order by argument.position), ', ') || ')' as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private'
        and p.proname like '%subscription\\_codex%'
        and has_function_privilege(p.oid, 'EXECUTE')
      order by 1`;
    const required = new Set<string>(SUBSCRIPTION_M3_PRECURSOR_PRIVATE_ROUTINES);
    expect(executable.length).toBeGreaterThan(0);
    expect(executable.map(({ name }) => name).filter((name) => !required.has(name))).toEqual([]);
  }, 180_000);

  test("a twin created again by hand fails the posture until it is dropped", async () => {
    const twin = "subscription_codex_reach(uuid, uuid)";
    expect(SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES).toContain(twin);
    await owner!.unsafe(
      `CREATE FUNCTION opengeni_private.subscription_codex_reach(uuid, uuid) RETURNS boolean
        LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS 'SELECT false'`,
    );
    try {
      expect(await postureViolations()).toEqual([
        retiredSubscriptionObjectViolation(`routine opengeni_private.${twin}`),
      ]);
    } finally {
      await owner!.unsafe(`DROP FUNCTION opengeni_private.${twin}`);
    }
    expect(await postureViolations()).toEqual([]);
  }, 180_000);

  test("the owner-implementation checks keep running without the Codex twin writers", async () => {
    // Readiness of this release, before and after provisioning roles again.
    expect(await postureViolations()).toEqual([]);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });
    expect(await postureViolations()).toEqual([]);

    // The neutral writers' owner-only internals are still checked for their
    // fixed search path (only the owner-implementation check looks at it).
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
