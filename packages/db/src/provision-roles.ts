import postgres from "postgres";
import type { RlsStrategy } from "./index";
import { RUNTIME_DML_TABLES } from "./runtime-posture";

export type ProvisionResult = {
  appRole: string | null;
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
      // Ownership and role-graph edges cannot be safely guessed away. Refuse to
      // mutate an existing role until an operator has explicitly transferred
      // objects/removed memberships; role attributes and direct grants, however,
      // are deterministic and are converged below on every run.
      await assertAppRoleSafeToNormalize(sql, appRole);
      await ensureRestrictedAppLoginRole(sql, appRole, appPassword);
      provisionedAppRole = appRole;
    }

    if (temporalPassword) {
      await ensureLoginRole(sql, temporalRole, temporalPassword);
      for (const database of temporalDatabases) {
        await ensureDatabase(sql, database, temporalRole);
        await grantTemporalRoleInDatabase(adminConnection, database, temporalRole);
      }
    }

    if (rlsStrategy === "force") {
      await grantAppRoleIfSchemaExists(sql, appRole, schema);
    }

    return {
      appRole: provisionedAppRole,
      temporalRole: temporalPassword ? temporalRole : null,
      temporalDatabases: temporalPassword ? temporalDatabases : [],
      schema,
      rlsStrategy,
    };
  } finally {
    await sql.end();
  }
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

async function ensureRestrictedAppLoginRole(
  sql: postgres.Sql,
  role: string,
  password: string,
): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(role)}) THEN
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD %L',
      ${literal(role)},
      ${literal(password)}
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT PASSWORD %L',
      ${literal(role)},
      ${literal(password)}
    );
  END IF;
END $$;
`);
}

/**
 * Fail rather than silently revoking role relationships or transferring owned
 * objects. Those operations have effects outside OpenGeni's runtime grant
 * contract and require an explicit, audited operator decision.
 */
async function assertAppRoleSafeToNormalize(sql: postgres.Sql, role: string): Promise<void> {
  const exists = await sql<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = ${role}) as exists
  `;
  if (!exists[0]?.exists) {
    return;
  }

  const memberships = await sql<{ relationship: string }[]>`
    select ('inherits:' || parent.rolname)::text as relationship
    from pg_auth_members membership
    join pg_roles member on member.oid = membership.member
    join pg_roles parent on parent.oid = membership.roleid
    where member.rolname = ${role}
    union all
    select ('member:' || member.rolname)::text as relationship
    from pg_auth_members membership
    join pg_roles member on member.oid = membership.member
    join pg_roles parent on parent.oid = membership.roleid
    where parent.rolname = ${role}
    order by relationship
  `;
  if (memberships.length > 0) {
    throw new Error(
      `Refusing to normalize app role ${role}: remove role relationships first (${memberships
        .map((row) => row.relationship)
        .join(", ")})`,
    );
  }

  const ownedObjects = await sql<{ object_name: string }[]>`
    select ('database:' || d.datname)::text as object_name
    from pg_database d
    join pg_roles owner on owner.oid = d.datdba
    where owner.rolname = ${role}
    union all
    select ('schema:' || n.nspname)::text as object_name
    from pg_namespace n
    join pg_roles owner on owner.oid = n.nspowner
    where owner.rolname = ${role}
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    union all
    select ('relation:' || n.nspname || '.' || c.relname)::text as object_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles owner on owner.oid = c.relowner
    where owner.rolname = ${role}
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    union all
    select (
      'routine:' || n.nspname || '.' || p.proname || '(' ||
      pg_get_function_identity_arguments(p.oid) || ')'
    )::text as object_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles owner on owner.oid = p.proowner
    where owner.rolname = ${role}
      and n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    order by object_name
  `;
  if (ownedObjects.length > 0) {
    throw new Error(
      `Refusing to normalize app role ${role}: transfer owned objects first (${ownedObjects
        .map((row) => row.object_name)
        .join(", ")})`,
    );
  }
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
  const runtimeDmlTables = `ARRAY[${RUNTIME_DML_TABLES.map(literal).join(", ")}]`;
  await sql.unsafe(`
DO $$
DECLARE
  owner_role text := current_user;
  runtime_table text;
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', current_database(), ${literal(role)});
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${literal(schema)}) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I', ${literal(schema)}, ${literal(role)});
    FOREACH runtime_table IN ARRAY ${runtimeDmlTables} LOOP
      IF to_regclass(format('%I.%I', ${literal(schema)}, runtime_table)) IS NOT NULL THEN
        EXECUTE format(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
          ${literal(schema)},
          runtime_table,
          ${literal(role)}
        );
      END IF;
    END LOOP;
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', ${literal(schema)}, ${literal(role)});
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL PRIVILEGES ON TABLES FROM %I',
      owner_role,
      ${literal(schema)},
      ${literal(role)}
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
      owner_role,
      ${literal(schema)},
      ${literal(role)}
    );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_private') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format('REVOKE CREATE ON SCHEMA opengeni_private FROM %I', ${literal(role)});
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA opengeni_private GRANT EXECUTE ON FUNCTIONS TO %I',
      owner_role,
      ${literal(role)}
    );
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
