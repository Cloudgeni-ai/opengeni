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
import {
  acceptOrganizationInvitation,
  claimTemporalScheduleCleanups,
  completeTemporalScheduleConnectorCleanup,
  createDb,
  createOrganizationInvitation,
  createSession,
  deleteWorkspaceIfQuiescent,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  listSelfOrganizationMemberships,
  settleTemporalScheduleCleanup,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  updateOrganizationMember,
} from "../src";

const migrationUrl = new URL("../drizzle/0275_scheduled_connection_authority.sql", import.meta.url);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function applyThrough0270(admin: Sql): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file < "0275_")
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
let sql: postgres.ReservedSql | null = null;

async function expectPostgresRejection(query: PromiseLike<unknown>, label: string): Promise<void> {
  try {
    await query;
  } catch {
    return;
  }
  throw new Error(`Expected PostgreSQL to reject ${label}`);
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0273-scheduled-authority");
  if (!shared) return;
  sql = await shared.admin.reserve();
  await sql`set lock_timeout = '5s'`;
  await sql`set statement_timeout = '15s'`;
}, 180_000);

afterAll(async () => {
  sql?.release();
  await shared?.release();
});

describe("migration 0275 scheduled connection authority", () => {
  test("declares one maintenance-cutover accepted-run protocol", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("0275 requires every nonterminal scheduled agent run to be drained");
    expect(source).toContain("item -> 'userDelegation' IS NOT NULL");
    expect(source).toContain("accepted_execution_snapshot jsonb");
    expect(source).toContain("accepted_execution_digest text");
    expect(source).toContain("scheduled_task_run_accepted_execution_required_chk");
    expect(source).toContain("NOT VALID");
    expect(source).toContain("CREATE FUNCTION admit_scheduled_agent_run_execution()");
    expect(source).toContain("CREATE FUNCTION validate_scheduled_occurrence_accepted_execution()");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION validate_scheduled_task_attempt_personal_resources()",
    );
    expect(source).toContain("CREATE FUNCTION fence_scheduled_task_tombstone()");
  });

  test("freezes task and occurrence authority without app table DML", async () => {
    const source = await readFile(migrationUrl, "utf8");
    for (const table of [
      "scheduled_task_connection_authority_snapshots",
      "scheduled_task_run_connection_authority_snapshots",
      "scheduled_task_reusable_connection_materializations",
    ]) {
      expect(source).toContain(`CREATE TABLE ${table}`);
      expect(source).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(source).toContain("acceptedWork', jsonb_build_object(");
    expect(source).toContain("'taskAuthorityRevision'");
    expect(source).toContain("'runId'");
    expect(source).toContain("accepted_work_id = NEW.id");
    expect(source).toContain("NEW.personal_connection_delegations");
    expect(source).toContain("accepted -> 'personalConnectionDelegations'");
    expect(source).toContain("NEW.xai_provider_account_authority_snapshot");
    expect(source).toContain("incidentTelemetryAuthorityFence");
    expect(source).toContain("REVOKE ALL ON TABLE %I.%I FROM opengeni_app");
  });

  test("uses one connection-before-personal and task-session-run lock order", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const freeze = source.slice(
      source.indexOf("CREATE FUNCTION freeze_scheduled_task_personal_resources("),
      source.indexOf("CREATE FUNCTION clone_scheduled_task_personal_resource_authority("),
    );
    expect(freeze.indexOf("freeze_scheduled_task_connection_authorities_inner")).toBeLessThan(
      freeze.indexOf("freeze_scheduled_task_personal_resources_0252"),
    );
    const materialize = source.slice(
      source.indexOf("CREATE FUNCTION materialize_scheduled_task_reusable_session_from_run("),
      source.indexOf("CREATE FUNCTION bind_scheduled_task_run_connection_authorities("),
    );
    expect(materialize.indexOf("FROM scheduled_tasks task")).toBeLessThan(
      materialize.indexOf("FROM sessions session_value"),
    );
    expect(materialize.indexOf("FROM sessions session_value")).toBeLessThan(
      materialize.indexOf("FROM scheduled_task_runs run"),
    );
    const membershipCommand = source.slice(
      source.indexOf("CREATE FUNCTION organization_membership_command(p_command jsonb)"),
      source.indexOf("DO $scheduled_connection_live_posture$"),
    );
    expect(membershipCommand.indexOf("PERFORM 1 FROM scheduled_tasks task")).toBeLessThan(
      membershipCommand.indexOf("PERFORM 1 FROM sessions session_row"),
    );
    expect(membershipCommand.indexOf("PERFORM 1 FROM sessions session_row")).toBeLessThan(
      membershipCommand.lastIndexOf("PERFORM 1 FROM organization_memberships membership"),
    );
    expect(membershipCommand).toContain("initiated.initiating_human_subject_id = target_subject");
    expect(source).toContain("FOR EACH ROW WHEN (NEW.status = 'queued')");
    expect(source).toContain("scheduled_authority_exhausted");
  });

  test("enforces one-way tombstones and retains task evidence on real PostgreSQL", async () => {
    if (!sql) return;
    const runtimeSql = sql;
    const [account] = await runtimeSql<{ id: string }[]>`
      insert into managed_accounts (name)
      values ('migration-0273-retention-account') returning id
    `;
    const [workspace] = await runtimeSql<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration-0273-retention-workspace') returning id
    `;
    const taskId = crypto.randomUUID();
    const agentTaskId = crypto.randomUUID();
    await shared!.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
      await tx`select set_config('opengeni.subject_id', 'subject:migration-0273', true)`;
      await tx`
        insert into scheduled_tasks (
          id, account_id, workspace_id, name, status, schedule,
          temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
          created_by_kind, created_by_subject_id, created_by_context,
          personal_connection_delegations, metadata
        ) values (
          ${taskId}, ${account!.id}, ${workspace!.id}, 'retained task', 'active',
          ${tx.json({ kind: "interval", everySeconds: 60 })}::jsonb,
          ${`migration-0273-${taskId}`}, 'new_session_per_run', 'skip',
          ${tx.json({ kind: "knowledge_source_sync" })}::jsonb,
          ${tx.json({ prompt: "retained", resources: [], tools: [] })}::jsonb,
          'subject', 'subject:migration-0273', ${tx.json({})}::jsonb,
          '[]'::jsonb, '{}'::jsonb
        )
      `;
      await tx`
        insert into scheduled_tasks (
          id, account_id, workspace_id, name, status, schedule,
          temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
          created_by_kind, created_by_subject_id, created_by_context,
          personal_connection_delegations, metadata
        ) values (
          ${agentTaskId}, ${account!.id}, ${workspace!.id}, 'agent identity task', 'active',
          ${tx.json({ kind: "interval", everySeconds: 60 })}::jsonb,
          ${`migration-0273-agent-${agentTaskId}`}, 'new_session_per_run',
          'allow_concurrent', ${tx.json({ kind: "agent_turn" })}::jsonb,
          ${tx.json({ prompt: "agent", resources: [], tools: [] })}::jsonb,
          'subject', 'subject:migration-0273', ${tx.json({})}::jsonb,
          '[]'::jsonb, '{}'::jsonb
        )
      `;
    });

    await expectPostgresRejection(
      runtimeSql`
        insert into scheduled_task_runs (
          task_id, account_id, workspace_id, status, trigger_type, action_kind,
          producer_key, completed_at
        ) values (
          ${taskId}, ${account!.id}, ${workspace!.id}, 'succeeded', 'manual',
          'agent_turn', ${`migration-0273-forged-agent-${taskId}`}, now()
        )
      `,
      "an agent run forged against a knowledge-source task",
    );
    await expectPostgresRejection(
      runtimeSql`
        insert into scheduled_task_runs (
          task_id, account_id, workspace_id, status, trigger_type, action_kind,
          producer_key, completed_at
        ) values (
          ${agentTaskId}, ${account!.id}, ${workspace!.id}, 'succeeded', 'manual',
          'knowledge_source_sync', ${`migration-0273-forged-sync-${agentTaskId}`}, now()
        )
      `,
      "a knowledge-source run forged against an agent task",
    );

    await runtimeSql`
      insert into scheduled_task_runs (
        task_id, account_id, workspace_id, status, trigger_type, action_kind,
        producer_key, completed_at
      ) values (
        ${taskId}, ${account!.id}, ${workspace!.id}, 'succeeded', 'manual',
        'knowledge_source_sync', ${`migration-0273-run-${taskId}`}, now()
      )
    `;
    await expectPostgresRejection(
      runtimeSql`
        update scheduled_tasks set action = '{"kind":"agent_turn"}'::jsonb
        where id = ${taskId}
      `,
      "changing a scheduled task action kind through direct DML",
    );

    const tombstonedAt = new Date();
    await runtimeSql`
      update scheduled_tasks
      set status = 'paused', deleted_at = ${tombstonedAt}
      where id = ${taskId}
    `;
    await expectPostgresRejection(
      runtimeSql`update scheduled_tasks set deleted_at = null where id = ${taskId}`,
      "clearing a scheduled-task tombstone",
    );
    await expectPostgresRejection(
      runtimeSql`update scheduled_tasks set status = 'active' where id = ${taskId}`,
      "reactivating a tombstoned scheduled task",
    );

    await expectPostgresRejection(
      runtimeSql`delete from scheduled_tasks where id = ${taskId}`,
      "physical deletion of a task with retained run evidence",
    );

    const [taskFk, updateFk] = await runtimeSql<Array<{ name: string; definition: string }>>`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'scheduled_task_runs_task_id_fkey',
        'session_system_updates_scheduled_run_fk'
      )
      order by conname
    `;
    expect(taskFk?.definition).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(updateFk?.definition).toContain("DEFERRABLE INITIALLY DEFERRED");
  });

  test("stages connector cleanup and lets workspace teardown adopt its receipt", async () => {
    if (!sql || !shared) return;
    const [account] = await sql<{ id: string }[]>`
      insert into managed_accounts (name) values ('migration-0273-cleanup-account') returning id
    `;
    await sql`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration-0273-cleanup-control')
    `;
    const [workspace] = await sql<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration-0273-cleanup-target') returning id
    `;
    const cleanupId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const temporalScheduleId = `migration-0273-cleanup-${taskId}`;
    const descriptor = {
      version: 1,
      taskId,
      accountId: account!.id,
      workspaceId: workspace!.id,
      connectorKind: "google_drive",
      connectionId: crypto.randomUUID(),
      connectionVersion: 1,
      sourceId: crypto.randomUUID(),
      sourceLifecycleGeneration: 1,
      sourceConfigGeneration: 1,
      externalSourceId: "drive-source",
      subjectId: "subject:migration-0273-cleanup",
    } as const;
    const upgradeId = crypto.randomUUID();
    const upgradeClaimId = crypto.randomUUID();
    await sql`
      insert into temporal_schedule_cleanup_outbox (
        id, account_id, workspace_id, temporal_schedule_id,
        claim_id, claim_until, attempt_count
      ) values (
        ${upgradeId}, ${account!.id}, ${workspace!.id}, ${`${temporalScheduleId}-upgrade`},
        ${crypto.randomUUID()}, now() + interval '15 seconds', 1
      )
    `;
    const [upgradeResult] = await shared.admin.begin(async (tx) => {
      await tx`set local role opengeni_app`;
      await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
      return await tx<{ upgraded: boolean }[]>`
        select opengeni_private.upgrade_temporal_schedule_connector_cleanup(
          ${account!.id}::uuid, ${workspace!.id}::uuid, ${`${temporalScheduleId}-upgrade`},
          ${taskId}::uuid, ${descriptor.subjectId}, ${tx.json(descriptor)}::jsonb,
          ${upgradeClaimId}::uuid
        ) as upgraded
      `;
    });
    expect(upgradeResult?.upgraded).toBe(true);
    const [upgradedReceipt] = await sql<
      Array<{ snapshot: unknown; completed: Date | null; claim_id: string }>
    >`
      select connector_cleanup_snapshot as snapshot,
        connector_cleanup_completed_at as completed, claim_id
      from temporal_schedule_cleanup_outbox where id = ${upgradeId}
    `;
    expect(upgradedReceipt?.snapshot).toEqual(descriptor);
    expect(upgradedReceipt?.completed).not.toBeNull();
    expect(upgradedReceipt?.claim_id).toBe(upgradeClaimId);
    await sql`
      insert into temporal_schedule_cleanup_outbox (
        id, account_id, workspace_id, temporal_schedule_id,
        scheduled_task_id, connector_cleanup_subject_id,
        connector_cleanup_snapshot, claim_id, claim_until, attempt_count
      ) values (
        ${cleanupId}, ${account!.id}, ${workspace!.id}, ${temporalScheduleId},
        ${taskId}, ${descriptor.subjectId}, ${sql.json(descriptor)}::jsonb,
        ${claimId}, now() + interval '15 seconds', 1
      )
    `;
    const client = createDb(shared.appUrl);
    expect(
      await completeTemporalScheduleConnectorCleanup(client.db, { id: cleanupId, claimId }),
    ).toBe(true);
    const [staged] = await sql<{ completed: Date | null }[]>`
      select connector_cleanup_completed_at as completed
      from temporal_schedule_cleanup_outbox where id = ${cleanupId}
    `;
    expect(staged?.completed).not.toBeNull();
    expect(
      await settleTemporalScheduleCleanup(client.db, {
        id: cleanupId,
        claimId,
        error: "simulated Temporal outage",
      }),
    ).toBe(true);
    await sql`
      update temporal_schedule_cleanup_outbox
      set next_attempt_at = now() - interval '1 second'
      where id = ${cleanupId}
    `;
    const replayClaimId = crypto.randomUUID();
    const [replayed] = await claimTemporalScheduleCleanups(client.db, {
      claimId: replayClaimId,
      limit: 1,
    });
    expect(replayed?.connectorCleanupCompletedAt).not.toBeNull();
    expect(replayed?.connectorCleanupSnapshot).toEqual(descriptor);
    expect(
      await settleTemporalScheduleCleanup(client.db, {
        id: cleanupId,
        claimId: replayClaimId,
        error: "simulated second outage",
      }),
    ).toBe(true);

    const deleted = await deleteWorkspaceIfQuiescent(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
    });
    expect(deleted).toEqual({ status: "deleted", temporalScheduleCleanups: [] });
    const [adopted] = await sql<
      Array<{ snapshot: unknown | null; subject: string | null; task_id: string | null }>
    >`
      select connector_cleanup_snapshot as snapshot,
        connector_cleanup_subject_id as subject, scheduled_task_id as task_id
      from temporal_schedule_cleanup_outbox where id = ${cleanupId}
    `;
    expect(adopted).toEqual({ snapshot: null, subject: null, task_id: null });
    await client.close();
  });

  test("upgrades only exact historical terminal deliveries and rejects ambiguous dispatched work", async () => {
    const blank = await acquireBlankTestDatabase("migration-0273-terminal-upgrade");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
    try {
      await applyThrough0270(admin);
      const [account] = await admin<{ id: string }[]>`
          insert into managed_accounts (name) values ('0275 historical account') returning id
        `;
      const [workspace] = await admin<{ id: string }[]>`
          insert into workspaces (account_id, name)
          values (${account!.id}, '0275 historical workspace') returning id
        `;
      await admin`
          insert into workspace_inference_controls (workspace_id, account_id)
          values (${workspace!.id}, ${account!.id})
        `;
      await admin.unsafe("alter table sessions disable trigger user");
      await admin.unsafe("alter table session_turns disable trigger user");
      await admin.unsafe("alter table session_system_updates disable trigger user");
      const sessionId = crypto.randomUUID();
      await admin`
          insert into sessions (
            id, account_id, workspace_id, initial_message, model, sandbox_backend,
            sandbox_group_id, tool_policy, root_session_id, nested_agent_depth,
            effective_max_nested_agent_depth, nested_agent_depth_policy_source,
            nested_agent_depth_policy_session_id
          ) values (
            ${sessionId}, ${account!.id}, ${workspace!.id}, 'historical', 'test-model',
            'none', ${sessionId},
            ${admin.json({ mode: "workspace_default", inheritedFromSessionId: null })}::jsonb,
            ${sessionId}, 0, 5, 'session', ${sessionId}
          )
        `;
      const taskId = crypto.randomUUID();
      await admin`
          insert into scheduled_tasks (
            id, account_id, workspace_id, name, status, schedule,
            temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
            created_by_kind, created_by_subject_id, created_by_context,
            personal_connection_delegations, metadata
          ) values (
            ${taskId}, ${account!.id}, ${workspace!.id}, 'historical task', 'paused',
            ${admin.json({ kind: "interval", everySeconds: 60 })}::jsonb,
            ${`migration-0273-${taskId}`}, 'existing_session', 'allow_concurrent',
            ${admin.json({ kind: "agent_turn" })}::jsonb,
            ${admin.json({ prompt: "historical", resources: [], tools: [] })}::jsonb,
            'service', 'scheduler', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb
          )
        `;

      const terminalCases = [
        { updateState: "delivered", turnStatus: "completed", expected: "succeeded" },
        { updateState: "failed", turnStatus: null, expected: "failed" },
        { updateState: "cancelled", turnStatus: null, expected: "skipped" },
      ] as const;
      const runIds: string[] = [];
      for (const terminalCase of terminalCases) {
        const runId = crypto.randomUUID();
        runIds.push(runId);
        await admin`
            insert into scheduled_task_runs (
              id, task_id, account_id, workspace_id, session_id, status,
              trigger_type, action_kind, producer_key
            ) values (
              ${runId}, ${taskId}, ${account!.id}, ${workspace!.id}, ${sessionId},
              'dispatched', 'scheduled', 'agent_turn', ${`historical-${runId}`}
            )
          `;
        let turnId: string | null = null;
        let historyId: string | null = null;
        if (terminalCase.turnStatus) {
          turnId = crypto.randomUUID();
          const [history] = await admin<{ id: string }[]>`
              insert into session_history_items (
                account_id, workspace_id, session_id, position, item
              ) values (
                ${account!.id}, ${workspace!.id}, ${sessionId}, ${runIds.length},
                ${admin.json({ role: "user", content: "historical" })}::jsonb
              ) returning id
            `;
          historyId = history!.id;
          await admin`
              insert into session_turns (
                id, account_id, workspace_id, session_id, trigger_event_id,
                temporal_workflow_id, status, position, prompt, model,
                reasoning_effort, sandbox_backend, finished_at
              ) values (
                ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId},
                ${crypto.randomUUID()}, ${`historical-turn-${turnId}`},
                ${terminalCase.turnStatus}, ${runIds.length}, 'historical',
                'test-model', 'medium', 'none', now()
              )
            `;
        }
        await admin`
            insert into session_system_updates (
              account_id, workspace_id, session_id, kind, classification,
              source_id, dedupe_key, summary, payload, scheduled_task_run_id,
              state, delivered_turn_id, delivered_history_item_id, delivered_at
            ) values (
              ${account!.id}, ${workspace!.id}, ${sessionId}, 'scheduled_occurrence',
              'info', ${runId}, ${`historical-update-${runId}`}, 'historical',
              ${admin.json({ type: "scheduled_occurrence" })}::jsonb, ${runId},
              ${terminalCase.updateState}, ${turnId}, ${historyId},
              ${terminalCase.updateState === "delivered" ? new Date() : null}
            )
          `;
      }

      const ambiguousRunId = crypto.randomUUID();
      await admin`
          insert into scheduled_task_runs (
            id, task_id, account_id, workspace_id, session_id, status,
            trigger_type, action_kind, producer_key
          ) values (
            ${ambiguousRunId}, ${taskId}, ${account!.id}, ${workspace!.id}, ${sessionId},
            'dispatched', 'scheduled', 'agent_turn', ${`historical-${ambiguousRunId}`}
          )
        `;
      await admin.unsafe("alter table session_system_updates enable trigger user");
      await admin.unsafe("alter table session_turns enable trigger user");
      await admin.unsafe("alter table sessions enable trigger user");
      let drainError: unknown;
      try {
        await admin.unsafe(await readFile(migrationUrl, "utf8"));
      } catch (error) {
        drainError = error;
      }
      expect((drainError as { code?: string }).code).toBe("55000");
      expect((drainError as Error).message).toContain(
        "requires every nonterminal scheduled agent run to be drained",
      );

      await admin`delete from scheduled_task_runs where id = ${ambiguousRunId}`;
      await admin.unsafe(await readFile(migrationUrl, "utf8"));
      const statuses = await admin<Array<{ id: string; status: string }>>`
          select id, status from scheduled_task_runs
          where id = any(${runIds}::uuid[]) order by id
        `;
      expect(new Map(statuses.map((row) => [row.id, row.status]))).toEqual(
        new Map(runIds.map((runId, index) => [runId, terminalCases[index]!.expected])),
      );
    } finally {
      await admin.end({ timeout: 5 });
      await blank.release();
    }
  }, 180_000);

  test("refuses cutover while an active personal-resource agent task has no active human authorizer", async () => {
    const blank = await acquireBlankTestDatabase("migration-0273-revision-authority-drain");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
    try {
      await applyThrough0270(admin);
      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('0275 drain account') returning id
      `;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, '0275 drain workspace') returning id
      `;
      await admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})
      `;
      const [variableSet] = await admin<{ id: string }[]>`
        insert into workspace_variable_sets (account_id, workspace_id, name)
        values (${account!.id}, ${workspace!.id}, '0275 drain variables') returning id
      `;
      // The creator has no organization membership at all, so the 0275
      // backfill cannot record a revision authorizer for this task. The
      // workspace Variable Set alone is fine (ordinary workspace authority);
      // the user-scoped xAI authority is the personal resource that needs an
      // exact human.
      const orphanSubject = `subject:0273-orphan-${crypto.randomUUID()}`;
      const taskId = crypto.randomUUID();
      await admin`
        insert into scheduled_tasks (
          id, account_id, workspace_id, name, status, schedule,
          temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
          created_by_kind, created_by_subject_id, created_by_context,
          personal_connection_delegations, variable_set_id,
          xai_provider_account_authority_snapshot, metadata
        ) values (
          ${taskId}, ${account!.id}, ${workspace!.id}, 'orphaned secrets task', 'active',
          ${admin.json({ type: "interval", everySeconds: 3_600 })}::jsonb,
          ${`migration-0273-drain-${taskId}`}, 'new_session_per_run', 'allow_concurrent',
          ${admin.json({ kind: "agent_turn" })}::jsonb,
          ${admin.json({ prompt: "use secrets", resources: [], tools: [] })}::jsonb,
          'subject', ${orphanSubject}, '{}'::jsonb, '[]'::jsonb, ${variableSet!.id},
          ${admin.json({ version: 1, scope: "user", authorityGeneration: 1 })}::jsonb, '{}'::jsonb
        )
      `;
      let drainError: unknown;
      try {
        await admin.unsafe(await readFile(migrationUrl, "utf8"));
      } catch (error) {
        drainError = error;
      }
      expect((drainError as { code?: string } | undefined)?.code).toBe("55000");
      expect((drainError as Error).message).toContain(
        "requires every active personal-resource scheduled agent revision to have an exact human authorizer",
      );
      const [notApplied] = await admin<{ exists: boolean }[]>`
        select exists (
          select 1 from pg_tables where tablename = 'scheduled_task_revision_authorities'
        ) as exists
      `;
      expect(notApplied?.exists).toBe(false);

      // The same orphaned creator on a plain prompt task delegates nothing, so
      // cutover proceeds and records no revision authorizer for it.
      // A workspace-Variable-Set task by the same orphaned writer carries no
      // personal authority, so the cutover accepts it and it keeps running.
      // (The xAI snapshot is immutable, so the personal task is removed pre-cutover.)
      await admin`delete from scheduled_tasks where id = ${taskId}`;
      await admin`
        insert into scheduled_tasks (
          id, account_id, workspace_id, name, status, schedule,
          temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
          created_by_kind, created_by_subject_id, created_by_context,
          personal_connection_delegations, variable_set_id, metadata
        ) values (
          ${taskId}, ${account!.id}, ${workspace!.id}, 'orphaned workspace secrets task', 'active',
          ${admin.json({ type: "interval", everySeconds: 3_600 })}::jsonb,
          ${`migration-0273-drain-${taskId}`}, 'new_session_per_run', 'allow_concurrent',
          ${admin.json({ kind: "agent_turn" })}::jsonb,
          ${admin.json({ prompt: "use secrets", resources: [], tools: [] })}::jsonb,
          'subject', ${orphanSubject}, '{}'::jsonb, '[]'::jsonb, ${variableSet!.id}, '{}'::jsonb
        )
      `;
      await admin.unsafe(await readFile(migrationUrl, "utf8"));
      const [applied] = await admin<{ authorities: number; status: string }[]>`
        select
          (select count(*)::int from scheduled_task_revision_authorities
            where task_id = ${taskId}) as authorities,
          (select status from scheduled_tasks where id = ${taskId}) as status
      `;
      expect(applied).toEqual({ authorities: 0, status: "active" });
    } finally {
      await admin.end({ timeout: 5 });
      await blank.release();
    }
  }, 180_000);

  test("offboards a member owning workspace-shared sessions with live turns after protocol settlement", async () => {
    if (!shared) return;
    const client = createDb(shared.appUrl, { max: 4 });
    try {
      const ownerId = `0273-offboard-owner-${crypto.randomUUID()}`;
      const targetId = `0273-offboard-target-${crypto.randomUUID()}`;
      const ownerSubject = `user:${ownerId}`;
      const targetSubject = `user:${targetId}`;
      await ensureManagedAccessForUser(client.db, {
        userId: ownerId,
        email: `${ownerId}@example.test`,
        name: ownerId,
      });
      const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
      const organizationId = owner!.organizationId;
      await shared.admin`
        insert into session_tenancy_activations (
          account_id, activation_version, inventory_digest, parity_digest, activated_by
        ) values (${organizationId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
        on conflict (account_id) do nothing`;
      const privateSessionSettings = await getOrganizationPrivateSessionSettings(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
      });
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        enabled: true,
        expectedVersion: privateSessionSettings.version,
        operationId: crypto.randomUUID(),
      });
      const invitation = await createOrganizationInvitation(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        operationId: crypto.randomUUID(),
        targetSubjectId: targetSubject,
        targetEmail: `${targetId}@example.test`,
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const member = (
        await acceptOrganizationInvitation(client.db, {
          organizationId,
          actorSubjectId: targetSubject,
          operationId: crypto.randomUUID(),
          invitationId: invitation.id,
          expectedRevision: invitation.revision,
        })
      ).membership;
      // The lifecycle command visits workspaces in id order and re-defers the
      // session commit guards only at the end of each workspace pass, so the
      // guard regression is only observable when the workspace holding the
      // target's live turns is visited first. Pin that ordering.
      const workspaceId = `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`;
      await shared.admin`
        insert into workspaces (id, account_id, name, external_source, external_id)
        values (${workspaceId}, ${organizationId}, '0275 offboard shared', 'test',
          ${crypto.randomUUID()})`;
      const [firstWorkspace] = await shared.admin<{ id: string }[]>`
        select id from workspaces where account_id = ${organizationId} order by id limit 1`;
      expect(firstWorkspace?.id).toBe(workspaceId);
      await shared.admin`
        insert into workspace_inference_controls (account_id, workspace_id)
        values (${organizationId}, ${workspaceId})`;
      await shared.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${organizationId}, ${workspaceId}, ${ownerSubject}, 'owner'),
          (${organizationId}, ${workspaceId}, ${targetSubject}, 'member')`;

      // Session one: workspace-shared, target-owned, requires_action with a
      // pending tool call and no live attempt, so the application-side
      // protocol settlement runs and finalizes its workspace activity gate.
      const settledSession = await createSession(client.db, {
        accountId: organizationId,
        workspaceId,
        initialMessage: "settled shared work",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: targetSubject },
        subjectId: targetSubject,
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
      });
      // Session two: target-owned, moved private and then explicitly back to
      // workspace-shared before offboarding, with a live queued turn the
      // wrapped lifecycle command must cancel through the gated session write.
      const sharedSession = await createSession(client.db, {
        accountId: organizationId,
        workspaceId,
        initialMessage: "shared queued work",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: targetSubject },
        subjectId: targetSubject,
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
      });
      const privateTransition = await transitionSessionVisibility(client.db, {
        workspaceId,
        sessionId: sharedSession.id,
        actorSubjectId: targetSubject,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `private:${crypto.randomUUID()}`,
      });
      expect(privateTransition.authorityEpoch).toBe(2);
      const sharedTransition = await transitionSessionVisibility(client.db, {
        workspaceId,
        sessionId: sharedSession.id,
        actorSubjectId: targetSubject,
        targetVisibility: "workspace_shared",
        expectedAuthorityEpoch: 2,
        operationKey: `shared:${crypto.randomUUID()}`,
      });
      expect(sharedTransition.authorityEpoch).toBe(3);
      const [visibility] = await shared.admin<
        Array<{ settled: string; shared: string; settledOwner: string; sharedOwner: string }>
      >`
        select
          (select visibility from sessions where id = ${settledSession.id}) as settled,
          (select visibility from sessions where id = ${sharedSession.id}) as shared,
          (select owner_organization_membership_id from sessions
            where id = ${settledSession.id}) as "settledOwner",
          (select owner_organization_membership_id from sessions
            where id = ${sharedSession.id}) as "sharedOwner"`;
      expect(visibility).toEqual({
        settled: "workspace_shared",
        shared: "workspace_shared",
        settledOwner: member.id,
        sharedOwner: member.id,
      });

      const requiresActionTurnId = crypto.randomUUID();
      const requiresActionAttemptId = crypto.randomUUID();
      const queuedTurnId = crypto.randomUUID();
      const pendingToolCallId = `call-${crypto.randomUUID()}`;
      await shared.admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, execution_generation, position, prompt,
          model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
          initiator_subject_id, initiating_human_subject_id
        ) values
        (
          ${requiresActionTurnId}, ${organizationId}, ${workspaceId}, ${settledSession.id},
          ${crypto.randomUUID()}, ${`offboard-0273-${crypto.randomUUID()}`},
          'running', 1, 1, 'settled shared work', 'test-model', 'medium', 'standard',
          'none', 'subject', ${targetSubject}, ${targetSubject}
        ),
        (
          ${queuedTurnId}, ${organizationId}, ${workspaceId}, ${sharedSession.id},
          ${crypto.randomUUID()}, ${`offboard-0273-${crypto.randomUUID()}`},
          'queued', 1, 1, 'shared queued work', 'test-model', 'medium', 'standard',
          'none', 'subject', ${targetSubject}, ${targetSubject}
        )`;
      await shared.admin.begin(async (tx) => {
        await tx`update sessions
          set active_turn_id = ${requiresActionTurnId}, status = 'running'
          where id = ${settledSession.id}`;
        await tx`update session_turns
          set active_attempt_id = ${requiresActionAttemptId}
          where id = ${requiresActionTurnId}`;
        await tx`
          insert into session_turn_attempts (
            id, account_id, workspace_id, session_id, turn_id, execution_generation,
            state, temporal_workflow_id, temporal_workflow_run_id,
            temporal_activity_id, verified_control_revision, mcp_approval_policies
          ) values (
            ${requiresActionAttemptId}, ${organizationId}, ${workspaceId},
            ${settledSession.id}, ${requiresActionTurnId}, 1, 'running',
            ${`offboard-0273-${requiresActionTurnId}`}, ${`run-${requiresActionAttemptId}`},
            ${`activity-${requiresActionAttemptId}`}, 0, '{}'::jsonb
          )`;
        await tx`update session_turn_attempts
          set state = 'closed', outcome = 'requires_action', closed_at = now()
          where id = ${requiresActionAttemptId}`;
        await tx`update session_turns
          set status = 'requires_action', active_attempt_id = null
          where id = ${requiresActionTurnId}`;
        await tx`update sessions set status = 'requires_action'
          where id = ${settledSession.id}`;
      });
      await shared.admin`
        insert into session_pending_tool_calls (
          account_id, workspace_id, session_id, turn_id, execution_generation,
          attempt_id, call_id, call_type, call_item, call_item_codec_version
        ) values (
          ${organizationId}, ${workspaceId}, ${settledSession.id},
          ${requiresActionTurnId}, 1, ${requiresActionAttemptId}, ${pendingToolCallId},
          'function_call',
          ${shared.admin.json({
            type: "function_call",
            name: "request_human_input",
            callId: pendingToolCallId,
            arguments: "{}",
          })},
          1
        )`;

      const offboarded = await updateOrganizationMember(client.db, {
        organizationId,
        actorSubjectId: ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: member.id,
        transition: {
          kind: "offboard",
          expectedAuthorizationRevision: member.authorizationRevision,
          operationId: crypto.randomUUID(),
          reason: "employment ended",
        },
      });
      expect(offboarded.status).toBe("revoked");
      const [after] = await shared.admin<
        Array<{
          queuedTurn: string;
          requiresActionTurn: string;
          pendingToolCalls: number;
          sharedEpoch: number;
          settledEpoch: number;
          revocationEvents: number;
        }>
      >`
        select
          (select status from session_turns where id = ${queuedTurnId}) as "queuedTurn",
          (select status from session_turns where id = ${requiresActionTurnId})
            as "requiresActionTurn",
          (select count(*)::int from session_pending_tool_calls
            where turn_id = ${requiresActionTurnId}) as "pendingToolCalls",
          (select authority_epoch::int from sessions where id = ${sharedSession.id})
            as "sharedEpoch",
          (select authority_epoch::int from sessions where id = ${settledSession.id})
            as "settledEpoch",
          (select count(*)::int from session_events event_row
            where event_row.session_id in (${sharedSession.id}, ${settledSession.id})
              and event_row.type = 'session.authority.revoked') as "revocationEvents"`;
      expect(after).toEqual({
        queuedTurn: "cancelled",
        requiresActionTurn: "cancelled",
        pendingToolCalls: 0,
        sharedEpoch: 4,
        settledEpoch: 2,
        revocationEvents: 2,
      });
    } finally {
      await client.close();
    }
  }, 180_000);
});
