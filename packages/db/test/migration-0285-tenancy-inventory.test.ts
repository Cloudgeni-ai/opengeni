// Migration 0285: the read-only organization tenancy inventory seam counts
// every legacy-attribution population the backfill/parity program gates on -
// integers only, exact-organization scoped, application-role executable.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createDb,
  createSession,
  inventoryOrganizationTenancy,
  migrate,
  type Database,
  type DbClient,
} from "../src";

const migrationUrl = new URL("../drizzle/0285_organization_tenancy_inventory.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0285-tenancy-inventory");
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

describe("migration 0285 tenancy inventory", () => {
  test("declares one read-only rolling seam that returns integers only", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE OR REPLACE FUNCTION inventory_organization_tenancy(");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("'tenancy inventory scope mismatch'");
    expect(source).toContain("'tenancy inventory requires an organization id'");
    // Every FORCE-RLS table the function reads is protected by a
    // transaction-scoped, migration-owner-only capability (the 0254 pattern),
    // never by widening the table's ordinary policies.
    expect(source).toContain(
      "CREATE TABLE opengeni_private.organization_tenancy_inventory_capabilities",
    );
    expect(source).toContain("current_user = %L AND");
    expect(source).toContain("opengeni_private.organization_tenancy_inventory_capability_active()");
    const body = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION inventory_organization_tenancy("),
    );
    for (const verb of ["UPDATE", "DROP", "ALTER TABLE"]) {
      expect(body).not.toContain(`${verb} `);
    }
    // The function's only writes are its own claim/release of the private
    // capability row - never any counted application table.
    expect(body).not.toMatch(
      /INSERT INTO (?!opengeni_private\.organization_tenancy_inventory_capabilities)/u,
    );
    expect(body).not.toMatch(
      /DELETE FROM (?!opengeni_private\.organization_tenancy_inventory_capabilities)/u,
    );
    // Counts only - the seam must never select identity or content columns
    // into its output (everything flows through count()/jsonb_object_agg of
    // grouped scope labels).
    expect(body).not.toContain("subject_id,");
    expect(body).not.toContain("value_encrypted");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION inventory_organization_tenancy(uuid) FROM PUBLIC",
    );
    // The documents gate counts only LEGACY personal rows - ordinary
    // workspace/organization documents are required to have a NULL
    // authority_id forever and must never be miscounted as unmigrated.
    expect(source).toContain("d.authority_kind = 'personal' AND d.authority_id IS NULL");
    // The inner predicate must be independently EXECUTE-granted to
    // opengeni_app (0254's exact pattern) - relying solely on provisionRoles'
    // blanket schema-wide sweep is not sufficient: an ordinary opengeni_app
    // read of ANY table this capability protects (e.g. sessions, reached
    // through session_reference_visible's inlined SQL body evaluating every
    // PERMISSIVE policy) needs execute privilege on every predicate function
    // those policies reference, even when that policy's own OR-branch would
    // ultimately evaluate false for the caller.
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION\n" +
        "      opengeni_private.organization_tenancy_inventory_capability_active()\n" +
        "      TO opengeni_app;",
    );
  });

  test("opengeni_app holds EXECUTE on the inner capability predicate under migrate() ALONE (no provisionRoles)", async () => {
    // The real-world regression this test pins: acquireBlankTestDatabase +
    // migrate() alone (the exact pattern migration-0252's suite uses to drive
    // fencing tests, and some production migration-owner topologies) never
    // runs provisionRoles' blanket schema-wide EXECUTE sweep. The predicate
    // must still be independently usable by an opengeni_app-effective role
    // reading ANY table this capability protects, even without that sweep -
    // relying on it alone silently breaks every such caller.
    const blank = await acquireBlankTestDatabase("migration-0283-no-provision-roles");
    if (!blank) return;
    try {
      await migrate(blank.databaseUrl);
      const probe = postgres(blank.databaseUrl, { max: 1 });
      try {
        const [row] = await probe<Array<{ appCanExecute: boolean }>>`
          select has_function_privilege(
            'opengeni_app',
            'opengeni_private.organization_tenancy_inventory_capability_active()',
            'EXECUTE'
          ) as "appCanExecute"`;
        expect(row?.appCanExecute).toBe(true);
      } finally {
        await probe.end().catch(() => undefined);
      }
    } finally {
      await blank.release();
    }
    // Explicit timeout: this replays the WHOLE migration chain against a blank
    // database (no template clone), which already exceeds bun's 5s default on a
    // loaded machine and grows with every migration added after 0285.
  }, 180_000);

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

    // A workspace-scoped variable set + a legacy_user connection. (0285
    // originally reported this row as `unclassified`; migration 0292 removed
    // that counter - the shape check REQUIRES a NULL authority_id here, so the
    // number was structurally `total - userScoped`. See
    // migration-0292-truthful-tenancy-inventory-counters.test.ts.)
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
      variableSets: { byScope: Record<string, number> };
      connections: Record<string, number>;
      documents: { total: number; legacyPersonalNullAuthority: number };
    };

    expect(inventory.workspaces).toBe(1);
    expect(inventory.organizationMemberships.byStatus).toMatchObject({
      active: 1,
      provisioning: 1,
    });
    expect(inventory.organizationMemberships.activeWithoutPersonalWorkspace).toBe(0);
    expect(inventory.workspaceMemberSubjectsWithoutMembershipAnchor).toBe(1);
    expect(inventory.sessions).toMatchObject({ total: 1, ownerless: 1, userPrivate: 0 });
    expect(inventory.variableSets.byScope).toMatchObject({ workspace: 1 });
    expect(inventory.connections).toMatchObject({ legacy_user: 1 });
    // Content-free: the report never carries identities.
    expect(JSON.stringify(inventory)).not.toContain(anchored);
    expect(JSON.stringify(inventory)).not.toContain(unanchored);
  });

  test("the documents gate counts only legacy personal rows, never ordinary workspace/organization documents", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('inventory-docs-org') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'inventory-docs-ws') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const [base] = await admin<{ id: string }[]>`
      insert into document_bases (account_id, workspace_id, name)
      values (${account!.id}, ${workspace!.id}, 'inventory-docs-base') returning id`;
    async function documentFile() {
      const [f] = await admin<{ id: string }[]>`
        insert into files (
          account_id, workspace_id, status, filename, safe_filename, content_type,
          size_bytes, bucket, object_key
        ) values (
          ${account!.id}, ${workspace!.id}, 'ready', 'doc.txt', 'doc.txt', 'text/plain',
          1, 'test', ${`documents/${crypto.randomUUID()}`}
        ) returning id`;
      return f!.id;
    }
    // A perfectly ordinary workspace document (authority_id is REQUIRED to be
    // NULL forever by documents_authority_chk) must NOT be counted as legacy.
    await admin`
      insert into documents (
        account_id, workspace_id, base_id, file_id, status, title, created_by,
        authority_kind, authority_workspace_id
      ) values (
        ${account!.id}, ${workspace!.id}, ${base!.id}, ${await documentFile()}, 'ready',
        'healthy workspace doc', 'user:doc-creator', 'workspace', ${workspace!.id}
      )`;
    // An unmigrated legacy PERSONAL document (authority_id null, no common
    // authority yet) IS the gate population.
    const owner = `user:${crypto.randomUUID()}`;
    await admin`
      insert into documents (
        account_id, workspace_id, base_id, file_id, status, title, created_by,
        authority_kind, authority_workspace_id, authority_subject_id
      ) values (
        ${account!.id}, ${workspace!.id}, ${base!.id}, ${await documentFile()}, 'ready',
        'legacy personal doc', ${owner}, 'personal', ${workspace!.id}, ${owner}
      )`;

    const inventory = (await inventoryOrganizationTenancy(db, {
      organizationId: account!.id,
    })) as { documents: { total: number; legacyPersonalNullAuthority: number } };

    expect(inventory.documents).toMatchObject({
      total: 2,
      legacyPersonalNullAuthority: 1,
    });
  });

  test("counts stay correct under a non-superuser, non-BYPASSRLS function owner", async () => {
    if (!available) return;
    // FORCE RLS applies to the function owner unless it holds BYPASSRLS - the
    // documented non-superuser migration-owner deployment shape
    // (docs/deployment.md). Reassign the seam's owning routines to a
    // synthetic NOSUPERUSER NOBYPASSRLS role with only ordinary table grants
    // and prove the counts are unchanged, not silently zeroed.
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('inventory-owner-probe') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'inventory-owner-probe-ws') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const anchored = `user:${crypto.randomUUID()}`;
    await admin`
      insert into organization_memberships
        (account_id, subject_id, status, role, personal_workspace_id)
      values (${account!.id}, ${anchored}, 'active', 'member', ${workspace!.id})`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${account!.id}, ${workspace!.id}, ${anchored})`;

    const probeRole = `tenancy_inventory_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const [ownerRow] = await admin<{ ownerName: string }[]>`
      select pg_get_userbyid(proowner) as "ownerName"
      from pg_proc
      where proname = 'inventory_organization_tenancy'`;
    const originalOwner = ownerRow!.ownerName;
    try {
      await admin.unsafe(`CREATE ROLE ${probeRole} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
      // Table-level grants only (never BYPASSRLS): mirrors an ordinary
      // migration-owner role's privileges, not superuser escape.
      // Broad ordinary GRANTs (never BYPASSRLS): a real migration-owner role
      // typically owns or has full-table-privilege access to every table it
      // has ever migrated, including the many pre-existing capability tables
      // whose policies are also evaluated on organization_memberships. This
      // isolates the ONE variable under test - the absence of BYPASSRLS -
      // from an unrelated "narrower grants than production" confound.
      await admin.unsafe(`GRANT USAGE ON SCHEMA opengeni_private TO ${probeRole}`);
      await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA opengeni_private TO ${probeRole}`);
      await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${probeRole}`);
      await admin.unsafe(
        `GRANT INSERT, DELETE ON opengeni_private.organization_tenancy_inventory_capabilities TO ${probeRole}`,
      );
      // The other capability families' predicate functions - and the
      // session-visibility helper functions RLS policies call internally -
      // are evaluated as part of planning organization_memberships/sessions
      // policy expressions regardless of which OR-branch ultimately wins;
      // execute privilege is required to even plan the query.
      await admin.unsafe(
        `DO $$DECLARE r record; BEGIN
           FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname IN ('opengeni_private', 'public')
           LOOP
             EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${probeRole}', r.sig);
           END LOOP;
         END$$;`,
      );
      await admin.unsafe(
        `ALTER FUNCTION inventory_organization_tenancy(uuid) OWNER TO ${probeRole}`,
      );
      await admin.unsafe(
        `ALTER FUNCTION opengeni_private.organization_tenancy_inventory_capability_active() OWNER TO ${probeRole}`,
      );
      // The capability-read policies bake in the exact migration-owner role
      // NAME at CREATE POLICY time (0254's established pattern: the same
      // entity that applies every migration owns every SECURITY DEFINER
      // routine forever, so the two are never reassigned independently in a
      // real deployment). Re-point the ten policies at the probe role so this
      // test faithfully simulates "the migration owner IS a non-superuser,
      // non-BYPASSRLS role" rather than an unrealistic post-hoc reassignment.
      for (const table of [
        "sessions",
        "workspace_variable_sets",
        "rigs",
        "enrollments",
        "connections",
        "documents",
        "codex_subscription_credentials",
        "sandbox_workspace_mutation_admissions",
        "sandbox_retained_processes",
        "organization_memberships",
      ]) {
        await admin.unsafe(
          `DROP POLICY IF EXISTS organization_tenancy_inventory_capability_read ON ${table}`,
        );
        await admin.unsafe(
          `CREATE POLICY organization_tenancy_inventory_capability_read ON ${table} ` +
            `FOR SELECT USING (current_user = '${probeRole}' AND ` +
            `opengeni_private.organization_tenancy_inventory_capability_active())`,
        );
      }

      const inventory = (await inventoryOrganizationTenancy(db, {
        organizationId: account!.id,
      })) as {
        organizationMemberships: { byStatus: Record<string, number> };
        workspaceMemberSubjectsWithoutMembershipAnchor: number;
      };
      // Under the previous (broken) posture this silently returned
      // byStatus:{} and anchorless:1 for this exact fixture - the bug the
      // capability seam fixes.
      expect(inventory.organizationMemberships.byStatus).toMatchObject({ active: 1 });
      expect(inventory.workspaceMemberSubjectsWithoutMembershipAnchor).toBe(0);
    } finally {
      for (const table of [
        "sessions",
        "workspace_variable_sets",
        "rigs",
        "enrollments",
        "connections",
        "documents",
        "codex_subscription_credentials",
        "sandbox_workspace_mutation_admissions",
        "sandbox_retained_processes",
        "organization_memberships",
      ]) {
        await admin
          .unsafe(
            `DROP POLICY IF EXISTS organization_tenancy_inventory_capability_read ON ${table}`,
          )
          .catch(() => undefined);
        await admin
          .unsafe(
            `CREATE POLICY organization_tenancy_inventory_capability_read ON ${table} ` +
              `FOR SELECT USING (current_user = '${originalOwner}' AND ` +
              `opengeni_private.organization_tenancy_inventory_capability_active())`,
          )
          .catch(() => undefined);
      }
      await admin
        .unsafe(`ALTER FUNCTION inventory_organization_tenancy(uuid) OWNER TO ${originalOwner}`)
        .catch(() => undefined);
      await admin
        .unsafe(
          `ALTER FUNCTION opengeni_private.organization_tenancy_inventory_capability_active() OWNER TO ${originalOwner}`,
        )
        .catch(() => undefined);
      await admin.unsafe(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => undefined);
    }
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
