import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { executeMigrationFile, migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const maintenance = "0730_maintenance_work_probes.sql";
const personal = "0730_subscription_core_personal_connection_versions.sql";
const pair = [maintenance, personal];
const options = { applicationDatabaseRoles: ["opengeni_app"] };
const routines = [
  "session_workflow_wakes_due_v1",
  "automatic_session_title_fanout_due_v1",
  "knowledge_index_due_v1",
  "site_auth_maintenance_due_v1",
  "subscription_core_personal_connection_versions",
];

async function snapshot(sql: postgres.Sql) {
  return {
    receipts: await sql`SELECT name, applied_at::text FROM schema_migrations ORDER BY name`,
    routines: await sql`SELECT p.oid::text, p.proname, p.proowner::text,
      p.proacl::text, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'opengeni_private' AND p.proname = ANY(${routines}::text[])
      ORDER BY p.proname`,
  };
}

for (const history of ["fresh", "neither", "personal", "maintenance", "both"] as const) {
  test(`published 0730 filename histories: ${history}, upgrade and no-op replay`, async () => {
    const database = await acquireOwnerMigratedTestDatabase(`published-0730-${history}`);
    if (!database) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
      return;
    }
    const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
    let app: postgres.Sql | undefined;
    try {
      expect(
        await owner`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      ).toMatchObject([{ rolsuper: false, rolbypassrls: false }]);
      if (history !== "fresh") {
        // Build the actual pre-0730 schema without rewriting SQL on disk. These
        // temporary withholding stamps are removed before constructing history.
        await owner`CREATE TABLE schema_migrations(name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now())`;
        await owner`INSERT INTO schema_migrations(name) SELECT unnest(${pair}::text[])`;
        await migrate(database.ownerUrl, undefined, options);
        await owner`DELETE FROM schema_migrations WHERE name = ANY(${pair}::text[])`;
        expect((await snapshot(owner)).routines).toHaveLength(0);
        await owner`SELECT set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
        // The real main upgrade saw personal first, then maintenance (opposite
        // lexical order). Also qualify each single-applied state independently.
        const applied =
          history === "both"
            ? [personal, maintenance]
            : history === "personal"
              ? [personal]
              : history === "maintenance"
                ? [maintenance]
                : [];
        for (const file of applied) {
          await executeMigrationFile(
            owner,
            file,
            await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
          );
          await owner`INSERT INTO schema_migrations(name) VALUES(${file})`;
        }
      }
      const before = history === "fresh" ? undefined : await snapshot(owner);
      await migrate(database.ownerUrl, undefined, options);
      const upgraded = await snapshot(owner);
      expect(upgraded.receipts.filter((row) => pair.includes(row.name))).toHaveLength(2);
      expect(upgraded.routines).toHaveLength(5);
      for (const receipt of before?.receipts ?? []) {
        expect(upgraded.receipts.find((row) => row.name === receipt.name)).toEqual(receipt);
      }
      for (const routine of before?.routines ?? []) {
        expect(upgraded.routines.find((row) => row.proname === routine.proname)).toEqual(routine);
      }
      await migrate(database.ownerUrl, undefined, options);
      expect(await snapshot(owner)).toEqual(upgraded);

      await owner.end();
      await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
      const url = new URL(database.adminUrl);
      url.username = "opengeni_app";
      url.password = database.appPassword;
      app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
      expect(
        await app`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      ).toMatchObject([{ rolsuper: false, rolbypassrls: false }]);
      expect(
        await app`SELECT opengeni_private.session_workflow_wakes_due_v1() AS due`,
      ).toMatchObject([{ due: false }]);
      expect(
        await app`SELECT opengeni_private.automatic_session_title_fanout_due_v1() AS due`,
      ).toMatchObject([{ due: false }]);
      expect(
        await app`SELECT opengeni_private.knowledge_index_due_v1('test', 3) AS due`,
      ).toMatchObject([{ due: false }]);
      expect(
        await app`SELECT opengeni_private.site_auth_maintenance_due_v1(600000) AS due`,
      ).toMatchObject([{ due: false }]);
      expect(
        await app`SELECT p.proname,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
        has_function_privilege(current_user, p.oid, 'EXECUTE') AS app_execute,
        p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS app_owns
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'opengeni_private' AND p.proname = ANY(${routines}::text[])
        ORDER BY p.proname`,
      ).toEqual(
        routines.toSorted().map((proname) => ({
          proname,
          public_execute: false,
          app_execute: true,
          app_owns: false,
        })),
      );
    } finally {
      await app?.end();
      await owner.end();
      await database.release();
    }
  }, 180_000);
}
