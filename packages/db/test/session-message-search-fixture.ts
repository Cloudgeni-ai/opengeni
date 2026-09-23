import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

/** Docker by default; an explicit disposable native test cluster is useful in
 * sandboxes without a Docker socket. Always create an isolated database and a
 * non-superuser application role with the production FORCE-RLS grant contract.
 */
export async function acquireSearchTestDatabase(label: string): Promise<SharedTestDatabase> {
  const nativeUrl = process.env.OPENGENI_SESSION_SEARCH_TEST_ADMIN_URL;
  if (!nativeUrl) {
    const shared = await acquireSharedTestDatabase(label);
    if (!shared)
      throw new Error(
        "Real PostgreSQL required: Docker unavailable and OPENGENI_SESSION_SEARCH_TEST_ADMIN_URL unset",
      );
    return shared;
  }
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const databaseName = `search_test_${suffix}`;
  const appRole = `search_app_${suffix}`;
  const appPassword = crypto.randomUUID();
  const root = postgres(nativeUrl, { max: 1 });
  const url = new URL(nativeUrl);
  url.pathname = `/${databaseName}`;
  const adminUrl = url.toString();
  let admin: postgres.Sql | undefined;
  let created = false;
  try {
    await root.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(adminUrl);
    await provisionRoles(adminUrl, { appRole, appPassword, rlsStrategy: "force" });
    url.username = appRole;
    url.password = appPassword;
    admin = postgres(adminUrl, { max: 4 });
    let released = false;
    return {
      admin,
      adminUrl,
      appUrl: url.toString(),
      release: async () => {
        if (released) return;
        released = true;
        await admin!.end();
        await root.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        await root.unsafe(`DROP ROLE "${appRole}"`);
        await root.end();
      },
    };
  } catch (error) {
    await admin?.end();
    if (created) await root.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await root.unsafe(`DROP ROLE IF EXISTS "${appRole}"`);
    await root.end();
    throw error;
  }
}
