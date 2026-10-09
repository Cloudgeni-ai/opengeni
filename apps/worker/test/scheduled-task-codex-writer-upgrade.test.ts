import { expect, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase, MemoryEventBus, testSettings } from "@opengeni/testing";
import {
  createDb,
  createVariableSet,
  ensureManagedAccessForUser,
  updateScheduledTask,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "../../../packages/db/src/provision-roles";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";
import postgres from "postgres";

test("a pre-writer personal-resource task retains its execution proof across migration, rename and pause/resume", async () => {
  const database = await acquireOwnerMigratedTestDatabase("codex-writer-task-digest-upgrade");
  if (!database) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  let client: ReturnType<typeof createDb> | undefined;
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  const writer = "0688_subscription_core_codex_writers.sql";
  const disconnect = "0691_subscription_core_codex_disconnect.sql";
  const explicitRetry = "0697_codex_retry_after_unknown_outcome.sql";
  const recovery = "0699_codex_recovery_after_interrupted_attempt.sql";
  try {
    // Stage the actual pre-writer ledger, including on the stacked cutover
    // branch. This is a rolling/gate-off regression, not cutover activation.
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    // Graceful disconnect rewrites writer routines; explicit Retry and recovery
    // rewrite its admission guard. Defer all with their prerequisite while constructing
    // the genuine pre-writer fixture, then replay them in ledger order below.
    await database.admin`insert into schema_migrations(name) values (${writer}),
      ('0689_subscription_core_codex_cutover.sql'), (${disconnect}), (${explicitRetry}), (${recovery})`;
    await migrate(database.adminUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
    const appUrl = new URL(database.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = database.appPassword;
    client = createDb(appUrl.toString());
    const userId = `digest-upgrade-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Digest upgrade",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const [workspace] = await database.admin`insert into workspaces (account_id, name)
      values (${accountId}::uuid, 'Digest shared workspace') returning id::text as id`;
    const workspaceId = workspace!.id as string;
    await database.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner')`;
    await database.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}::uuid, ${workspaceId}::uuid)`;
    const variableSet = await withSessionRlsActorContext({ subjectId }, () =>
      createVariableSet(client!.db, {
        accountId,
        workspaceId,
        subjectId,
        scope: "user",
        name: "Personal execution proof",
      }),
    );
    const taskId = crypto.randomUUID();
    await database.admin.begin(async (tx) => {
      await tx`select acquire_session_tenancy_fence(${workspaceId}::uuid)`;
      await tx`select set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${subjectId}, true),
        set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
      await tx`select issue_self_user_resource_grant(${accountId}::uuid, authority_id,
        ${workspaceId}::uuid, 'variable_set', 'always', 'workspace_shared', null, null, true)
        from workspace_variable_sets where id = ${variableSet.id}::uuid`;
      await tx`insert into scheduled_tasks (id, account_id, workspace_id, name, schedule, temporal_schedule_id,
        run_mode, overlap_policy, agent_config, created_by_kind, created_by_subject_id, owner_subject_id, variable_set_id)
        values (${taskId}::uuid, ${accountId}::uuid, ${workspaceId}::uuid, 'Before upgrade', '{"type":"manual"}',
          ${crypto.randomUUID()}, 'new_session_per_run', 'allow_concurrent',
          '{"prompt":"Run with the frozen personal resource","model":"scripted-model","resources":[],"tools":[],"metadata":{}}',
          'subject', ${subjectId}, ${subjectId}, ${variableSet.id}::uuid)`;
      await tx`select freeze_scheduled_task_personal_resources(${accountId}::uuid, ${workspaceId}::uuid, ${taskId}::uuid, 1)`;
      await tx`select record_scheduled_task_revision_authority(${accountId}::uuid, ${workspaceId}::uuid, ${taskId}::uuid, 1)`;
    });
    const [before] =
      await database.admin`select execution_digest, authority_revision from scheduled_tasks where id = ${taskId}::uuid`;
    await client.close();
    client = undefined;
    await database.admin`delete from schema_migrations where name in (${writer}, ${disconnect}, ${explicitRetry}, ${recovery})`;
    await migrate(database.adminUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
    client = createDb(appUrl.toString());
    for (const patch of [
      { name: "After upgrade" },
      { status: "paused" as const },
      { status: "active" as const },
    ]) {
      await withSessionRlsActorContext({ subjectId }, () =>
        updateScheduledTask(client!.db, workspaceId, taskId, patch),
      );
      const [after] =
        await database.admin`select execution_digest, authority_revision from scheduled_tasks where id = ${taskId}::uuid`;
      expect(after).toEqual(before);
    }
    const [computed] =
      await database.admin`select scheduled_task_execution_digest(task) as digest from scheduled_tasks task where id = ${taskId}::uuid`;
    expect(computed!.digest).toBe(before!.execution_digest);
    const scheduler = createScheduledTaskActivities(
      async () =>
        ({
          settings: testSettings({ databaseUrl: appUrl.toString(), sandboxBackend: "none" }),
          db: client!.db,
          bus: new MemoryEventBus(),
        }) as unknown as ActivityServices,
    );
    expect(
      await scheduler.dispatchScheduledTaskRun({
        workspaceId,
        taskId,
        triggerType: "scheduled",
        producerKey: crypto.randomUUID(),
      }),
    ).toMatchObject({ action: "start" });
  } finally {
    await client?.close();
    await owner.end();
    await database.release();
  }
}, 600_000);
