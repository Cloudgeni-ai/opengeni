import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import {
  captureScheduledTaskRestoreState,
  ScheduledTaskSyncError,
  syncUpdatedScheduledTask,
} from "@opengeni/core";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  getScheduledTask,
  getScheduledTaskRunPersonalResourceAuthority,
  updateScheduledTask,
} from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0250_scheduled_personal_resource_delegation.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const explicitAdminDatabaseUrl = process.env.OPENGENI_MIGRATION_0250_TEST_DATABASE_ADMIN_URL;

describe("migration 0250 scheduled personal-resource delegation", () => {
  test("freezes task authority and revalidates each occurrence and exact attempt", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const executable = source.replace(/^--.*$/gmu, "");

    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "authority_revision" bigint NOT NULL DEFAULT 1');
    expect(source).toContain('ADD COLUMN "scheduled_task_run_id" uuid');
    expect(source).toContain('CREATE TABLE "scheduled_task_personal_resource_authorities"');
    expect(source).toContain('CREATE TABLE "scheduled_task_personal_resource_snapshots"');
    expect(source).toContain('CREATE TABLE "scheduled_task_run_personal_resource_admissions"');
    expect(source).toContain('CREATE TABLE "scheduled_task_run_personal_resource_snapshots"');
    expect(source).toContain('CREATE TABLE "scheduled_task_run_personal_resource_once_receipts"');
    expect(executable.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(5);
    expect(executable.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(5);
    expect(executable.match(/SECURITY DEFINER/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(source).toContain("SET search_path FROM CURRENT");
    expect(source).not.toContain("SET search_path = public");
    expect(source).toContain("scheduled personal-resource authority snapshot is no longer live");
    expect(source).toContain("scheduled personal-resource task has no authority snapshot");
    expect(source).toContain("clone_scheduled_task_personal_resource_authority");
    expect(source).toContain("SET \"status\" = 'paused'");
    expect(source).toContain("scheduled task authority revision changed before attempt admission");
    expect(source).toContain("scheduled occurrence personal-resource snapshot widened or changed");
    expect(source).toContain("scheduled occurrence once grant lost its first-use race");
    expect(source).toContain("CREATE TRIGGER scheduled_task_attempt_once_retry_prepare");
    expect(source).toContain("membership.authorization_revision");
    expect(source).toContain("authority.generation = snapshot.authority_generation");
    expect(source).toContain("grant_value.generation = snapshot.grant_generation");
    expect(source).toContain(
      "session_value.authority_epoch = authority_row.session_authority_epoch",
    );
    expect(source).not.toMatch(/\b(?:value_encrypted|secret_value|plaintext_value)\b/iu);
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION scheduled_task_run_personal_resource_authority(uuid, uuid, uuid)",
    );
  });

  test("applies in a dedicated schema and installs the exact trigger/function boundary", async () => {
    const blank = await acquireMigrationTestDatabase("dedicated-schema");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0250-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const schema = `scheduled_personal_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 40);
    const sql = postgres(blank.databaseUrl, { max: 2, prepare: false });
    try {
      await migrate(blank.databaseUrl, schema);
      const [installed] = await sql.unsafe<
        {
          taskColumn: boolean;
          updateColumn: boolean;
          freezeFunction: boolean;
          cloneFunction: boolean;
          runTrigger: boolean;
          attemptTrigger: boolean;
          forcedLedgers: number;
        }[]
      >(`
        select
          exists (
            select 1 from information_schema.columns
            where table_schema = '${schema}' and table_name = 'scheduled_tasks'
              and column_name = 'authority_revision'
          ) as "taskColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = '${schema}' and table_name = 'session_system_updates'
              and column_name = 'scheduled_task_run_id'
          ) as "updateColumn",
          to_regprocedure('${schema}.freeze_scheduled_task_personal_resources(uuid,uuid,uuid,bigint)')
            is not null as "freezeFunction",
          to_regprocedure('${schema}.clone_scheduled_task_personal_resource_authority(uuid,uuid,uuid,bigint,bigint)')
            is not null as "cloneFunction",
          exists (
            select 1 from pg_trigger trigger_value
            join pg_class table_value on table_value.oid = trigger_value.tgrelid
            join pg_namespace namespace_value on namespace_value.oid = table_value.relnamespace
            where namespace_value.nspname = '${schema}'
              and trigger_value.tgname = 'scheduled_task_run_personal_resource_admission'
              and not trigger_value.tgisinternal
          ) as "runTrigger",
          exists (
            select 1 from pg_trigger trigger_value
            join pg_class table_value on table_value.oid = trigger_value.tgrelid
            join pg_namespace namespace_value on namespace_value.oid = table_value.relnamespace
            where namespace_value.nspname = '${schema}'
              and trigger_value.tgname = 'zz_scheduled_task_attempt_personal_resource_match'
              and not trigger_value.tgisinternal
          ) as "attemptTrigger",
          (
            select count(*)::int from pg_class table_value
            join pg_namespace namespace_value on namespace_value.oid = table_value.relnamespace
            where namespace_value.nspname = '${schema}' and table_value.relforcerowsecurity
              and table_value.relname in (
                'scheduled_task_personal_resource_authorities',
                'scheduled_task_personal_resource_snapshots',
                'scheduled_task_run_personal_resource_admissions',
                'scheduled_task_run_personal_resource_once_receipts',
                'scheduled_task_run_personal_resource_snapshots'
              )
          ) as "forcedLedgers"
      `);
      expect(installed).toEqual({
        taskColumn: true,
        updateColumn: true,
        freezeFunction: true,
        cloneFunction: true,
        runTrigger: true,
        attemptTrigger: true,
        forcedLedgers: 5,
      });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("pauses pre-migration personal tasks and rejects an old writer without a snapshot", async () => {
    const blank = await acquireMigrationTestDatabase("rolling-old-writer");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    const migrationName = "0250_scheduled_personal_resource_delegation.sql";
    try {
      await admin`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `;
      await admin`insert into schema_migrations (name) values (${migrationName})`;
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const [legacyTask] = await admin<Array<{ id: string }>>`
        insert into scheduled_tasks (
          account_id, workspace_id, name, status, schedule, temporal_schedule_id,
          run_mode, overlap_policy, agent_config, created_by_kind,
          created_by_subject_id, variable_set_id, metadata
        ) values (
          ${fixture.accountId}, ${fixture.targetWorkspaceId}, 'legacy personal task', 'active',
          '{"type":"manual"}'::jsonb, ${`scheduled-personal-legacy-${crypto.randomUUID()}`},
          'new_session_per_run', 'allow_concurrent',
          '{"prompt":"legacy","resources":[],"tools":[],"metadata":{}}'::jsonb,
          'subject', ${fixture.subjectId}, ${fixture.variableSetId}, '{}'::jsonb
        ) returning id
      `;

      await admin`delete from schema_migrations where name = ${migrationName}`;
      await migrate(blank.databaseUrl);

      const [paused] = await admin<
        Array<{ status: string; authorityRevision: number; authorityCount: number }>
      >`
        select task.status, task.authority_revision::int as "authorityRevision",
          (select count(*)::int from scheduled_task_personal_resource_authorities authority
            where authority.task_id = task.id) as "authorityCount"
        from scheduled_tasks task where task.id = ${legacyTask!.id}
      `;
      expect(paused).toEqual({ status: "paused", authorityRevision: 1, authorityCount: 0 });
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: legacyTask!.id,
            triggerType: "scheduled",
            producerKey: "scheduled-personal-pre-migration-paused",
          }),
        ),
      ).toContain("scheduled personal-resource task has no authority snapshot");

      // A rolling old writer can still issue the pre-0250 status update, but it
      // cannot manufacture the new immutable authority ledger. The database
      // rejects the occurrence instead of silently dispatching authority-free.
      await admin`update scheduled_tasks set status = 'active' where id = ${legacyTask!.id}`;
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: legacyTask!.id,
            triggerType: "scheduled",
            producerKey: "scheduled-personal-old-writer-reactivated",
          }),
        ),
      ).toContain("scheduled personal-resource task has no authority snapshot");
      const [runCount] = await admin<Array<{ count: number }>>`
        select count(*)::int as count from scheduled_task_runs where task_id = ${legacyTask!.id}
      `;
      expect(runCount?.count).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("Temporal rollback clones the prior causal human instead of the task creator", async () => {
    const blank = await acquireMigrationTestDatabase("cross-human-rollback");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const createdByOtherHuman = await createScheduledTask(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        name: "created by another human",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `scheduled-personal-rollback-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: "before personal authority",
          resources: [],
          tools: [],
          metadata: {},
        },
        createdBy: { kind: "subject", subjectId: fixture.otherSubjectId },
        metadata: {},
      });
      const acceptedByResourceOwner = await updateScheduledTask(
        client.db,
        fixture.targetWorkspaceId,
        createdByOtherHuman.id,
        {
          name: "accepted by resource owner",
          variableSetId: fixture.variableSetId,
          refreshPersonalResourceAuthority: true,
          authorityUpdatedBy: { kind: "subject", subjectId: fixture.subjectId },
          authorityUpdatedByActor: null,
        },
      );
      const previous = await captureScheduledTaskRestoreState(client.db, acceptedByResourceOwner);
      const changed = await updateScheduledTask(
        client.db,
        fixture.targetWorkspaceId,
        createdByOtherHuman.id,
        {
          name: "Temporal will reject this update",
          refreshPersonalResourceAuthority: true,
          authorityUpdatedBy: { kind: "subject", subjectId: fixture.subjectId },
          authorityUpdatedByActor: null,
        },
      );

      let syncError: unknown;
      try {
        await syncUpdatedScheduledTask({
          db: client.db,
          previous,
          task: changed,
          workflowClient: {
            syncScheduledTask: async () => {
              throw new Error("expected Temporal synchronization failure");
            },
          } as never,
        });
      } catch (error) {
        syncError = error;
      }
      expect(syncError).toBeInstanceOf(ScheduledTaskSyncError);
      expect((syncError as ScheduledTaskSyncError).persistenceRestored).toBe(true);

      const restored = await getScheduledTask(
        client.db,
        fixture.targetWorkspaceId,
        createdByOtherHuman.id,
      );
      expect(restored).toMatchObject({
        name: acceptedByResourceOwner.name,
        variableSetId: fixture.variableSetId,
        authorityRevision: changed.authorityRevision + 1,
      });
      const restoredRun = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: createdByOtherHuman.id,
        triggerType: "scheduled",
        producerKey: "scheduled-personal-cross-human-restored",
      });
      expect(
        await getScheduledTaskRunPersonalResourceAuthority(client.db, {
          accountId: fixture.accountId,
          workspaceId: fixture.targetWorkspaceId,
          runId: restoredRun.id,
        }),
      ).toMatchObject({
        taskAuthorityRevision: changed.authorityRevision + 1,
        initiatingHumanSubjectId: fixture.subjectId,
        resources: [expect.objectContaining({ resourceId: fixture.variableSetId })],
      });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("freezes exact authority, reuses producer admission, and rejects stale or cross-human runs", async () => {
    const blank = await acquireMigrationTestDatabase("authority-lifecycle");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0250-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const task = await createScheduledTask(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        name: "scheduled personal authority",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `scheduled-personal-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: "use the frozen variable set",
          resources: [],
          tools: [],
          metadata: {},
        },
        createdBy: { kind: "subject", subjectId: fixture.subjectId },
        variableSetId: fixture.variableSetId,
        metadata: {},
      });
      expect(task.authorityRevision).toBe(1);

      const firstRun = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: "scheduled-personal-producer",
      });
      const replay = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: "scheduled-personal-producer",
      });
      expect(replay.id).toBe(firstRun.id);
      const firstAuthority = await getScheduledTaskRunPersonalResourceAuthority(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        runId: firstRun.id,
      });
      expect(firstAuthority).toMatchObject({
        taskId: task.id,
        taskAuthorityRevision: 1,
        initiatingHumanSubjectId: fixture.subjectId,
      });
      expect(firstAuthority?.resources).toEqual([
        expect.objectContaining({
          resourceKind: "variable_set",
          resourceId: fixture.variableSetId,
          grantId: fixture.grantId,
          grantMode: "always",
        }),
      ]);

      await admin`
        update organization_user_resource_grants
        set status = 'revoked', revoked_at = now(), updated_at = now()
        where id = ${fixture.grantId}
      `;
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: "scheduled-personal-revoked",
          }),
        ),
      ).toContain("scheduled personal-resource authority snapshot is no longer live");

      await admin`
        update organization_user_resource_grants
        set status = 'active', revoked_at = null, updated_at = now()
        where id = ${fixture.grantId}
      `;
      await admin`
        delete from workspace_memberships
        where workspace_id = ${fixture.targetWorkspaceId}
          and subject_id = ${fixture.subjectId}
      `;
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: "scheduled-personal-membership-lost",
          }),
        ),
      ).toContain("scheduled personal-resource authority snapshot is no longer live");
      await admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${fixture.accountId}, ${fixture.targetWorkspaceId}, ${fixture.subjectId})
      `;

      const revised = await updateScheduledTask(client.db, fixture.targetWorkspaceId, task.id, {
        name: "scheduled personal authority revised",
        refreshPersonalResourceAuthority: true,
        authorityUpdatedBy: { kind: "subject", subjectId: fixture.subjectId },
        authorityUpdatedByActor: null,
      });
      expect(revised.authorityRevision).toBe(2);
      const revisedRun = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: "scheduled-personal-revised",
      });
      expect(
        (
          await getScheduledTaskRunPersonalResourceAuthority(client.db, {
            accountId: fixture.accountId,
            workspaceId: fixture.targetWorkspaceId,
            runId: revisedRun.id,
          })
        )?.taskAuthorityRevision,
      ).toBe(2);
      expect(firstAuthority?.taskAuthorityRevision).toBe(1);

      expect(
        await rejectedErrorChain(
          createScheduledTask(client.db, {
            accountId: fixture.accountId,
            workspaceId: fixture.targetWorkspaceId,
            name: "cross-human scheduled authority",
            status: "active",
            schedule: { type: "manual" },
            temporalScheduleId: `scheduled-personal-cross-human-${crypto.randomUUID()}`,
            runMode: "new_session_per_run",
            overlapPolicy: "allow_concurrent",
            agentConfig: { prompt: "must fail", resources: [], tools: [], metadata: {} },
            createdBy: { kind: "subject", subjectId: fixture.otherSubjectId },
            variableSetId: fixture.variableSetId,
            metadata: {},
          }),
        ),
      ).toContain("scheduled personal resource belongs to another human or organization");
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("consumes a once grant per occurrence and transfers its attempt receipt on retry", async () => {
    const blank = await acquireMigrationTestDatabase("once-retry");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const session = await createSession(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        initialMessage: "scheduled once authority target",
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId: fixture.subjectId },
        model: "test-model",
        sandboxBackend: "modal",
        variableSetId: fixture.variableSetId,
        subjectId: fixture.subjectId,
      });
      const [sessionAuthority] = await admin<
        Array<{
          authorityEpoch: number;
          visibility: string;
          ownerOrganizationMembershipId: string | null;
        }>
      >`
        select authority_epoch as "authorityEpoch", visibility,
          owner_organization_membership_id as "ownerOrganizationMembershipId"
        from sessions where id = ${session.id}
      `;
      if (!sessionAuthority) throw new Error("scheduled once target authority is missing");
      await admin`
        update organization_user_resource_grants
        set mode = 'once', session_id = ${session.id}, context = ${sessionAuthority.visibility},
          authority_epoch = ${sessionAuthority.authorityEpoch}, updated_at = now()
        where id = ${fixture.grantId}
      `;
      const task = await createScheduledTask(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        name: "scheduled once authority",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `scheduled-personal-once-${crypto.randomUUID()}`,
        runMode: "existing_session",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "use once authority", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: fixture.subjectId },
        targetSessionId: session.id,
        variableSetId: fixture.variableSetId,
        metadata: {},
      });
      const run = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: "scheduled-personal-once-run",
      });
      expect(await grantAndReceiptState(admin, fixture.grantId)).toEqual({
        status: "consumed",
        scheduledReceipts: 1,
        attemptReceipts: 0,
        attemptId: null,
      });

      const turnId = crypto.randomUUID();
      await admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, execution_generation, position, prompt,
          model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
          initiator_subject_id, initiating_human_subject_id
        ) values (
          ${turnId}, ${fixture.accountId}, ${fixture.targetWorkspaceId}, ${session.id},
          ${crypto.randomUUID()}, 'scheduled-personal-once-workflow', 'running', 1, 1,
          'scheduled once attempt', 'test-model', 'medium', 'standard', 'modal',
          'service', 'scheduler', ${fixture.subjectId}
        )
      `;
      const scheduledPayload = JSON.stringify({
        type: "scheduled_occurrence",
        text: "scheduled once attempt",
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
      });
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, classification, source_id,
          dedupe_key, summary, payload, lineage, state, delivered_turn_id,
          scheduled_task_run_id
        ) values (
          ${fixture.accountId}, ${fixture.targetWorkspaceId}, ${session.id},
          'scheduled_occurrence', 'info', ${run.id}, ${`scheduled-personal-once:${run.id}`},
          'scheduled once attempt', ${scheduledPayload}::jsonb,
          '{}'::jsonb, 'pending', ${turnId}, ${run.id}
        )
      `;
      const firstAttemptId = crypto.randomUUID();
      await insertScheduledAttempt(admin, {
        fixture,
        sessionId: session.id,
        turnId,
        attemptId: firstAttemptId,
        executionGeneration: 1,
        authorityEpoch: sessionAuthority.authorityEpoch,
        authorityVisibility: sessionAuthority.visibility,
        authorityOwnerOrganizationMembershipId: sessionAuthority.ownerOrganizationMembershipId,
      });
      expect(await grantAndReceiptState(admin, fixture.grantId)).toEqual({
        status: "consumed",
        scheduledReceipts: 1,
        attemptReceipts: 1,
        attemptId: firstAttemptId,
      });

      await admin`
        update session_turn_attempts
        set state = 'closed', outcome = 'interrupted_recoverable', closed_at = now(),
          updated_at = now()
        where id = ${firstAttemptId}
      `;
      const retryAttemptId = crypto.randomUUID();
      await insertScheduledAttempt(admin, {
        fixture,
        sessionId: session.id,
        turnId,
        attemptId: retryAttemptId,
        executionGeneration: 2,
        authorityEpoch: sessionAuthority.authorityEpoch,
        authorityVisibility: sessionAuthority.visibility,
        authorityOwnerOrganizationMembershipId: sessionAuthority.ownerOrganizationMembershipId,
      });
      expect(await grantAndReceiptState(admin, fixture.grantId)).toEqual({
        status: "consumed",
        scheduledReceipts: 1,
        attemptReceipts: 1,
        attemptId: retryAttemptId,
      });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});

async function createAuthorityFixture(sql: postgres.Sql): Promise<{
  accountId: string;
  personalWorkspaceId: string;
  targetWorkspaceId: string;
  subjectId: string;
  otherSubjectId: string;
  variableSetId: string;
  grantId: string;
  authorityId: string;
}> {
  const subjectId = `human:${crypto.randomUUID()}`;
  const otherSubjectId = `human:${crypto.randomUUID()}`;
  const [account] = await sql<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`scheduled-personal-${crypto.randomUUID()}`}) returning id
  `;
  const [personalWorkspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${account!.id}, 'personal') returning id
  `;
  const [otherPersonalWorkspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${account!.id}, 'other personal') returning id
  `;
  const [targetWorkspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${account!.id}, 'target') returning id
  `;
  await sql`
    insert into workspace_inference_controls (workspace_id, account_id)
    values
      (${personalWorkspace!.id}, ${account!.id}),
      (${otherPersonalWorkspace!.id}, ${account!.id}),
      (${targetWorkspace!.id}, ${account!.id})
  `;
  const [membership] = await sql<Array<{ id: string }>>`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${account!.id}, ${subjectId}, 'active', ${personalWorkspace!.id}, 7)
    returning id
  `;
  await sql`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${account!.id}, ${otherSubjectId}, 'active', ${otherPersonalWorkspace!.id}, 3)
  `;
  await sql`
    insert into workspace_memberships (account_id, workspace_id, subject_id)
    values
      (${account!.id}, ${targetWorkspace!.id}, ${subjectId}),
      (${account!.id}, ${targetWorkspace!.id}, ${otherSubjectId})
  `;
  const [variableSet] = await sql<Array<{ id: string }>>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${account!.id}, ${personalWorkspace!.id}, 'personal variables')
    returning id
  `;
  const [authority] = await sql<Array<{ id: string }>>`
    insert into organization_user_resource_authorities (
      account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) values (
      ${account!.id}, ${membership!.id}, 'variable_set', ${variableSet!.id},
      ${personalWorkspace!.id}, 11, 'active'
    ) returning id
  `;
  await sql`
    update workspace_variable_sets
    set authority_scope = 'user', authority_id = ${authority!.id},
      owner_organization_membership_id = ${membership!.id},
      origin_workspace_id = ${personalWorkspace!.id}
    where id = ${variableSet!.id}
  `;
  const [grant] = await sql<Array<{ id: string }>>`
    insert into organization_user_resource_grants (
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      action, mode, context, generation, status
    ) values (
      ${account!.id}, ${authority!.id}, ${membership!.id}, ${targetWorkspace!.id},
      'variable_set.use', 'always', 'workspace_shared', 13, 'active'
    ) returning id
  `;
  return {
    accountId: account!.id,
    personalWorkspaceId: personalWorkspace!.id,
    targetWorkspaceId: targetWorkspace!.id,
    subjectId,
    otherSubjectId,
    variableSetId: variableSet!.id,
    grantId: grant!.id,
    authorityId: authority!.id,
  };
}

async function insertScheduledAttempt(
  sql: postgres.Sql,
  input: {
    fixture: Awaited<ReturnType<typeof createAuthorityFixture>>;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    authorityEpoch: number;
    authorityVisibility: string;
    authorityOwnerOrganizationMembershipId: string | null;
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("set local opengeni.session_inference_claim = '1'");
    await tx`
      update sessions
      set active_turn_id = ${input.turnId}, status = 'running'
      where id = ${input.sessionId}
    `;
    await tx`
      update session_turns
      set active_attempt_id = ${input.attemptId},
        execution_generation = ${input.executionGeneration}, status = 'running'
      where id = ${input.turnId}
    `;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, authority_epoch, authority_visibility,
        authority_owner_organization_membership_id, mcp_approval_policies,
        connector_action_policies
      ) values (
        ${input.attemptId}, ${input.fixture.accountId},
        ${input.fixture.targetWorkspaceId}, ${input.sessionId}, ${input.turnId},
        ${input.executionGeneration}, 'scheduled-personal-once-workflow',
        ${`run-${input.attemptId}`}, ${`activity-${input.attemptId}`}, 1,
        ${input.authorityEpoch}, ${input.authorityVisibility},
        ${input.authorityOwnerOrganizationMembershipId}, '{}'::jsonb, '[]'::jsonb
      )
    `;
  });
}

async function grantAndReceiptState(
  sql: postgres.Sql,
  grantId: string,
): Promise<{
  status: string;
  scheduledReceipts: number;
  attemptReceipts: number;
  attemptId: string | null;
}> {
  const [row] = await sql<
    Array<{
      status: string;
      scheduledReceipts: number;
      attemptReceipts: number;
      attemptId: string | null;
    }>
  >`
    select grant_value.status,
      (select count(*)::int from scheduled_task_run_personal_resource_once_receipts receipt
        where receipt.grant_id = grant_value.id) as "scheduledReceipts",
      (select count(*)::int from personal_resource_once_consumption_receipts receipt
        where receipt.grant_id = grant_value.id) as "attemptReceipts",
      (select receipt.attempt_id from personal_resource_once_consumption_receipts receipt
        where receipt.grant_id = grant_value.id) as "attemptId"
    from organization_user_resource_grants grant_value
    where grant_value.id = ${grantId}
  `;
  return row!;
}

async function acquireMigrationTestDatabase(label: string): Promise<BlankTestDatabase | null> {
  if (!explicitAdminDatabaseUrl) {
    const blank = await acquireBlankTestDatabase(`migration-0250-${label}`);
    if (!blank && requireRealDatabase) {
      throw new Error(
        `[migration-0250-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable for ${label}`,
      );
    }
    return blank;
  }

  const databaseName = `opengeni_0250_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${crypto
    .randomUUID()
    .replaceAll("-", "")}`.slice(0, 63);
  const control = postgres(explicitAdminDatabaseUrl, { max: 1, prepare: false });
  await control.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  const databaseUrl = new URL(explicitAdminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  let released = false;
  return {
    databaseUrl: databaseUrl.toString(),
    release: async () => {
      if (released) return;
      released = true;
      try {
        await control`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${databaseName} and pid <> pg_backend_pid()
        `;
        await control.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
      } finally {
        await control.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function rejectedErrorChain(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join("\ncaused by: ");
  }
  throw new Error("expected operation to reject");
}
