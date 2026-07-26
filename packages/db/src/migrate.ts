import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";
const concurrentIndexDirective = /^-- opengeni:concurrent-index lock-timeout=(\d+(?:ms|s|min))$/;
const concurrentIndexStatement =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:(IF\s+NOT\s+EXISTS)\s+)?(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))\s+ON\b/is;
const governedLegacyConcurrentIndexMigrations = new Set([
  "0066_session_interruption_attempt_lookup.sql",
  "0070_session_event_type_sequence_lookup.sql",
  "0071_session_event_monitoring_tail.sql",
  "0072_sessions_workspace_created_id_idx.sql",
  "0073_sessions_workspace_updated_id_idx.sql",
  "0075_sessions_workspace_activity_revision_idx.sql",
  "0077_session_attempt_latest_lookup.sql",
]);

export interface ConcurrentIndexMigration {
  indexName: string;
  lockTimeout: string;
  skipWhenValid: boolean;
  statement: string;
}

/** A bare Postgres identifier (schema/role name) safe to interpolate into DDL. */
function assertIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} is not a valid Postgres identifier: ${value}`);
  }
  return value;
}

/**
 * Most migration files intentionally execute as one implicit transaction.
 * PostgreSQL forbids CREATE INDEX CONCURRENTLY there, so a migration may opt
 * into one narrowly validated transactionless statement with:
 *
 *   -- opengeni:concurrent-index lock-timeout=5s
 *   CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS ...;
 *
 * The directive is deliberately not a generic "no transaction" escape hatch:
 * only one idempotent concurrent-index statement is accepted, lock acquisition
 * is always bounded, and an invalid artifact left by a failed concurrent build
 * is removed before retry. Seven governed historical migrations predate the
 * IF NOT EXISTS rule; only those exact filenames may use their immutable bare
 * statements, and the runner makes their retries idempotent by skipping an
 * already-valid index. This keeps additive large-table indexes online without
 * rewriting shipped history or making arbitrary partially-applied migration
 * scripts possible.
 */
export function parseConcurrentIndexMigration(
  file: string,
  sqlText: string,
): ConcurrentIndexMigration | null {
  const lines = sqlText.replaceAll("\r\n", "\n").split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const deploymentPrefixed = /^-- deployment-mode: (?:rolling|maintenance)$/.test(firstLine);
  const directiveIndex = deploymentPrefixed ? 1 : 0;
  const directiveLine = lines[directiveIndex]?.trim() ?? "";
  const directive = concurrentIndexDirective.exec(directiveLine);
  if (!directive) {
    if (directiveLine.startsWith("-- opengeni:")) {
      throw new Error(`Unsupported OpenGeni migration directive in ${file}`);
    }
    return null;
  }

  const lockTimeout = directive[1]!;
  const statement = lines
    .slice(directiveIndex + 1)
    .join("\n")
    .trim();
  const withoutTrailingSemicolon = statement.endsWith(";")
    ? statement.slice(0, -1).trimEnd()
    : statement;
  const parsedStatement = concurrentIndexStatement.exec(withoutTrailingSemicolon);
  if (!parsedStatement || withoutTrailingSemicolon.includes(";")) {
    throw new Error(
      `${file}: opengeni:concurrent-index requires exactly one CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS statement with an unqualified index name`,
    );
  }
  const idempotentInSql = parsedStatement[1] !== undefined;
  if (!idempotentInSql && !governedLegacyConcurrentIndexMigrations.has(file)) {
    throw new Error(
      `${file}: opengeni:concurrent-index requires IF NOT EXISTS; bare statements are supported only for governed historical migrations`,
    );
  }
  return {
    indexName: (parsedStatement[2] ?? parsedStatement[3]!).replaceAll('""', '"'),
    lockTimeout,
    skipWhenValid: !idempotentInSql,
    statement,
  };
}

async function executeMigrationFile(
  sql: postgres.Sql,
  file: string,
  sqlText: string,
): Promise<void> {
  const concurrentIndex = parseConcurrentIndexMigration(file, sqlText);
  if (!concurrentIndex) {
    await sql.unsafe(sqlText);
    return;
  }

  await sql`select set_config('lock_timeout', ${concurrentIndex.lockTimeout}, false)`;
  try {
    const [existing] = await sql<Array<{ valid: boolean; ready: boolean }>>`
      select i.indisvalid as valid, i.indisready as ready
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_index i on i.indexrelid = c.oid
      where n.nspname = current_schema() and c.relname = ${concurrentIndex.indexName}
    `;
    if (existing && (!existing.valid || !existing.ready)) {
      const quotedIndexName = `"${concurrentIndex.indexName.replaceAll('"', '""')}"`;
      await sql.unsafe(`DROP INDEX CONCURRENTLY ${quotedIndexName}`);
    } else if (existing && concurrentIndex.skipWhenValid) {
      return;
    }
    await sql.unsafe(concurrentIndex.statement);
  } finally {
    await sql`select set_config('lock_timeout', '0', false)`;
  }
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
 * EMBEDDED SCHEMA MODE: pass a `schema` (or set
 * `OPENGENI_DB_SCHEMA`). The migrate session then `CREATE SCHEMA IF NOT EXISTS`
 * for both `<schema>` and `opengeni_private`, and sets
 * `search_path = "<schema>", "opengeni_private", "public"`, so EVERY unqualified
 * DDL statement lands in the dedicated schema with NO per-statement SQL rewrite
 * (the schema-isolation contract). Two things make this work and stay idempotent:
 *   1. The policy-existence guards in the migration SQL use `current_schema()`
 *      (not a hardcoded `'public'`) — so a re-run finds the policy it already
 *      created in `<schema>` and DROP/CREATEs idempotently instead of failing
 *      with "policy already exists". (This guard substitution is the migrate-
 *      time enabler for the runtime search_path approach; without it the SDK
 *      entry point silently fails on re-run — the migration replay hazard.)
 *   2. `public` stays LAST on the path so `gen_random_uuid()` (pgcrypto) and the
 *      `vector` type — both installed into `public` by 0000 — still resolve. The
 *      `opengeni_private.*` helpers are always called with an absolute prefix.
 *
 * `OPENGENI_DB_SCHEMA` defaults UNSET → `public` → standalone, so the default
 * binding never regresses.
 */
export async function migrate(
  databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ??
    process.env.OPENGENI_DATABASE_URL ??
    DEFAULT_DATABASE_URL,
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
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
    );
    const appliedRows = await sql`SELECT "name" FROM "schema_migrations"`;
    const applied = new Set(appliedRows.map((row) => row.name as string));
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sqlText = await readFile(join(migrationsDir, file), "utf8");
      await executeMigrationFile(sql, file, sqlText);
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
