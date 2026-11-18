/**
 * Migration 1487: opengeni_private.nango_live_connection_owners_v1 pages
 * through every active Nango row's owner, integration and Nango connection
 * id, deployment-wide. Like 1482 it runs as the table owner, which FORCE ROW
 * LEVEL SECURITY binds too, so it must read through the one-transaction
 * tenancy inventory window, close it again, and leave the runtime role
 * seeing only its own rows. It was created withheld; 1494 grants it.
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
  listNangoLiveConnectionOwners,
  revokeConnection,
  setConnectionStatus,
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

const ROUTINE = "opengeni_private.nango_live_connection_owners_v1(text, text, text, integer)";

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("nango-live-connection-owners");
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

async function nangoRow(nangoConnectionId: string, providerConfigKey = "google-mail") {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `owners-${suffix}`,
    accountName: "Owners",
    workspaceExternalSource: "test",
    workspaceExternalId: `owners-${suffix}`,
    workspaceName: "Owners workspace",
    subjectId: `user:owners-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const connection = await createConnection(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    providerDomain: "nango:gmail",
    kind: "oauth2",
    credentialEncrypted: "test-encrypted",
    metadata: {
      integrationBackend: "nango",
      nangoConnectionId,
      nangoProviderConfigKey: providerConfigKey,
    },
    createdBySubjectId: grant.subjectId,
  });
  return { grant, connection };
}

describe("migration 1487: live Nango connection owners", () => {
  test("the owner-run listing pages through active rows only; without the runtime grant it answers nothing", async () => {
    if (!owned) return;
    const live = await nangoRow("owners-live");
    const second = await nangoRow("owners-second");
    const revoked = await nangoRow("owners-revoked");
    await revokeConnection(
      client!.db,
      revoked.grant.workspaceId!,
      revoked.connection.id,
      revoked.grant.subjectId,
    );
    const reauth = await nangoRow("owners-reauth");
    expect(
      await setConnectionStatus(
        client!.db,
        reauth.grant.workspaceId!,
        "needs_reauth",
        "nango_refresh_failed",
        {
          id: reauth.connection.id,
          version: reauth.connection.version,
          subjectId: reauth.grant.subjectId,
        },
      ),
    ).toBe(true);
    // 1487 created it withheld (1494 grants it): without the grant, no answer.
    await owned.admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${ROUTINE} FROM opengeni_app`);
    expect(await listNangoLiveConnectionOwners(client!.db)).toBeNull();
    await owned.admin.unsafe(`GRANT EXECUTE ON FUNCTION ${ROUTINE} TO opengeni_app`);
    try {
      // Without any workspace context, as the sweep calls it; one row per page.
      const owners = await listNangoLiveConnectionOwners(client!.db, { pageSize: 1 });
      expect(owners).toEqual(
        [
          {
            subjectId: live.grant.subjectId,
            providerConfigKey: "google-mail",
            nangoConnectionId: "owners-live",
          },
          {
            subjectId: second.grant.subjectId,
            providerConfigKey: "google-mail",
            nangoConnectionId: "owners-second",
          },
        ].sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1)),
      );
      expect(await listNangoLiveConnectionOwners(client!.db, { pageSize: 1, maxRows: 1 })).toEqual(
        owners!.slice(0, 1),
      );
    } finally {
      await owned.admin.unsafe(`GRANT EXECUTE ON FUNCTION ${ROUTINE} TO opengeni_app`);
    }
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

  test("it closes only the window it opened, and refuses a page size out of range", async () => {
    if (!owned) return;
    const windows = `select count(*)::text as count
      from opengeni_private.organization_tenancy_inventory_capabilities
      where backend_pid = pg_backend_pid() and transaction_id = pg_current_xact_id()`;
    const call = (limit: number) =>
      `select nango_connection_id
        from opengeni_private.nango_live_connection_owners_v1(null, null, null, ${limit})`;
    await owned.admin.begin(async (tx) => {
      expect((await tx.unsafe(call(1000))).length).toBeGreaterThan(0);
      expect((await tx.unsafe(windows))[0]?.count).toBe("0");
      // A window the caller opened before stays open afterwards.
      await tx.unsafe(`insert into opengeni_private.organization_tenancy_inventory_capabilities
        (backend_pid, transaction_id) values (pg_backend_pid(), pg_current_xact_id())`);
      await tx.unsafe(call(1));
      expect((await tx.unsafe(windows))[0]?.count).toBe("1");
      await tx.unsafe(`delete from opengeni_private.organization_tenancy_inventory_capabilities
        where backend_pid = pg_backend_pid() and transaction_id = pg_current_xact_id()`);
    });
    for (const limit of [0, 1001]) {
      const refused = await owned.admin.unsafe(call(limit)).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
      expect(refused?.code).toBe("22023");
    }
  }, 120_000);
});
