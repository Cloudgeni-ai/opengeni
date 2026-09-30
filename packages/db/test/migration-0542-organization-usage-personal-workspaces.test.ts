import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  ensureManagedAccessForUser,
  getOrganizationUsageSummary,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationPath = new URL(
  "../drizzle/0542_organization_usage_personal_workspaces.sql",
  import.meta.url,
);
const signature =
  "opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("org-usage-personal");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Organization usage Personal rows owner-RLS fixture unavailable");
    console.warn("SKIPPED 0542 owner/FORCE-RLS Personal usage assertions: PostgreSQL unavailable");
    return;
  }
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 180_000);

describe("0542 organization usage Personal workspace rows", () => {
  test("source replaces only the aggregate, keeps the shared inventory and restores scope", async () => {
    const source = await readFile(migrationPath, "utf8");
    expect(source.split("\n")[0]).toBe("-- deployment-mode: rolling");
    // Same signature, so the 0473 ACL, owner and runtime-posture contract stay.
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.organization_usage_summary(",
    );
    expect(source).toContain(
      "id IN (SELECT workspace_id FROM %1$I.list_organization_workspace_ids(context_account_id))",
    );
    expect(source).toContain("usage_row.session_id IS NULL OR session_row.id IS NOT NULL");
    expect(source).toContain(
      "PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);",
    );
    // Personal rows name the membership, never the workspace.
    expect(source).toContain(
      "jsonb_build_object('membershipId', ranked.membership_id, 'totals', ranked.totals)",
    );
    expect(source).not.toMatch(/'personalWorkspaces'[^;]*'workspaceId'/s);
    expect(source).not.toMatch(
      /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|row_security\s*=\s*off|CREATE POLICY|ALTER POLICY/i,
    );
  });

  test("a non-bypass owner lists Personal usage by membership under FORCE RLS", async () => {
    if (!owned || !client) return;
    const [grants] = await owned.admin`select
      has_function_privilege('opengeni_app', ${signature}, 'EXECUTE') as app,
      has_function_privilege('public', ${signature}, 'EXECUTE') as public`;
    expect(grants).toMatchObject({ app: true, public: false });
    const userId = `org-usage-personal-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Personal usage",
    });
    const grant = access.workspaceGrants[0]!;
    const [pointer] = await owned.admin<Array<{ id: string; personal_workspace_id: string }>>`
      select id, personal_workspace_id from organization_memberships
      where account_id = ${grant.accountId} and subject_id = ${`user:${userId}`}`;
    expect(pointer?.personal_workspace_id).toBeTruthy();
    for (const [workspaceId, quantity] of [
      [grant.workspaceId!, 40],
      [pointer!.personal_workspace_id, 9],
    ] as const) {
      await owned.admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at)
        values (${grant.accountId}, ${workspaceId}, 'model.cost', ${quantity}, 'usd_micros', ${crypto.randomUUID()}, '2026-09-05T00:00:00Z')`;
    }
    const summary = await withSessionRlsActorContext({ subjectId: "user:billing-reader" }, () =>
      getOrganizationUsageSummary(
        client!.db,
        { accountId: grant.accountId, period: "month" },
        new Date("2026-09-14T00:00:00Z"),
      ),
    );
    expect(summary.totals.find((total) => total.eventType === "model.cost")?.quantity).toBe("49");
    expect(summary.workspaces.map((row) => row.workspaceId)).toEqual([grant.workspaceId!]);
    expect(summary.personalWorkspaceCount).toBe(1);
    expect(summary.personalWorkspaces).toEqual([
      {
        membershipId: pointer!.id,
        totals: [{ eventType: "model.cost", unit: "usd_micros", quantity: "9", eventCount: "1" }],
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain(pointer!.personal_workspace_id);
    const [count] =
      await owned.admin`select count(*)::int as count from opengeni_private.organization_usage_read_capabilities`;
    expect(count!.count).toBe(0);
  }, 180_000);
});
