import postgres from "postgres";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import type { SharedTestDatabase } from "@opengeni/testing";
import { requireCanary } from "./sandbox-rotation-canary-evidence";

export const NATIVE_CANARY_DATABASE_OPT_IN = "LOCAL_DISPOSABLE_55434";
const CANARY_DATABASE_PREFIX = "og_rotation_canary_";
const NATIVE_ROOT = "postgres://postgres@127.0.0.1:55434/postgres";
export type CanaryDatabase = SharedTestDatabase & { appRole: string };

export function requireCanaryDatabaseAttribution(adminUrl: string): void {
  const url = new URL(adminUrl);
  const name = url.pathname.slice(1);
  requireCanary(
    url.protocol === "postgres:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "55434" &&
      url.username === "postgres" &&
      url.search === "" &&
      url.hash === "" &&
      name.startsWith(CANARY_DATABASE_PREFIX) &&
      /^[a-f0-9]{32}$/.test(name.slice(CANARY_DATABASE_PREFIX.length)),
    "unexpected database attribution",
  );
}

/** Never accepts a database URL. This endpoint is the explicit disposable local
 * PG17 fixture authorized for Sandbox rotation, not a generic provider/database target. */
export async function acquireCanaryDatabase(
  env: Record<string, string | undefined> = process.env,
): Promise<CanaryDatabase> {
  requireCanary(
    !env.OPENGENI_TEST_POSTGRES_ADMIN_URL && !env.OPENGENI_TEST_POSTGRES_APP_URL,
    "external database overrides are forbidden",
  );
  // No Docker fallback: the shared-PG template provisioner accepts ambient
  // capability/Temporal credentials and cannot provide this fixture's scope.
  requireCanary(
    env.OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES === NATIVE_CANARY_DATABASE_OPT_IN,
    "native database opt-in must name LOCAL_DISPOSABLE_55434",
  );
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const databaseName = `${CANARY_DATABASE_PREFIX}${suffix}`;
  const appRole = `sandbox_rotation_app_${suffix}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  const adminUrl = `postgres://postgres@127.0.0.1:55434/${databaseName}`;
  const appUrl = `postgres://${appRole}:${password}@127.0.0.1:55434/${databaseName}`;
  const root = postgres(NATIVE_ROOT, { max: 1, connect_timeout: 5 });
  let createdDatabase = false;
  let roleMayExist = false;
  let admin: postgres.Sql | undefined;
  let released = false;
  const release = async () => {
    if (released) return;
    const errors: unknown[] = [];
    if (admin) await admin.end().catch((error) => errors.push(error));
    // Both identifiers are generated here, never supplied by the caller. Never
    // terminate connections or drop objects in any other worker's database.
    if (createdDatabase) {
      try {
        await root`DROP DATABASE ${root(databaseName)} WITH (FORCE)`;
        createdDatabase = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (roleMayExist && !createdDatabase) {
      try {
        await root`DROP ROLE IF EXISTS ${root(appRole)}`;
        roleMayExist = false;
      } catch (error) {
        errors.push(error);
      }
    }
    await root.end().catch((error) => errors.push(error));
    released = true;
    if (errors.length)
      throw new AggregateError(
        errors,
        `Exact canary fixture cleanup failed: ${databaseName}/${appRole}`,
      );
  };
  try {
    const [server] = await root`select current_setting('server_version_num')::int as version,
      current_user as login, (select rolsuper from pg_roles where rolname=current_user) as superuser,
      exists(select 1 from pg_available_extensions where name='vector') as vector`;
    requireCanary(
      server?.login === "postgres" &&
        server.superuser &&
        server.vector &&
        server.version >= 170000 &&
        server.version < 180000,
      "expected disposable PG17 + pgvector fixture",
    );
    await root`CREATE DATABASE ${root(databaseName)}`;
    createdDatabase = true;
    const roleOptions = {
      appRole,
      appPassword: password,
      rlsStrategy: "force" as const,
      targetSchema: "public",
      // Explicit empty passwords prevent ambient deployment credentials from
      // creating/altering unrelated cluster-global capability/Temporal roles.
      artifactOutboxDispatcherRole: `${appRole}_outbox`,
      artifactOutboxDispatcherPassword: "",
      artifactMaterializerRole: `${appRole}_materializer`,
      artifactMaterializerPassword: "",
      hostExportRole: `${appRole}_export`,
      hostExportPassword: "",
      temporalRole: `${appRole}_temporal`,
      temporalPassword: "",
      temporalDatabases: [],
    };
    roleMayExist = true;
    await provisionRoles(adminUrl, roleOptions);
    // Pass schema explicitly so ambient OPENGENI_DB_SCHEMA cannot redirect the
    // fixture. Maintenance migrations know only this unique application login.
    await migrate(adminUrl, "public", { applicationDatabaseRoles: [appRole] });
    await provisionRoles(adminUrl, roleOptions);
    admin = postgres(adminUrl, { max: 4 });
    return { admin, adminUrl, appUrl, appRole, release };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "Canary DB initialization/cleanup failed",
        {
          cause: cleanupError,
        },
      );
      throw failure;
    }
    throw error;
  }
}
