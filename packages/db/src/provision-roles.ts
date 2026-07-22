import postgres from "postgres";
import type { RlsStrategy } from "./index";

export type ProvisionResult = {
  appRole: string | null;
  hostExportRole: string | null;
  temporalRole: string | null;
  temporalDatabases: string[];
  schema: string;
  rlsStrategy: RlsStrategy;
};

export type ProvisionRolesOptions = {
  /**
   * The schema OpenGeni's tables live in. The app-role GRANTs target this
   * schema + `opengeni_private`. Defaults to `public` (standalone).
   */
  targetSchema?: string;
  /**
   * RLS posture (Step I). `"force"` (default) provisions the non-owner
   * `opengeni_app` login role and GRANTs it table DML in the target schema —
   * the role OpenGeni connects as under FORCE-RLS. `"scoped"` SKIPS the app-role
   * provisioning entirely: the embedded host runs OpenGeni's queries over a role
   * IT owns/manages (typically the schema owner), so OpenGeni neither creates
   * nor grants the `opengeni_app` role. Temporal-role provisioning is unaffected
   * by strategy.
   */
  rlsStrategy?: RlsStrategy;
  appRole?: string;
  appPassword?: string;
  /**
   * Optional cross-workspace projection role. It receives schema USAGE and
   * EXECUTE only on the host-export API; it receives no table privileges.
   * Provision it after the first migration run so the schema exists. The
   * provisioner also registers same-owner default privileges for future
   * host-export functions; shipped migrations preserve existing exporter ACLs
   * when a migration-only upgrade adds a function.
   */
  hostExportRole?: string;
  hostExportPassword?: string;
  temporalRole?: string;
  temporalPassword?: string;
  temporalDatabases?: string[];
};

/**
 * SDK entry point (Step I): provision the OpenGeni database roles + grants over
 * a host-supplied admin connection. This is the named, parameterized form of the
 * historical env-driven `provision-roles` script (which still works as a CLI via
 * the `import.meta.main` block at the bottom — it just reads env into these
 * options).
 *
 * STANDALONE (default): `provisionRoles(adminConnection)` with no options →
 * `targetSchema: "public"`, `rlsStrategy: "force"`, reads `opengeni_app` creds
 * from env. Byte-for-byte the historical script behavior.
 *
 * EMBEDDED: `provisionRoles(adminConnection, { targetSchema, rlsStrategy })` lets
 * a host provision the app role over a dedicated schema (force) OR skip the
 * app role entirely and own the connection role itself (scoped).
 */
export async function provisionRoles(
  adminConnection: string,
  options: ProvisionRolesOptions = {},
): Promise<ProvisionResult> {
  const schema = validateIdentifier("targetSchema", options.targetSchema ?? "public");
  const rlsStrategy: RlsStrategy = options.rlsStrategy ?? "force";

  const appRole = validateIdentifier(
    "appRole",
    options.appRole ?? (process.env.OPENGENI_APP_DATABASE_USER?.trim() || "opengeni_app"),
  );
  const appPassword = options.appPassword ?? process.env.OPENGENI_APP_DATABASE_PASSWORD;
  const hostExportRole = validateIdentifier(
    "hostExportRole",
    options.hostExportRole ??
      (process.env.OPENGENI_HOST_EXPORT_DATABASE_USER?.trim() || "opengeni_host_exporter"),
  );
  const hostExportPassword =
    options.hostExportPassword ?? process.env.OPENGENI_HOST_EXPORT_DATABASE_PASSWORD;
  const temporalRole = validateIdentifier(
    "temporalRole",
    options.temporalRole ??
      (process.env.OPENGENI_TEMPORAL_DATABASE_USER?.trim() || "opengeni_temporal"),
  );
  const temporalPassword =
    options.temporalPassword ?? process.env.OPENGENI_TEMPORAL_DATABASE_PASSWORD;
  const temporalDatabases = (
    options.temporalDatabases ??
    commaSeparated(process.env.OPENGENI_TEMPORAL_DATABASES ?? "temporal,temporal_visibility")
  ).map((name) => validateIdentifier("temporalDatabases", name));

  const sql = postgres(adminConnection, { max: 1 });
  try {
    // FORCE strategy provisions the non-owner app role OpenGeni connects as.
    // SCOPED strategy: the host owns the connection role; OpenGeni provisions no
    // app role (skipped here), only the optional Temporal role.
    let provisionedAppRole: string | null = null;
    if (rlsStrategy === "force") {
      if (!appPassword) {
        throw new Error(
          "OPENGENI_APP_DATABASE_PASSWORD (or appPassword) is required for rlsStrategy 'force'",
        );
      }
      await ensureLoginRole(sql, appRole, appPassword);
      provisionedAppRole = appRole;
    }

    if (temporalPassword) {
      await ensureLoginRole(sql, temporalRole, temporalPassword);
      for (const database of temporalDatabases) {
        await ensureDatabase(sql, database, temporalRole);
        await grantTemporalRoleInDatabase(adminConnection, database, temporalRole);
      }
    }

    if (hostExportPassword) {
      await ensureLoginRole(sql, hostExportRole, hostExportPassword);
      await grantHostExportRoleIfSchemaExists(sql, hostExportRole);
    }

    if (rlsStrategy === "force") {
      await grantAppRoleIfSchemaExists(sql, appRole, schema);
    }

    return {
      appRole: provisionedAppRole,
      hostExportRole: hostExportPassword ? hostExportRole : null,
      temporalRole: temporalPassword ? temporalRole : null,
      temporalDatabases: temporalPassword ? temporalDatabases : [],
      schema,
      rlsStrategy,
    };
  } finally {
    await sql.end();
  }
}

/**
 * The exporter is intentionally separate from `opengeni_app`: its functions
 * project every workspace into a host-owned sink and therefore cannot be made
 * available to the tenant-scoped application role.
 */
async function grantHostExportRoleIfSchemaExists(sql: postgres.Sql, role: string): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_host_export') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_host_export TO %I', ${literal(role)});
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_host_export TO %I', ${literal(role)});
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_host_export GRANT EXECUTE ON FUNCTIONS TO %I', ${literal(role)});
  END IF;
END $$;
`);
}

async function ensureLoginRole(sql: postgres.Sql, role: string, password: string): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', ${literal(role)}, ${literal(password)});
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', ${literal(role)}, ${literal(password)});
  END IF;
END $$;
`);
}

async function ensureDatabase(sql: postgres.Sql, database: string, owner: string): Promise<void> {
  const existing = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_database where datname = ${database}) as exists
  `;
  if (!existing[0]?.exists) {
    await sql.unsafe(`CREATE DATABASE ${identifier(database)} OWNER ${identifier(owner)}`);
  }
  await sql.unsafe(
    `GRANT ALL PRIVILEGES ON DATABASE ${identifier(database)} TO ${identifier(owner)}`,
  );
}

async function grantTemporalRoleInDatabase(
  adminConnection: string,
  database: string,
  role: string,
): Promise<void> {
  const databaseUrl = databaseUrlFor(adminConnection, database);
  const databaseSql = postgres(databaseUrl, { max: 1 });
  try {
    await databaseSql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(role)}`);
  } finally {
    await databaseSql.end();
  }
}

/**
 * Grant the app role table DML in the OpenGeni data schema + EXECUTE on the
 * `opengeni_private` helper functions. Schema-parameterized (Step I): standalone
 * passes `public`; embedded passes the dedicated schema. The grants are guarded
 * on schema existence so provisioning before migrate is a safe no-op.
 */
async function grantAppRoleIfSchemaExists(
  sql: postgres.Sql,
  role: string,
  schema: string,
): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${literal(schema)}) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', ${literal(schema)}, ${literal(role)});
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_private') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO %I', ${literal(role)});
  END IF;
END $$;
`);
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} contains an invalid Postgres identifier: ${value}`);
  }
  return value;
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function databaseUrlFor(value: string, database: string): string {
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}

// CLI form (unchanged behavior): read env into the SDK options and run. This is
// what `bun src/provision-roles.ts` / the `provision-roles` package script
// invokes — standalone byte-for-byte the historical script (public schema,
// force strategy, env-driven creds).
if (import.meta.main) {
  const adminUrl =
    process.env.OPENGENI_MIGRATIONS_DATABASE_URL ??
    process.env.OPENGENI_DATABASE_ADMIN_URL ??
    process.env.OPENGENI_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "OPENGENI_MIGRATIONS_DATABASE_URL, OPENGENI_DATABASE_ADMIN_URL, or OPENGENI_DATABASE_URL is required",
    );
  }
  const result = await provisionRoles(adminUrl, {
    ...(process.env.OPENGENI_DB_SCHEMA?.trim()
      ? { targetSchema: process.env.OPENGENI_DB_SCHEMA.trim() }
      : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}
