/**
 * Migration 1482: opengeni_private.nango_connections_in_use_v1 answers which
 * Nango connections a live row still stands for, deployment-wide. It runs as
 * the table owner, which FORCE ROW LEVEL SECURITY binds too, so it must read
 * through the one-transaction tenancy inventory window when migrated by a role
 * without BYPASSRLS (as in production), close that window again, and leave the
 * runtime role seeing only its own rows.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  nangoConnectionsInUse,
  revokeConnection,
  type DbClient,
} from "../src/index";
import { sql } from "drizzle-orm";
import { rawRows } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(60_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("nango-connections-in-use");
  if (!owned) {
    if (requireRealDatabase) throw new Error("owner-migrated PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 60_000);

async function nangoRow(nangoConnectionId: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `in-use-${suffix}`,
    accountName: "In use",
    workspaceExternalSource: "test",
    workspaceExternalId: `in-use-${suffix}`,
    workspaceName: "In use workspace",
    subjectId: `user:in-use-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const connection = await createConnection(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    providerDomain: "nango:gmail",
    kind: "oauth2",
    credentialEncrypted: "test-encrypted",
    metadata: { integrationBackend: "nango", nangoConnectionId },
    createdBySubjectId: grant.subjectId,
  });
  return { grant, connection };
}

describe("migration 1482: Nango connections in use", () => {
  test("the owner-run check sees every live row; without the runtime grant it answers nothing", async () => {
    if (!owned) return;
    await nangoRow("in-use-live");
    const revoked = await nangoRow("in-use-revoked");
    await revokeConnection(
      client!.db,
      revoked.grant.workspaceId!,
      revoked.connection.id,
      revoked.grant.subjectId,
    );
    const ids = ["in-use-live", "in-use-revoked", "in-use-unknown"];
    // 1482 created it withheld (1494 grants it): without the grant, no answer.
    await owned.admin.unsafe(
      "REVOKE EXECUTE ON FUNCTION opengeni_private.nango_connections_in_use_v1(text[]) FROM opengeni_app",
    );
    expect(await nangoConnectionsInUse(client!.db, ids)).toBeNull();
    await owned.admin.unsafe(
      "GRANT EXECUTE ON FUNCTION opengeni_private.nango_connections_in_use_v1(text[]) TO opengeni_app",
    );
    // Without any workspace context, as the sweep and disconnect call it.
    expect([...(await nangoConnectionsInUse(client!.db, ids))!]).toEqual(["in-use-live"]);
    // The inventory window it opened is closed again.
    const [windows] = await owned.admin.unsafe(
      "select count(*)::text as count from opengeni_private.organization_tenancy_inventory_capabilities",
    );
    expect(windows?.count).toBe("0");
    // It never widens what the runtime role reads itself.
    const [visible] = await rawRows<{ count: string }>(
      client!.db,
      sql`select count(*)::text as count from connections`,
    );
    expect(visible?.count).toBe("0");
  }, 120_000);

  test("it closes only the window it opened, and works twice in one transaction", async () => {
    if (!owned) return;
    await nangoRow("in-use-window");
    const windows = `select count(*)::text as count
      from opengeni_private.organization_tenancy_inventory_capabilities
      where backend_pid = pg_backend_pid() and transaction_id = pg_current_xact_id()`;
    const call = `select nango_connection_id
      from opengeni_private.nango_connections_in_use_v1(array['in-use-window'])`;
    await owned.admin.begin(async (tx) => {
      // Called twice in one transaction, it opens and closes its own window each time.
      expect((await tx.unsafe(call)).map((row) => row.nango_connection_id)).toEqual([
        "in-use-window",
      ]);
      expect((await tx.unsafe(call)).map((row) => row.nango_connection_id)).toEqual([
        "in-use-window",
      ]);
      expect((await tx.unsafe(windows))[0]?.count).toBe("0");
      // A window the caller opened before stays open afterwards.
      await tx.unsafe(`insert into opengeni_private.organization_tenancy_inventory_capabilities
        (backend_pid, transaction_id) values (pg_backend_pid(), pg_current_xact_id())`);
      expect((await tx.unsafe(call)).map((row) => row.nango_connection_id)).toEqual([
        "in-use-window",
      ]);
      expect((await tx.unsafe(windows))[0]?.count).toBe("1");
      await tx.unsafe(`delete from opengeni_private.organization_tenancy_inventory_capabilities
        where backend_pid = pg_backend_pid() and transaction_id = pg_current_xact_id()`);
    });
  }, 120_000);

  test("more ids than one call answers are refused, never read as unused", async () => {
    if (!owned) return;
    await nangoRow("in-use-limit-0");
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `in-use-limit-${index}`);
    const call = (count: number) =>
      owned!.admin.unsafe(
        `select nango_connection_id
          from opengeni_private.nango_connections_in_use_v1($1::text[])`,
        [ids(count)],
      );
    expect((await call(1000)).map((row) => row.nango_connection_id)).toEqual(["in-use-limit-0"]);
    const refused = await call(1001).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(refused?.code).toBe("22023");
    expect(refused?.message).toContain("at most 1000 Nango connection ids per call");
  }, 120_000);
});
