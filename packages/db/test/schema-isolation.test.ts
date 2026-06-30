import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { migrate, runMigrations } from "../src/migrate";

// Step I (§7.7 + §7.8 runtime half) — schema-isolation re-confirmation (SPIKE-1
// F1, productized). Proves the embedded dedicated-schema path through the REAL
// `migrate()` SDK entry point:
//
//   1. `migrate(DB_URL, "opengeni")` lands EVERY table + RLS policy in the
//      dedicated `opengeni` schema, with ZERO leaking into `public`, via the
//      connection search_path + the `current_schema()` policy guards — NO
//      pgTable rewrite and NO per-statement SQL rewrite.
//   2. Re-running the chain under the SAME dedicated schema is IDEMPOTENT — the
//      load-bearing `current_schema()` guard fix (a `'public'`-pinned guard
//      would fail re-run with "policy ... already exists"; this is the Fork-6
//      silent-failure hazard the substitution closes).
//   3. The opengeni_private SECURITY-DEFINER helpers exist (RLS GUC readers).
//   4. STANDALONE (`migrate(DB_URL)` with no schema) keeps everything in
//      `public` — byte-for-byte today's behavior, run on a SECOND fresh db so
//      the two paths don't interfere.
//
// One throwaway pgvector container, torn down with the test (NEVER a persistent
// default-port stack). Non-default port. Assertions run as superuser (the
// opengeni_app GRANTs are IF EXISTS-guarded, so no role provisioning needed).

const CONTAINER = "ogbuild-pg-schema-iso";
const PORT = 55471;
const PASSWORD = "x";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg17";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn(`[schema-isolation] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
  // A second logical database for the standalone (public) leg so it can't
  // interfere with the dedicated-schema leg's "0 tables in public" assertion.
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE standalone_public`);
  } finally {
    await admin.end();
  }
}, 120_000);

afterAll(() => {
  removeContainer();
});

function publicUrl(database: string): string {
  return `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/${database}`;
}

describe("Step I — embedded dedicated-schema isolation (SPIKE-1 F1, productized)", () => {
  test("migrate(url, 'opengeni') isolates all tables + policies into the dedicated schema, idempotently; standalone stays in public", async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn("[schema-isolation] skipped (docker not available)");
      return;
    }

    // --- EMBEDDED leg: dedicated schema via the SDK entry point.
    // Run TWICE to prove idempotency under the current_schema() guards.
    await migrate(ADMIN_URL, "opengeni");
    await runMigrations(ADMIN_URL, "opengeni"); // second pass via the named SDK alias — must be a clean no-op.

    const sql = postgres(ADMIN_URL, { max: 1 });
    try {
      const tablesInOpengeni = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'opengeni'`;
      const tablesInPublic = await sql<{ name: string }[]>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
        ORDER BY table_name`;

      // Every OpenGeni table landed in the dedicated schema, none in public.
      expect(tablesInOpengeni[0]!.count).toBeGreaterThan(30);
      expect(tablesInPublic.map((r) => r.name)).toEqual([]);

      // Every RLS policy is scoped to the dedicated schema, none in public.
      const policiesInOpengeni = (await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'opengeni'`)[0]!.count;
      const policiesInPublic = (await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'`)[0]!.count;
      expect(policiesInOpengeni).toBeGreaterThan(20);
      expect(policiesInPublic).toBe(0);

      // The opengeni_private RLS GUC-reader helpers exist (SECURITY DEFINER).
      const privateFns = (await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'opengeni_private'`)[0]!.count;
      expect(privateFns).toBeGreaterThan(0);

      // RLS is enabled + FORCED on a representative table in the dedicated schema.
      const rls = (await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'opengeni' AND c.relname = 'sessions'`)[0]!;
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(true);
    } finally {
      await sql.end();
    }

    // --- STANDALONE leg: no schema → public, byte-for-byte today's behavior.
    await migrate(publicUrl("standalone_public"));
    const pub = postgres(publicUrl("standalone_public"), { max: 1 });
    try {
      const tablesInPublic = (await pub<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public'`)[0]!.count;
      const opengeniSchemaExists = (await pub<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'opengeni') AS exists`)[0]!.exists;
      expect(tablesInPublic).toBeGreaterThan(30);
      expect(opengeniSchemaExists).toBe(false);
    } finally {
      await pub.end();
    }
  }, 120_000);
});
