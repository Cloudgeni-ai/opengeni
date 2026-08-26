// Migration 0277: every persistable /workspace writer admission and retained
// process carries its own authority tuple. The rolling backfill promotes only
// rows whose frozen turn/attempt snapshot makes the authority unambiguous;
// `direct` and `process` rows that never had an owner keep the honest
// sentinel, and nothing running is terminated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

const migrationUrl = new URL(
  "../drizzle/0277_workspace_writer_authority_attribution.sql",
  import.meta.url,
);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function applyThrough0276(admin: Sql): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file < "0277_")
    .sort();
  await admin.unsafe(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  // Mirror the session facts the real migrator establishes before replaying
  // the ledger: later cutovers (0257) fail closed without an explicit
  // application role list.
  await admin`select set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
  for (const file of files) {
    await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
    await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
  }
}

let shared: SharedTestDatabase | null = null;

async function expectPostgresRejection(query: PromiseLike<unknown>, label: string): Promise<void> {
  try {
    await query;
  } catch {
    return;
  }
  throw new Error(`Expected PostgreSQL to reject ${label}`);
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0277-writer-authority");
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

describe("migration 0277 workspace writer authority attribution", () => {
  test("declares one rolling writer-attribution protocol", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    // The rolling sentinel pair, on both writer tables.
    expect(source).toContain("DEFAULT 'legacy_unattributed'");
    expect(source).toContain("DEFAULT 'unattributed-legacy'");
    for (const table of ["sandbox_workspace_mutation_admissions", "sandbox_retained_processes"]) {
      for (const constraint of [
        `${table}_initiator_check`,
        `${table}_tenancy_check`,
        `${table}_initiator_membership_fk`,
        `${table}_authority_owner_fk`,
      ]) {
        expect(source).toContain(`"${constraint}"`);
        expect(source).toContain(`VALIDATE CONSTRAINT "${constraint}"`);
      }
    }
    // Expand online: every constraint lands NOT VALID first.
    expect((source.match(/NOT VALID/gu) ?? []).length).toBe(8);
    // The two halves stay independent: only the missing tenancy half marks a
    // pre-0277 row.
    expect(source).toContain("two INDEPENDENT halves");
    // The grant seam is the only new runtime surface, and it is tenant-fenced.
    expect(source).toContain("CREATE FUNCTION resolve_workspace_writer_grant_identity(");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("opengeni_private.current_account_id()");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION resolve_workspace_writer_grant_identity(uuid,text) FROM PUBLIC",
    );
    expect(source).toContain("TO opengeni_app");
    // Backfill promotes; it never destroys evidence.
    expect(source).not.toMatch(/\bDROP TABLE\b/u);
    expect(source).not.toMatch(/\bDELETE FROM\b/u);
    expect(source).not.toMatch(/\bTRUNCATE\b/u);
    // The membership FKs must survive offboarding, which keeps the row.
    expect(source).toContain("ON DELETE RESTRICT");
    expect(source).not.toContain("ON DELETE CASCADE");
  });

  test("the grant seam resolves only the caller's own tenant", async () => {
    if (!shared) return;
    const [tenantA] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0277 seam tenant a') returning id`;
    const [tenantB] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0277 seam tenant b') returning id`;
    const subjectId = `user:0277-seam-${crypto.randomUUID()}`;
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${tenantB!.id}, '0277 seam personal') returning id`;
    const [membership] = await shared.admin<{ id: string }[]>`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id, authorization_revision
      ) values (${tenantB!.id}, ${subjectId}, 'member', 'active', ${personal!.id}, 5)
      returning id`;

    const resolveAs = async (contextAccountId: string, targetAccountId: string) =>
      await shared!.admin.begin(async (tx) => {
        await tx`set local role opengeni_app`;
        await tx`select set_config('opengeni.account_id', ${contextAccountId}, true)`;
        return await tx<
          Array<{
            membership_id: string;
            membership_status: string;
            authorization_revision: string;
          }>
        >`
          select membership_id, membership_status, authorization_revision
          from resolve_workspace_writer_grant_identity(${targetAccountId}::uuid, ${subjectId})
        `;
      });

    // The caller's own tenant resolves exactly the grant identity: id, status,
    // revision - nothing else.
    const own = await resolveAs(tenantB!.id, tenantB!.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toEqual({
      membership_id: membership!.id,
      membership_status: "active",
      authorization_revision: "5",
    });
    // A caller established in tenant A cannot resolve tenant B's grant even by
    // naming B explicitly, and cannot resolve anything against a mismatched
    // pair in either direction.
    expect(await resolveAs(tenantA!.id, tenantB!.id)).toHaveLength(0);
    expect(await resolveAs(tenantB!.id, tenantA!.id)).toHaveLength(0);
  });

  test("promotes only unambiguous turn-owned rows and preserves direct sentinels on replay", async () => {
    const blank = await acquireBlankTestDatabase("migration-0277-backfill-replay");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
    try {
      await applyThrough0276(admin);
      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('0277 backfill account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, '0277 backfill workspace') returning id`;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;
      const humanSubject = "user:0277-backfill-human";
      const [personal] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, '0277 backfill personal') returning id`;
      const [membership] = await admin<{ id: string }[]>`
        insert into organization_memberships (
          account_id, subject_id, role, status, personal_workspace_id, authorization_revision
        ) values (${account!.id}, ${humanSubject}, 'member', 'active', ${personal!.id}, 9)
        returning id`;

      await admin.unsafe("alter table sessions disable trigger user");
      await admin.unsafe("alter table session_turns disable trigger user");
      await admin.unsafe("alter table session_turn_attempts disable trigger user");
      const sessionId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id, tool_policy, root_session_id, nested_agent_depth,
          effective_max_nested_agent_depth, nested_agent_depth_policy_source,
          nested_agent_depth_policy_session_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'backfill', 'test-model',
          'none', ${groupId},
          ${admin.json({ mode: "workspace_default", inheritedFromSessionId: null })}::jsonb,
          ${sessionId}, 0, 5, 'session', ${sessionId}
        )`;

      // Two historical turns: one with a real frozen initiator, one frozen
      // before migration 0096 (the column-default sentinel).
      const attributedTurnId = crypto.randomUUID();
      const sentinelTurnId = crypto.randomUUID();
      await admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model, reasoning_effort,
          sandbox_backend, initiator_kind, initiator_subject_id,
          initiating_human_subject_id, finished_at
        ) values
        (
          ${attributedTurnId}, ${account!.id}, ${workspace!.id}, ${sessionId},
          ${crypto.randomUUID()}, ${`0277-${attributedTurnId}`}, 'completed', 1,
          'attributed', 'test-model', 'medium', 'none', 'subject', ${humanSubject},
          ${humanSubject}, now()
        ),
        (
          ${sentinelTurnId}, ${account!.id}, ${workspace!.id}, ${sessionId},
          ${crypto.randomUUID()}, ${`0277-${sentinelTurnId}`}, 'completed', 2,
          'pre-0096', 'test-model', 'medium', 'none', 'service',
          'unattributed-legacy', null, now()
        )`;
      const attributedAttemptId = crypto.randomUUID();
      const sentinelAttemptId = crypto.randomUUID();
      for (const [attemptId, turnId] of [
        [attributedAttemptId, attributedTurnId],
        [sentinelAttemptId, sentinelTurnId],
      ] as const) {
        // Historical fixture: the 0222 freeze already stamped the session's
        // authority epoch/visibility onto the attempt when it ran live.
        await admin`
          insert into session_turn_attempts (
            id, account_id, workspace_id, session_id, turn_id, execution_generation,
            state, outcome, closed_at, temporal_workflow_id, temporal_workflow_run_id,
            temporal_activity_id, verified_control_revision, mcp_approval_policies,
            authority_epoch, authority_visibility
          ) values (
            ${attemptId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId},
            1, 'closed', 'completed', now(), ${`0277-${turnId}`}, ${`run-${attemptId}`},
            ${`activity-${attemptId}`}, 0, '{}'::jsonb, 1, 'workspace_shared'
          )`;
      }

      const [lease] = await admin<{ id: string }[]>`
        insert into sandbox_leases (
          account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          resume_backend_id, resume_state, expires_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${groupId}, 'warm', 1, 1, 0,
          '0277-backfill-box', 'local', 3, 'local',
          ${admin.json({ backendId: "local" })}::jsonb, now() + interval '10 minutes'
        ) returning id`;

      // Four pre-0277 admissions on the same lease: two settled turn-owned
      // ones (attributed and sentinel-initiator), plus one turn-owned and one
      // direct admission still open behind a retained yielded process.
      const directActorId = crypto.randomUUID();
      const admitPre0277 = async (input: {
        actor: "turn" | "direct";
        actorId: string;
        turnId?: string;
        attemptId?: string;
        generation: number;
        outcome: "resolved" | "retained";
      }): Promise<string> => {
        const [row] = await admin<{ id: string }[]>`
          insert into sandbox_workspace_mutation_admissions (
            account_id, workspace_id, lease_id, sandbox_group_id, session_id,
            actor_kind, actor_id, turn_id, attempt_id, execution_generation,
            holder_kind, holder_id, lease_epoch, provider_backend,
            provider_instance_id, route_kind, route_epoch, workspace_generation,
            operation, provider_outcome, settled_at
          ) values (
            ${account!.id}, ${workspace!.id}, ${lease!.id}, ${groupId}, ${sessionId},
            ${input.actor}, ${input.actorId},
            ${input.turnId ?? null}, ${input.attemptId ?? null},
            ${input.actor === "turn" ? 1 : null}, ${input.actor},
            ${input.actor === "turn" ? `turn-attempt:${input.attemptId}` : `direct:${input.actorId}`},
            3, 'local', '0277-backfill-box', 'home', 0, ${input.generation},
            ${`0277-op-${input.generation}`}, ${input.outcome},
            ${input.outcome === "resolved" ? admin`now()` : null}
          ) returning id`;
        return row!.id;
      };
      const attributedAdmissionId = await admitPre0277({
        actor: "turn",
        actorId: attributedAttemptId,
        turnId: attributedTurnId,
        attemptId: attributedAttemptId,
        generation: 1,
        outcome: "resolved",
      });
      const sentinelAdmissionId = await admitPre0277({
        actor: "turn",
        actorId: sentinelAttemptId,
        turnId: sentinelTurnId,
        attemptId: sentinelAttemptId,
        generation: 2,
        outcome: "resolved",
      });
      const yieldedAdmissionId = await admitPre0277({
        actor: "turn",
        actorId: attributedAttemptId,
        turnId: attributedTurnId,
        attemptId: attributedAttemptId,
        generation: 3,
        outcome: "retained",
      });
      const directAdmissionId = await admitPre0277({
        actor: "direct",
        actorId: directActorId,
        generation: 4,
        outcome: "retained",
      });

      // A pre-0277 retained process yielded by the attributed turn, plus one
      // retained by the ownerless direct request. Both keep the live holder
      // rows the v2 validator requires of an active process.
      const insertProcess = async (input: {
        admissionId: string;
        owner: "turn" | "direct";
        actorId: string;
        turnId?: string;
        attemptId?: string;
        providerSessionId: number;
      }): Promise<string> => {
        const holderId = `process:${crypto.randomUUID()}`;
        await admin`
          insert into sandbox_lease_holders (
            account_id, workspace_id, lease_id, kind, holder_id, subject_id
          ) values (
            ${account!.id}, ${workspace!.id}, ${lease!.id}, 'process', ${holderId},
            ${sessionId}
          )`;
        const [row] = await admin<{ id: string }[]>`
          insert into sandbox_retained_processes (
            account_id, workspace_id, session_id, lease_id, sandbox_group_id,
            parent_admission_id, holder_id, owner_actor_kind, owner_actor_id,
            owner_turn_id, owner_attempt_id, owner_execution_generation,
            lease_epoch, provider_backend, provider_instance_id, route_kind,
            route_epoch, provider_session_id
          ) values (
            ${account!.id}, ${workspace!.id}, ${sessionId}, ${lease!.id}, ${groupId},
            ${input.admissionId}, ${holderId}, ${input.owner},
            ${input.actorId}, ${input.turnId ?? null},
            ${input.attemptId ?? null}, ${input.owner === "turn" ? 1 : null},
            3, 'local', '0277-backfill-box', 'home', 0, ${input.providerSessionId}
          ) returning id`;
        return row!.id;
      };
      const turnProcessId = await insertProcess({
        admissionId: yieldedAdmissionId,
        owner: "turn",
        actorId: attributedAttemptId,
        turnId: attributedTurnId,
        attemptId: attributedAttemptId,
        providerSessionId: 11,
      });
      const directProcessId = await insertProcess({
        admissionId: directAdmissionId,
        owner: "direct",
        actorId: directActorId,
        providerSessionId: 12,
      });

      await admin.unsafe("alter table session_turn_attempts enable trigger user");
      await admin.unsafe("alter table session_turns enable trigger user");
      await admin.unsafe("alter table sessions enable trigger user");
      await admin.unsafe(await readFile(migrationUrl, "utf8"));

      type AuthorityRow = {
        initiator_kind: string;
        initiator_subject_id: string;
        initiating_human_subject_id: string | null;
        initiator_organization_membership_id: string | null;
        initiator_authorization_revision: string | null;
        authority_epoch: number | null;
        authority_visibility: string | null;
        state?: string;
      };
      const readAuthority = async (table: "admissions" | "processes", id: string) => {
        const rows =
          table === "admissions"
            ? await admin<AuthorityRow[]>`
                select initiator_kind, initiator_subject_id, initiating_human_subject_id,
                  initiator_organization_membership_id,
                  initiator_authorization_revision::text as initiator_authorization_revision,
                  authority_epoch, authority_visibility
                from sandbox_workspace_mutation_admissions where id = ${id}`
            : await admin<AuthorityRow[]>`
                select initiator_kind, initiator_subject_id, initiating_human_subject_id,
                  initiator_organization_membership_id,
                  initiator_authorization_revision::text as initiator_authorization_revision,
                  authority_epoch, authority_visibility, state
                from sandbox_retained_processes where id = ${id}`;
        return rows[0]!;
      };

      // Turn-owned attributed rows are promoted verbatim from the frozen
      // turn/attempt snapshot, and the human's grant identity resolves exactly.
      for (const promoted of [
        await readAuthority("admissions", attributedAdmissionId),
        await readAuthority("processes", turnProcessId),
      ]) {
        expect(promoted.initiator_kind).toBe("subject");
        expect(promoted.initiator_subject_id).toBe(humanSubject);
        expect(promoted.initiating_human_subject_id).toBe(humanSubject);
        expect(promoted.initiator_organization_membership_id).toBe(membership!.id);
        expect(promoted.initiator_authorization_revision).toBe("9");
        expect(promoted.authority_epoch).toBe(1);
        expect(promoted.authority_visibility).toBe("workspace_shared");
      }
      // The retained process is promoted, never settled by the migration.
      expect((await readAuthority("processes", turnProcessId)).state).toBe("active");

      // A pre-0096 turn has no causal initiator to copy: the sentinel is
      // normalized, never invented into a real principal - but its tenancy
      // half is still real, so ordinary turn work stays admitted.
      const sentinelRow = await readAuthority("admissions", sentinelAdmissionId);
      expect(sentinelRow.initiator_kind).toBe("legacy_unattributed");
      expect(sentinelRow.initiator_subject_id).toBe("unattributed-legacy");
      expect(sentinelRow.initiating_human_subject_id).toBeNull();
      expect(sentinelRow.initiator_organization_membership_id).toBeNull();
      expect(sentinelRow.authority_epoch).toBe(1);
      expect(sentinelRow.authority_visibility).toBe("workspace_shared");

      // A direct row that never recorded an owner stays the honest sentinel
      // with no tenancy half - the mark that fails a retained process closed
      // on its NEXT mutation, without touching the running process.
      for (const legacy of [
        await readAuthority("admissions", directAdmissionId),
        await readAuthority("processes", directProcessId),
      ]) {
        expect(legacy.initiator_kind).toBe("legacy_unattributed");
        expect(legacy.initiator_subject_id).toBe("unattributed-legacy");
        expect(legacy.initiator_organization_membership_id).toBeNull();
        expect(legacy.authority_epoch).toBeNull();
        expect(legacy.authority_visibility).toBeNull();
      }
      expect((await readAuthority("processes", directProcessId)).state).toBe("active");

      // The validated constraints now hold both halves independently honest.
      await expectPostgresRejection(
        admin`
          update sandbox_workspace_mutation_admissions
          set authority_epoch = 4
          where id = ${directAdmissionId}`,
        "a partial tenancy half (epoch without visibility)",
      );
      await expectPostgresRejection(
        admin`
          update sandbox_workspace_mutation_admissions
          set authority_epoch = 4, authority_visibility = 'user_private'
          where id = ${directAdmissionId}`,
        "a private-session tenancy half with no owning membership",
      );
      await expectPostgresRejection(
        admin`
          update sandbox_workspace_mutation_admissions
          set initiator_authorization_revision = 9
          where id = ${directAdmissionId}`,
        "an authorization revision on a sentinel initiator",
      );
      await expectPostgresRejection(
        admin`
          update sandbox_workspace_mutation_admissions
          set initiator_kind = 'subject'
          where id = ${directAdmissionId}`,
        "a real initiator kind keeping the sentinel subject id",
      );
      await expectPostgresRejection(
        admin`
          update sandbox_retained_processes
          set initiator_authorization_revision = 0
          where id = ${turnProcessId}`,
        "a non-positive authorization revision",
      );
    } finally {
      await admin.end({ timeout: 5 });
      await blank.release();
    }
  }, 240_000);
});
