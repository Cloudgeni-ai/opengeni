import { expect, test } from "bun:test";
import postgres from "postgres";
import { createDb } from "@opengeni/db";
import { supervisedCommandProtocolReady } from "@opengeni/db/retained-provider-commands";
import {
  acquireCanaryDatabase,
  NATIVE_CANARY_DATABASE_OPT_IN,
  requireCanaryDatabaseAttribution,
} from "./sandbox-rotation-canary-database";
import { withCanaryFixture } from "./sandbox-rotation-canary-cleanup";

test("live attribution accepts only the exact disposable local database shape", () => {
  const valid = `postgres://postgres@127.0.0.1:55434/og_rotation_canary_${"a".repeat(32)}`;
  expect(() => requireCanaryDatabaseAttribution(valid)).not.toThrow();
  for (const invalid of [
    valid.replace("127.0.0.1", "example.invalid"),
    valid.replace("55434", "5432"),
    valid.replace("postgres@", "application@"),
    valid.replace("og_rotation_canary_", "other_fixture_"),
    valid.slice(0, -1),
    `${valid}extra`,
    `${valid}?options=unsafe`,
    `${valid}#fragment`,
  ])
    expect(() => requireCanaryDatabaseAttribution(invalid)).toThrow(
      "unexpected database attribution",
    );
});

test("canary DB rejects a caller-supplied target before connecting", async () => {
  await expect(
    acquireCanaryDatabase({ OPENGENI_TEST_POSTGRES_ADMIN_URL: "postgres://remote/shared" }),
  ).rejects.toThrow("external database overrides");
  await expect(
    acquireCanaryDatabase({ OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES: "staging" }),
  ).rejects.toThrow("LOCAL_DISPOSABLE_55434");
});

test("canary DB rejects Docker fallback even with ambient role credentials", async () => {
  await expect(
    acquireCanaryDatabase({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      OPENGENI_ARTIFACT_MATERIALIZER_DATABASE_PASSWORD: "unused-test-value",
      OPENGENI_ARTIFACT_OUTBOX_DATABASE_PASSWORD: "unused-test-value",
      OPENGENI_HOST_EXPORT_DATABASE_PASSWORD: "unused-test-value",
      OPENGENI_TEMPORAL_DATABASE_PASSWORD: "unused-test-value",
    }),
  ).rejects.toThrow("LOCAL_DISPOSABLE_55434");
  await expect(acquireCanaryDatabase({})).rejects.toThrow("LOCAL_DISPOSABLE_55434");
});

test.skipIf(
  process.env.OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES !== NATIVE_CANARY_DATABASE_OPT_IN,
)(
  "Sandbox rotation native fixture migrates unique DB, restricts app role, and cleans exact targets",
  async () => {
    const { databaseName, appRole } = await withCanaryFixture(
      () =>
        acquireCanaryDatabase({
          OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES: NATIVE_CANARY_DATABASE_OPT_IN,
        }),
      async (fixture, defer) => {
        expect(() => requireCanaryDatabaseAttribution(fixture.adminUrl)).not.toThrow();
        const fixtureDatabaseName = new URL(fixture.adminUrl).pathname.slice(1);
        const app = postgres(fixture.appUrl, { max: 1 });
        defer("fixture test app client", () => app.end());
        const client = createDb(fixture.appUrl);
        defer("readiness test client", () => client.close());
        expect(fixtureDatabaseName).toMatch(/^og_rotation_canary_[a-f0-9]{32}$/);
        const [identity] = await app`select current_user as login, current_database() as database,
        (select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb from pg_roles where rolname=current_user) as privileged`;
        expect(identity).toMatchObject({
          login: fixture.appRole,
          database: fixtureDatabaseName,
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
        // Exercise the actual prevention readiness API under the restricted app
        // login. The altered trigger belongs only to this disposable database.
        expect(await supervisedCommandProtocolReady(client.db)).toBe(true);
        await fixture.admin`alter table sandbox_lease_holders disable trigger supervised_command_holder_guard`;
        try {
          expect(await supervisedCommandProtocolReady(client.db)).toBe(false);
        } finally {
          await fixture.admin`alter table sandbox_lease_holders enable trigger supervised_command_holder_guard`;
        }
        expect(await supervisedCommandProtocolReady(client.db)).toBe(true);
        return { databaseName: fixtureDatabaseName, appRole: fixture.appRole };
      },
    );
    const root = postgres("postgres://postgres@127.0.0.1:55434/postgres", { max: 1 });
    try {
      const [remaining] =
        await root`select exists(select 1 from pg_database where datname=${databaseName}) as database,
        exists(select 1 from pg_roles where rolname=${appRole}) as role`;
      expect(remaining).toEqual({ database: false, role: false });
    } finally {
      await root.end();
    }
  },
  180_000,
);
