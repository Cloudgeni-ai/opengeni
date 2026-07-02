import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";

/** A bare Postgres identifier (schema/role name) safe to interpolate into DDL. */
function assertIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} is not a valid Postgres identifier: ${value}`);
  }
  return value;
}

/**
 * Apply the OpenGeni SQL migration chain.
 *
 * STANDALONE (default, unchanged): `migrate()` / `migrate(databaseUrl)` runs the
 * whole chain with NO search_path manipulation, so every unqualified
 * table/index/policy lands in the server default schema (`public`). This is the
 * byte-for-byte historical behavior — the migration test suite calls
 * `migrate(DB_URL)` and is unaffected.
 *
 * EMBEDDED (Step I, §7.8 runtime/SDK half): pass a `schema` (or set
 * `OPENGENI_DB_SCHEMA`). The migrate session then `CREATE SCHEMA IF NOT EXISTS`
 * for both `<schema>` and `opengeni_private`, and sets
 * `search_path = "<schema>", "opengeni_private", "public"`, so EVERY unqualified
 * DDL statement lands in the dedicated schema with NO per-statement SQL rewrite
 * (the SPIKE-1 F1 result). Two things make this work and stay idempotent:
 *   1. The policy-existence guards in the migration SQL use `current_schema()`
 *      (not a hardcoded `'public'`) — so a re-run finds the policy it already
 *      created in `<schema>` and DROP/CREATEs idempotently instead of failing
 *      with "policy already exists". (This guard substitution is the migrate-
 *      time enabler for the runtime search_path approach; without it the SDK
 *      entry point silently fails on re-run — the Fork-6 hazard.)
 *   2. `public` stays LAST on the path so `gen_random_uuid()` (pgcrypto) and the
 *      `vector` type — both installed into `public` by 0000 — still resolve. The
 *      `opengeni_private.*` helpers are always called with an absolute prefix.
 *
 * `OPENGENI_DB_SCHEMA` defaults UNSET → `public` → standalone, so the default
 * binding never regresses.
 */
export async function migrate(
  databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_URL ?? DEFAULT_DATABASE_URL,
  schema: string | undefined = process.env.OPENGENI_DB_SCHEMA?.trim() || undefined,
): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // Serialize concurrent migrate() runs; the session-level lock is released
    // when the connection closes.
    await sql`SELECT pg_advisory_lock(727458)`;
    if (schema) {
      assertIdentifier("OPENGENI_DB_SCHEMA", schema);
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      // opengeni_private is also created by 0001 with an absolute prefix, but the
      // session search_path must already resolve it for the policy predicates
      // and the SECURITY DEFINER functions that inherit the caller's path.
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "opengeni_private"`);
      await sql.unsafe(`SET search_path = "${schema}", "opengeni_private", "public"`);
    }
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`);
    const appliedRows = await sql`SELECT "name" FROM "schema_migrations"`;
    const applied = new Set(appliedRows.map((row) => row.name as string));
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sqlText = await readFile(join(migrationsDir, file), "utf8");
      await sql.unsafe(sqlText);
      await sql`INSERT INTO "schema_migrations" ("name") VALUES (${file}) ON CONFLICT DO NOTHING`;
    }
  } finally {
    await sql.end();
  }
}

/**
 * SDK entry point (Step I): run the migration chain over a host-supplied admin
 * connection string against an explicit target schema. This is the embedded
 * topology's named entry — a host calls `runMigrations(adminConnection,
 * targetSchema)` from its own provisioning code instead of relying on env vars.
 * `targetSchema` undefined → `public` → standalone behavior. Thin wrapper over
 * `migrate` so there is one migration engine.
 */
export async function runMigrations(adminConnection: string, targetSchema?: string): Promise<void> {
  await migrate(adminConnection, targetSchema);
}

if (import.meta.main) {
  await migrate();
  console.log("Applied Drizzle SQL migrations.");
}
