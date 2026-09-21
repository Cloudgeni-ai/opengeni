import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession } from "../src/index";

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
    const blank = await acquireBlankTestDatabase("migration-0264-cutover-drain");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 2, onnotice: () => undefined });
    try {
      await sql`
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
      await sql`insert into schema_migrations (name) select unnest(${embeddingMigrationTail}::text[])`;
      await migrate(blank.databaseUrl);
      // Current session adapters select the complete sessions row while this
      // fixture intentionally withholds 0402. Supply only its later columns
      // during fixture setup, then remove them before the ordered replay.
      await sql`
        alter table sessions
        add column scope_subject_id text,
        add column input_wait_turn_id uuid,
        add column input_wait_until timestamptz,
        add column input_wait_reason text,
        add column input_wait_set_at timestamptz
      `;

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
      const cutoverClient = createDb(blank.databaseUrl, { max: 1 });
      const session = await createSession(cutoverClient.db, {
        accountId: account!.id,
        workspaceId: target!.id,
        initialMessage: "pre-activation authority",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        subjectId,
      });
      await cutoverClient.close();
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
      const [preActivationTurn] = await sql<{ id: string }[]>`
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
          ${sql.json(explicitDelegation)}::jsonb
        ) returning id
      `;
      await sql`
        delete from schema_migrations
        where name = any(${embeddingMigrationTail}::text[]) or name in (
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
      await expect(migrate(blank.databaseUrl)).rejects.toMatchObject({ code: "55000" });

      await sql`
        update sessions set status = 'recovering', active_turn_id = ${preActivationTurn!.id}
        where id = ${session.id}
      `;
      await sql`
        update session_turns set status = 'recovering', active_attempt_id = null
        where id = ${preActivationTurn!.id}
      `;
      await expect(migrate(blank.databaseUrl)).rejects.toMatchObject({ code: "55000" });

      await sql`delete from session_turns where session_id = ${session.id}`;
      await sql`
        do $role$
        begin
          if not exists (select 1 from pg_roles where rolname = 'opengeni_app') then
            create role opengeni_app login password 'cutover-test';
          else
            alter role opengeni_app login password 'cutover-test';
          end if;
        end
        $role$
      `;
      await sql`grant connect on database ${sql(blank.databaseUrl.split("/").at(-1)!)} to opengeni_app`;
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "cutover-test";
      const appSql = postgres(appUrl.toString(), { max: 1 });
      try {
        await appSql`select 1`;
        await expect(migrate(blank.databaseUrl)).rejects.toMatchObject({ code: "55000" });
      } finally {
        await appSql.end({ timeout: 1 });
      }

      await sql`
        alter table sessions
        drop column scope_subject_id,
        drop column input_wait_turn_id,
        drop column input_wait_until,
        drop column input_wait_reason,
        drop column input_wait_set_at
      `;
      await migrate(blank.databaseUrl);
      const receipts = await sql<Array<{ name: string }>>`
        select name from schema_migrations
        where name = any(${embeddingMigrationTail}::text[]) or name in (
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
      expect(receipts.map((receipt) => receipt.name)).toEqual([
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
        ...embeddingMigrationTail,
      ]);
    } finally {
      await sql.end({ timeout: 1 });
      await blank.release();
    }
  }, 180_000);

  // Current sender-owned runtime coverage lives in sender-connection-accounts.test.ts.
  // Conversation-grant execution was retired by migration 0478.
});
