import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { databaseBootConnectOptions } from "./boot-connect";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as databaseSchema from "./schema";
import { BASELINE_MIGRATIONS, SQUASHED_MIGRATIONS } from "./migration-baseline";
import {
  RELEASE_DIRECTIVE,
  migrationDeploymentMode,
  migrationPhaseFromArgs,
  migrationReleaseDirectives,
  ordinaryMigrationIsPostureInert,
  parseMigrationPhase,
  partitionMigrationPhases,
  type MigrationDeploymentMode,
  type MigrationPhase,
  type MigrationPhases,
} from "./migration-phases";
export { migrationDeploymentMode } from "./migration-phases";
export type { MigrationDeploymentMode } from "./migration-phases";
import {
  migrateInterruptedTurnRetirement,
  parseInterruptedTurnRetirementManifest,
  type InterruptedTurnRetirementManifest,
} from "./interrupted-turn-retirement-migration";

const DEFAULT_DATABASE_URL = "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";
const DEFAULT_MAX_NESTED_AGENT_DEPTH = 3;
const MAX_NESTED_AGENT_DEPTH = 2_147_483_647;
const DEFAULT_APPLICATION_DATABASE_ROLE = "opengeni_app";
const MIGRATION_APPLICATION_ROLES_SETTING = "opengeni.migration_application_roles";
const MAX_MIGRATION_APPLICATION_ROLES = 16;
const batchedBackfillDirective =
  /^-- opengeni:batched-backfill batch-size=(\d+) lock-timeout=(\d+(?:ms|s|min)) statement-timeout=(\d+(?:ms|s|min))$/;
const concurrentIndexDirective = /^-- opengeni:concurrent-index lock-timeout=(\d+(?:ms|s|min))$/;
const concurrentIndexStatement =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:(IF\s+NOT\s+EXISTS)\s+)?(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))\s+ON\b/is;
export interface ConcurrentIndexMigration {
  indexName: string;
  /** Historical directive metadata; concurrent builds must wait for old snapshots. */
  lockTimeout: string;
  statement: string;
}

export type MigrationRuntimeOptions = {
  /** Read migration files from this directory instead of the shipped ones. */
  migrationsDirectory?: string;
  /** Cumulative execution: pre; pre + maintenance; or everything (default). */
  phase?: MigrationPhase;
  /** Called after successful execution and policy reconciliation, under the lock. */
  onPhaseComplete?: (result: MigrationPhaseResult) => void;
  /** Explicit historical retirement of interrupted turns, never inferred from
   * Pause or row age. The exact version/sequence-fenced manifest runs before
   * pending migrations and needs an existing Opengeni database. */
  interruptedTurnRetirement?: InterruptedTurnRetirementManifest;
  maxNestedAgentDepth?: number;
  /**
   * For managed Postgres where an administrator preinstalls pgvector but the
   * migration owner cannot execute CREATE EXTENSION, verify the public vector
   * type and omit only the baseline's exact vector installation statement. The
   * default executes the shipped baseline verbatim.
   */
  preinstalledVector?: boolean;
  /**
   * Exact database login roles that may run an Opengeni API or worker against
   * this target. Maintenance cutovers use this list to reject a live mixed-
   * version fleet, and rolling ACL migrations use it to preserve old-binary
   * readiness until later role provisioning converges. Dedicated-schema and
   * custom-role deployments must supply it.
   */
  applicationDatabaseRoles?: string[];
};

type DeploymentDepthPolicy = {
  maxNestedAgentDepth: number;
  source: "deployment" | "default";
};

const baselineParts = new Set(BASELINE_MIGRATIONS);
const SHIPPED_MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/**
 * How a ledger relates to the baseline (see migration-baseline.ts): `started`
 * lists at least one part (the rest, if any, apply as pending migrations),
 * `adopt` lists every file the baseline replaced, and `fresh` lists none of
 * them, so the parts run.
 */
function baselineState(applied: ReadonlySet<string>): "started" | "adopt" | "fresh" {
  if (BASELINE_MIGRATIONS.some((name) => applied.has(name))) return "started";
  const missing = SQUASHED_MIGRATIONS.filter((name) => !applied.has(name));
  if (missing.length === 0) return "adopt";
  if (missing.length === SQUASHED_MIGRATIONS.length) return "fresh";
  throw new Error(
    `This database applied only part of migrations 0000-0977 (missing ${missing[0]} and ` +
      `${missing.length - 1} more). Upgrade it with the last Opengeni release that ships ` +
      `those files individually, then run this release's migrations.`,
  );
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
 * only one idempotent concurrent-index statement is accepted, and an invalid
 * artifact left by a failed concurrent build
 * is removed before retry. This keeps additive large-table indexes online
 * without making arbitrary partially-applied migration scripts possible.
 * The historical lock-timeout directive is parsed without rewriting shipped
 * files, but is no longer applied: PostgreSQL also uses lock_timeout for its
 * safe wait for old snapshots, including readers of unrelated tables when the
 * index is partial or has expressions. Ordinary DDL keeps its short timeout.
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
      throw new Error(`Unsupported Opengeni migration directive in ${file}`);
    }
    return null;
  }

  const lockTimeout = directive[1]!;
  let inLeadingComments = true;
  const statement = lines
    .slice(directiveIndex + 1)
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("--")) inLeadingComments = false;
      return !(inLeadingComments && RELEASE_DIRECTIVE.test(trimmed));
    })
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
  if (parsedStatement[1] === undefined) {
    throw new Error(`${file}: opengeni:concurrent-index requires IF NOT EXISTS`);
  }
  return {
    indexName: (parsedStatement[2] ?? parsedStatement[3]!).replaceAll('""', '"'),
    lockTimeout,
    statement,
  };
}

export function parseBatchedBackfillMigration(
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

export async function executeMigrationFile(
  sql: postgres.Sql,
  file: string,
  sqlText: string,
  options?: Pick<MigrationRuntimeOptions, "preinstalledVector"> & {
    /** Record `file` in schema_migrations atomically with an ordinary body. */
    recordApplied?: boolean;
  },
): Promise<void> {
  if (baselineParts.has(file)) {
    sqlText = await baselineSqlForSession(
      sql,
      sqlText,
      file === BASELINE_MIGRATIONS[0] && options?.preinstalledVector === true,
    );
  }
  const batchedBackfill = parseBatchedBackfillMigration(file, sqlText);
  if (batchedBackfill) {
    const [priorSettings] = await sql<{ lock_timeout: string; statement_timeout: string }[]>`
      select current_setting('lock_timeout') as lock_timeout,
        current_setting('statement_timeout') as statement_timeout
    `;
    try {
      await sql`select set_config('lock_timeout', ${batchedBackfill.lockTimeout}, false),
        set_config('statement_timeout', ${batchedBackfill.statementTimeout}, false)`;
      for (;;) {
        const result = await sql.begin(async (transaction) => {
          await transaction`select
            pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
            pg_catalog.set_config(
              'opengeni.session_variable_set_attachments_v1',
              '1',
              true
            )`;
          return await transaction.unsafe(batchedBackfill.statement);
        });
        if (result.length === 0) break;
      }
    } finally {
      // These overrides belong only to this backfill. Preserve the operator's
      // inherited deadline for later files, including concurrent index builds.
      await sql`select set_config('statement_timeout', ${priorSettings!.statement_timeout}, false),
        set_config('lock_timeout', ${priorSettings!.lock_timeout}, false)`;
    }
    return;
  }
  const concurrentIndex = parseConcurrentIndexMigration(file, sqlText);
  if (!concurrentIndex) {
    // Migration SQL is the only writer allowed to cross protocol generations.
    // Keep the authority transaction-local and inside the same PostgreSQL simple
    // query as the migration body: setting it in a prior statement would end
    // that implicit transaction and silently lose the LOCAL value, and a
    // process-global PGOPTIONS escape hatch would reach application writers.
    // Bound ordinary DDL lock acquisition in that same implicit transaction.
    // The migration body follows this preamble, so its own SET LOCAL can still
    // override the default; a lock timeout aborts the whole body before the
    // ledger row is written. The ledger row ends the same simple query, so a
    // migrator that dies after sending the body (the server still finishes and
    // commits it) never leaves an applied body without its row.
    const receipt = options?.recordApplied
      ? `\n;\nINSERT INTO "schema_migrations" ("name") VALUES ('${file.replaceAll("'", "''")}') ON CONFLICT DO NOTHING;`
      : "";
    await sql.unsafe(
      `SELECT
  pg_catalog.set_config('lock_timeout', '5s', true),
  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\n${sqlText}${receipt}`,
    );
    return;
  }

  const [priorSettings] = await sql<{ lock_timeout: string }[]>`
    select current_setting('lock_timeout') as lock_timeout
  `;
  // CONCURRENTLY is the online lock strategy. Its virtual-xid waits are part
  // of completing a valid index, not failure to acquire an exclusive DDL lock.
  // Aborting those waits rebuilds the same index on every deploy retry.
  await sql`select set_config('lock_timeout', '0', false)`;
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
    }
    await sql.unsafe(concurrentIndex.statement);
  } finally {
    await sql`select set_config('lock_timeout', ${priorSettings!.lock_timeout}, false)`;
  }
}

const baselineVectorStatement = "\nCREATE EXTENSION IF NOT EXISTS vector;\n";

/**
 * The baseline writes four install-specific values as placeholders: its own
 * schema as `{{schema}}` where the session search_path does not apply (routine
 * bodies and dynamic SQL), that schema's OID as `{{schema_oid}}`, the
 * migration owner as `{{owner}}` (policies and routines that only the owner
 * may pass), and the install time as `{{migrated_at}}` (the cutoff before
 * which learning settings resolve to their earlier defaults). Substitute the
 * migration session's values; the schema and owner
 * must be bare identifiers so the unquoted text names the same objects. With a
 * preinstalled vector extension, verify the public extension and type and drop
 * only the baseline's exact vector installation statement; never trust a
 * same-named type in another schema.
 */
async function baselineSqlForSession(
  sql: postgres.Sql,
  sqlText: string,
  preinstalledVector: boolean,
): Promise<string> {
  const [session] = await sql<
    Array<{ schema: string | null; schemaOid: string | null; owner: string; now: string }>
  >`
    SELECT current_schema() AS schema,
      (SELECT oid::text FROM pg_catalog.pg_namespace WHERE nspname = current_schema()) AS "schemaOid",
      current_user AS owner,
      now()::text AS now
  `;
  if (!session?.schema || !session.schemaOid) {
    throw new Error("The migration baseline needs an existing target schema");
  }
  for (const [label, name] of [
    ["target schema", session.schema],
    ["migration role", session.owner],
  ] as const) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
      throw new Error(
        `The migration baseline needs a lowercase unquoted ${label}, not ${JSON.stringify(name)}`,
      );
    }
  }
  const text = sqlText
    .replaceAll("{{schema}}", session.schema)
    .replaceAll("{{schema_oid}}", session.schemaOid)
    .replaceAll("{{owner}}", session.owner)
    .replaceAll("{{migrated_at}}", session.now);
  if (!preinstalledVector) return text;
  if (text.split(baselineVectorStatement).length !== 2) {
    throw new Error("The baseline's vector statement changed; review managed Postgres admission");
  }
  const [installed] = await sql<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_extension extension
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = extension.extnamespace
      JOIN pg_catalog.pg_type type ON type.typnamespace = namespace.oid AND type.typname = 'vector'
      JOIN pg_catalog.pg_depend dependency
        ON dependency.classid = 'pg_catalog.pg_type'::regclass
       AND dependency.objid = type.oid
       AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
       AND dependency.refobjid = extension.oid AND dependency.deptype = 'e'
      WHERE extension.extname = 'vector' AND namespace.nspname = 'public'
    ) AS present
  `;
  if (!installed?.present) {
    throw new Error("Preinstalled public pgvector extension and type are required");
  }
  return text.replace(baselineVectorStatement, "\n");
}

function preinstalledVectorPolicy(options: MigrationRuntimeOptions | undefined): boolean {
  if (options !== undefined) return options.preinstalledVector === true;
  const configured = process.env.OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR;
  if (configured === undefined || configured === "false") return false;
  if (configured === "true") return true;
  throw new Error("OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR must be true or false");
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

export function migrationApplicationRoles(
  schema: string | undefined,
  options: MigrationRuntimeOptions | undefined,
): string[] {
  const configured = options?.applicationDatabaseRoles;
  const environment = process.env.OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES?.trim();
  const explicit =
    configured !== undefined
      ? configured
      : environment
        ? environment.split(",").map((role) => role.trim())
        : undefined;

  if (!explicit) {
    const configuredRuntimeRoles = [
      process.env.OPENGENI_APP_DATABASE_USER?.trim(),
      process.env.OPENGENI_RUNTIME_DATABASE_ROLE?.trim(),
    ].filter((role): role is string => Boolean(role) && role !== DEFAULT_APPLICATION_DATABASE_ROLE);
    if (schema || configuredRuntimeRoles.length > 0) {
      throw new Error(
        "Pending migrations require the exact application database roles via " +
          "MigrationRuntimeOptions.applicationDatabaseRoles or " +
          "OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES for dedicated-schema or custom-role deployments",
      );
    }
    return [DEFAULT_APPLICATION_DATABASE_ROLE];
  }

  if (
    configured !== undefined &&
    configured.some((role) => typeof role !== "string" || role !== role.trim())
  ) {
    throw new Error(
      "MigrationRuntimeOptions.applicationDatabaseRoles must contain canonical Postgres role names without surrounding whitespace",
    );
  }
  if (explicit.length < 1 || explicit.length > MAX_MIGRATION_APPLICATION_ROLES) {
    throw new Error(
      `Migration application database roles must contain 1-${MAX_MIGRATION_APPLICATION_ROLES} entries`,
    );
  }
  const normalized = [...new Set(explicit)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  if (
    normalized.length !== explicit.length ||
    normalized.some((role) => role.length === 0 || Buffer.byteLength(role, "utf8") > 63)
  ) {
    throw new Error(
      "Migration application database roles must be unique, non-empty Postgres role names of at most 63 UTF-8 bytes",
    );
  }
  return normalized;
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
 * Apply the Opengeni SQL migration chain.
 *
 * STANDALONE (default): `migrate()` / `migrate(databaseUrl)` runs the whole
 * chain with NO search_path manipulation, so every unqualified
 * table/index/policy lands in the server default schema (`public`).
 *
 * EMBEDDED SCHEMA MODE: pass a `schema` (or set
 * `OPENGENI_DB_SCHEMA`). The migrate session then `CREATE SCHEMA IF NOT EXISTS`
 * for both `<schema>` and `opengeni_private`, and sets
 * `search_path = "<schema>", "opengeni_private", "public"`, so EVERY unqualified
 * DDL statement lands in the dedicated schema with NO per-statement SQL rewrite
 * (the schema-isolation contract). Migration SQL that must name the schema
 * (policy-existence guards, dynamic SQL) uses `current_schema()`, and the
 * baseline's routine bodies use a `{{schema}}` placeholder the runner fills in.
 * `public` stays LAST on the path so extensions an administrator installed
 * there still resolve. The `opengeni_private.*` helpers are always called with
 * an absolute prefix.
 * Dedicated-schema callers must also pass the exact API/worker database login
 * identities in `applicationDatabaseRoles`; maintenance cutovers cannot infer
 * host-managed or scoped runtime roles from the admin connection.
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
  const phase = parseMigrationPhase(runtimeOptions?.phase);
  const migrationsDir = runtimeOptions?.migrationsDirectory ?? SHIPPED_MIGRATIONS_DIRECTORY;
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const depthPolicy = deploymentDepthPolicy(runtimeOptions);
  const preinstalledVector = preinstalledVectorPolicy(runtimeOptions);
  const retirementPath = process.env.OPENGENI_MIGRATION_INTERRUPTED_TURN_RETIREMENT_MANIFEST;
  const retirement =
    runtimeOptions?.interruptedTurnRetirement ??
    (retirementPath
      ? parseInterruptedTurnRetirementManifest(JSON.parse(await readFile(retirementPath, "utf8")))
      : undefined);
  const sql = postgres(databaseUrl, { max: 1, ...databaseBootConnectOptions(databaseUrl) });
  try {
    // Serialize concurrent migrate() runs; the session-level lock is released
    // when the connection closes.
    await sql`SELECT pg_advisory_lock(727458)`;
    if (schema) {
      assertIdentifier("OPENGENI_DB_SCHEMA", schema);
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      // The baseline also creates opengeni_private, but the session
      // search_path must already resolve it for the policy predicates and the
      // SECURITY DEFINER functions that capture the caller's path.
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
    if (baselineState(applied) === "adopt") {
      await sql`INSERT INTO "schema_migrations" ("name")
        SELECT unnest(${[...BASELINE_MIGRATIONS]}::text[]) ON CONFLICT DO NOTHING`;
      for (const name of BASELINE_MIGRATIONS) applied.add(name);
    }
    // Explicit operator retirement. Do not silently ignore supplied intent.
    // Replay proves the same terminal audit receipt; another epoch fails closed.
    if (retirement) {
      if (!BASELINE_MIGRATIONS.every((name) => applied.has(name))) {
        throw new Error(
          "An interrupted-turn retirement manifest needs an existing Opengeni database",
        );
      }
      await drizzle(sql, { schema: databaseSchema }).transaction(async (transaction) => {
        await transaction.execute(drizzleSql`select set_config('lock_timeout', '5s', true),
          set_config('statement_timeout', '10min', true)`);
        await migrateInterruptedTurnRetirement(transaction, retirement);
      });
    }
    const pendingMigrationSources = new Map<string, string>();
    for (const file of files) {
      if (!applied.has(file)) {
        pendingMigrationSources.set(file, await readFile(join(migrationsDir, file), "utf8"));
      }
    }
    const phases = phasesForMigrationSources(pendingMigrationSources);
    const selected = new Set([
      ...phases.pre,
      ...(phase !== "pre" ? phases.maintenance : []),
      ...(phase === "post" ? phases.post : []),
    ]);
    const appliedThisRun: string[] = [];
    // Initialize this session GUC for every pending migration that consumes it,
    // instead of maintaining a second filename list that can silently lag the
    // shipped migration chain. The conservative source marker is intentional:
    // setting the bounded role list for a migration that only mentions the GUC
    // is harmless, while omitting it makes an otherwise valid upgrade fail.
    if (
      Array.from(pendingMigrationSources.values()).some((source) =>
        source.includes(MIGRATION_APPLICATION_ROLES_SETTING),
      )
    ) {
      const applicationRoles = migrationApplicationRoles(schema, runtimeOptions);
      await sql`select set_config(
        ${MIGRATION_APPLICATION_ROLES_SETTING},
        ${JSON.stringify(applicationRoles)},
        false
      )`;
    }
    for (const file of files) {
      if (!selected.has(file)) {
        continue;
      }
      const sqlText = pendingMigrationSources.get(file);
      if (sqlText === undefined) {
        throw new Error(`Pending migration source was not loaded: ${file}`);
      }
      // Batched backfills and concurrent index builds are resumable, so their
      // row follows them; ordinary bodies record themselves atomically.
      await executeMigrationFile(sql, file, sqlText, { preinstalledVector, recordApplied: true });
      await sql`INSERT INTO "schema_migrations" ("name") VALUES (${file}) ON CONFLICT DO NOTHING`;
      appliedThisRun.push(file);
    }
    // Reconcile even when all migration names were already recorded. This is
    // the only supported way to change deployment policy in a live database.
    await persistDeploymentDepthPolicy(sql, depthPolicy);
    runtimeOptions?.onPhaseComplete?.({
      schemaVersion: "opengeni/migration-phase/v1",
      phase,
      applied: appliedThisRun,
      remaining: [...pendingMigrationSources.keys()].filter((file) => !selected.has(file)),
    });
  } finally {
    await sql.end();
  }
}

/**
 * SDK entry point (Step I): run the migration chain over a host-supplied admin
 * connection string against an explicit target schema. This is the embedded
 * topology's named entry — a host calls `runMigrations(adminConnection,
 * targetSchema, { applicationDatabaseRoles })` from its own provisioning code
 * instead of relying on env vars.
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

export interface MigrationPhaseResult {
  schemaVersion: "opengeni/migration-phase/v1";
  phase: MigrationPhase;
  /** Names applied by this invocation, not the cumulative database ledger. */
  applied: string[];
  remaining: string[];
}

/** Malformed or unsupported files are never deferred; execution still reports
 * their original parser error at the original point in the default path. */
export function isPostReleaseEligible(file: string, sqlText: string): boolean {
  if (migrationDeploymentMode(sqlText) !== "rolling") return false;
  const markers = migrationReleaseDirectives(sqlText);
  if (markers.has("pre-release")) return false;
  try {
    // Check backfills first: the index parser rejects other opengeni directives.
    if (parseBatchedBackfillMigration(file, sqlText)) return markers.has("post-release");
    const index = parseConcurrentIndexMigration(file, sqlText);
    return !!index && (markers.has("post-release") || !/^CREATE\s+UNIQUE\b/i.test(index.statement));
  } catch {
    return false;
  }
}

export function isPreReleaseEligible(file: string, sqlText: string): boolean {
  if (migrationDeploymentMode(sqlText) !== "rolling") return false;
  try {
    if (parseBatchedBackfillMigration(file, sqlText)) return true;
    if (parseConcurrentIndexMigration(file, sqlText)) return true;
    return ordinaryMigrationIsPostureInert(sqlText);
  } catch {
    return false;
  }
}

function phasesForMigrationSources(sources: ReadonlyMap<string, string>): MigrationPhases {
  return partitionMigrationPhases(
    [...sources].map(([name, source]) => ({
      name,
      deploymentMode: migrationDeploymentMode(source),
      preReleaseEligible: isPreReleaseEligible(name, source),
      postReleaseEligible: isPostReleaseEligible(name, source),
    })),
  );
}

export interface MigrationPlan {
  phaseProtocol: 1;
  phases: MigrationPhases;
  /** Shipped migrations this database has not applied yet, in apply order. */
  pending: { name: string; deploymentMode: MigrationDeploymentMode }[];
  /**
   * True when any pending migration is not `rolling`. Rolling migrations run
   * while the previous release keeps serving; anything else needs every
   * API/control/turn process drained before the migration job runs.
   */
  requiresDrain: boolean;
}

/**
 * Read-only: compare the shipped migration chain with the database's applied
 * list. Takes no lock and creates nothing, so it is safe to run against a live
 * deployment before deciding whether an upgrade needs a drain.
 */
export async function planMigrations(
  databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL ??
    process.env.OPENGENI_DATABASE_URL ??
    DEFAULT_DATABASE_URL,
  schema: string | undefined = process.env.OPENGENI_DB_SCHEMA?.trim() || undefined,
  migrationsDir = SHIPPED_MIGRATIONS_DIRECTORY,
): Promise<MigrationPlan> {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const sql = postgres(databaseUrl, { max: 1, ...databaseBootConnectOptions(databaseUrl) });
  let applied: Set<string>;
  try {
    if (schema) assertIdentifier("OPENGENI_DB_SCHEMA", schema);
    const qualified = `"${schema ?? "public"}"."schema_migrations"`;
    const [table] = await sql`SELECT to_regclass(${qualified}) IS NOT NULL AS present`;
    applied = table?.present
      ? new Set(
          (await sql.unsafe(`SELECT "name" FROM ${qualified}`)).map((row) => row.name as string),
        )
      : new Set();
  } finally {
    await sql.end();
  }
  if (baselineState(applied) === "adopt") {
    for (const name of BASELINE_MIGRATIONS) applied.add(name);
  }
  const pending: MigrationPlan["pending"] = [];
  const sources = new Map<string, string>();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = await readFile(join(migrationsDir, file), "utf8");
    sources.set(file, sqlText);
    pending.push({ name: file, deploymentMode: migrationDeploymentMode(sqlText) });
  }
  return {
    phaseProtocol: 1,
    phases: phasesForMigrationSources(sources),
    pending,
    requiresDrain: pending.some((migration) => migration.deploymentMode !== "rolling"),
  };
}

/** Command-line entry. Bundled release images call this explicitly; see
 * scripts/assemble-server-runtime.ts. */
export async function runMigrateCli(): Promise<void> {
  const phase = migrationPhaseFromArgs(process.argv, process.env.OPENGENI_MIGRATION_PHASE);
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify(await planMigrations(), null, 2));
  } else {
    let result: MigrationPhaseResult | undefined;
    await migrate(undefined, undefined, {
      phase,
      onPhaseComplete: (value) => {
        result = value;
      },
    });
    console.log("Applied Drizzle SQL migrations.");
    console.log(JSON.stringify(result));
  }
}

if (import.meta.main) await runMigrateCli();
