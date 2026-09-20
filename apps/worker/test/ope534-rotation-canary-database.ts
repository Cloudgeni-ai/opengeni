import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { requireCanary } from "./ope534-rotation-canary-evidence";

export const NATIVE_CANARY_DATABASE_OPT_IN = "LOCAL_DISPOSABLE_55434";
const NATIVE_ROOT = "postgres://postgres@127.0.0.1:55434/postgres";
export type CanaryDatabase = SharedTestDatabase & { appRole: string };

/** Never accepts a database URL. This endpoint is the explicit disposable local
 * PG17 fixture authorized for OPE534, not a generic provider/database target. */
export async function acquireCanaryDatabase(
  env: Record<string, string | undefined> = process.env,
): Promise<CanaryDatabase> {
  requireCanary(
    !env.OPENGENI_TEST_POSTGRES_ADMIN_URL && !env.OPENGENI_TEST_POSTGRES_APP_URL,
    "external database overrides are forbidden",
  );
  if (!env.OPENGENI_OPE534_NATIVE_POSTGRES) {
    requireCanary(
      (!env.DOCKER_HOST || env.DOCKER_HOST.startsWith("unix://")) &&
        (!env.DOCKER_CONTEXT || env.DOCKER_CONTEXT === "default"),
      "use local Docker only",
    );
    let endpoint: unknown;
    try {
      endpoint = JSON.parse(
        execFileSync(
          "docker",
          ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ),
      );
    } catch {
      throw new Error("OPE534 canary: local Docker context is unavailable");
    }
    requireCanary(
      typeof endpoint === "string" && endpoint.startsWith("unix://"),
      "refusing remote Docker",
    );
    const shared = await acquireSharedTestDatabase("ope534_rotation_canary");
    requireCanary(shared, "isolated Docker database unavailable (not a skip)");
    return { ...shared, appRole: "opengeni_app" };
  }
  requireCanary(
    env.OPENGENI_OPE534_NATIVE_POSTGRES === NATIVE_CANARY_DATABASE_OPT_IN,
    "native database opt-in must name LOCAL_DISPOSABLE_55434",
  );
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const databaseName = `og_ope534_rotation_canary_${suffix}`;
  const appRole = `ope534_app_${suffix}`;
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
      throw new AggregateError([error, cleanupError], "Canary DB initialization/cleanup failed");
    }
    throw error;
  }
}
