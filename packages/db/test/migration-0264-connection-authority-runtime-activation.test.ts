import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { sql as query } from "drizzle-orm";
import postgres from "postgres";
import { createDb, withSessionRlsActorContext } from "../src/index";
import { withSessionActivityRlsContext } from "../src/database";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

import { migrate } from "../src/migrate";
import { embeddingMigrationTail } from "./embedding-migration-tail";

const migrationUrl = new URL(
  "../drizzle/0264_connection_authority_runtime_activation.sql",
  import.meta.url,
);
const migrationName = "0264_connection_authority_runtime_activation.sql";
// 0275 replaces the accepted-authority capture installed by 0264, 0299 repairs
// that membership wrapper, and 0315 extends the 0275 ledgers. Migration 0345
// patches the frozen 0275 routine, while 0374 consumes the tenancy helpers
// installed by 0345, 0379 activates the cursor as public sequence authority,
// and 0388 drift-guards the reaper definition produced by 0345. Migration 0391
// extends that exact 0388 definition, and 0394 patches the resulting deadline
// branch. Migration 0402 inventories accepted-execution columns created by
// 0275. The synthetic upgrade must therefore withhold every dependent beside
// 0264 and replay them in real filename order.
const scheduledConnectionAuthorityMigrationName = "0275_scheduled_connection_authority.sql";
const organizationMembershipLockOrderMigrationName = "0299_organization_membership_lock_order.sql";
const personalGitHubRepositorySelectionMigrationName =
  "0315_personal_github_repository_selection.sql";
const sessionTenancyFenceMigrationName = "0345_tenant_scoped_session_tenancy_fence.sql";
const sessionEventCursorMigrationName = "0374_session_event_cursors.sql";
const sessionEventRawLaneActivationMigrationName = "0379_session_event_raw_lane_activation.sql";
const sandboxProviderDeadlineInteractionMigrationName =
  "0388_sandbox_provider_deadline_interactions.sql";
const sandboxProviderDeadlineInteractionFollowupMigrationName =
  "0391_sandbox_provider_deadline_interaction_followup.sql";
const sandboxDeadlineRotationPreemptionMigrationName =
  "0397_sandbox_deadline_rotation_preemption.sql";
const sessionInputWaitMigrationName = "0402_session_input_wait_and_background_command_results.sql";
const commandTrackingRetirementMigrationName = "0407_connected_command_tracking_retirement.sql";
const scheduledSessionTargetIndexMigrationName = "0408_scheduled_session_target_index.sql";
// 0414 patches the producer fence created by withheld 0275; replay them together.
const scheduledProducerMaterializationMigrationName =
  "0414_scheduled_generated_producer_materialization.sql";
const scheduledInheritedToolAdmissionMigrationName = "0416_scheduled_inherited_tool_admission.sql";
// The shared tail includes every dependent authority cutover. Replay in ledger
// order after restoring this fixture's withheld prerequisites.
const cutoverMigrationTail = [...embeddingMigrationTail].sort();

describe("migration 0264 connection authority runtime activation", () => {
  test("is a drained exact-attempt cutover with canonical snapshots and idempotent audit", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('CREATE TABLE "turn_connection_authority_snapshots"');
    expect(source).toContain('"membership_authorization_revision" bigint');
    expect(source).toContain('"canonical_snapshot" jsonb NOT NULL');
    expect(source).toContain('"snapshot_digest" bytea NOT NULL');
    expect(source).toContain('CREATE TABLE "connection_use_audit_facts"');
    expect(source).toContain('"physical_request_id" uuid PRIMARY KEY');
    expect(source).toContain("accepted_turn_connection_authority_capture");
    expect(source).toContain("attempt.quiesced_at IS NULL");
    expect(source).toContain("attempt.authority_epoch = session_row.authority_epoch");
    expect(source).toContain("turn_value.active_attempt_id = p_attempt_id");
    expect(source).toContain(
      "membership.authorization_revision = snapshot.membership_authorization_revision",
    );
    expect(source).toContain("snapshot.canonical_snapshot::text");
    expect(source).toContain("resolve_connection_use_authority_legacy_0256");
    expect(source).toContain("p_snapshot ->> 'scope' = 'user'");
    expect(source).toContain("connection_use_once_consumption_receipts");
    expect(source).toContain("resolve_connection_use_authority_legacy_0256");
    expect(source).toContain("GRANT EXECUTE ON FUNCTION resolve_accepted_connection_use");
    expect(source).toContain("FROM pg_stat_activity");
    expect(source.match(/all opengeni_app sessions to be stopped/gu)).toHaveLength(2);
    expect(source).toContain("resolve_personal_connection_authority_selection");
    expect(source).not.toMatch(/credential_encrypted\s*(?:->|#>|#>>)|decrypt/iu);
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects a live application writer and explicit pre-activation queued authority", async () => {
    const blank = await acquireOwnerMigratedTestDatabase("migration-0264-cutover-drain");
    if (!blank) return;
    const sql = postgres(blank.adminUrl, {
      max: 2,
      onnotice: () => undefined,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    const owner = postgres(blank.ownerUrl, { max: 1, onnotice: () => undefined });
    const migrateFixture = () =>
      migrate(blank.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    try {
      const [ownerRole] = await owner`
        select rolsuper, rolbypassrls from pg_roles where rolname = current_user
      `;
      expect(ownerRole).toMatchObject({ rolsuper: false, rolbypassrls: false });
      await owner`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `;
      await sql`
        insert into schema_migrations (name)
        values
          (${migrationName}),
          (${scheduledConnectionAuthorityMigrationName}),
          (${organizationMembershipLockOrderMigrationName}),
          (${personalGitHubRepositorySelectionMigrationName}),
          (${sessionTenancyFenceMigrationName}),
          (${sessionEventCursorMigrationName}),
          (${sessionEventRawLaneActivationMigrationName}),
          (${sandboxProviderDeadlineInteractionMigrationName}),
          (${sandboxProviderDeadlineInteractionFollowupMigrationName}),
          (${sandboxDeadlineRotationPreemptionMigrationName}),
          (${sessionInputWaitMigrationName}),
          (${commandTrackingRetirementMigrationName}),
          (${scheduledSessionTargetIndexMigrationName}),
          (${scheduledProducerMaterializationMigrationName}),
          (${scheduledInheritedToolAdmissionMigrationName})
      `;
      await sql`insert into schema_migrations (name) select unnest(${cutoverMigrationTail}::text[])`;
      await migrateFixture();
      const [historicalRoutines] = await sql`
        select
          to_regprocedure('opengeni_private.capture_accepted_turn_connection_authorities()') as current_capture,
          to_regprocedure('opengeni_private.capture_accepted_turn_connection_authorities_0264()') as retired_capture
      `;
      expect(historicalRoutines).toMatchObject({ current_capture: null, retired_capture: null });
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('connection cutover drain') returning id
      `;
      const [origin] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'origin') returning id
      `;
      const [target] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${account!.id}, 'target') returning id
      `;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${origin!.id}, ${account!.id}), (${target!.id}, ${account!.id})
      `;
      const subjectId = `user:${crypto.randomUUID()}`;
      await sql`
        insert into organization_memberships (
          account_id, subject_id, status, personal_workspace_id
        ) values (${account!.id}, ${subjectId}, 'active', ${origin!.id})
      `;
      await sql`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${account!.id}, ${target!.id}, ${subjectId})
      `;
      const connection = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${origin!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [row] = await tx<Array<{ id: string; authorityId: string }>>`
          insert into connections (
            account_id, workspace_id, subject_id, provider_domain, kind,
            credential_encrypted
          ) values (
            ${account!.id}, ${origin!.id}, ${subjectId}, 'api.example.com', 'oauth2', 'ciphertext'
          ) returning id, authority_id as "authorityId"
        `;
        return row!;
      });
      // This is a pre-0264 row, not a current runtime create. The current
      // mapper requires subscription-core tables deliberately withheld here.
      // Seed historical facts directly; do not add fake current reader columns
      // or restore a production legacy fallback to construct this fixture.
      const session = { id: crypto.randomUUID() };
      const cutoverClient = createDb(blank.adminUrl, { max: 1 });
      try {
        await withSessionRlsActorContext({ subjectId }, () =>
          withSessionActivityRlsContext(
            cutoverClient.db,
            { accountId: account!.id, workspaceId: target!.id },
            (tx) =>
              tx.execute(query`
          insert into sessions (
            id, account_id, workspace_id, initial_message, model, sandbox_backend,
            reasoning_effort, latency_mode,
            sandbox_group_id, tool_policy, root_session_id, nested_agent_depth,
            effective_max_nested_agent_depth, nested_agent_depth_policy_source,
            nested_agent_depth_policy_session_id, created_by_kind, created_by_subject_id
          ) values (
            ${session.id}, ${account!.id}, ${target!.id}, 'pre-activation authority',
            'test-model', 'none', 'medium', 'standard', ${session.id},
            ${JSON.stringify({ mode: "workspace_default", inheritedFromSessionId: null })}::jsonb,
            ${session.id}, 0, 5, 'session', ${session.id}, 'subject', ${subjectId}
          )
        `),
          ),
        );
      } finally {
        await cutoverClient.close();
      }
      const explicitDelegation = [
        {
          serverId: "example",
          connectionId: connection.id,
          ownerSubjectId: subjectId,
          providerDomain: "api.example.com",
          kind: "oauth2",
          userDelegation: {
            organizationId: account!.id,
            authorityId: connection.authorityId,
            authorityGeneration: 1,
            workspaceId: target!.id,
            sessionId: null,
            action: "connection.use",
            mode: "always",
            context: "workspace_shared",
            authorityEpoch: null,
            grantId: crypto.randomUUID(),
            grantGeneration: 1,
          },
        },
      ];
      const [preActivationTurn] = await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        return tx<{ id: string }[]>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, execution_generation, position, prompt,
          model, reasoning_effort, latency_mode, sandbox_backend, source,
          initiator_kind, initiator_subject_id, initiating_human_subject_id,
          personal_connection_delegations
        ) values (
          ${account!.id}, ${target!.id}, ${session.id}, ${crypto.randomUUID()},
          ${`cutover-${crypto.randomUUID()}`}, 'queued', 1, 1, 'queued authority',
          'test-model', 'medium', 'standard', 'none', 'user',
          'subject', ${subjectId}, ${subjectId},
          ${tx.json(explicitDelegation)}::jsonb
        ) returning id
        `;
      });
      await sql`
        delete from schema_migrations
        where name = any(${cutoverMigrationTail}::text[]) or name in (
          ${migrationName},
          ${scheduledConnectionAuthorityMigrationName},
          ${organizationMembershipLockOrderMigrationName},
          ${personalGitHubRepositorySelectionMigrationName},
          ${sessionTenancyFenceMigrationName},
          ${sessionEventCursorMigrationName},
          ${sessionEventRawLaneActivationMigrationName},
          ${sandboxProviderDeadlineInteractionMigrationName},
          ${sandboxProviderDeadlineInteractionFollowupMigrationName},
          ${sandboxDeadlineRotationPreemptionMigrationName},
          ${sessionInputWaitMigrationName},
          ${commandTrackingRetirementMigrationName},
          ${scheduledSessionTargetIndexMigrationName},
          ${scheduledProducerMaterializationMigrationName},
          ${scheduledInheritedToolAdmissionMigrationName}
        )
      `;
      // 0264's historical global preflight predates owner-only backfill windows.
      // This synthetic schema already has later FORCE-RLS policies, which would
      // hide the queued work from a non-bypass migration owner. Relax only owner
      // visibility in this disposable fixture; opengeni_app is not the owner and
      // remains policy-bound. Restore and verify FORCE RLS after the replay.
      await owner`
        alter table sessions no force row level security;
        alter table session_turns no force row level security;
        alter table session_system_updates no force row level security;
        alter table session_system_update_outbox no force row level security;
        alter table scheduled_tasks no force row level security;
        alter table connections no force row level security;
      `.simple();
      await expect(migrateFixture()).rejects.toMatchObject({
        code: "55000",
        message:
          "0264 requires draining or superseding executable pre-activation common-user connection work",
      });

      await sql`
        update sessions set status = 'recovering', active_turn_id = ${preActivationTurn!.id}
        where id = ${session.id}
      `;
      await sql`
        update session_turns set status = 'recovering', active_attempt_id = null
        where id = ${preActivationTurn!.id}
      `;
      await expect(migrateFixture()).rejects.toMatchObject({
        code: "55000",
        message:
          "0264 requires draining or superseding executable pre-activation common-user connection work",
      });

      await sql`delete from session_turns where session_id = ${session.id}`;
      // The canonical harness owns this cluster-wide role and password. Do not
      // rotate it from a historical fixture while other test files use it.
      await sql`grant connect on database ${sql(new URL(blank.adminUrl).pathname.slice(1))} to opengeni_app`;
      const appUrl = new URL(blank.adminUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = blank.appPassword;
      const appSql = postgres(appUrl.toString(), {
        max: 1,
        connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
      });
      try {
        const [appRole] = await appSql`
          select rolsuper, rolbypassrls,
            pg_has_role(current_user, ${blank.ownerRole}, 'MEMBER') as inherits_owner
          from pg_roles where rolname = current_user
        `;
        expect(appRole).toMatchObject({
          rolsuper: false,
          rolbypassrls: false,
          inherits_owner: false,
        });
        await expect(migrateFixture()).rejects.toMatchObject({
          code: "55000",
          message:
            "0264 connection authority activation requires all opengeni_app sessions to be stopped",
        });
      } finally {
        await appSql.end({ timeout: 1 });
      }

      await migrateFixture();
      await owner`
        alter table sessions force row level security;
        alter table session_turns force row level security;
        alter table session_system_updates force row level security;
        alter table session_system_update_outbox force row level security;
        alter table scheduled_tasks force row level security;
        alter table connections force row level security;
      `.simple();
      const posture = await sql`
        select relname, relrowsecurity, relforcerowsecurity from pg_class
        where oid = any(array[
          'sessions'::regclass, 'session_turns'::regclass,
          'session_system_updates'::regclass, 'session_system_update_outbox'::regclass,
          'scheduled_tasks'::regclass, 'connections'::regclass
        ])
      `;
      expect(posture.every((table) => table.relrowsecurity && table.relforcerowsecurity)).toBe(
        true,
      );
      const [capture] = await sql`
        select routine.proname, role.rolsuper, role.rolbypassrls
        from pg_trigger trigger
        join pg_proc routine on routine.oid = trigger.tgfoid
        join pg_roles role on role.oid = routine.proowner
        where trigger.tgrelid = 'session_turns'::regclass
          and trigger.tgname = 'accepted_turn_connection_authority_capture'
      `;
      expect(capture).toMatchObject({
        proname: "capture_accepted_turn_connection_authorities",
        rolsuper: false,
        rolbypassrls: false,
      });
      const [retired] = await sql`
        select to_regprocedure('opengeni_private.capture_accepted_turn_connection_authorities_0264()') as capture
      `;
      expect(retired!.capture).toBeNull();
      const receipts = await sql<Array<{ name: string }>>`
        select name from schema_migrations
        where name = any(${cutoverMigrationTail}::text[]) or name in (
          ${migrationName},
          ${scheduledConnectionAuthorityMigrationName},
          ${organizationMembershipLockOrderMigrationName},
          ${personalGitHubRepositorySelectionMigrationName},
          ${sessionTenancyFenceMigrationName},
          ${sessionEventCursorMigrationName},
          ${sessionEventRawLaneActivationMigrationName},
          ${sandboxProviderDeadlineInteractionMigrationName},
          ${sandboxProviderDeadlineInteractionFollowupMigrationName},
          ${sandboxDeadlineRotationPreemptionMigrationName},
          ${sessionInputWaitMigrationName},
          ${commandTrackingRetirementMigrationName},
          ${scheduledSessionTargetIndexMigrationName},
          ${scheduledProducerMaterializationMigrationName},
          ${scheduledInheritedToolAdmissionMigrationName}
        )
        order by name
      `;
      expect(receipts.map((receipt) => receipt.name)).toEqual(
        [
          migrationName,
          scheduledConnectionAuthorityMigrationName,
          organizationMembershipLockOrderMigrationName,
          personalGitHubRepositorySelectionMigrationName,
          sessionTenancyFenceMigrationName,
          sessionEventCursorMigrationName,
          sessionEventRawLaneActivationMigrationName,
          sandboxProviderDeadlineInteractionMigrationName,
          sandboxProviderDeadlineInteractionFollowupMigrationName,
          sandboxDeadlineRotationPreemptionMigrationName,
          sessionInputWaitMigrationName,
          commandTrackingRetirementMigrationName,
          scheduledSessionTargetIndexMigrationName,
          scheduledProducerMaterializationMigrationName,
          scheduledInheritedToolAdmissionMigrationName,
          ...cutoverMigrationTail,
        ].sort(),
      );
    } finally {
      await owner.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 180_000);

  // Current sender-owned runtime coverage lives in sender-connection-accounts.test.ts.
  // Conversation-grant execution was retired by migration 0478.
});
