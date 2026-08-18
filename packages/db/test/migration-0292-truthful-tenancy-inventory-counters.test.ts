// Migration 0292: the tenancy inventory seam's `unclassified` counters for
// Variable Sets, Rigs, and Connected Machines were structurally
// `total - userScoped` (the authority shape checks REQUIRE a NULL authority_id
// for every organization/workspace row), so every correctly classified row was
// reported as unmigrated and the gate could never drain. No column
// distinguishes an unmigrated legacy row from a deliberately workspace-scoped
// one for any of the three families, so the counter is removed rather than
// renamed; `byScope` already reports every distinction the schema can make.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, inventoryOrganizationTenancy, type Database, type DbClient } from "../src";

const migrationUrl = new URL(
  "../drizzle/0292_truthful_tenancy_inventory_counters.sql",
  import.meta.url,
);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0292-tenancy-inventory-counters");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Inventory = {
  schemaVersion: number;
  variableSets: { byScope: Record<string, number>; unclassified?: number };
  rigs: { byScope: Record<string, number>; unclassified?: number };
  machines: { byScope: Record<string, number>; unclassified?: number };
  documents: { total: number; legacyPersonalNullAuthority: number };
};

/**
 * Seed, for one organization, exactly one CORRECTLY CLASSIFIED workspace-scoped
 * row and one user-scoped row in each of the three families. Everything is
 * written through the superuser handle so RLS never masks a fixture.
 */
async function seedOrganization(label: string): Promise<{
  accountId: string;
  workspaceId: string;
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${label}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`${label}-ws`}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;

  const owner = `user:${crypto.randomUUID()}`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships
      (account_id, subject_id, status, role, personal_workspace_id)
    values (${account!.id}, ${owner}, 'active', 'member', ${workspace!.id})
    returning id`;

  // --- Variable Sets -------------------------------------------------------
  // A deliberately workspace-scoped set. Its authority_id is NULL because the
  // shape check REQUIRES that - it is not "unclassified".
  await admin`
    insert into workspace_variable_sets
      (account_id, workspace_id, name, authority_scope, origin_workspace_id)
    values (${account!.id}, ${workspace!.id}, 'classified workspace set', 'workspace',
      ${workspace!.id})`;
  const variableSetId = crypto.randomUUID();
  const variableSetAuthority = crypto.randomUUID();
  await admin`
    insert into organization_user_resource_authorities
      (id, account_id, organization_membership_id, resource_kind, resource_id,
       origin_workspace_id, generation, status)
    values (${variableSetAuthority}, ${account!.id}, ${membership!.id}, 'variable_set',
      ${variableSetId}, ${workspace!.id}, 1, 'active')`;
  await admin`
    insert into workspace_variable_sets
      (id, account_id, workspace_id, name, authority_scope, authority_id,
       owner_organization_membership_id, origin_workspace_id)
    values (${variableSetId}, ${account!.id}, ${workspace!.id}, 'personal set', 'user',
      ${variableSetAuthority}, ${membership!.id}, ${workspace!.id})`;

  // --- Rigs ----------------------------------------------------------------
  await admin`
    insert into rigs (account_id, workspace_id, name, authority_scope, origin_workspace_id)
    values (${account!.id}, ${workspace!.id}, 'classified workspace rig', 'workspace',
      ${workspace!.id})`;
  const rigId = crypto.randomUUID();
  const rigAuthority = crypto.randomUUID();
  await admin`
    insert into organization_user_resource_authorities
      (id, account_id, organization_membership_id, resource_kind, resource_id,
       origin_workspace_id, generation, status)
    values (${rigAuthority}, ${account!.id}, ${membership!.id}, 'rig', ${rigId},
      ${workspace!.id}, 1, 'active')`;
  await admin`
    insert into rigs
      (id, account_id, workspace_id, name, authority_scope, authority_id,
       owner_organization_membership_id, origin_workspace_id)
    values (${rigId}, ${account!.id}, ${workspace!.id}, 'personal rig', 'user',
      ${rigAuthority}, ${membership!.id}, ${workspace!.id})`;

  // --- Connected Machines --------------------------------------------------
  await admin`
    insert into enrollments
      (account_id, workspace_id, pubkey, authority_scope, origin_workspace_id)
    values (${account!.id}, ${workspace!.id}, ${`ws-key-${crypto.randomUUID()}`}, 'workspace',
      ${workspace!.id})`;
  const enrollmentId = crypto.randomUUID();
  const enrollmentAuthority = crypto.randomUUID();
  await admin`
    insert into organization_user_resource_authorities
      (id, account_id, organization_membership_id, resource_kind, resource_id,
       origin_workspace_id, generation, status)
    values (${enrollmentAuthority}, ${account!.id}, ${membership!.id}, 'connected_machine',
      ${enrollmentId}, ${workspace!.id}, 1, 'active')`;
  await admin`
    insert into enrollments
      (id, account_id, workspace_id, pubkey, authority_scope, authority_id,
       owner_organization_membership_id, origin_workspace_id)
    values (${enrollmentId}, ${account!.id}, ${workspace!.id},
      ${`user-key-${crypto.randomUUID()}`}, 'user', ${enrollmentAuthority}, ${membership!.id},
      ${workspace!.id})`;

  return { accountId: account!.id, workspaceId: workspace!.id };
}

describe("migration 0292 truthful tenancy inventory counters", () => {
  test("replaces the seam in place and drops the three untruthful counters", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    // In-place replacement: dropping and recreating would discard the
    // function's owner and its EXECUTE grant to opengeni_app.
    expect(source).toContain("CREATE OR REPLACE FUNCTION inventory_organization_tenancy(");
    expect(source).not.toContain("DROP FUNCTION");
    expect(source).toContain("'schemaVersion', 2");

    const body = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION inventory_organization_tenancy("),
    );
    // The removed jsonb keys must not come back. (Prose explaining WHY they
    // were removed legitimately mentions the word, so match the emitted key
    // spelling, not the raw substring.)
    expect(body).not.toContain("'unclassified'");
    expect(body).not.toMatch(/'unclassified[A-Za-z]*'/u);
    // `authority_id IS NULL` survives in exactly one place: the documents gate,
    // where it is paired with authority_kind = 'personal' and therefore names a
    // genuine post-migration invariant violation.
    const authorityIdNullMatches = body.match(/authority_id IS NULL/gu) ?? [];
    expect(authorityIdNullMatches).toHaveLength(1);
    expect(body).toContain("d.authority_kind = 'personal' AND d.authority_id IS NULL");
    // Still strictly read-only over application tables.
    for (const verb of ["UPDATE ", "DROP ", "ALTER TABLE "]) {
      expect(body).not.toContain(verb);
    }
    expect(body).not.toMatch(
      /INSERT INTO (?!opengeni_private\.organization_tenancy_inventory_capabilities)/u,
    );
    expect(body).not.toMatch(
      /DELETE FROM (?!opengeni_private\.organization_tenancy_inventory_capabilities)/u,
    );
  });

  test("byScope distinguishes a correctly classified workspace row from a user-scoped one, and no `unclassified` counter is reported", async () => {
    if (!available) return;
    const { accountId } = await seedOrganization("inventory-0292-counters");

    const inventory = (await inventoryOrganizationTenancy(db, {
      organizationId: accountId,
    })) as Inventory;

    expect(inventory.schemaVersion).toBe(2);
    // Each family holds exactly one correctly classified workspace row and
    // one user-scoped row, and the report says so.
    expect(inventory.variableSets.byScope).toEqual({ workspace: 1, user: 1 });
    expect(inventory.rigs.byScope).toEqual({ workspace: 1, user: 1 });
    expect(inventory.machines.byScope).toEqual({ workspace: 1, user: 1 });

    // The defect: 0285 reported `unclassified` for every one of these
    // families. Under the old function this fixture produced
    // `unclassified: 1` for all three even though NOTHING is unclassified.
    expect(inventory.variableSets).not.toHaveProperty("unclassified");
    expect(inventory.rigs).not.toHaveProperty("unclassified");
    expect(inventory.machines).not.toHaveProperty("unclassified");
    expect(JSON.stringify(inventory)).not.toContain("unclassified");
  }, 180_000);

  test("the removed predicate was structurally `total - userScoped`, never an unmigrated population", async () => {
    if (!available) return;
    const { accountId } = await seedOrganization("inventory-0292-predicate");

    // Prove the old predicate's arithmetic directly against the fixture: for
    // each family, `authority_id IS NULL` counts EXACTLY the correctly
    // classified workspace rows, which is why the gate could never drain.
    for (const table of ["workspace_variable_sets", "rigs", "enrollments"]) {
      const [row] = await admin<
        { oldPredicate: number; totalRows: number; userScoped: number; workspaceScoped: number }[]
      >`
          select
            count(*) filter (where authority_id is null)::int as "oldPredicate",
            count(*)::int as "totalRows",
            count(*) filter (where authority_scope = 'user')::int as "userScoped",
            count(*) filter (where authority_scope = 'workspace')::int as "workspaceScoped"
          from ${admin(table)}
          where account_id = ${accountId}`;
      expect(row!.totalRows).toBe(2);
      expect(row!.userScoped).toBe(1);
      expect(row!.workspaceScoped).toBe(1);
      // The old counter equalled the CORRECTLY CLASSIFIED workspace rows.
      expect(row!.oldPredicate).toBe(row!.totalRows - row!.userScoped);
      expect(row!.oldPredicate).toBe(row!.workspaceScoped);
    }
  }, 180_000);

  test("CREATE OR REPLACE preserves the seam's EXECUTE grant to the application role", async () => {
    if (!available) return;
    const [row] = await admin<{ appCanExecute: boolean }[]>`
        select has_function_privilege(
          'opengeni_app', 'inventory_organization_tenancy(uuid)', 'EXECUTE'
        ) as "appCanExecute"`;
    expect(row?.appCanExecute).toBe(true);
    // The `db` handle connects as the non-superuser opengeni_app login role,
    // so a successful call is the end-to-end proof that the grant survived.
    const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('inventory-0292-grant') returning id`;
    const inventory = (await inventoryOrganizationTenancy(db, {
      organizationId: account!.id,
    })) as Inventory;
    expect(inventory.schemaVersion).toBe(2);
  }, 180_000);

  test("a null organization id still raises 22004 and a cross-organization request still raises 42501", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('inventory-0292-scope-a') returning id`;
    const [victim] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('inventory-0292-scope-b') returning id`;

    // postgres.js query objects are thenables, not real Promises - awaiting
    // them explicitly inside try/catch is the only safe way to assert on the
    // raised error (expect(...).rejects.toThrow() hangs on them).
    let mismatch: unknown;
    try {
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select inventory_organization_tenancy(${victim!.id})`;
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({ code: "42501" });

    let missing: unknown;
    try {
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select inventory_organization_tenancy(null::uuid)`;
      });
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({ code: "22004" });
  }, 180_000);
});
