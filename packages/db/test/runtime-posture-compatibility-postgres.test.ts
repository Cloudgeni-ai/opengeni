import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { createDb, type DbClient } from "../src/database";
import {
  assertRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";
import {
  loadRuntimePostureBaseline,
  PRE_COMPATIBILITY_PRODUCTION_SOURCE,
  readRuntimePostureBaseline,
} from "../../../scripts/runtime-posture-baseline";

let database: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let baseline: Awaited<ReturnType<typeof loadRuntimePostureBaseline>> | null = null;
let preCompatibility: Awaited<ReturnType<typeof loadRuntimePostureBaseline>> | null = null;
const options = { rlsStrategy: "force" as const, targetSchema: "og_data" };

beforeAll(async () => {
  // Explicit opt-in avoids a silent successful no-DB run in the dedicated CI
  // job. The ordinary isolated unit runner may discover and skip this suite.
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  const root = resolve(import.meta.dir, "../../..");
  const pin = await readRuntimePostureBaseline(root);
  baseline = await loadRuntimePostureBaseline(root, pin.sourceCommit);
  preCompatibility = await loadRuntimePostureBaseline(root, PRE_COMPATIBILITY_PRODUCTION_SOURCE);
  console.log(
    `runtime posture baseline: ${pin.status} ${pin.sourceCommit} (${pin.release ?? "not yet a production release"})`,
  );
  database = await acquireRestrictedRuntimeTestDatabase(
    "posture-compatibility",
    options.targetSchema,
  );
  if (!database) throw new Error("Real PostgreSQL is required for previous-binary readiness");
  client = createDb(database.appUrl, { searchPath: database.schema, max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
  await baseline?.cleanup();
  await preCompatibility?.cleanup();
}, 180_000);

const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");

realTest(
  "pinned previous inspector AND evaluator accept all current migrations and role provisioning",
  async () => {
    await assertRuntimeDatabasePosture(client!.db, options);
    await baseline!.module.assertRuntimeDatabasePosture(client!.db, options);
  },
);

realTest(
  "reproduces the production bcc60cd8 upgrade rejection without broadening EXECUTE",
  async () => {
    const module = preCompatibility!.module;
    const posture = await module.inspectRuntimeDatabasePosture(client!.db, options);
    const failures = module.evaluateRuntimeDatabasePosture(posture, options);
    console.log("pre-compatibility production violations", JSON.stringify(failures));
    expect(failures.length).toBeGreaterThanOrEqual(42);
    for (const table of ["session_title_operations", "site_session_access"]) {
      expect(
        failures.some(
          (failure) =>
            failure.startsWith("RLS tables are absent from the declared contract:") &&
            failure.includes(table),
        ),
      ).toBe(true);
      expect(
        failures.some((failure) =>
          failure.startsWith(`table ${table} grants excess runtime privileges:`),
        ),
      ).toBe(true);
    }
    expect(
      failures.filter((failure) =>
        failure.startsWith("runtime role lacks EXECUTE on private routine "),
      ).length,
    ).toBeGreaterThanOrEqual(39);
    await assertRuntimeDatabasePosture(client!.db, options);

    // Replay those real catalog shapes under names neither compatibility
    // binary knows. Keep the originals: removing them would weaken the current
    // binary's named-object contract and would not simulate an additive change.
    const future = await inspectRuntimeDatabasePosture(client!.db, options);
    for (const name of ["session_title_operations", "site_session_access"]) {
      const table = future.tables.find((entry) => entry.name === name)!;
      future.tables.push({ ...table, name: `future_${name}` });
    }
    for (const failure of failures) {
      const prefix = "runtime role lacks EXECUTE on private routine ";
      if (!failure.startsWith(prefix)) continue;
      const name = failure.slice(prefix.length);
      const routine = future.privateRoutines.find((entry) => entry.name === name)!;
      expect(routine.execute).toBe(false);
      future.privateRoutines.push({ ...routine, name: `future_${name}` });
    }
    expect(evaluateRuntimeDatabasePosture(future, options)).toEqual([]);
    expect(baseline!.module.evaluateRuntimeDatabasePosture(future, options)).toEqual([]);
  },
);

realTest(
  "both binaries admit additive safe objects and reject catalog-level regressions",
  async () => {
    const admin = database!.admin;
    const owner = database!.ownerRole;
    const evaluators = [
      { inspectRuntimeDatabasePosture, evaluateRuntimeDatabasePosture },
      baseline!.module,
    ];
    const violations = async () =>
      Promise.all(
        evaluators.map(async (module) =>
          module.evaluateRuntimeDatabasePosture(
            await module.inspectRuntimeDatabasePosture(client!.db, options),
            options,
          ),
        ),
      );
    const expectReady = async () => {
      for (const result of await violations()) expect(result).toEqual([]);
    };
    const expectUnready = async (fragment: string) => {
      for (const result of await violations())
        expect(result.some((message) => message.includes(fragment))).toBe(true);
    };
    try {
      await admin.unsafe(`
      SET ROLE "${owner}";
      CREATE TABLE future_posture_rows (id integer PRIMARY KEY);
      ALTER TABLE future_posture_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE future_posture_rows FORCE ROW LEVEL SECURITY;
      CREATE POLICY future_posture_deny ON future_posture_rows USING (false);
      GRANT SELECT, INSERT, UPDATE, DELETE ON future_posture_rows TO opengeni_app;
      CREATE TABLE future_owner_only_rows (id integer);
      REVOKE ALL ON future_owner_only_rows FROM opengeni_app, PUBLIC;
      CREATE FUNCTION future_posture_invoker() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION opengeni_private.future_posture_invoker() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION opengeni_private.future_posture_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT 1';
      REVOKE ALL ON FUNCTION opengeni_private.future_posture_definer() FROM opengeni_app, PUBLIC;
      RESET ROLE;
    `);
      await expectReady();
      // FORCE RLS actually binds the runtime, not merely catalog flags.
      const rows = await client!.db.execute(
        (await import("drizzle-orm")).sql`select * from future_posture_rows`,
      );
      expect(Array.from(rows as unknown as unknown[])).toEqual([]);

      await admin`ALTER TABLE future_posture_rows NO FORCE ROW LEVEL SECURITY`;
      await expectUnready("future_posture_rows");
      await admin`ALTER TABLE future_posture_rows FORCE ROW LEVEL SECURITY`;
      await admin`DROP POLICY future_posture_deny ON future_posture_rows`;
      await expectUnready("future_posture_rows");
      await admin`CREATE POLICY future_posture_deny ON future_posture_rows USING (false)`;
      await admin`ALTER TABLE future_posture_rows DISABLE ROW LEVEL SECURITY`;
      await expectUnready("future_posture_rows");
      await admin`ALTER TABLE future_posture_rows ENABLE ROW LEVEL SECURITY`;

      await admin`GRANT SELECT (id) ON future_owner_only_rows TO opengeni_app`;
      await expectUnready("future_owner_only_rows grants excess");
      await admin`REVOKE SELECT (id) ON future_owner_only_rows FROM opengeni_app`;
      await admin`ALTER TABLE future_posture_rows OWNER TO opengeni_app`;
      await expectUnready("runtime role owns");
      await admin.unsafe(`ALTER TABLE future_posture_rows OWNER TO "${owner}"`);

      await admin`GRANT EXECUTE ON FUNCTION opengeni_private.future_posture_definer() TO opengeni_app`;
      await expectUnready("exposes SECURITY DEFINER execution");
      await admin`REVOKE EXECUTE ON FUNCTION opengeni_private.future_posture_definer() FROM opengeni_app`;
      await admin`ALTER FUNCTION future_posture_invoker() SECURITY DEFINER`;
      await expectUnready("exposes SECURITY DEFINER execution");
      await admin`ALTER FUNCTION future_posture_invoker() SECURITY INVOKER`;
      await admin`ALTER FUNCTION opengeni_private.future_posture_invoker() OWNER TO opengeni_app`;
      await expectUnready("runtime role owns");
      await admin.unsafe(
        `ALTER FUNCTION opengeni_private.future_posture_invoker() OWNER TO "${owner}"`,
      );

      // Negative controls prove neither current nor pinned binary silently skips
      // the exact known-object checks while allowing unrelated additions.
      await admin`ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY`;
      await expectUnready("table sessions does not FORCE RLS");
      await admin`ALTER TABLE sessions FORCE ROW LEVEL SECURITY`;
      await admin`REVOKE EXECUTE ON FUNCTION opengeni_private.current_account_id() FROM opengeni_app, PUBLIC`;
      await expectUnready("runtime role lacks EXECUTE on private routine current_account_id()");
      await admin`GRANT EXECUTE ON FUNCTION opengeni_private.current_account_id() TO opengeni_app`;
      await expectReady();
    } finally {
      await admin.unsafe(`
      RESET ROLE;
      DROP TABLE IF EXISTS future_posture_rows, future_owner_only_rows;
      DROP FUNCTION IF EXISTS future_posture_invoker(), opengeni_private.future_posture_invoker(), opengeni_private.future_posture_definer();
    `);
    }
  },
  180_000,
);
