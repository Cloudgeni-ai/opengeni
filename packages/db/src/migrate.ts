import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";
const DEFAULT_MAX_NESTED_AGENT_DEPTH = 3;
const MAX_NESTED_AGENT_DEPTH = 2_147_483_647;
const batchedBackfillDirective =
  /^-- opengeni:batched-backfill batch-size=(\d+) lock-timeout=(\d+(?:ms|s|min)) statement-timeout=(\d+(?:ms|s|min))$/;
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

export type MigrationRuntimeOptions = {
  maxNestedAgentDepth?: number;
};

type DeploymentDepthPolicy = {
  maxNestedAgentDepth: number;
  source: "deployment" | "default";
};

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

function parseBatchedBackfillMigration(
  file: string,
  sqlText: string,
): { batchSize: number; lockTimeout: string; statementTimeout: string; statement: string } | null {
  const lines = sqlText.replaceAll("\r\n", "\n").split("\n");
  const directiveIndex = /^-- deployment-mode: (?:rolling|maintenance)$/.test(
    lines[0]?.trim() ?? "",
  )
    ? 1
    : 0;
  const directive = batchedBackfillDirective.exec(lines[directiveIndex]?.trim() ?? "");
  if (!directive) return null;
  const statement = lines
    .slice(directiveIndex + 1)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  const withoutTrailingSemicolon = statement.endsWith(";")
    ? statement.slice(0, -1).trimEnd()
    : statement;
  const batchSize = Number(directive[1]!);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 10_000 ||
    !/^WITH\b/is.test(withoutTrailingSemicolon) ||
    !/\bUPDATE\b/is.test(withoutTrailingSemicolon) ||
    !/\bRETURNING\b/is.test(withoutTrailingSemicolon) ||
    !new RegExp(`\\bLIMIT\\s+${batchSize}\\b`, "i").test(withoutTrailingSemicolon) ||
    withoutTrailingSemicolon.includes(";")
  ) {
    throw new Error(
      `${file}: opengeni:batched-backfill requires one bounded WITH ... UPDATE ... RETURNING statement whose LIMIT matches batch-size`,
    );
  }
  return {
    batchSize,
    lockTimeout: directive[2]!,
    statementTimeout: directive[3]!,
    statement,
  };
}

async function executeMigrationFile(
  sql: postgres.Sql,
  file: string,
  sqlText: string,
): Promise<void> {
  const batchedBackfill = parseBatchedBackfillMigration(file, sqlText);
  if (batchedBackfill) {
    await sql`select set_config('lock_timeout', ${batchedBackfill.lockTimeout}, false)`;
    await sql`select set_config('statement_timeout', ${batchedBackfill.statementTimeout}, false)`;
    try {
      for (;;) {
        const result = await sql.unsafe(batchedBackfill.statement);
        if (result.length === 0) break;
      }
    } finally {
      await sql`select set_config('statement_timeout', '0', false)`;
      await sql`select set_config('lock_timeout', '0', false)`;
    }
    return;
  }
  const concurrentIndex = parseConcurrentIndexMigration(file, sqlText);
  if (!concurrentIndex) {
    // Migration SQL is the only writer allowed to cross protocol generations.
    // Keep the authority transaction-local and inside the same PostgreSQL simple
    // query as the migration body: setting it in a prior statement would end
    // that implicit transaction and silently lose the LOCAL value. This also
    // makes a fresh database capable of applying maintenance migration 0138
    // without a process-global PGOPTIONS escape hatch.
    await sql.unsafe(
      `SELECT pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);\n${sqlText}`,
    );
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

function deploymentDepthPolicy(
  options: MigrationRuntimeOptions | undefined,
): DeploymentDepthPolicy {
  const raw =
    options === undefined
      ? process.env.OPENGENI_MAX_NESTED_AGENT_DEPTH?.trim() || undefined
      : options.maxNestedAgentDepth;
  if (raw === undefined) {
    return { maxNestedAgentDepth: DEFAULT_MAX_NESTED_AGENT_DEPTH, source: "default" };
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_NESTED_AGENT_DEPTH ||
    (typeof raw === "string" && !/^(0|[1-9][0-9]*)$/.test(raw))
  ) {
    throw new Error(
      `OPENGENI_MAX_NESTED_AGENT_DEPTH must be a non-negative 32-bit integer: ${raw}`,
    );
  }
  return { maxNestedAgentDepth: value, source: "deployment" };
}

async function persistDeploymentDepthPolicy(
  sql: postgres.Sql,
  policy: DeploymentDepthPolicy,
): Promise<void> {
  const [relation] = await sql<{ exists: boolean }[]>`
    select to_regclass('nested_agent_depth_configuration') is not null as exists
  `;
  if (!relation?.exists) return;
  await sql`
    insert into "nested_agent_depth_configuration" (
      "singleton", "max_nested_agent_depth", "policy_source", "updated_at"
    ) values (true, ${policy.maxNestedAgentDepth}, ${policy.source}, now())
    on conflict ("singleton") do update
    set "max_nested_agent_depth" = excluded."max_nested_agent_depth",
        "policy_source" = excluded."policy_source",
        "updated_at" = now()
    where "nested_agent_depth_configuration"."max_nested_agent_depth"
            is distinct from excluded."max_nested_agent_depth"
       or "nested_agent_depth_configuration"."policy_source"
            is distinct from excluded."policy_source"
  `;
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
  runtimeOptions?: MigrationRuntimeOptions,
): Promise<void> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const depthPolicy = deploymentDepthPolicy(runtimeOptions);
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
    await sql`select set_config('opengeni.max_nested_agent_depth', ${String(depthPolicy.maxNestedAgentDepth)}, false)`;
    await sql`select set_config('opengeni.nested_agent_depth_policy_source', ${depthPolicy.source}, false)`;
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
    // Reconcile even when all migration names were already recorded. This is
    // the only supported way to change deployment policy in a live database.
    await persistDeploymentDepthPolicy(sql, depthPolicy);
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
export async function runMigrations(
  adminConnection: string,
  targetSchema?: string,
  runtimeOptions?: MigrationRuntimeOptions,
): Promise<void> {
  await migrate(adminConnection, targetSchema, runtimeOptions);
}

if (import.meta.main) {
  await migrate();
  console.log("Applied Drizzle SQL migrations.");
}
