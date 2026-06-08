import postgres from "postgres";

type ProvisionResult = {
  appRole: string;
  temporalRole: string | null;
  temporalDatabases: string[];
};

const adminUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL
  ?? process.env.OPENGENI_DATABASE_ADMIN_URL
  ?? process.env.OPENGENI_DATABASE_URL;

if (!adminUrl) {
  throw new Error("OPENGENI_MIGRATIONS_DATABASE_URL, OPENGENI_DATABASE_ADMIN_URL, or OPENGENI_DATABASE_URL is required");
}

const appRole = envName("OPENGENI_APP_DATABASE_USER", "opengeni_app");
const appPassword = requiredEnv("OPENGENI_APP_DATABASE_PASSWORD");
const temporalRole = optionalEnvName("OPENGENI_TEMPORAL_DATABASE_USER", "opengeni_temporal");
const temporalPassword = process.env.OPENGENI_TEMPORAL_DATABASE_PASSWORD;
const temporalDatabases = commaSeparated(process.env.OPENGENI_TEMPORAL_DATABASES ?? "temporal,temporal_visibility")
  .map((name) => validateIdentifier("OPENGENI_TEMPORAL_DATABASES", name));

const sql = postgres(adminUrl, { max: 1 });
try {
  await ensureLoginRole(sql, appRole, appPassword);
  if (temporalPassword) {
    await ensureLoginRole(sql, temporalRole, temporalPassword);
    for (const database of temporalDatabases) {
      await ensureDatabase(sql, database, temporalRole);
      await grantTemporalRoleInDatabase(adminUrl, database, temporalRole);
    }
  }
  await grantAppRoleIfSchemaExists(sql, appRole);
  const result: ProvisionResult = {
    appRole,
    temporalRole: temporalPassword ? temporalRole : null,
    temporalDatabases: temporalPassword ? temporalDatabases : [],
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end();
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
  await sql.unsafe(`GRANT ALL PRIVILEGES ON DATABASE ${identifier(database)} TO ${identifier(owner)}`);
}

async function grantTemporalRoleInDatabase(adminUrl: string, database: string, role: string): Promise<void> {
  const databaseUrl = databaseUrlFor(adminUrl, database);
  const databaseSql = postgres(databaseUrl, { max: 1 });
  try {
    await databaseSql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${identifier(role)}`);
  } finally {
    await databaseSql.end();
  }
}

async function grantAppRoleIfSchemaExists(sql: postgres.Sql, role: string): Promise<void> {
  await sql.unsafe(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', ${literal(role)});
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', ${literal(role)});
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'opengeni_private') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', ${literal(role)});
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO %I', ${literal(role)});
  END IF;
END $$;
`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envName(name: string, fallback: string): string {
  return validateIdentifier(name, process.env[name]?.trim() || fallback);
}

function optionalEnvName(name: string, fallback: string): string {
  return validateIdentifier(name, process.env[name]?.trim() || fallback);
}

function commaSeparated(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function validateIdentifier(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} contains an invalid Postgres identifier: ${value}`);
  }
  return value;
}

function identifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function databaseUrlFor(value: string, database: string): string {
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}
