// Migration 0291: the OPE-204 phase D classification assertion seam for
// Variable Sets, Rigs, and Connected Machines.
//
// The load-bearing claim under test is that these three families need NO data
// rewrite: `authority_scope` is `NOT NULL DEFAULT 'workspace'` and every
// `*_authority_shape_check` was VALIDATEd at creation, so every row already
// carries an explicit terminal classification and a legacy row is byte-
// identical to a deliberately workspace-scoped one. The seam therefore asserts
// and receipts; it must never write a resource row, and must never infer user
// ownership from anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, migrate, verifyOrganizationResourceClassification } from "../src";
import type { Database, DbClient } from "../src";

const migrationUrl = new URL(
  "../drizzle/0291_resource_authority_classification_assertion.sql",
  import.meta.url,
);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0291-resource-classification");
  if (!shared) {
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

type Fixture = {
  organizationId: string;
  workspaceId: string;
  personalWorkspaceId: string;
  activeMembershipId: string;
  revokedMembershipId: string;
};

/** Seeds one organization with a terminal workspace-owned row in every family. */
async function seedOrganization(label: string): Promise<Fixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`0291-${label}`}) returning id
  `;
  const organizationId = account!.id;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${organizationId}, 'shared') returning id
  `;
  const [personalWorkspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${organizationId}, 'personal') returning id
  `;
  const [activeMembership] = await admin<{ id: string }[]>`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${organizationId}, ${`user:active-${label}`}, 'active', ${personalWorkspace!.id}
    ) returning id
  `;
  const [revokedMembership] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, status, revoked_at)
    values (${organizationId}, ${`user:revoked-${label}`}, 'revoked', now()) returning id
  `;
  // One legacy/workspace-owned row per family, created exactly the way an
  // unmigrated row looks: every authority column left at its default.
  await admin`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${organizationId}, ${workspace!.id}, 'legacy-variable-set')
  `;
  await admin`
    insert into rigs (account_id, workspace_id, name)
    values (${organizationId}, ${workspace!.id}, 'legacy-rig')
  `;
  await admin`
    insert into enrollments (account_id, workspace_id, pubkey, os, arch)
    values (${organizationId}, ${workspace!.id}, ${`legacy-${label}`}, 'linux', 'x86_64')
  `;
  return {
    organizationId,
    workspaceId: workspace!.id,
    personalWorkspaceId: personalWorkspace!.id,
    activeMembershipId: activeMembership!.id,
    revokedMembershipId: revokedMembership!.id,
  };
}

type FamilyReport = {
  total: number;
  workspaceOwned: number;
  organizationOwned: number;
  userOwned: number;
  unresolved: number;
  unresolvedRows: Array<{ resourceId: string; reasonCode: string }>;
  unresolvedTruncated: boolean;
  receiptId?: string;
};
type ClassificationReport = {
  schemaVersion: number;
  organizationId: string;
  runKey: string | null;
  ledgerAvailable: boolean;
  rewroteResourceRows: boolean;
  families: Record<"variable_sets" | "rigs" | "machines", FamilyReport>;
};

/** Drizzle wraps the driver error, so the PostgreSQL message is on the cause. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
    parts.push(String(current));
    current = current instanceof Error ? current.cause : null;
  }
  return parts.join(" | ");
}

async function verify(organizationId: string, runKey?: string): Promise<ClassificationReport> {
  return (await verifyOrganizationResourceClassification(db, {
    organizationId,
    ...(runKey === undefined ? {} : { runKey }),
  })) as unknown as ClassificationReport;
}

describe("migration 0291 resource classification assertion", () => {
  test("is a rolling seam that rewrites no resource row and infers no owner", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION verify_organization_resource_classification(",
    );
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("'resource classification scope mismatch'");
    expect(source).toContain("'resource classification requires an organization id'");

    // The org-wide read of five FORCE-RLS tables goes through a transaction-
    // scoped, migration-owner-only capability (the 0254/0285 pattern), never by
    // widening any table's ordinary policies.
    expect(source).toContain("CREATE TABLE opengeni_private.resource_classification_capabilities");
    expect(source).toContain("current_user = %L AND");
    expect(source).toContain("opengeni_private.resource_classification_capability_active()");

    const body = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION verify_organization_resource_classification("),
    );
    // The seam's ONLY writes are its own capability row and the 0286 ledger
    // seam. It must never touch a resource table, and must never mint an
    // authority or grant row - that is precisely the inference phase D forbids.
    expect(body).not.toMatch(
      /INSERT INTO (?!opengeni_private\.resource_classification_capabilities)/u,
    );
    expect(body).not.toMatch(
      /DELETE FROM (?!opengeni_private\.resource_classification_capabilities)/u,
    );
    for (const verb of ["UPDATE ", "DROP ", "ALTER TABLE"]) {
      expect(body).not.toContain(verb);
    }
    expect(body).not.toContain("organization_user_resource_grants");
    // Never infer ownership from creator attribution, naming, or access.
    for (const forbidden of ["created_by", "subject_id", "workspace_memberships"]) {
      expect(body).not.toContain(forbidden);
    }

    expect(source).toContain(
      "REVOKE ALL ON FUNCTION\n  verify_organization_resource_classification(uuid, text) FROM PUBLIC",
    );
    // 0254's and 0285's exact lesson: the inner predicate must be independently
    // EXECUTE-granted, or an ordinary opengeni_app read of any protected table
    // fails closed instead of the policy branch evaluating false.
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION\n" +
        "      opengeni_private.resource_classification_capability_active() TO opengeni_app;",
    );
  });

  test("installs the capability read policy on every table the seam joins", async () => {
    if (!shared) return;
    const policies = await admin<Array<{ tableName: string }>>`
      select tablename as "tableName" from pg_policies
      where schemaname = current_schema()
        and policyname = 'resource_classification_capability_read'
      order by tablename
    `;
    expect(policies.map((policy) => policy.tableName)).toEqual([
      "enrollments",
      "organization_memberships",
      "organization_user_resource_authorities",
      "rigs",
      "workspace_variable_sets",
    ]);
  }, 180_000);

  test("reports every unmigrated row as already explicitly workspace-owned", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("terminal");
    const report = await verify(fixture.organizationId);

    expect(report.schemaVersion).toBe(1);
    // The whole point of the slice: nothing was rewritten, because nothing
    // could be - a legacy row and a deliberate workspace row are identical.
    expect(report.rewroteResourceRows).toBe(false);
    const families = report.families;
    for (const family of ["variable_sets", "rigs", "machines"] as const) {
      expect(families[family]).toMatchObject({
        total: 1,
        workspaceOwned: 1,
        organizationOwned: 0,
        userOwned: 0,
        unresolved: 0,
        unresolvedRows: [],
        unresolvedTruncated: false,
      });
    }
  }, 180_000);

  test("counts a reviewed user-owned row as user-owned, never as backfill work", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("user-owned");
    const [variableSet] = await admin<{ id: string }[]>`
      select gen_random_uuid() as id
    `;
    const [authority] = await admin<{ id: string }[]>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${fixture.organizationId}, ${fixture.activeMembershipId}, 'variable_set',
        ${variableSet!.id}, ${fixture.personalWorkspaceId}, 1, 'active'
      ) returning id
    `;
    await admin`
      insert into workspace_variable_sets (
        id, account_id, workspace_id, name, authority_scope, authority_id,
        owner_organization_membership_id, origin_workspace_id
      ) values (
        ${variableSet!.id}, ${fixture.organizationId}, ${fixture.personalWorkspaceId},
        'personal-variable-set', 'user', ${authority!.id},
        ${fixture.activeMembershipId}, ${fixture.personalWorkspaceId}
      )
    `;

    // Organization scope is a deliberate lifecycle choice, never a legacy
    // default, so it is reported in its own bucket rather than folded into the
    // workspace population it is not part of.
    await admin`
      insert into rigs (account_id, workspace_id, name, authority_scope)
      values (${fixture.organizationId}, ${fixture.workspaceId}, 'org-rig', 'organization')
    `;

    const report = await verify(fixture.organizationId);
    expect(report.families.variable_sets).toMatchObject({
      total: 2,
      workspaceOwned: 1,
      organizationOwned: 0,
      userOwned: 1,
      unresolved: 0,
    });
    expect(report.families.rigs).toMatchObject({
      total: 2,
      workspaceOwned: 1,
      organizationOwned: 1,
      userOwned: 0,
      unresolved: 0,
    });
  }, 180_000);

  test("refuses to classify the four delegation defects no constraint catches", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("defects");

    // (a) the authority row describes a different resource kind entirely.
    const [mismatched] = await admin<{ id: string }[]>`select gen_random_uuid() as id`;
    const [wrongKind] = await admin<{ id: string }[]>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${fixture.organizationId}, ${fixture.activeMembershipId}, 'rig',
        ${mismatched!.id}, ${fixture.personalWorkspaceId}, 1, 'active'
      ) returning id
    `;
    await admin`
      insert into workspace_variable_sets (
        id, account_id, workspace_id, name, authority_scope, authority_id,
        owner_organization_membership_id, origin_workspace_id
      ) values (
        ${mismatched!.id}, ${fixture.organizationId}, ${fixture.personalWorkspaceId},
        'wrong-kind', 'user', ${wrongKind!.id}, ${fixture.activeMembershipId},
        ${fixture.personalWorkspaceId}
      )
    `;

    // (b) the owning organization membership is revoked.
    const [orphaned] = await admin<{ id: string }[]>`select gen_random_uuid() as id`;
    const [orphanAuthority] = await admin<{ id: string }[]>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${fixture.organizationId}, ${fixture.revokedMembershipId}, 'rig',
        ${orphaned!.id}, ${fixture.workspaceId}, 1, 'active'
      ) returning id
    `;
    await admin`
      insert into rigs (
        id, account_id, workspace_id, name, authority_scope, authority_id,
        owner_organization_membership_id, origin_workspace_id
      ) values (
        ${orphaned!.id}, ${fixture.organizationId}, ${fixture.workspaceId},
        'orphan-rig', 'user', ${orphanAuthority!.id}, ${fixture.revokedMembershipId},
        ${fixture.workspaceId}
      )
    `;

    // (c) the authority itself is revoked while the resource still claims it.
    const [staleMachine] = await admin<{ id: string }[]>`select gen_random_uuid() as id`;
    const [staleAuthority] = await admin<{ id: string }[]>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status, revoked_at
      ) values (
        ${fixture.organizationId}, ${fixture.activeMembershipId}, 'connected_machine',
        ${staleMachine!.id}, ${fixture.personalWorkspaceId}, 1, 'revoked', now()
      ) returning id
    `;
    await admin`
      insert into enrollments (
        id, account_id, workspace_id, pubkey, os, arch, authority_scope,
        authority_id, owner_organization_membership_id, origin_workspace_id
      ) values (
        ${staleMachine!.id}, ${fixture.organizationId}, ${fixture.personalWorkspaceId},
        'stale-authority', 'linux', 'x86_64', 'user', ${staleAuthority!.id},
        ${fixture.activeMembershipId}, ${fixture.personalWorkspaceId}
      )
    `;

    // (d) a user-scoped row whose origin workspace the FK's ON DELETE SET NULL
    //     erased. The origin is genuinely unknown, so it must NOT be
    //     resurrected from workspace_id.
    const [originless] = await admin<{ id: string }[]>`select gen_random_uuid() as id`;
    const [originlessAuthority] = await admin<{ id: string }[]>`
      insert into organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) values (
        ${fixture.organizationId}, ${fixture.activeMembershipId}, 'connected_machine',
        ${originless!.id}, ${fixture.personalWorkspaceId}, 1, 'active'
      ) returning id
    `;
    await admin`
      insert into enrollments (
        id, account_id, workspace_id, pubkey, os, arch, authority_scope,
        authority_id, owner_organization_membership_id, origin_workspace_id
      ) values (
        ${originless!.id}, ${fixture.organizationId}, ${fixture.personalWorkspaceId},
        'originless', 'linux', 'x86_64', 'user', ${originlessAuthority!.id},
        ${fixture.activeMembershipId}, null
      )
    `;

    const families = (await verify(fixture.organizationId)).families;

    expect(families.variable_sets).toMatchObject({ unresolved: 1, userOwned: 0 });
    expect(families.variable_sets.unresolvedRows).toEqual([
      { resourceId: mismatched!.id, reasonCode: "conflicting_authority_rows" },
    ]);
    expect(families.rigs.unresolvedRows).toEqual([
      { resourceId: orphaned!.id, reasonCode: "missing_organization_membership" },
    ]);
    const machineRows = families.machines.unresolvedRows;
    expect(machineRows.find((row) => row.resourceId === staleMachine!.id)?.reasonCode).toBe(
      "ambiguous_candidate_authority",
    );
    expect(machineRows.find((row) => row.resourceId === originless!.id)?.reasonCode).toBe(
      "no_deterministic_evidence",
    );

    // The seam records refusals; it never repairs one. Every defective row is
    // still byte-identical afterwards.
    const [untouched] = await admin<Array<{ originWorkspaceId: string | null }>>`
      select origin_workspace_id as "originWorkspaceId" from enrollments
      where id = ${originless!.id}
    `;
    expect(untouched!.originWorkspaceId).toBeNull();
  }, 180_000);

  test("rejects a cross-organization request and a blank run key", async () => {
    if (!shared) return;
    const first = await seedOrganization("scope-a");
    const second = await seedOrganization("scope-b");

    let crossOrganizationError: unknown = null;
    try {
      // Drives the raw seam with one organization's RLS context and the
      // other's id. bun's expect(promise).rejects hangs on postgres.js
      // thenables, so this is try/catch throughout.
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${first.organizationId}, true)`;
        await tx`select verify_organization_resource_classification(${second.organizationId})`;
      });
    } catch (error) {
      crossOrganizationError = error;
    }
    expect(errorText(crossOrganizationError)).toContain("resource classification scope mismatch");

    let blankRunKeyError: unknown = null;
    try {
      await verify(first.organizationId, "   ");
    } catch (error) {
      blankRunKeyError = error;
    }
    expect(errorText(blankRunKeyError)).toContain(
      "resource classification run key must not be blank",
    );
  }, 180_000);

  test("reports ledgerAvailable honestly rather than dropping the obligation", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("ledger-probe");
    // The ledger lives in its own migration (PR #1588). Whichever way that
    // lands, a run key must produce either durable receipts or an explicit
    // `ledgerAvailable: false` - never a silent no-op.
    const report = await verify(fixture.organizationId, `run-${fixture.organizationId}`);
    const [ledger] = await admin<Array<{ present: boolean }>>`
      select to_regprocedure('open_tenancy_backfill_receipt(uuid, text, text)') is not null
        as present
    `;
    expect(report.ledgerAvailable).toBe(ledger!.present);
    expect(report.runKey).toBe(`run-${fixture.organizationId}`);

    if (ledger!.present) {
      const receipts = await admin<Array<{ resourceFamily: string; status: string }>>`
        select resource_family as "resourceFamily", status from tenancy_backfill_receipts
        where account_id = ${fixture.organizationId} order by resource_family
      `;
      expect(receipts.map((receipt) => receipt.resourceFamily)).toEqual([
        "machines",
        "rigs",
        "variable_sets",
      ]);
      for (const receipt of receipts) expect(receipt.status).toBe("completed");
    }
  }, 180_000);

  test("opengeni_app can execute the seam and its predicate under migrate() alone", async () => {
    // 0285's exact regression: acquireBlankTestDatabase + migrate() never runs
    // provisionRoles' blanket sweep, and 0291's own GRANT block is skipped when
    // opengeni_app does not yet exist. Both grants must still land.
    const blank = await acquireBlankTestDatabase("migration-0291-no-provision-roles");
    if (!blank) return;
    const probe = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [row] = await probe<Array<{ seam: boolean; predicate: boolean }>>`
        select
          has_function_privilege(
            'opengeni_app',
            'verify_organization_resource_classification(uuid, text)',
            'EXECUTE'
          ) as seam,
          has_function_privilege(
            'opengeni_app',
            'opengeni_private.resource_classification_capability_active()',
            'EXECUTE'
          ) as predicate
      `;
      expect(row).toEqual({ seam: true, predicate: true });
    } finally {
      await probe.end({ timeout: 5 });
      await blank.release();
    }
  }, 180_000);

  test("a non-superuser owner cannot see FORCE-RLS rows without the capability", async () => {
    // This pins the structural reason 0291 is a definer seam instead of a
    // migration-time UPDATE. OpenGeni's documented deployment posture is a
    // NON-superuser migration principal without BYPASSRLS, and FORCE ROW LEVEL
    // SECURITY applies to the table owner. A plain `UPDATE ... WHERE ...` in a
    // migration body therefore matches ZERO rows on such a deployment while
    // reporting success - and it looks fine here only because this harness
    // migrates as a superuser, for whom FORCE RLS never engages.
    const blank = await acquireBlankTestDatabase("migration-0291-force-rls-hazard");
    if (!blank) return;
    const probe = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await probe.unsafe(`
        drop role if exists og_0291_probe_owner;
        create role og_0291_probe_owner nosuperuser nobypassrls login password 'probe';
        grant create, usage on schema public to og_0291_probe_owner;
      `);
      const ownerUrl = new URL(blank.databaseUrl);
      ownerUrl.username = "og_0291_probe_owner";
      ownerUrl.password = "probe";
      const owner = postgres(ownerUrl.toString(), { max: 1, onnotice: () => undefined });
      try {
        await owner.unsafe(`
          create table probe_resource (
            id int primary key, workspace_id uuid, origin_workspace_id uuid
          );
          insert into probe_resource values (1, gen_random_uuid(), null);
          alter table probe_resource enable row level security;
          alter table probe_resource force row level security;
          create policy workspace_isolation on probe_resource using (
            workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
          );
        `);
        const [visible] = await owner<Array<{ count: string }>>`
          select count(*)::text as count from probe_resource
        `;
        expect(visible!.count).toBe("0");
        const updated = await owner.unsafe(
          "update probe_resource set origin_workspace_id = workspace_id " +
            "where origin_workspace_id is null returning id",
        );
        expect(updated.length).toBe(0);
      } finally {
        await owner.end({ timeout: 5 });
      }
      // Ground truth from a superuser: the row really is still unwritten.
      const [ground] = await probe<Array<{ stillNull: boolean }>>`
        select origin_workspace_id is null as "stillNull" from probe_resource where id = 1
      `;
      expect(ground!.stillNull).toBe(true);
    } finally {
      await probe.unsafe("drop table if exists probe_resource").catch(() => undefined);
      await probe.unsafe("drop owned by og_0291_probe_owner").catch(() => undefined);
      await probe.unsafe("drop role if exists og_0291_probe_owner").catch(() => undefined);
      await probe.end({ timeout: 5 });
      await blank.release();
    }
  }, 180_000);
});
