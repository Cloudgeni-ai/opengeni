// Migration 0297: organization-tenancy phase D session ownership classification and the one
// deterministic backfill.
//
// The load-bearing claims under test are:
//
//   1. The population is NOT "everything is ownerless". Migration 0225's
//      `guard_session_authority_write` trigger already derives ownership on
//      INSERT, so the first `measured population` test drives real inserts
//      through that live trigger and pins exactly which shapes it reaches and
//      which it silently leaves NULL. If 0225's derivation ever changes, this
//      test - not production - is where it surfaces.
//   2. Only two populations are deterministically repairable, and the seam
//      refuses every other one with a fixed reason code instead of guessing.
//   3. The backfill is idempotent, resumable, bounded, dry-run by default, and
//      changes no read: visibility, authority epoch, and `updated_at` are
//      untouched.
//   4. It still attributes a NON-ZERO count under a NOSUPERUSER NOBYPASSRLS
//      function owner - the FORCE-RLS no-op trap that a
//      superuser-migrating harness cannot otherwise catch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  backfillOrganizationSessionOwnership,
  classifyOrganizationSessionOwnership,
  createDb,
} from "../src";
import type { Database, DbClient } from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0297-session-ownership");
  if (!shared) {
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 300_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Fixture = {
  organizationId: string;
  sharedWorkspaceId: string;
  alicePersonalWorkspaceId: string;
  bobPersonalWorkspaceId: string;
  aliceMembershipId: string;
  bobMembershipId: string;
};

async function seedOrganization(label: string): Promise<Fixture> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`0297-${label}`}) returning id
  `;
  const organizationId = account!.id;
  const workspace = async (name: string): Promise<string> => {
    const [row] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${organizationId}, ${name}) returning id
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${row!.id}, ${organizationId})
    `;
    return row!.id;
  };
  const sharedWorkspaceId = await workspace("shared");
  const alicePersonalWorkspaceId = await workspace("alice-personal");
  const bobPersonalWorkspaceId = await workspace("bob-personal");
  const [alice] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${organizationId}, ${`user:alice-${label}`}, 'active', ${alicePersonalWorkspaceId})
    returning id
  `;
  const [bob] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${organizationId}, ${`user:bob-${label}`}, 'active', ${bobPersonalWorkspaceId})
    returning id
  `;
  // Only Alice holds an ordinary workspace membership in the SHARED workspace.
  // Neither personal workspace gets one - that is exactly slice B's shape.
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${organizationId}, ${sharedWorkspaceId}, ${`user:alice-${label}`}, 'admin')
  `;
  return {
    organizationId,
    sharedWorkspaceId,
    alicePersonalWorkspaceId,
    bobPersonalWorkspaceId,
    aliceMembershipId: alice!.id,
    bobMembershipId: bob!.id,
  };
}

type SessionRow = {
  id: string;
  owner_organization_membership_id: string | null;
  owner_subject_id: string | null;
  visibility: string;
  authority_epoch: number;
  updated_at: string;
};

/**
 * Insert one session through the LIVE 0225 authority trigger.
 *
 * Migration 0214's `sessions_mark_activity_pending` is disabled around the
 * insert. That trigger is unrelated workspace-activity-revision bookkeeping
 * which would otherwise demand a full commit-gate open/finalize cycle; with it
 * off the row lands in the same quiescent state (`activity_revision = 0`, no
 * pending xid) a finalized gate produces. `sessions_authority_write_fence` -
 * the trigger actually under test - stays enabled throughout.
 */
async function insertSession(
  fixture: Fixture,
  workspaceId: string,
  overrides: Record<string, unknown>,
): Promise<SessionRow> {
  const id = crypto.randomUUID();
  const row = {
    id,
    account_id: fixture.organizationId,
    workspace_id: workspaceId,
    initial_message: "0297 fixture",
    model: "gpt-5",
    sandbox_backend: "none",
    sandbox_group_id: id,
    reasoning_effort: "medium",
    latency_mode: "standard",
    first_party_mcp_tools: admin.json([]),
    tool_policy: admin.json({ mode: "workspace_default", inheritedFromSessionId: null }),
    ...overrides,
  };
  await admin.unsafe("alter table sessions disable trigger sessions_mark_activity_pending");
  try {
    const [inserted] = await admin<SessionRow[]>`
      insert into sessions ${admin(row as never)}
      returning id, owner_organization_membership_id, owner_subject_id,
                visibility, authority_epoch, updated_at
    `;
    return inserted!;
  } finally {
    await admin.unsafe("alter table sessions enable trigger sessions_mark_activity_pending");
  }
}

async function readSession(sessionId: string): Promise<SessionRow> {
  const [row] = await admin<SessionRow[]>`
    select id, owner_organization_membership_id, owner_subject_id,
           visibility, authority_epoch, updated_at
    from sessions where id = ${sessionId}
  `;
  return row!;
}

type ClassificationReport = {
  schemaVersion: number;
  organizationId: string;
  runKey: string | null;
  ledgerAvailable: boolean;
  rewroteSessionRows: boolean;
  sessions: {
    total: number;
    ownerAttributed: number;
    repairablePersonalWorkspace: number;
    repairableParentInheritance: number;
    unresolved: number;
    unresolvedByReason: Record<string, number>;
    unresolvedRows: Array<{ sessionId: string; reasonCode: string }>;
    unresolvedTruncated: boolean;
    receiptId?: string;
  };
};

type BackfillReport = {
  organizationId: string;
  ledgerAvailable: boolean;
  dryRun: boolean;
  limit: number;
  personalWorkspaceCandidates: number;
  parentInheritanceCandidates: number;
  personalWorkspaceAttributed: number;
  parentInheritanceAttributed: number;
  attributed: number;
  moreLikely: boolean;
};

async function classify(
  organizationId: string,
  runKey?: string | null,
): Promise<ClassificationReport> {
  return (await classifyOrganizationSessionOwnership(db, {
    organizationId,
    runKey: runKey ?? null,
  })) as unknown as ClassificationReport;
}

async function backfill(
  organizationId: string,
  input: { limit?: number; dryRun?: boolean; runKey?: string | null } = {},
): Promise<BackfillReport> {
  return (await backfillOrganizationSessionOwnership(db, {
    organizationId,
    ...input,
  })) as unknown as BackfillReport;
}

describe("migration 0297 session ownership", () => {
  test("measured population: which shapes migration 0225 actually attributes", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("population");
    const label = "population";

    // The trigger DOES attribute this one. The premise "nothing writes
    // session ownership" is false.
    const attributed = await insertSession(fixture, fixture.sharedWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: `user:alice-${label}`,
    });
    expect(attributed.owner_organization_membership_id).toBe(fixture.aliceMembershipId);
    expect(attributed.owner_subject_id).toBe(`user:alice-${label}`);
    expect(attributed.authority_epoch).toBe(1);

    // A managed human in HER OWN personal workspace is NOT attributed:
    // slice B's personal workspace deliberately has no workspace_memberships
    // row, so the trigger's second branch fails its EXISTS guard.
    const personal = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: `user:alice-${label}`,
    });
    expect(personal.owner_organization_membership_id).toBeNull();

    // An active managed human with no workspace membership in a shared
    // workspace: also not attributed.
    const noWorkspaceMembership = await insertSession(fixture, fixture.sharedWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: `user:bob-${label}`,
    });
    expect(noWorkspaceMembership.owner_organization_membership_id).toBeNull();

    // An API-key subject can never acquire an organization anchor.
    const apiKey = await insertSession(fixture, fixture.sharedWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "api_key:00000000-0000-4000-8000-000000000001",
    });
    expect(apiKey.owner_organization_membership_id).toBeNull();

    // Service-created (scheduler / delegated host / pre-0096 legacy default).
    const service = await insertSession(fixture, fixture.sharedWorkspaceId, {});
    expect(service.owner_organization_membership_id).toBeNull();

    // The parent branch WINS even when it resolves NULL: a child of an
    // ownerless parent is ownerless no matter who created it.
    const childOfOwnerless = await insertSession(fixture, fixture.sharedWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: `user:alice-${label}`,
      parent_session_id: service.id,
    });
    expect(childOfOwnerless.owner_organization_membership_id).toBeNull();

    // ...and it inherits verbatim when the parent IS owned, even from an
    // API-key creator.
    const childOfOwned = await insertSession(fixture, fixture.sharedWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "api_key:00000000-0000-4000-8000-000000000001",
      parent_session_id: attributed.id,
    });
    expect(childOfOwned.owner_organization_membership_id).toBe(fixture.aliceMembershipId);

    // Bob's session inside ALICE's personal workspace: the workspace anchor
    // and the creator disagree, so it must stay unresolved forever.
    const crossPersonal = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: `user:bob-${label}`,
    });
    expect(crossPersonal.owner_organization_membership_id).toBeNull();

    const report = await classify(fixture.organizationId);
    expect(report.rewroteSessionRows).toBe(false);
    expect(report.sessions.total).toBe(8);
    expect(report.sessions.ownerAttributed).toBe(2);
    expect(report.sessions.repairablePersonalWorkspace).toBe(1);
    expect(report.sessions.repairableParentInheritance).toBe(0);
    expect(report.sessions.unresolvedByReason).toEqual({
      no_deterministic_evidence: 2,
      external_lane_owns_row: 1,
      legacy_shape_unrecognized: 1,
      ambiguous_candidate_authority: 1,
    });
    const byId = new Map(report.sessions.unresolvedRows.map((r) => [r.sessionId, r.reasonCode]));
    expect(byId.get(noWorkspaceMembership.id)).toBe("no_deterministic_evidence");
    expect(byId.get(apiKey.id)).toBe("external_lane_owns_row");
    expect(byId.get(service.id)).toBe("legacy_shape_unrecognized");
    // A fully attributable human whose session hangs off an ownerless parent
    // in a SHARED workspace is still refused: replaying the trigger's second
    // branch here would read today's workspace grants.
    expect(byId.get(childOfOwnerless.id)).toBe("no_deterministic_evidence");
    expect(byId.get(crossPersonal.id)).toBe("ambiguous_candidate_authority");
  }, 300_000);

  test("classification proves attributed rows no constraint can prove", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("attributed");
    const session = await insertSession(fixture, fixture.sharedWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:alice-attributed",
    });

    // The two FKs prove the membership id exists and that (account, subject)
    // exists - not that they are the SAME row. Break exactly that. 0225's
    // authority fence is disabled only to INJECT a state no supported writer
    // can produce; the point is that the classifier detects it.
    const corrupt = async (subjectId: string): Promise<void> => {
      await admin.unsafe("alter table sessions disable trigger sessions_authority_write_fence");
      try {
        await admin`update sessions set owner_subject_id = ${subjectId} where id = ${session.id}`;
      } finally {
        await admin.unsafe("alter table sessions enable trigger sessions_authority_write_fence");
      }
    };
    await corrupt("user:bob-attributed");
    let report = await classify(fixture.organizationId);
    expect(report.sessions.ownerAttributed).toBe(0);
    expect(report.sessions.unresolvedByReason).toMatchObject({ conflicting_authority_rows: 1 });

    await corrupt("user:alice-attributed");
    await admin`
        update organization_memberships set status = 'suspended'
        where id = ${fixture.aliceMembershipId}
      `;
    report = await classify(fixture.organizationId);
    expect(report.sessions.ownerAttributed).toBe(0);
    expect(report.sessions.unresolvedByReason).toMatchObject({
      missing_organization_membership: 1,
    });
  }, 300_000);

  test("backfill is dry-run by default and writes nothing", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("dry-run");
    const personal = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:alice-dry-run",
    });

    const report = await backfill(fixture.organizationId);
    expect(report.dryRun).toBe(true);
    expect(report.personalWorkspaceCandidates).toBe(1);
    // A dry run reports only the backlog that exists RIGHT NOW; it never
    // models the inheritance closure a real run's root writes would create.
    expect(report.parentInheritanceCandidates).toBe(0);
    expect(report.attributed).toBe(0);
    expect(report.moreLikely).toBe(false);
    expect((await readSession(personal.id)).owner_organization_membership_id).toBeNull();
  }, 300_000);

  test("backfill attributes the personal-workspace convergence and its inheritance closure", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("apply");
    const root = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:alice-apply",
    });
    // A whole ownerless subtree under that root, including a grandchild and a
    // child whose own creator is an API key.
    const child = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "api_key:00000000-0000-4000-8000-000000000002",
      parent_session_id: root.id,
    });
    const grandchild = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "service",
      created_by_subject_id: "scheduler",
      parent_session_id: child.id,
    });
    // Bob's session in Alice's personal workspace must be left alone.
    const crossPersonal = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:bob-apply",
    });

    const before = await readSession(root.id);
    const report = await backfill(fixture.organizationId, { dryRun: false });
    expect(report.dryRun).toBe(false);
    expect(report.personalWorkspaceAttributed).toBe(1);
    expect(report.parentInheritanceAttributed).toBe(2);
    expect(report.attributed).toBe(3);

    for (const id of [root.id, child.id, grandchild.id]) {
      const row = await readSession(id);
      expect(row.owner_organization_membership_id).toBe(fixture.aliceMembershipId);
      expect(row.owner_subject_id).toBe("user:alice-apply");
      // Never a grant: visibility, epoch, and updated_at are untouched.
      expect(row.visibility).toBe("workspace_shared");
      expect(row.authority_epoch).toBe(1);
    }
    expect((await readSession(root.id)).updated_at).toEqual(before.updated_at);
    expect((await readSession(crossPersonal.id)).owner_organization_membership_id).toBeNull();

    // Idempotent: a second run attributes nothing.
    const second = await backfill(fixture.organizationId, { dryRun: false });
    expect(second.attributed).toBe(0);

    const report2 = await classify(fixture.organizationId);
    expect(report2.sessions.ownerAttributed).toBe(3);
    expect(report2.sessions.repairablePersonalWorkspace).toBe(0);
    expect(report2.sessions.unresolvedByReason).toEqual({ ambiguous_candidate_authority: 1 });
  }, 300_000);

  test("backfill is bounded and resumable across batches", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("batched");
    for (let index = 0; index < 5; index += 1) {
      await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
        created_by_kind: "subject",
        created_by_subject_id: "user:alice-batched",
      });
    }
    const first = await backfill(fixture.organizationId, { dryRun: false, limit: 2 });
    expect(first.personalWorkspaceAttributed).toBe(2);
    expect(first.moreLikely).toBe(true);
    const second = await backfill(fixture.organizationId, { dryRun: false, limit: 2 });
    expect(second.personalWorkspaceAttributed).toBe(2);
    const third = await backfill(fixture.organizationId, { dryRun: false, limit: 2 });
    expect(third.personalWorkspaceAttributed).toBe(1);
    expect(third.moreLikely).toBe(false);
    expect((await classify(fixture.organizationId)).sessions.ownerAttributed).toBe(5);
  }, 300_000);

  test("a revoked personal-workspace anchor is never a candidate", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("revoked");
    const session = await insertSession(fixture, fixture.bobPersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:bob-revoked",
    });
    await admin`
        update organization_memberships
        set status = 'revoked', revoked_at = now(), personal_workspace_id = null
        where id = ${fixture.bobMembershipId}
      `;
    const report = await backfill(fixture.organizationId, { dryRun: false });
    expect(report.attributed).toBe(0);
    expect((await readSession(session.id)).owner_organization_membership_id).toBeNull();
    const classification = await classify(fixture.organizationId);
    expect(classification.sessions.unresolvedByReason).toMatchObject({
      missing_organization_membership: 1,
    });
  }, 300_000);

  test("scope and argument guards fail closed", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("guards");
    const other = await seedOrganization("guards-other");

    // Every probe runs in its own transaction with transaction-local GUCs,
    // so a fail-closed path can never leak scope onto a pooled connection.
    const probe = async (gucs: Record<string, string>, call: string): Promise<string> => {
      try {
        await admin.begin(async (tx) => {
          for (const [name, value] of Object.entries(gucs)) {
            await tx`select set_config(${name}, ${value}, true)`;
          }
          await tx.unsafe(call);
        });
        return "no-error";
      } catch (caught) {
        return (caught as { code?: string }).code ?? String(caught);
      }
    };
    const account = { "opengeni.account_id": fixture.organizationId };

    // Answering about another organization while scoped to this one.
    expect(
      await probe(
        account,
        `select classify_organization_session_ownership('${other.organizationId}'::uuid)`,
      ),
    ).toBe("42501");
    // An actor subject scope would make `session_visibility_isolation` hide
    // another owner's private sessions and UNDERCOUNT instead of failing.
    expect(
      await probe(
        { ...account, "opengeni.subject_id": "user:alice-guards" },
        `select classify_organization_session_ownership('${fixture.organizationId}'::uuid)`,
      ),
    ).toBe("42501");
    expect(
      await probe(
        account,
        `select backfill_organization_session_ownership(
             '${fixture.organizationId}'::uuid, 0, true, null)`,
      ),
    ).toBe("22023");
    expect(
      await probe(
        account,
        `select backfill_organization_session_ownership(
             '${fixture.organizationId}'::uuid, 5001, true, null)`,
      ),
    ).toBe("22023");
    expect(
      await probe(
        account,
        `select backfill_organization_session_ownership(
             '${fixture.organizationId}'::uuid, 500, true, '   ')`,
      ),
    ).toBe("22023");
    // A sane call in the same shape still succeeds, so the guards above are
    // not passing for an unrelated reason.
    expect(
      await probe(
        account,
        `select backfill_organization_session_ownership(
             '${fixture.organizationId}'::uuid, 500, true, null)`,
      ),
    ).toBe("no-error");
  }, 300_000);

  test("the ledger is optional and its calls are exact when present", async () => {
    if (!shared) return;
    const fixture = await seedOrganization("ledger");
    await insertSession(fixture, fixture.sharedWorkspaceId, {});

    // The ledger lives in its own (unmerged) migration. Without it the seam
    // must report `ledgerAvailable: false` and still answer.
    const withoutLedger = await classify(fixture.organizationId, "run-1");
    expect(withoutLedger.ledgerAvailable).toBe(false);
    expect(withoutLedger.sessions.unresolved).toBe(1);

    // Contract stubs with the ledger's exact signatures prove the seam calls
    // it correctly and that `to_regprocedure` flips `ledgerAvailable`. These
    // are stand-ins for the real ledger, not a copy of its tables.
    await admin.unsafe(`
        create table if not exists ledger_probe_calls (
          call_order bigserial primary key,
          routine text not null,
          detail text not null
        );
        create or replace function open_tenancy_backfill_receipt(
          p_account_id uuid, p_resource_family text, p_run_key text
        ) returns uuid language plpgsql as $probe$
        begin
          insert into ledger_probe_calls (routine, detail)
          values ('open', p_resource_family || '/' || p_run_key);
          return '11111111-1111-4111-8111-111111111111'::uuid;
        end $probe$;
        create or replace function record_tenancy_backfill_unresolved(
          p_receipt_id uuid, p_resource_id uuid, p_reason_code text
        ) returns void language plpgsql as $probe$
        begin
          insert into ledger_probe_calls (routine, detail)
          values ('unresolved', p_resource_id::text || '/' || p_reason_code);
        end $probe$;
        create or replace function complete_tenancy_backfill_receipt(
          p_receipt_id uuid, p_classified_count bigint, p_skipped_count bigint,
          p_status text default 'completed'
        ) returns void language plpgsql as $probe$
        begin
          insert into ledger_probe_calls (routine, detail)
          values ('complete', p_classified_count || '/' || p_skipped_count || '/' || p_status);
        end $probe$;
      `);
    try {
      const withLedger = await classify(fixture.organizationId, "run-2");
      expect(withLedger.ledgerAvailable).toBe(true);
      expect(withLedger.sessions.receiptId).toBe("11111111-1111-4111-8111-111111111111");
      const calls = await admin<{ routine: string; detail: string }[]>`
          select routine, detail from ledger_probe_calls order by call_order
        `;
      expect(calls.map((row) => row.routine)).toEqual(["open", "unresolved", "complete"]);
      expect(calls[0]!.detail).toBe("sessions/run-2");
      expect(calls[1]!.detail.endsWith("/legacy_shape_unrecognized")).toBe(true);
      expect(calls[2]!.detail).toBe("0/0/completed");
    } finally {
      await admin.unsafe(`
          drop function if exists open_tenancy_backfill_receipt(uuid, text, text);
          drop function if exists record_tenancy_backfill_unresolved(uuid, uuid, text);
          drop function if exists complete_tenancy_backfill_receipt(uuid, bigint, bigint, text);
          drop table if exists ledger_probe_calls;
        `);
    }
  }, 300_000);

  test("attributes a non-zero count under a NOSUPERUSER NOBYPASSRLS owner", async () => {
    if (!shared) return;
    // The FORCE-RLS no-op trap: `sessions` is FORCE RLS, and FORCE RLS applies to the table
    // owner unless it holds BYPASSRLS. The documented deployment posture is a
    // non-superuser migration principal. Under that posture a seam without a
    // capability policy silently matches ZERO rows and reports success. This
    // test reassigns every routine and re-points every policy this seam owns
    // to a synthetic NOSUPERUSER NOBYPASSRLS role and proves a real, non-zero
    // attribution still happens.
    const fixture = await seedOrganization("rls-owner");
    const root = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:alice-rls-owner",
    });
    const child = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "service",
      created_by_subject_id: "scheduler",
      parent_session_id: root.id,
    });

    const probeRole = `session_ownership_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const [ownerRow] = await admin<{ ownerName: string }[]>`
        select pg_get_userbyid(proowner) as "ownerName"
        from pg_proc where proname = 'classify_organization_session_ownership'
      `;
    const originalOwner = ownerRow!.ownerName;
    const routines = [
      "classify_organization_session_ownership(uuid, text)",
      "backfill_organization_session_ownership(uuid, integer, boolean, text)",
      "opengeni_private.session_ownership_capability_active()",
      "opengeni_private.assert_session_ownership_scope(uuid, text)",
      "opengeni_private.tenancy_backfill_ledger_available()",
    ];
    const repointPolicies = async (role: string): Promise<void> => {
      await admin.unsafe(`
          drop policy if exists session_ownership_capability_write on sessions;
          create policy session_ownership_capability_write on sessions
            for all using (current_user = '${role}'
              and opengeni_private.session_ownership_capability_active())
            with check (current_user = '${role}'
              and opengeni_private.session_ownership_capability_active());
          drop policy if exists session_ownership_capability_read on organization_memberships;
          create policy session_ownership_capability_read on organization_memberships
            for select using (current_user = '${role}'
              and opengeni_private.session_ownership_capability_active());
          drop policy if exists session_visibility_capability_owner
            on session_visibility_write_capabilities;
          create policy session_visibility_capability_owner
            on session_visibility_write_capabilities
            for all using (current_user = '${role}') with check (current_user = '${role}');
        `);
    };
    try {
      await admin.unsafe(`create role ${probeRole} nosuperuser nobypassrls nologin`);
      // Ordinary table/function privileges only - never BYPASSRLS. This
      // isolates the ONE variable under test.
      await admin.unsafe(`grant usage on schema opengeni_private to ${probeRole}`);
      await admin.unsafe(`grant select on all tables in schema opengeni_private to ${probeRole}`);
      await admin.unsafe(
        `grant select, insert, update, delete on all tables in schema public to ${probeRole}`,
      );
      await admin.unsafe(
        `grant insert, delete on opengeni_private.session_ownership_capabilities to ${probeRole}`,
      );
      await admin.unsafe(
        `do $$declare r record; begin
             for r in select p.oid::regprocedure as sig from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('opengeni_private', 'public')
             loop execute format('grant execute on function %s to ${probeRole}', r.sig); end loop;
           end$$;`,
      );
      for (const routine of routines) {
        await admin.unsafe(`alter function ${routine} owner to ${probeRole}`);
      }
      await repointPolicies(probeRole);

      const report = await backfill(fixture.organizationId, { dryRun: false });
      // Under the FORCE-RLS trap this silently returns 0 and "succeeds".
      expect(report.personalWorkspaceAttributed).toBe(1);
      expect(report.parentInheritanceAttributed).toBe(1);
      expect((await readSession(root.id)).owner_subject_id).toBe("user:alice-rls-owner");
      expect((await readSession(child.id)).owner_subject_id).toBe("user:alice-rls-owner");

      const classification = await classify(fixture.organizationId);
      expect(classification.sessions.ownerAttributed).toBe(2);
    } finally {
      for (const routine of routines) {
        await admin
          .unsafe(`alter function ${routine} owner to ${originalOwner}`)
          .catch(() => undefined);
      }
      await repointPolicies(originalOwner).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${probeRole}`).catch(() => undefined);
    }
  }, 300_000);

  test("the write path never attributes a subject the classifier calls unrepairable", async () => {
    if (!shared) return;
    // The exact shape where the backfill's candidate predicate could be more
    // permissive than the classifier that authorizes it: an anchor whose
    // subject is NOT a `user:` identity, owning a personal workspace, with a
    // session created by that same non-`user:` subject. Every join condition
    // the candidate CTE tests is satisfied; only the classifier's
    // `created_by_subject_id LIKE 'user:%'` fence separates the two, and
    // `external_lane_owns_row` is documented as permanently unrepairable.
    //
    // Unreachable through today's supported writers - 0263 revokes application
    // DML on `organization_memberships`, and 0219/0263 gate provisioning to
    // `user:%` - so this is seeded as durable state, exactly as a legacy or
    // out-of-band row would arrive. The point is that the invariant is enforced
    // HERE by construction rather than borrowed from two other migrations.
    const fixture = await seedOrganization("external-lane-write");
    const externalSubject = "api_key:00000000-0000-4000-8000-000000000003";
    const [externalWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fixture.organizationId}, 'external-lane-personal') returning id
    `;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${externalWorkspace!.id}, ${fixture.organizationId})
    `;
    await admin`
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${fixture.organizationId}, ${externalSubject}, 'active', ${externalWorkspace!.id})
    `;
    const external = await insertSession(fixture, externalWorkspace!.id, {
      created_by_kind: "subject",
      created_by_subject_id: externalSubject,
    });
    expect(external.owner_organization_membership_id).toBeNull();
    expect(external.owner_subject_id).toBeNull();

    // The classifier's verdict is the contract the write path must obey.
    const classification = await classify(fixture.organizationId);
    expect(classification.sessions.repairablePersonalWorkspace).toBe(0);
    expect(classification.sessions.unresolvedByReason).toEqual({ external_lane_owns_row: 1 });
    expect(classification.sessions.unresolvedRows).toEqual([
      { sessionId: external.id, reasonCode: "external_lane_owns_row" },
    ]);

    // A dry run must not promise an attribution the classifier refuses...
    const preview = await backfill(fixture.organizationId, { dryRun: true });
    expect(preview.personalWorkspaceCandidates).toBe(0);
    expect(preview.parentInheritanceCandidates).toBe(0);

    // ...and --apply must not perform one.
    const applied = await backfill(fixture.organizationId, { dryRun: false });
    expect(applied.personalWorkspaceAttributed).toBe(0);
    expect(applied.parentInheritanceAttributed).toBe(0);
    expect(applied.attributed).toBe(0);

    const after = await readSession(external.id);
    expect(after.owner_organization_membership_id).toBeNull();
    expect(after.owner_subject_id).toBeNull();
    expect(after.authority_epoch).toBe(external.authority_epoch);
    expect(after.updated_at).toEqual(external.updated_at);

    // Still unrepairable after the run, with the identical verdict.
    const afterClassification = await classify(fixture.organizationId);
    expect(afterClassification.sessions.unresolvedByReason).toEqual({
      external_lane_owns_row: 1,
    });

    // A `user:` sibling in the same organization still converges, so the fence
    // is a fence and not a switch that turned the backfill off.
    const human = await insertSession(fixture, fixture.alicePersonalWorkspaceId, {
      created_by_kind: "subject",
      created_by_subject_id: "user:alice-external-lane-write",
    });
    const humanRun = await backfill(fixture.organizationId, { dryRun: false });
    expect(humanRun.personalWorkspaceAttributed).toBe(1);
    const humanRow = await readSession(human.id);
    expect(humanRow.owner_organization_membership_id).toBe(fixture.aliceMembershipId);
    expect(humanRow.owner_subject_id).toBe("user:alice-external-lane-write");
  }, 300_000);
});
