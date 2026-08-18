// Migration 0283: the read-only organization tenancy inventory seam counts
// every legacy-attribution population the backfill/parity program gates on -
// integers only, exact-organization scoped, application-role executable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createDb,
  createSession,
  inventoryOrganizationTenancy,
  type Database,
  type DbClient,
} from "../src";

const migrationUrl = new URL("../drizzle/0283_organization_tenancy_inventory.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0283-tenancy-inventory");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

describe("migration 0283 tenancy inventory", () => {
  test("declares one read-only rolling seam that returns integers only", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE OR REPLACE FUNCTION inventory_organization_tenancy(");
    expect(source).toContain("STABLE");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("'tenancy inventory scope mismatch'");
    // Strictly read-only: no writes of any kind.
    for (const verb of ["INSERT", "UPDATE", "DELETE FROM", "DROP", "ALTER TABLE"]) {
      expect(source).not.toContain(`${verb} `);
    }
    // Counts only - the seam must never select identity or content columns
    // into its output (everything flows through count()/jsonb_object_agg of
    // grouped scope labels).
    expect(source).not.toContain("subject_id,");
    expect(source).not.toContain("value_encrypted");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION inventory_organization_tenancy(uuid) FROM PUBLIC",
    );
  });

  test("counts the legacy populations for exactly the requested organization", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('inventory-org') returning id`;
    const [otherAccount] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('inventory-other-org') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'inventory-ws') returning id`;
    const [otherWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${otherAccount!.id}, 'other-ws') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${otherWorkspace!.id}, ${otherAccount!.id})`;

    // A member with an anchor (active membership, personal workspace missing)
    // and a member with workspace access but NO membership anchor.
    const anchored = `user:${crypto.randomUUID()}`;
    const provisioning = `user:${crypto.randomUUID()}`;
    const unanchored = `user:${crypto.randomUUID()}`;
    // An ACTIVE membership always carries its personal-workspace pointer (the
    // 0219 check constraint); the anchor gap therefore lives in provisioning
    // rows and in subjects with no membership row at all.
    await admin`
      insert into organization_memberships
        (account_id, subject_id, status, role, personal_workspace_id)
      values (${account!.id}, ${anchored}, 'active', 'member', ${workspace!.id})`;
    await admin`
      insert into organization_memberships (account_id, subject_id, status, role)
      values (${account!.id}, ${provisioning}, 'provisioning', 'member')`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${workspace!.id}, ${anchored}),
             (${account!.id}, ${workspace!.id}, ${unanchored})`;

    // One ownerless workspace-shared session (the legacy default shape).
    await createSession(db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "inventory me",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    // A session in ANOTHER organization must not leak into the counts.
    await createSession(db, {
      accountId: otherAccount!.id,
      workspaceId: otherWorkspace!.id,
      initialMessage: "other org",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });

    // Unclassified (legacy) variable set + a legacy_user connection.
    await admin`
      insert into workspace_variable_sets (account_id, workspace_id, name, origin_workspace_id)
      values (${account!.id}, ${workspace!.id}, 'legacy set', ${workspace!.id})`;
    // A personal connection whose subject has no active membership: the 0256
    // binding trigger classifies it legacy_user (the lane this program drains).
    // The trigger requires the authenticated-subject GUC to match the owner.
    await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.subject_id', ${unanchored}, true)`;
      await tx`
        insert into connections (
          account_id, workspace_id, origin_workspace_id, provider_domain, kind,
          credential_encrypted, subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${workspace!.id}, 'example.com', 'oauth2',
          'ciphertext', ${unanchored}
        )`;
    });

    const inventory = (await inventoryOrganizationTenancy(db, {
      organizationId: account!.id,
    })) as {
      workspaces: number;
      organizationMemberships: {
        byStatus: Record<string, number>;
        activeWithoutPersonalWorkspace: number;
      };
      workspaceMemberSubjectsWithoutMembershipAnchor: number;
      sessions: { total: number; ownerless: number; userPrivate: number };
      variableSets: { unclassified: number };
      connections: Record<string, number>;
    };

    expect(inventory.workspaces).toBe(1);
    expect(inventory.organizationMemberships.byStatus).toMatchObject({
      active: 1,
      provisioning: 1,
    });
    expect(inventory.organizationMemberships.activeWithoutPersonalWorkspace).toBe(0);
    expect(inventory.workspaceMemberSubjectsWithoutMembershipAnchor).toBe(1);
    expect(inventory.sessions).toMatchObject({ total: 1, ownerless: 1, userPrivate: 0 });
    expect(inventory.variableSets.unclassified).toBe(1);
    expect(inventory.connections).toMatchObject({ legacy_user: 1 });
    // Content-free: the report never carries identities.
    expect(JSON.stringify(inventory)).not.toContain(anchored);
    expect(JSON.stringify(inventory)).not.toContain(unanchored);
  });

  test("the seam rejects a cross-organization request (42501)", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('inventory-scope-a') returning id`;
    const [victim] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('inventory-scope-b') returning id`;
    // RLS context is account A; requesting account B's inventory must 42501.
    const attempt = inventoryOrganizationTenancy(db, {
      organizationId: victim!.id,
    }).catch((error: unknown) => error);
    // The wrapper sets context to the REQUESTED organization, so drive the
    // mismatch through the seam directly under account A's context. The raise
    // aborts the transaction; the begin() itself rejects with the seam error.
    const mismatch = await admin
      .begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select inventory_organization_tenancy(${victim!.id})`;
      })
      .catch((error: unknown) => error);
    expect(mismatch).toMatchObject({ code: "42501" });
    await attempt;
  });
});
