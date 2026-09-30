import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireBlankTestDatabase, acquireOwnerMigratedTestDatabase } from "../src/shared-pg";

const nativeTest = process.env.OPENGENI_TEST_PG_ADMIN_URL ? test : test.skip;

test("explicit native configuration rejects malformed, remote, and unpinned endpoints", async () => {
  const moduleUrl = new URL("../src/shared-pg.ts", import.meta.url).href;
  for (const url of [
    "",
    "https://127.0.0.1:61440/postgres",
    "postgres://postgres:x@database.example:61440/postgres",
    "postgres://postgres:x@127.0.0.1/postgres",
    "postgres://127.0.0.1:61440/postgres",
  ]) {
    const child = Bun.spawn(
      [process.execPath, "-e", `await import(${JSON.stringify(moduleUrl)})`],
      {
        env: { ...process.env, OPENGENI_TEST_PG_ADMIN_URL: url },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("shared-pg: OPENGENI_TEST_PG_ADMIN_URL");
    expect(stderr).not.toContain("docker");
  }
});

nativeTest(
  "native blank acquisition is pristine, authenticates the app role, and releases exactly once",
  async () => {
    const fixture = await acquireBlankTestDatabase("native-blank-contract");
    expect(fixture).not.toBeNull();
    if (!fixture) throw new Error("explicit native PostgreSQL must not skip");
    const url = new URL(fixture.databaseUrl);
    const configured = new URL(process.env.OPENGENI_TEST_PG_ADMIN_URL!);
    expect(url.host).toBe(configured.host);
    expect(url.search).toBe(configured.search);
    const admin = postgres(fixture.databaseUrl, { max: 1 });
    url.username = "opengeni_app";
    url.password = fixture.appPassword!;
    const app = postgres(url.href, { max: 1 });
    try {
      const [schema] = await admin`
        SELECT to_regclass('public.schema_migrations') AS migrations`;
      expect(schema!.migrations).toBeNull();
      const [role] = await app`
        SELECT current_user, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({
        current_user: "opengeni_app",
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      await admin`CREATE TABLE native_blank_probe (id integer PRIMARY KEY)`;
      await admin`INSERT INTO native_blank_probe VALUES (1)`;
      const [probe] = await admin`SELECT id FROM native_blank_probe`;
      expect(probe!.id).toBe(1);
    } finally {
      await app.end();
      await admin.end();
      await fixture.release();
      await fixture.release();
    }
    const root = postgres(process.env.OPENGENI_TEST_PG_ADMIN_URL!, { max: 1 });
    try {
      const [remaining] = await root`
        SELECT count(*)::integer AS count FROM pg_database
        WHERE datname = ${url.pathname.slice(1)}`;
      expect(remaining!.count).toBe(0);
    } finally {
      await root.end();
    }
  },
  180_000,
);

nativeTest(
  "native owner acquisition preinstalls extensions and enforces FORCE RLS on the owner",
  async () => {
    const fixture = await acquireOwnerMigratedTestDatabase("native-owner-contract");
    expect(fixture).not.toBeNull();
    if (!fixture) throw new Error("explicit native PostgreSQL must not skip");
    const owner = postgres(fixture.ownerUrl, { max: 1 });
    try {
      const [role] = await owner`
        SELECT current_user, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
        FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({
        current_user: fixture.ownerRole,
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const extensions = await owner`
        SELECT extname FROM pg_extension
        WHERE extname IN ('pgcrypto', 'vector') ORDER BY extname`;
      expect(extensions.map((row) => row.extname)).toEqual(["pgcrypto", "vector"]);
      const [vector] = await owner`
        SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance`;
      expect(vector!.distance).toBe(1);
      await owner`CREATE TABLE native_owner_probe (id integer PRIMARY KEY)`;
      await fixture.admin`INSERT INTO native_owner_probe VALUES (1)`;
      await owner`ALTER TABLE native_owner_probe ENABLE ROW LEVEL SECURITY`;
      await owner`ALTER TABLE native_owner_probe FORCE ROW LEVEL SECURITY`;
      const [hidden] = await owner`SELECT count(*)::integer AS count FROM native_owner_probe`;
      const [groundTruth] = await fixture.admin`
        SELECT count(*)::integer AS count FROM native_owner_probe`;
      expect(hidden!.count).toBe(0);
      expect(groundTruth!.count).toBe(1);
    } finally {
      await owner.end();
      await fixture.release();
      await fixture.release();
    }
    const root = postgres(process.env.OPENGENI_TEST_PG_ADMIN_URL!, { max: 1 });
    try {
      const [remaining] = await root`
        SELECT count(*)::integer AS count FROM pg_roles WHERE rolname = ${fixture.ownerRole}`;
      expect(remaining!.count).toBe(0);
    } finally {
      await root.end();
    }
  },
  180_000,
);
