import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";
const DEFAULT_MAX_NESTED_AGENT_DEPTH = 3;
const MAX_NESTED_AGENT_DEPTH = 2_147_483_647;
const deploymentModeDirective = /^-- deployment-mode: (?:rolling|maintenance)$/;
const concurrentIndexDirective = /^-- opengeni:concurrent-index lock-timeout=(\d+(?:ms|s|min))$/;
const batchedBackfillDirective =
  /^-- opengeni:batched-backfill batch-size=(\d+) lock-timeout=(\d+(?:ms|s|min)) statement-timeout=(\d+(?:ms|s|min))$/;

export type MigrationRuntimeOptions = {
  /**
   * Deployment-wide nested-agent maximum to persist in the target schema.
   * An omitted property means the product default (3). Omitting the options
   * object entirely reads OPENGENI_MAX_NESTED_AGENT_DEPTH for CLI parity.
   */
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
 * Online migrations may opt into one of two narrowly validated, autocommitted
 * operations on the line immediately after their required deployment mode:
 *
 *   -- deployment-mode: rolling
 *   -- opengeni:concurrent-index lock-timeout=5s
 *   CREATE [UNIQUE] INDEX CONCURRENTLY ...;
 *
 * or:
 *
 *   -- deployment-mode: rolling
 *   -- opengeni:batched-backfill batch-size=1000 lock-timeout=5s statement-timeout=30s
 *   WITH ... LIMIT 1000 ... UPDATE ... RETURNING ...;
 *
 * Neither directive is a generic "no transaction" escape hatch. The first
 * accepts exactly one concurrent-index statement with bounded lock acquisition.
 * The second accepts exactly one bounded CTE UPDATE RETURNING statement and
 * repeats it, one autocommit transaction per batch, until it updates zero rows.
 */
async function executeMigrationFile(
  sql: postgres.Sql,
  file: string,
  sqlText: string,
): Promise<void> {
  const lines = sqlText.replaceAll("\r\n", "\n").split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const directiveIndex = deploymentModeDirective.test(firstLine) ? 1 : 0;
  const directiveLine = lines[directiveIndex]?.trim() ?? "";
  const concurrentDirective = concurrentIndexDirective.exec(directiveLine);
  const backfillDirective = batchedBackfillDirective.exec(directiveLine);
  if (!concurrentDirective && !backfillDirective) {
    if (directiveLine.startsWith("-- opengeni:")) {
      throw new Error(`Unsupported OpenGeni migration directive in ${file}`);
    }
    await sql.unsafe(sqlText);
    return;
  }

  const statementLines = lines.slice(directiveIndex + 1);
  // Human-readable comments may explain the one validated operation, but they
  // are not part of the statement shape. Strip only leading ordinary comments;
  // a second OpenGeni directive is always an error rather than an escape hatch.
  while (
    statementLines.length > 0 &&
    (statementLines[0]!.trim() === "" ||
      (statementLines[0]!.trim().startsWith("--") &&
        !statementLines[0]!.trim().startsWith("-- opengeni:")))
  ) {
    statementLines.shift();
  }
  if (statementLines.some((line) => line.trim().startsWith("-- opengeni:"))) {
    throw new Error(`Unsupported additional OpenGeni migration directive in ${file}`);
  }
  const statement = statementLines.join("\n").trim();
  const withoutTrailingSemicolon = statement.endsWith(";")
    ? statement.slice(0, -1).trimEnd()
    : statement;
  if (concurrentDirective) {
    if (
      !/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/is.test(withoutTrailingSemicolon) ||
      withoutTrailingSemicolon.includes(";")
    ) {
      throw new Error(
        `${file}: opengeni:concurrent-index requires exactly one CREATE [UNIQUE] INDEX CONCURRENTLY statement`,
      );
    }

    await sql`select set_config('lock_timeout', ${concurrentDirective[1]!}, false)`;
    try {
      await sql.unsafe(statement);
    } finally {
      await sql`select set_config('lock_timeout', '0', false)`;
    }
    return;
  }

  const batchSize = Number(backfillDirective![1]!);
  const lockTimeout = backfillDirective![2]!;
  const statementTimeout = backfillDirective![3]!;
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
      `${file}: opengeni:batched-backfill requires exactly one bounded WITH ... UPDATE ... RETURNING statement whose LIMIT matches batch-size`,
    );
  }

  await sql`select set_config('lock_timeout', ${lockTimeout}, false)`;
  await sql`select set_config('statement_timeout', ${statementTimeout}, false)`;
  try {
    for (;;) {
      const rows = await sql.unsafe(statement);
      if (rows.length === 0) break;
    }
  } finally {
    await sql`select set_config('statement_timeout', '0', false)`;
    await sql`select set_config('lock_timeout', '0', false)`;
  }
}

function deploymentDepthPolicy(
  options: MigrationRuntimeOptions | undefined,
): DeploymentDepthPolicy {
  const configured =
    options === undefined
      ? process.env.OPENGENI_MAX_NESTED_AGENT_DEPTH?.trim() || undefined
      : options.maxNestedAgentDepth;
  if (configured === undefined) {
    return { maxNestedAgentDepth: DEFAULT_MAX_NESTED_AGENT_DEPTH, source: "default" };
  }
  const value = typeof configured === "number" ? configured : Number(configured);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_NESTED_AGENT_DEPTH ||
    (typeof configured === "string" && !/^(0|[1-9][0-9]*)$/.test(configured))
  ) {
    throw new Error(
      `OPENGENI_MAX_NESTED_AGENT_DEPTH must be a non-negative 32-bit integer: ${configured}`,
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
    // The expand migration reads these session-local values when it creates the
    // singleton row, so there is no commit gap in which mixed-version inserts
    // could observe the wrong deployment fallback.
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
    // Reconcile configuration even when the SQL chain was already current.
    // The row lock serializes this rare deployment change with trigger- and
    // application-side policy readers.
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
