import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
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

realTest("readiness inspects both namespaces once without caching posture", async () => {
  const driver = (client!.db as unknown as { $client: postgres.Sql }).$client;
  const originalDebug = driver.options.debug;
  try {
    // Warm the driver before counting protocol statements.
    await assertRuntimeDatabasePosture(client!.db, options);
    for (let attempt = 0; attempt < 2; attempt++) {
      const statements: string[] = [];
      driver.options.debug = (_connection, query) => statements.push(query);
      const posture = await assertRuntimeDatabasePosture(client!.db, options);
      expect(posture.tables.length).toBeGreaterThan(0);
      expect(posture.privateTables.length).toBeGreaterThan(0);
      expect(posture.targetRoutines.length).toBeGreaterThan(0);
      expect(posture.privateRoutines.length).toBeGreaterThan(0);
      expect(statements).toHaveLength(13);
      expect(
        statements.filter((query) => query.includes("row_security_active(c.oid)")),
      ).toHaveLength(1);
      expect(statements.filter((query) => query.includes("as trigger_callable"))).toHaveLength(1);
    }
  } finally {
    driver.options.debug = originalDebug;
  }
});

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
    const unsafeTriggerNames: string[] = [];
    for (const failure of failures) {
      const prefix = "runtime role lacks EXECUTE on private routine ";
      if (!failure.startsWith(prefix)) continue;
      const name = failure.slice(prefix.length);
      const routine = future.privateRoutines.find((entry) => entry.name === name)!;
      expect(routine.execute).toBe(false);
      const renamed = { ...routine, name: `future_${name}` };
      if (routine.securityDefiner && (routine.triggerCallable || routine.hasDependents)) {
        // Revoked EXECUTE does not prevent trigger invocation. These additions
        // require an explicit compatibility contract; never widen their ACLs.
        unsafeTriggerNames.push(renamed.name);
      } else {
        future.privateRoutines.push(renamed);
      }
    }
    expect(evaluateRuntimeDatabasePosture(future, options)).toEqual([]);
    expect(baseline!.module.evaluateRuntimeDatabasePosture(future, options)).toEqual([]);
    console.log(
      "production owner-only trigger definers still require a prior contract",
      unsafeTriggerNames,
    );
    for (const name of unsafeTriggerNames) {
      const original = future.privateRoutines.find((r) => `future_${r.name}` === name)!;
      const unsafe = {
        ...future,
        privateRoutines: [...future.privateRoutines, { ...original, name }],
      };
      for (const evaluator of [{ evaluateRuntimeDatabasePosture }, baseline!.module]) {
        expect(evaluator.evaluateRuntimeDatabasePosture(unsafe, options)).toContain(
          `unknown routine opengeni_private.${name} exposes SECURITY DEFINER execution`,
        );
      }
    }
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
      const [server] = await admin<{ version: number }[]>`
        SELECT current_setting('server_version_num')::integer AS version`;
      // Broad CI also runs PostgreSQL 16; MAINTAIN was introduced in 17.
      // The dedicated PG17 readiness job still exercises its rejection.
      const nonRowPrivileges = ["TRUNCATE", "REFERENCES", "TRIGGER"];
      if (server!.version >= 170000) nonRowPrivileges.push("MAINTAIN");
      for (const privilege of nonRowPrivileges) {
        await admin.unsafe(`GRANT ${privilege} ON future_posture_rows TO opengeni_app`);
        await expectUnready(`future_posture_rows grants excess runtime privileges: ${privilege}`);
        await admin.unsafe(`REVOKE ${privilege} ON future_posture_rows FROM opengeni_app`);
      }
      await admin`GRANT REFERENCES (id) ON future_posture_rows TO opengeni_app`;
      await expectUnready("future_posture_rows grants excess runtime privileges: REFERENCES");
      await admin`REVOKE REFERENCES (id) ON future_posture_rows FROM opengeni_app`;

      await admin.unsafe(`SET ROLE "${owner}";
        CREATE TABLE future_parent ();
        ALTER TABLE future_parent ENABLE ROW LEVEL SECURITY;
        ALTER TABLE future_parent FORCE ROW LEVEL SECURITY;
        CREATE POLICY future_parent_any ON future_parent USING (true);
        GRANT SELECT, DELETE ON future_parent TO opengeni_app;
        ALTER TABLE deployment_model_catalog INHERIT future_parent;
        RESET ROLE;`);
      await expectUnready("future_parent");
      await admin`ALTER TABLE deployment_model_catalog NO INHERIT future_parent`;
      await admin`DROP TABLE future_parent`;

      for (const schema of [options.targetSchema, "opengeni_private"]) {
        await admin.unsafe(`SET ROLE "${owner}";
          CREATE TABLE ${schema}.future_hidden_child () INHERITS (deployment_model_catalog);
          REVOKE ALL ON ${schema}.future_hidden_child FROM opengeni_app, PUBLIC;
          RESET ROLE;`);
        await expectUnready("future_hidden_child has an inheritance or partition relationship");
        await admin.unsafe(`DROP TABLE ${schema}.future_hidden_child`);
      }

      // Partition attachment has the same parent-only ACL/RLS semantics.
      await admin.unsafe(`SET ROLE "${owner}";
        CREATE TABLE future_partition_parent(id integer) PARTITION BY RANGE(id);
        CREATE TABLE future_partition_child PARTITION OF future_partition_parent FOR VALUES FROM (0) TO (10);
        ALTER TABLE future_partition_parent ENABLE ROW LEVEL SECURITY;
        ALTER TABLE future_partition_parent FORCE ROW LEVEL SECURITY;
        CREATE POLICY future_partition_any ON future_partition_parent USING (true);
        RESET ROLE;`);
      await expectUnready("future_partition_parent");
      await admin`DROP TABLE future_partition_parent CASCADE`;

      await admin.unsafe(`SET ROLE "${owner}";
        CREATE FUNCTION opengeni_private.future_posture_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END';
        REVOKE ALL ON FUNCTION opengeni_private.future_posture_trigger() FROM PUBLIC, opengeni_app;
        CREATE TRIGGER future_posture_trigger BEFORE INSERT ON future_posture_rows FOR EACH ROW EXECUTE FUNCTION opengeni_private.future_posture_trigger();
        RESET ROLE;`);
      await expectUnready("future_posture_trigger() exposes SECURITY DEFINER execution");
      await admin`DROP TRIGGER future_posture_trigger ON future_posture_rows`;
      // A currently unattached trigger is still callable without an ACL change.
      await expectUnready("future_posture_trigger() exposes SECURITY DEFINER execution");
      await admin`DROP FUNCTION opengeni_private.future_posture_trigger()`;

      await admin.unsafe(`SET ROLE "${owner}";
        CREATE FUNCTION opengeni_private.future_posture_sfunc(state text, value integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS 'BEGIN RETURN current_user::text; END';
        REVOKE ALL ON FUNCTION opengeni_private.future_posture_sfunc(text, integer) FROM PUBLIC, opengeni_app;
        CREATE AGGREGATE opengeni_private.future_posture_aggregate(integer) (sfunc=opengeni_private.future_posture_sfunc, stype=text);
        RESET ROLE;`);
      await expectUnready("future_posture_sfunc(text, integer) exposes SECURITY DEFINER execution");
      const { sql } = await import("drizzle-orm");
      await expect(
        Promise.resolve(
          client!.db.execute(sql`SELECT opengeni_private.future_posture_sfunc('x', 1)`),
        ),
      ).rejects.toThrow();
      // PostgreSQL checks EXECUTE on the aggregate, not its support function.
      const aggregateRows = await client!.db.execute(
        sql`SELECT opengeni_private.future_posture_aggregate(1) AS owner`,
      );
      expect(Array.from(aggregateRows as unknown as { owner: string }[])[0]?.owner).toBe(owner);
      await admin`DROP AGGREGATE opengeni_private.future_posture_aggregate(integer)`;
      await expectReady();
      await admin`DROP FUNCTION opengeni_private.future_posture_sfunc(text, integer)`;

      for (const name of [
        "subscription_plan_catalog_revisions",
        "credit_promotion_policy_revisions",
        "slack_file_upload_operations",
      ]) {
        const [column] =
          await admin`select a.attname from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='opengeni_private' and c.relname=${name} and a.attnum=1`;
        const quotedColumn = `"${String(column!.attname).replaceAll('"', '""')}"`;
        await admin.unsafe(
          `REVOKE SELECT ON opengeni_private.${name} FROM opengeni_app; GRANT SELECT (${quotedColumn}) ON opengeni_private.${name} TO opengeni_app`,
        );
        await expectUnready(
          name === "subscription_plan_catalog_revisions"
            ? "cannot read the subscription plan catalog"
            : name === "credit_promotion_policy_revisions"
              ? "cannot read the credit promotion policy"
              : "unsafe Slack file upload ledger privileges",
        );
        await admin.unsafe(
          `REVOKE SELECT (${quotedColumn}) ON opengeni_private.${name} FROM opengeni_app; GRANT SELECT ON opengeni_private.${name} TO opengeni_app`,
        );
      }
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
      DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = 'deployment_model_catalog'::regclass AND inhparent = to_regclass('future_parent')) THEN ALTER TABLE deployment_model_catalog NO INHERIT future_parent; END IF; END $$;
      DROP TABLE IF EXISTS future_posture_rows, future_owner_only_rows, future_parent, future_partition_parent CASCADE;
      DROP TABLE IF EXISTS future_hidden_child, opengeni_private.future_hidden_child;
      DROP AGGREGATE IF EXISTS opengeni_private.future_posture_aggregate(integer);
      DROP FUNCTION IF EXISTS opengeni_private.future_posture_sfunc(text, integer);
      DROP FUNCTION IF EXISTS future_posture_invoker(), opengeni_private.future_posture_invoker(), opengeni_private.future_posture_definer(), opengeni_private.future_posture_trigger();
    `);
    }
  },
  180_000,
);
