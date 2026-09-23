/** Optional infrastructure-only bridge for running unchanged DB/owner-migrated
 * worker tests on an explicitly prepared native PostgreSQL fixture. It replaces
 * Docker allocation only; migrations, FORCE-RLS, DB methods and worker behavior
 * remain real. The launching command owns cluster/database cleanup. */
import { mock } from "bun:test";
import postgres from "postgres";
import * as testing from "@opengeni/testing";

const adminUrl = process.env.MCP_LEDGER_TEST_ADMIN_URL;
const ownerUrl = process.env.MCP_LEDGER_TEST_OWNER_URL;
if (!adminUrl || !ownerUrl)
  throw new Error("Native owner fixture requires explicit admin and owner URLs");
if (new URL(adminUrl).pathname !== new URL(ownerUrl).pathname)
  throw new Error("Native owner fixture database mismatch");
const originalTesting = { ...testing };
mock.module("@opengeni/testing", () => ({
  ...originalTesting,
  acquireSharedTestDatabase: async (): Promise<testing.SharedTestDatabase> => {
    const admin = postgres(adminUrl, { max: 4 });
    const appUrl = new URL(adminUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = "ledger-test-only";
    return {
      admin,
      adminUrl,
      appUrl: appUrl.toString(),
      release: async () => {
        await admin.end();
      },
    };
  },
  acquireOwnerMigratedTestDatabase: async (): Promise<testing.OwnerMigratedTestDatabase> => {
    const admin = postgres(adminUrl, { max: 4 });
    return {
      admin,
      adminUrl,
      ownerUrl,
      ownerRole: new URL(ownerUrl).username,
      appPassword: "ledger-test-only",
      release: async () => {
        await admin.end();
      },
    };
  },
}));
