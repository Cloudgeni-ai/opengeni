import { expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireCanaryDatabase,
  NATIVE_CANARY_DATABASE_OPT_IN,
} from "./ope534-rotation-canary-database";

test("canary DB rejects a caller-supplied target before connecting", async () => {
  await expect(
    acquireCanaryDatabase({ OPENGENI_TEST_POSTGRES_ADMIN_URL: "postgres://remote/shared" }),
  ).rejects.toThrow("external database overrides");
  await expect(
    acquireCanaryDatabase({ OPENGENI_OPE534_NATIVE_POSTGRES: "staging" }),
  ).rejects.toThrow("LOCAL_DISPOSABLE_55434");
});

test.skipIf(process.env.OPENGENI_OPE534_NATIVE_POSTGRES !== NATIVE_CANARY_DATABASE_OPT_IN)(
  "OPE534 native fixture migrates unique DB, restricts app role, and cleans exact targets",
  async () => {
    const fixture = await acquireCanaryDatabase({
      OPENGENI_OPE534_NATIVE_POSTGRES: NATIVE_CANARY_DATABASE_OPT_IN,
    });
    const databaseName = new URL(fixture.adminUrl).pathname.slice(1);
    const app = postgres(fixture.appUrl, { max: 1 });
    try {
      expect(databaseName).toMatch(/^og_ope534_rotation_canary_[a-f0-9]{32}$/);
      const [identity] = await app`select current_user as login, current_database() as database,
        (select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb from pg_roles where rolname=current_user) as privileged`;
      expect(identity).toMatchObject({
        login: fixture.appRole,
        database: databaseName,
        privileged: false,
      });
      const [schema] = await fixture.admin`select count(*)::int as count from schema_migrations`;
      expect(schema!.count).toBeGreaterThan(490);
      const [rls] =
        await fixture.admin`select relrowsecurity,relforcerowsecurity from pg_class where oid='sandbox_leases'::regclass`;
      expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      // postgres-js queries are lazy thenables; give Bun's rejection matcher a
      // real Promise so the forbidden query actually executes.
      await expect(
        (async () => await app`select * from schema_migrations limit 1`)(),
      ).rejects.toThrow();
    } finally {
      await app.end();
      await fixture.release();
    }
    const root = postgres("postgres://postgres@127.0.0.1:55434/postgres", { max: 1 });
    try {
      const [remaining] =
        await root`select exists(select 1 from pg_database where datname=${databaseName}) as database,
        exists(select 1 from pg_roles where rolname=${fixture.appRole}) as role`;
      expect(remaining).toEqual({ database: false, role: false });
    } finally {
      await root.end();
    }
  },
  180_000,
);
