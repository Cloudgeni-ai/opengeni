// Migration 0298: the read-only organization tenancy PARITY seam (phase E)
// verifies the structural tenancy invariants, reports the compatibility lanes,
// and never writes, repairs, or widens anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  checkOrganizationTenancyParity,
  composeTenancyParityReport,
  createDb,
  createSession,
  migrate,
  TENANCY_PARITY_GATES,
  TENANCY_PARITY_LANES,
  TENANCY_PARITY_UNVERIFIABLE,
  type Database,
  type DbClient,
  type TenancyParityReport,
} from "../src";

const migrationUrl = new URL("../drizzle/0298_organization_tenancy_parity.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0298-tenancy-parity");
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

/** A clean organization whose every parity gate is expected to pass. */
async function seedCleanOrganization(label: string): Promise<{
  accountId: string;
  workspaceId: string;
  personalWorkspaceId: string;
  membershipId: string;
  subjectId: string;
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${label}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`${label}-ws`}) returning id`;
  const [personalWorkspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`${label}-personal`}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id}),
           (${personalWorkspace!.id}, ${account!.id})`;
  const subjectId = `user:${crypto.randomUUID()}`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships
      (account_id, subject_id, status, role, personal_workspace_id)
    values (${account!.id}, ${subjectId}, 'active', 'member', ${personalWorkspace!.id})
    returning id`;
  // The SHARED workspace carries the ordinary membership row; the personal
  // workspace deliberately carries none.
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${account!.id}, ${workspace!.id}, ${subjectId})`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    personalWorkspaceId: personalWorkspace!.id,
    membershipId: membership!.id,
    subjectId,
  };
}

function gate(report: TenancyParityReport, id: string) {
  const found = report.gates.find((entry) => entry.id === id);
  if (!found) throw new Error(`gate ${id} missing from report`);
  return found;
}

function laneResult(report: TenancyParityReport, id: string) {
  const found = report.lanes.find((entry) => entry.id === id);
  if (!found) throw new Error(`lane ${id} missing from report`);
  return found;
}

/**
 * Content-free snapshot of every table the seam can reach, used to prove the
 * checker writes nothing.
 */
const INSPECTED_TABLES = [
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
  "organization_user_resource_authorities",
  "organization_user_resource_grants",
  "connection_use_audit_facts",
  "canonical_human_identities",
  "canonical_human_identity_subjects",
  "canonical_human_login_bindings",
  "workspaces",
  "workspace_memberships",
] as const;

async function snapshotInspectedTables(): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const table of INSPECTED_TABLES) {
    // ctid + xmin make this a PHYSICAL write proof, not just a content one: an
    // UPDATE that rewrote a row back to identical bytes would still move its
    // tuple and change its inserting xid.
    const [row] = await admin.unsafe<Array<{ digest: string | null }>>(
      `select md5(coalesce(
         string_agg(t.ctid::text || ':' || t.xmin::text || ':' || t::text, '|'
           order by t.ctid::text), '')) as digest
       from ${table} t`,
    );
    snapshot[table] = row?.digest ?? "";
  }
  return snapshot;
}

describe("migration 0298 tenancy parity", () => {
  test("declares one read-only rolling seam whose only writes are its own capability row", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("CREATE OR REPLACE FUNCTION check_organization_tenancy_parity(");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("'tenancy parity scope mismatch'");
    expect(source).toContain("'tenancy parity check requires an organization id'");
    // Its own capability, never a widening of 0285's reviewed inventory seam.
    expect(source).toContain(
      "CREATE TABLE opengeni_private.organization_tenancy_parity_capabilities",
    );
    expect(source).toContain("opengeni_private.organization_tenancy_parity_capability_active()");
    expect(source).not.toContain("organization_tenancy_inventory_capability_active");
    const body = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION check_organization_tenancy_parity("),
    );
    for (const verb of ["UPDATE ", "DROP ", "ALTER TABLE ", "TRUNCATE ", "CREATE TABLE "]) {
      expect(body).not.toContain(verb);
    }
    expect(body).not.toMatch(
      /INSERT INTO (?!opengeni_private\.organization_tenancy_parity_capabilities)/u,
    );
    expect(body).not.toMatch(
      /DELETE FROM (?!opengeni_private\.organization_tenancy_parity_capabilities)/u,
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION\n  check_organization_tenancy_parity(uuid, integer, integer) FROM PUBLIC",
    );
    // Same independent EXECUTE grant the 0254/0285 capability pattern requires.
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION\n" +
        "      opengeni_private.organization_tenancy_parity_capability_active()\n" +
        "      TO opengeni_app;",
    );
    // Every catalogued gate must exist in the seam, or a gate would silently
    // never be evaluated.
    for (const definition of TENANCY_PARITY_GATES) {
      expect(source).toContain(`('${definition.id}'`);
    }
    for (const lane of TENANCY_PARITY_LANES) {
      expect(source).toContain(`'${lane.id}',`);
    }
  }, 180_000);

  test("opengeni_app holds EXECUTE on the inner capability predicate under migrate() ALONE", async () => {
    // acquireBlankTestDatabase + migrate() never runs provisionRoles' blanket
    // schema-wide EXECUTE sweep, and neither do some production migration-owner
    // topologies. The predicate must still be usable by an opengeni_app
    // -effective role reading ANY table this capability protects.
    const blank = await acquireBlankTestDatabase("migration-0293-no-provision-roles");
    if (!blank) return;
    try {
      await migrate(blank.databaseUrl);
      const probe = postgres(blank.databaseUrl, { max: 1 });
      try {
        const [row] = await probe<Array<{ appCanExecute: boolean }>>`
          select has_function_privilege(
            'opengeni_app',
            'opengeni_private.organization_tenancy_parity_capability_active()',
            'EXECUTE'
          ) as "appCanExecute"`;
        expect(row?.appCanExecute).toBe(true);
      } finally {
        await probe.end().catch(() => undefined);
      }
    } finally {
      await blank.release();
    }
  }, 180_000);

  test("a clean organization passes every gate and drains every lane", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(`parity-clean-${crypto.randomUUID().slice(0, 8)}`);
    // An ordinary shared session in the shared workspace: legacy default shape.
    await createSession(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      initialMessage: "clean fixture",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });

    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });

    expect(report.status).toBe("pass");
    expect(report.summary.gatesFailed).toBe(0);
    expect(report.summary.violations).toBe(0);
    for (const entry of report.gates) {
      expect({ id: entry.id, status: entry.status, violations: entry.violations }).toEqual({
        id: entry.id,
        status: "pass",
        violations: 0,
      });
    }
    // Every compatibility lane is genuinely reachable-zero on a clean org.
    for (const lane of report.lanes) {
      expect({ id: lane.id, count: lane.count }).toEqual({ id: lane.id, count: 0 });
    }
    expect(report.cutoverReady).toBe(true);
    expect(report.unverifiable.length).toBe(TENANCY_PARITY_UNVERIFIABLE.length);
    // Content-free: never a subject, name, or value.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(fixture.subjectId);
    expect(serialized).not.toContain("parity-clean");
  }, 180_000);

  test("a permanently undrainable legacy_unattributed writer row still leaves cutoverReady reachable", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(`parity-writer-${crypto.randomUUID().slice(0, 8)}`);
    const session = await createSession(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      initialMessage: "writer fixture",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    const [sessionRow] = await admin<{ sandboxGroupId: string }[]>`
      select sandbox_group_id as "sandboxGroupId" from sessions where id = ${session.id}`;
    const groupId = sessionRow!.sandboxGroupId;
    const [leaseRow] = await admin<{ id: string }[]>`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        turn_holders, viewer_holders, instance_id, backend, lease_epoch,
        resume_backend_id, resume_state, expires_at
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${groupId}, 'warm', 1, 0, 0,
        '0293-writer-box', 'local', 3, 'local',
        ${admin.json({ backendId: "local" })}::jsonb, now() + interval '10 minutes'
      ) returning id`;

    // A pre-0277 DIRECT admission and the process it retained. 0277's one-shot
    // attribution backfill only touched rows whose actor was a turn
    // (actor_kind / owner_actor_kind = 'turn'), so both keep the
    // legacy_unattributed sentinel PERMANENTLY - and neither table is ever
    // DELETEd anywhere in the tree, only settled by UPDATE. Aged 100 days so
    // the default 30-day observation window has already moved past them.
    const directActorId = crypto.randomUUID();
    const [admission] = await admin<{ id: string }[]>`
      insert into sandbox_workspace_mutation_admissions (
        account_id, workspace_id, lease_id, sandbox_group_id, session_id,
        actor_kind, actor_id, holder_kind, holder_id, lease_epoch,
        provider_backend, provider_instance_id, route_kind, route_epoch,
        workspace_generation, operation, provider_outcome, admitted_at
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${leaseRow!.id}, ${groupId},
        ${session.id}, 'direct', ${directActorId}, 'direct',
        ${`direct:${directActorId}`}, 3, 'local', '0293-writer-box', 'home', 0, 1,
        '0293-writer-op', 'retained', now() - interval '100 days'
      ) returning id`;
    const holderId = `process:${crypto.randomUUID()}`;
    await admin`
      insert into sandbox_lease_holders (
        account_id, workspace_id, lease_id, kind, holder_id, subject_id
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${leaseRow!.id}, 'process',
        ${holderId}, ${session.id}
      )`;
    await admin`
      insert into sandbox_retained_processes (
        account_id, workspace_id, session_id, lease_id, sandbox_group_id,
        parent_admission_id, holder_id, owner_actor_kind, owner_actor_id,
        lease_epoch, provider_backend, provider_instance_id, route_kind,
        route_epoch, provider_session_id, started_at
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, ${session.id}, ${leaseRow!.id},
        ${groupId}, ${admission!.id}, ${holderId}, 'direct', ${directActorId},
        3, 'local', '0293-writer-box', 'home', 0, 293, now() - interval '100 days'
      )`;

    // The rows really are permanently legacy_unattributed: this is the exact
    // shape that made an all-time "drainable" lane structurally unreachable.
    const [stuck] = await admin<Array<{ admissions: number; processes: number }>>`
      select
        (select count(*)::int from sandbox_workspace_mutation_admissions
          where account_id = ${fixture.accountId}
            AND initiator_kind = 'legacy_unattributed') as admissions,
        (select count(*)::int from sandbox_retained_processes
          where account_id = ${fixture.accountId}
            AND initiator_kind = 'legacy_unattributed') as processes`;
    expect(stuck).toEqual({ admissions: 1, processes: 1 });

    // Inside a window that still covers them, the lanes report them honestly
    // and the cutover gate is (correctly) not ready.
    const wide = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
      observationWindowDays: 365,
    });
    expect(wide.status).toBe("pass");
    expect(laneResult(wide, "workspaceWriterAdmissionsLegacyUnattributedInWindow").count).toBe(1);
    expect(laneResult(wide, "workspaceWriterProcessesLegacyUnattributedInWindow").count).toBe(1);
    expect(wide.cutoverReady).toBe(false);

    // Once the lane stops being exercised, the bounded window drains to zero
    // WITHOUT deleting immutable history - so cutoverReady is reachable rather
    // than structurally pinned to false forever.
    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });
    expect(report.observationWindowDays).toBe(30);
    expect(laneResult(report, "workspaceWriterAdmissionsLegacyUnattributedInWindow").count).toBe(0);
    expect(laneResult(report, "workspaceWriterProcessesLegacyUnattributedInWindow").count).toBe(0);
    expect(report.summary.lanesUndrained).toBe(0);
    expect(report.cutoverReady).toBe(true);
    // Both lanes must declare themselves observation lanes, exactly like the
    // connection-use audit lane they now match.
    for (const id of [
      "workspaceWriterAdmissionsLegacyUnattributedInWindow",
      "workspaceWriterProcessesLegacyUnattributedInWindow",
      "connectionUseLegacyResolutionsInWindow",
    ]) {
      expect(laneResult(report, id).kind).toBe("observation");
    }
  }, 180_000);

  test("a personal workspace that grows a membership row fails exactly that gate with that workspace id", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(
      `parity-personal-${crypto.randomUUID().slice(0, 8)}`,
    );
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${fixture.accountId}, ${fixture.personalWorkspaceId}, ${fixture.subjectId})`;

    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });

    expect(report.status).toBe("fail");
    expect(report.cutoverReady).toBe(false);
    const failed = gate(report, "personal_workspace_has_no_membership_row");
    expect(failed.violations).toBe(1);
    expect(failed.evidence).toEqual([fixture.personalWorkspaceId]);
    expect(failed.basis).toBe("runtime");
    // No other gate is disturbed.
    expect(
      report.gates.filter((entry) => entry.status === "fail").map((entry) => entry.id),
    ).toEqual(["personal_workspace_has_no_membership_row"]);
  }, 180_000);

  test("two memberships claiming one resource fail authority uniqueness with both authority ids", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(`parity-dual-${crypto.randomUUID().slice(0, 8)}`);
    const [secondPersonal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fixture.accountId}, 'parity-dual-personal-2') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${secondPersonal!.id}, ${fixture.accountId})`;
    const [secondMembership] = await admin<{ id: string }[]>`
      insert into organization_memberships
        (account_id, subject_id, status, role, personal_workspace_id)
      values (
        ${fixture.accountId}, ${`user:${crypto.randomUUID()}`}, 'active', 'member',
        ${secondPersonal!.id}
      ) returning id`;
    const contestedResource = crypto.randomUUID();
    const authorityIds: string[] = [];
    for (const membershipId of [fixture.membershipId, secondMembership!.id]) {
      const [authority] = await admin<{ id: string }[]>`
        insert into organization_user_resource_authorities
          (account_id, organization_membership_id, resource_kind, resource_id)
        values (${fixture.accountId}, ${membershipId}, 'connection', ${contestedResource})
        returning id`;
      authorityIds.push(authority!.id);
    }

    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });

    const failed = gate(report, "authority_resource_single_owner");
    expect(failed.violations).toBe(2);
    expect([...failed.evidence].sort()).toEqual([...authorityIds].sort());
    expect(report.status).toBe("fail");
  }, 180_000);

  test("a user-scope resource with no live anchor fails the shadow comparison, never resolving to user authority", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(`parity-shadow-${crypto.randomUUID().slice(0, 8)}`);
    const [authority] = await admin<{ id: string }[]>`
      insert into organization_user_resource_authorities
        (account_id, organization_membership_id, resource_kind, resource_id, status, revoked_at)
        values (
          ${fixture.accountId}, ${fixture.membershipId}, 'variable_set',
          ${crypto.randomUUID()}, 'revoked', now()
        ) returning id`;
    // A Variable Set that CLAIMS user scope behind a REVOKED authority.
    const [variableSet] = await admin<{ id: string }[]>`
      insert into workspace_variable_sets (
        account_id, workspace_id, name, origin_workspace_id, authority_scope, authority_id,
        owner_organization_membership_id
      ) values (
        ${fixture.accountId}, ${fixture.workspaceId}, 'orphan user set',
        ${fixture.workspaceId}, 'user', ${authority!.id}, ${fixture.membershipId}
      ) returning id`;

    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });

    const failed = gate(report, "user_scoped_resource_live_anchor");
    expect(failed.violations).toBe(1);
    expect(failed.evidence).toEqual([variableSet!.id]);
    // The report states the mismatch; it never rewrites the row toward user
    // authority. The declared scope on disk is untouched.
    const [after] = await admin<{ authorityScope: string }[]>`
      select authority_scope as "authorityScope"
      from workspace_variable_sets where id = ${variableSet!.id}`;
    expect(after?.authorityScope).toBe("user");
  }, 180_000);

  test("a disputed login binding whose identity is still usable fails the collision gate", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(
      `parity-collision-${crypto.randomUUID().slice(0, 8)}`,
    );
    const authUserId = fixture.subjectId.slice("user:".length);
    await admin`
      insert into auth_users (id, name, email, email_verified)
      values (${authUserId}, 'parity collision', ${`${authUserId}@example.test`}, true)`;
    const [identity] = await admin<{ id: string }[]>`
      insert into canonical_human_identities (display_name) values ('parity collision')
      returning id`;
    await admin`
      insert into canonical_human_identity_subjects (auth_user_id, identity_id)
      values (${authUserId}, ${identity!.id})`;
    const [binding] = await admin<{ id: string }[]>`
      insert into canonical_human_login_bindings (identity_id, provider_id, provider_account_id)
      values (${identity!.id}, 'example', ${crypto.randomUUID()}) returning id`;
    // A collision disputed the BINDING but (wrongly) left the identity active.
    await admin`
      update canonical_human_login_bindings set status = 'disputed' where id = ${binding!.id}`;

    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });

    const failed = gate(report, "login_binding_dispute_propagated");
    expect(failed.violations).toBe(1);
    expect(failed.evidence).toEqual([binding!.id]);

    // Propagating the dispute (the lifecycle's real behaviour) drains the gate:
    // the pass state is genuinely reachable.
    await admin`
      update canonical_human_identities
      set status = 'disputed', recovery_state = 'disputed'
      where id = ${identity!.id}`;
    const repaired = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });
    expect(gate(repaired, "login_binding_dispute_propagated").violations).toBe(0);
  }, 180_000);

  test("the checker writes nothing: every inspected table is byte-identical before and after", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(`parity-ro-${crypto.randomUUID().slice(0, 8)}`);
    await createSession(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      initialMessage: "read only proof",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    // Deliberately corrupt one gate so the run takes the failure path too.
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${fixture.accountId}, ${fixture.personalWorkspaceId}, ${fixture.subjectId})`;

    const before = await snapshotInspectedTables();
    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });
    expect(report.status).toBe("fail");
    const after = await snapshotInspectedTables();
    expect(after).toEqual(before);

    // The transaction-local capability row is also released, never leaked.
    const [capability] = await admin<{ rows: number }[]>`
      select count(*)::int as rows
      from opengeni_private.organization_tenancy_parity_capabilities`;
    expect(capability?.rows).toBe(0);
  }, 180_000);

  test("the seam rejects a cross-organization request (42501) and a null organization (22004)", async () => {
    if (!available) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('parity-scope-a') returning id`;
    const [victim] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('parity-scope-b') returning id`;
    let mismatch: unknown;
    try {
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select check_organization_tenancy_parity(${victim!.id})`;
      });
    } catch (error: unknown) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({ code: "42501" });

    let missing: unknown;
    try {
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select check_organization_tenancy_parity(null)`;
      });
    } catch (error: unknown) {
      missing = error;
    }
    expect(missing).toMatchObject({ code: "22004" });
  }, 180_000);

  test("evidence is bounded and truncation is reported honestly", async () => {
    if (!available) return;
    const fixture = await seedCleanOrganization(`parity-bound-${crypto.randomUUID().slice(0, 8)}`);
    // Three memberships contesting one resource: three violations of one gate.
    const contestedResource = crypto.randomUUID();
    const membershipIds = [fixture.membershipId];
    for (let index = 0; index < 2; index += 1) {
      const [personal] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${fixture.accountId}, ${`parity-bound-personal-${index}`}) returning id`;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${personal!.id}, ${fixture.accountId})`;
      const [membership] = await admin<{ id: string }[]>`
        insert into organization_memberships
          (account_id, subject_id, status, role, personal_workspace_id)
        values (
          ${fixture.accountId}, ${`user:${crypto.randomUUID()}`}, 'active', 'member',
          ${personal!.id}
        ) returning id`;
      membershipIds.push(membership!.id);
    }
    for (const membershipId of membershipIds) {
      await admin`
        insert into organization_user_resource_authorities
          (account_id, organization_membership_id, resource_kind, resource_id)
        values (${fixture.accountId}, ${membershipId}, 'rig', ${contestedResource})`;
    }

    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
      evidenceLimit: 2,
    });
    const failed = gate(report, "authority_resource_single_owner");
    expect(failed.violations).toBe(3);
    expect(failed.evidence.length).toBe(2);
    expect(failed.evidenceTruncated).toBe(true);
    expect(report.evidenceLimit).toBe(2);

    // A full-evidence run reports no truncation for the same fixture.
    const complete = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });
    expect(gate(complete, "authority_resource_single_owner").evidence.length).toBe(3);
    expect(gate(complete, "authority_resource_single_owner").evidenceTruncated).toBe(false);
  }, 180_000);

  test("session owner provenance cannot even be corrupted through the lifecycle capability", async () => {
    if (!available) return;
    // The gate's basis is 'trigger' for a reason: guard_session_authority_write
    // validates the owner pair BEFORE the capability check, so a half-set pair
    // is unreachable by any writer. Pin that, so the gate's declared basis
    // stays honest if the trigger is ever reordered.
    const fixture = await seedCleanOrganization(`parity-trig-${crypto.randomUUID().slice(0, 8)}`);
    const session = await createSession(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      initialMessage: "trigger fence",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "none",
    });
    let rejected: unknown;
    try {
      await admin.begin(async (tx) => {
        const [capability] = await tx<{ id: string }[]>`
          insert into session_visibility_write_capabilities
            (backend_pid, transaction_id, capability_id)
          values (pg_backend_pid(), pg_current_xact_id(), gen_random_uuid())
          returning capability_id as id`;
        await tx`select set_config(
          'opengeni.session_visibility_write_capability', ${capability!.id}, true)`;
        await tx`
          update sessions set owner_subject_id = ${fixture.subjectId}
          where id = ${session.id}`;
      });
    } catch (error: unknown) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: "23514" });
    const report = await checkOrganizationTenancyParity(db, {
      organizationId: fixture.accountId,
    });
    expect(gate(report, "session_owner_provenance_paired").violations).toBe(0);
  }, 180_000);

  test("composeTenancyParityReport fails a gate the seam did not emit instead of passing it", () => {
    const report = composeTenancyParityReport(
      { organizationId: "org", evidenceLimit: 10, observationWindowDays: 30, gates: {}, lanes: {} },
      { generatedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(report.status).toBe("fail");
    expect(report.summary.gatesFailed).toBe(TENANCY_PARITY_GATES.length);
    expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    // A lane the seam did not emit is likewise not silently treated as drained.
    expect(report.lanes.every((lane) => !lane.drained)).toBe(true);
    expect(report.cutoverReady).toBe(false);
  });

  test("every catalogued gate declares its evidentiary basis and every lane its drainability", () => {
    for (const definition of TENANCY_PARITY_GATES) {
      expect(["constraint", "trigger", "runtime"]).toContain(definition.basis);
      expect(definition.rule.length).toBeGreaterThan(0);
    }
    // The program's real evidence comes from the runtime-basis gates.
    expect(
      TENANCY_PARITY_GATES.filter((entry) => entry.basis === "runtime").length,
    ).toBeGreaterThan(5);
    for (const lane of TENANCY_PARITY_LANES) {
      expect(["drainable", "observation"]).toContain(lane.kind);
    }
    // The unverifiable catalog must name the structurally-undrainable shapes
    // rather than emitting a counter that can never reach zero.
    const ids = TENANCY_PARITY_UNVERIFIABLE.map((entry) => entry.id);
    expect(ids).toContain("variableSetsLegacyClassification");
    expect(ids).toContain("rigsLegacyClassification");
    expect(ids).toContain("machinesLegacyClassification");
    expect(ids).toContain("sessionsDefaultVisibility");
    expect(ids).toContain("sessionsOwnerless");
  });
});
