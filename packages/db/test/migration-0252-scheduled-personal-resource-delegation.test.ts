import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
} from "@opengeni/contracts";
import {
  captureScheduledTaskRestoreState,
  ScheduledTaskSyncError,
  syncUpdatedScheduledTask,
} from "@opengeni/core";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createDb,
  addSessionSystemUpdateWithSourceMutation,
  createScheduledTask,
  createScheduledTaskRun as createScheduledTaskRunRaw,
  createSession,
  bindScheduledTaskRunSessionInTransaction,
  getScheduledTask,
  getScheduledTaskRunAcceptedExecution,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTargetSessionExecution,
  getScheduledTaskRunPersonalResourceAuthority,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  materializeScheduledTaskReusableSessionFromRun,
  settleScheduledTaskRunInTransaction,
  updateScheduledTask,
} from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0252_scheduled_personal_resource_delegation.sql",
  import.meta.url,
);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const explicitAdminDatabaseUrl = process.env.OPENGENI_MIGRATION_0252_TEST_DATABASE_ADMIN_URL;

describe("migration 0252 scheduled personal-resource delegation", () => {
  test("freezes task authority and revalidates each occurrence and exact attempt", async () => {
    const source = await readFile(migrationUrl, "utf8");
    const executable = source.replace(/^--.*$/gmu, "");

    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('ADD COLUMN "authority_revision" bigint NOT NULL DEFAULT 1');
    expect(source).toContain('ADD COLUMN "execution_digest" text');
    expect(source).toContain('ADD COLUMN "task_authority_revision" bigint');
    expect(source).toContain('ADD COLUMN "task_execution_digest" text');
    expect(source).toContain('ADD COLUMN "scheduled_task_run_id" uuid');
    expect(source).toContain('CREATE TABLE "scheduled_task_personal_resource_authorities"');
    expect(source).toContain('CREATE TABLE "scheduled_task_personal_resource_snapshots"');
    expect(source).toContain('CREATE TABLE "scheduled_task_run_personal_resource_admissions"');
    expect(source).toContain('CREATE TABLE "scheduled_task_run_personal_resource_snapshots"');
    expect(source).toContain('CREATE TABLE "scheduled_task_run_personal_resource_once_receipts"');
    expect(executable.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(5);
    expect(executable.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(5);
    expect(executable.match(/SECURITY DEFINER/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(source).not.toContain("SET search_path FROM CURRENT");
    expect(executable.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(11);
    expect(executable.match(/SET search_path = pg_catalog, %1\$I, pg_temp/gu)).toHaveLength(11);
    expect(source).not.toContain("SET search_path = public");
    expect(source).toContain("CREATE OR REPLACE FUNCTION scheduled_task_execution_state");
    expect(source).toContain("SELECT pg_catalog.to_jsonb(p_task) - ARRAY[");
    for (const excluded of [
      "'name'",
      "'status'",
      "'updated_at'",
      "'authority_revision'",
      "'execution_digest'",
    ]) {
      expect(source).toContain(excluded);
    }
    expect(source).toContain("CREATE OR REPLACE FUNCTION scheduled_task_execution_digest");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION materialize_scheduled_task_reusable_session_from_run",
    );
    expect(source).toContain("scheduled personal-resource authority snapshot is no longer live");
    expect(source).toContain("scheduled personal-resource task has no authority snapshot");
    expect(source).toContain("clone_scheduled_task_personal_resource_authority");
    expect(source).toContain("scheduled personal-resource clone scope mismatch");
    const cloneBody = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION clone_scheduled_task_personal_resource_authority"),
      source.indexOf("$clone_scheduled_task_personal_resource_authority$;"),
    );
    expect(cloneBody.indexOf("scheduled personal-resource clone scope mismatch")).toBeLessThan(
      cloneBody.indexOf("INSERT INTO opengeni_private.scheduled_personal_resource_capabilities"),
    );
    const executionFenceBody = source.slice(
      source.indexOf(
        "CREATE OR REPLACE FUNCTION fence_scheduled_task_personal_resource_execution_update",
      ),
      source.indexOf("$fence_scheduled_task_personal_resource_execution_update$;"),
    );
    expect(executionFenceBody).toContain("pg_catalog.to_jsonb(NEW)");
    expect(executionFenceBody).toContain("pg_catalog.to_jsonb(OLD)");
    expect(executionFenceBody).not.toContain("scheduled_task_execution_state(");
    for (const excluded of [
      "'name'",
      "'status'",
      "'updated_at'",
      "'authority_revision'",
      "'execution_digest'",
    ]) {
      expect(executionFenceBody).toContain(excluded);
    }
    expect(source).toContain("CREATE TRIGGER scheduled_task_personal_resource_execution_revision");
    const runAdmissionBody = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION admit_scheduled_task_run_personal_resources"),
      source.indexOf("$admit_scheduled_task_run_personal_resources$;"),
    );
    expect(runAdmissionBody.indexOf("scheduled task is not active")).toBeGreaterThan(
      runAdmissionBody.indexOf("selected_personal_count = 0"),
    );
    expect(runAdmissionBody.indexOf("scheduled task is not active")).toBeLessThan(
      runAdmissionBody.indexOf("INSERT INTO scheduled_task_run_personal_resource_admissions"),
    );
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
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const schema = `scheduled_personal_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 40);
    const sql = postgres(blank.databaseUrl, { max: 2, prepare: false });
    try {
      await migrate(blank.databaseUrl, schema, {
        applicationDatabaseRoles: ["opengeni_app"],
      });
      const [installed] = await sql.unsafe<
        {
          taskColumn: boolean;
          taskDigestColumn: boolean;
          runRevisionColumn: boolean;
          runDigestColumn: boolean;
          updateColumn: boolean;
          freezeFunction: boolean;
          cloneFunction: boolean;
          materializeFunction: boolean;
          executionFenceFunction: boolean;
          hardenedSearchPaths: number;
          executionFenceTrigger: boolean;
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
            where table_schema = '${schema}' and table_name = 'scheduled_tasks'
              and column_name = 'execution_digest'
          ) as "taskDigestColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = '${schema}' and table_name = 'scheduled_task_runs'
              and column_name = 'task_authority_revision'
          ) as "runRevisionColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = '${schema}' and table_name = 'scheduled_task_runs'
              and column_name = 'task_execution_digest'
          ) as "runDigestColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = '${schema}' and table_name = 'session_system_updates'
              and column_name = 'scheduled_task_run_id'
          ) as "updateColumn",
          to_regprocedure('${schema}.freeze_scheduled_task_personal_resources(uuid,uuid,uuid,bigint)')
            is not null as "freezeFunction",
          to_regprocedure('${schema}.clone_scheduled_task_personal_resource_authority(uuid,uuid,uuid,bigint,bigint)')
            is not null as "cloneFunction",
          to_regprocedure('${schema}.materialize_scheduled_task_reusable_session_from_run(uuid,uuid,uuid,uuid,uuid,bigint,text)')
            is not null as "materializeFunction",
          to_regprocedure('${schema}.fence_scheduled_task_personal_resource_execution_update()')
            is not null as "executionFenceFunction",
          (
            select count(*)::int
            from pg_proc procedure
            join pg_namespace namespace_value on namespace_value.oid = procedure.pronamespace
            where namespace_value.nspname = '${schema}'
              and procedure.proname in (
                'freeze_scheduled_task_personal_resources',
                'clone_scheduled_task_personal_resource_authority',
                'materialize_scheduled_task_reusable_session_from_run',
                'scheduled_task_execution_state',
                'scheduled_task_execution_digest',
                'set_scheduled_task_execution_digest',
                'fence_scheduled_task_personal_resource_execution_update',
                'admit_scheduled_task_run_personal_resources',
                'prepare_scheduled_task_attempt_once_grants',
                'validate_scheduled_task_attempt_personal_resources',
                'scheduled_task_run_personal_resource_authority'
              )
              and procedure.proconfig = array[
                'search_path=pg_catalog, ${schema}, pg_temp'
              ]::text[]
          ) as "hardenedSearchPaths",
          exists (
            select 1 from pg_trigger trigger_value
            join pg_class table_value on table_value.oid = trigger_value.tgrelid
            join pg_namespace namespace_value on namespace_value.oid = table_value.relnamespace
            where namespace_value.nspname = '${schema}'
              and trigger_value.tgname = 'scheduled_task_personal_resource_execution_revision'
              and not trigger_value.tgisinternal
          ) as "executionFenceTrigger",
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
        taskDigestColumn: true,
        runRevisionColumn: true,
        runDigestColumn: true,
        updateColumn: true,
        freezeFunction: true,
        cloneFunction: true,
        materializeFunction: true,
        executionFenceFunction: true,
        hardenedSearchPaths: 6,
        executionFenceTrigger: true,
        runTrigger: true,
        attemptTrigger: true,
        forcedLedgers: 5,
      });
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("denies cross-scope app clones before capability elevation", async () => {
    const blank = await acquireMigrationTestDatabase("clone-scope-fence");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const task = await createPersonalScheduledTask(client.db, fixture, "clone scope fence");
      await admin`
        update scheduled_tasks set authority_revision = 2 where id = ${task.id}
      `;

      let scopeError: unknown;
      try {
        await admin.begin(async (tx) => {
          await tx.unsafe("set local role opengeni_app");
          await tx`select set_config('opengeni.account_id', ${crypto.randomUUID()}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
          await tx`
            select clone_scheduled_task_personal_resource_authority(
              ${fixture.accountId}::uuid,
              ${fixture.targetWorkspaceId}::uuid,
              ${task.id}::uuid,
              1::bigint,
              2::bigint
            )
          `;
        });
      } catch (error) {
        scopeError = error;
      }
      expect((scopeError as { code?: string } | undefined)?.code).toBe("42501");
      expect(await rejectedErrorChain(Promise.reject(scopeError))).toContain(
        "scheduled connection clone scope or revision mismatch",
      );
      const [ledger] = await admin<Array<{ targetHeaders: number; capabilities: number }>>`
        select
          (select count(*)::int from scheduled_task_personal_resource_authorities
            where task_id = ${task.id} and task_authority_revision = 2) as "targetHeaders",
          (select count(*)::int from opengeni_private.scheduled_personal_resource_capabilities)
            as capabilities
      `;
      expect(ledger).toEqual({ targetHeaders: 0, capabilities: 0 });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("resolves a cross-workspace personal Variable Set through the app-role authority seam", async () => {
    const blank = await acquireMigrationTestDatabase("app-role-cross-workspace-variable-set");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const [resolved] = await admin.begin(async (tx) => {
        await tx.unsafe("set local role opengeni_app");
        await tx`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${fixture.targetWorkspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', ${fixture.subjectId}, true)`;
        return await tx<Array<{ value: { id: string; workspaceId: string; generation: number } }>>`
          select value from list_scoped_variable_sets(
            ${fixture.accountId}::uuid,
            ${fixture.targetWorkspaceId}::uuid,
            ${fixture.variableSetId}::uuid,
            null,
            null
          ) value
        `;
      });
      expect(resolved?.value).toMatchObject({
        id: fixture.variableSetId,
        workspaceId: fixture.personalWorkspaceId,
        generation: 1,
      });
    } finally {
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("rejects new paused run history without creating authority evidence", async () => {
    const blank = await acquireMigrationTestDatabase("paused-non-personal-history");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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
        name: "paused non-personal history",
        status: "paused",
        schedule: { type: "manual" },
        temporalScheduleId: `scheduled-non-personal-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "history only", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: fixture.subjectId },
        metadata: {},
      });
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: task.id,
            ...executionBinding(task),
            triggerType: "manual",
            producerKey: "paused-non-personal-history",
          }),
        ),
      ).toContain("scheduled agent run task changed before producer admission");
      const [counts] = await admin<Array<{ runs: number; admissions: number; snapshots: number }>>`
        select
          (select count(*)::int from scheduled_task_runs
            where task_id = ${task.id}) as runs,
          (select count(*)::int from scheduled_task_run_personal_resource_admissions
            where task_id = ${task.id}) as admissions,
          (select count(*)::int from scheduled_task_run_personal_resource_snapshots
            where task_id = ${task.id}) as snapshots
      `;
      expect(counts).toEqual({ runs: 0, admissions: 0, snapshots: 0 });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("app clone ignores caller temporary authority relations", async () => {
    const blank = await acquireMigrationTestDatabase("clone-temp-shadow");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const task = await createPersonalScheduledTask(client.db, fixture, "clone temp shadow");
      await admin`
        update scheduled_tasks set authority_revision = 2 where id = ${task.id}
      `;

      const [result] = await admin.begin(async (tx) => {
        await tx.unsafe("set local role opengeni_app");
        await tx`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${fixture.targetWorkspaceId}, true)`;
        await tx.unsafe("create temporary table scheduled_tasks (trap text) on commit drop");
        await tx.unsafe(
          "create temporary table scheduled_task_personal_resource_authorities (trap text) on commit drop",
        );
        await tx.unsafe(
          "create temporary table scheduled_task_personal_resource_snapshots (trap text) on commit drop",
        );
        return await tx<Array<{ copied: number }>>`
          select clone_scheduled_task_personal_resource_authority(
            ${fixture.accountId}::uuid,
            ${fixture.targetWorkspaceId}::uuid,
            ${task.id}::uuid,
            1::bigint,
            2::bigint
          )::int as copied
        `;
      });
      expect(result).toEqual({ copied: 1 });
      const [cloned] = await admin<Array<{ headers: number; snapshots: number }>>`
        select
          (select count(*)::int from scheduled_task_personal_resource_authorities
            where task_id = ${task.id} and task_authority_revision = 2) as headers,
          (select count(*)::int from scheduled_task_personal_resource_snapshots
            where task_id = ${task.id} and task_authority_revision = 2) as snapshots
      `;
      expect(cloned).toEqual({ headers: 1, snapshots: 1 });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("legacy app execution updates cannot reuse another human's frozen authority", async () => {
    const blank = await acquireMigrationTestDatabase("legacy-execution-fence");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const task = await createPersonalScheduledTask(client.db, fixture, "legacy execution fence");

      const [adminOnly] = await admin.begin(async (tx) => {
        await setLegacyScheduledTaskWriterContext(tx, fixture, fixture.otherSubjectId);
        return await tx<Array<{ authorityRevision: number; executionDigest: string }>>`
          update scheduled_tasks
          set name = 'display-only legacy edit', updated_at = now()
          where id = ${task.id}
          returning authority_revision::int as "authorityRevision",
            execution_digest as "executionDigest"
        `;
      });
      expect(adminOnly).toEqual({ authorityRevision: 1, executionDigest: task.executionDigest });

      const changedConfig = {
        ...task.agentConfig,
        prompt: "human B changed instructions under human A authority",
      };
      const [legacyUpdate] = await admin.begin(async (tx) => {
        await setLegacyScheduledTaskWriterContext(tx, fixture, fixture.otherSubjectId);
        return await tx<Array<{ authorityRevision: number; executionDigest: string }>>`
          update scheduled_tasks
          set agent_config = ${JSON.stringify(changedConfig)}::text::jsonb, updated_at = now()
          where id = ${task.id}
          returning authority_revision::int as "authorityRevision",
            execution_digest as "executionDigest"
        `;
      });
      expect(legacyUpdate?.authorityRevision).toBe(2);
      expect(legacyUpdate?.executionDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(legacyUpdate?.executionDigest).not.toBe(task.executionDigest);

      const [fenced] = await admin<
        Array<{
          prompt: string;
          authorityRevision: number;
          revisionOneHeaders: number;
          revisionOneSubject: string | null;
          revisionOneSnapshots: number;
          revisionTwoHeaders: number;
          revisionTwoSnapshots: number;
        }>
      >`
        select task.agent_config->>'prompt' as prompt,
          task.authority_revision::int as "authorityRevision",
          (select count(*)::int from scheduled_task_personal_resource_authorities authority
            where authority.task_id = task.id and authority.task_authority_revision = 1)
            as "revisionOneHeaders",
          (select authority.initiating_human_subject_id
            from scheduled_task_personal_resource_authorities authority
            where authority.task_id = task.id and authority.task_authority_revision = 1)
            as "revisionOneSubject",
          (select count(*)::int from scheduled_task_personal_resource_snapshots snapshot
            where snapshot.task_id = task.id and snapshot.task_authority_revision = 1)
            as "revisionOneSnapshots",
          (select count(*)::int from scheduled_task_personal_resource_authorities authority
            where authority.task_id = task.id and authority.task_authority_revision = 2)
            as "revisionTwoHeaders",
          (select count(*)::int from scheduled_task_personal_resource_snapshots snapshot
            where snapshot.task_id = task.id and snapshot.task_authority_revision = 2)
            as "revisionTwoSnapshots"
        from scheduled_tasks task where task.id = ${task.id}
      `;
      expect(fenced).toEqual({
        prompt: changedConfig.prompt,
        authorityRevision: 2,
        revisionOneHeaders: 1,
        revisionOneSubject: fixture.subjectId,
        revisionOneSnapshots: 1,
        revisionTwoHeaders: 0,
        revisionTwoSnapshots: 0,
      });

      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: "scheduled-personal-legacy-execution-fence",
          }),
        ),
      ).toContain("scheduled task accepted execution binding changed");
      const [residue] = await admin<
        Array<{ runs: number; admissions: number; capabilities: number }>
      >`
        select
          (select count(*)::int from scheduled_task_runs run where run.task_id = ${task.id}) as runs,
          (select count(*)::int from scheduled_task_run_personal_resource_admissions admission
            where admission.task_id = ${task.id}) as admissions,
          (select count(*)::int from opengeni_private.scheduled_personal_resource_capabilities)
            as capabilities
      `;
      expect(residue).toEqual({ runs: 0, admissions: 0, capabilities: 0 });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("future scheduled-task columns are execution-affecting by default", async () => {
    const blank = await acquireMigrationTestDatabase("future-execution-column");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const task = await createPersonalScheduledTask(client.db, fixture, "future digest fence");
      await admin`alter table scheduled_tasks
        add column future_execution_behavior text not null default 'v1'`;

      const [changed] = await admin.begin(async (tx) => {
        await setLegacyScheduledTaskWriterContext(tx, fixture, fixture.otherSubjectId);
        return await tx<Array<{ authorityRevision: number; executionDigest: string }>>`
          update scheduled_tasks
          set future_execution_behavior = 'v2', updated_at = now()
          where id = ${task.id}
          returning authority_revision::int as "authorityRevision",
            execution_digest as "executionDigest"
        `;
      });
      expect(changed?.authorityRevision).toBe(task.authorityRevision + 1);
      expect(changed?.executionDigest).not.toBe(task.executionDigest);
      const [ledger] = await admin<Array<{ newHeaders: number }>>`
        select count(*)::int as "newHeaders"
        from scheduled_task_personal_resource_authorities
        where task_id = ${task.id} and task_authority_revision = ${task.authorityRevision + 1}
      `;
      expect(ledger).toEqual({ newHeaders: 0 });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("paused stale-worker run admission preserves an unconsumed once grant", async () => {
    const blank = await acquireMigrationTestDatabase("paused-once-run-fence");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
        );
      }
      return;
    }
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await migrate(blank.databaseUrl);
      const fixture = await createAuthorityFixture(admin);
      const { task } = await createOncePersonalScheduledTask(
        client.db,
        admin,
        fixture,
        "paused once run fence",
      );

      await admin.begin(async (tx) => {
        await setLegacyScheduledTaskWriterContext(tx, fixture, fixture.otherSubjectId);
        await tx`update scheduled_tasks set status = 'paused', updated_at = now()
          where id = ${task.id}`;
      });
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: task.id,
            ...executionBinding(task),
            triggerType: "scheduled",
            producerKey: "scheduled-personal-paused-stale-worker",
          }),
        ),
      ).toContain("scheduled agent run task changed before producer admission");

      const [state] = await admin<
        Array<{
          grantStatus: string;
          authorityRevision: number;
          runs: number;
          admissions: number;
          runSnapshots: number;
          scheduledReceipts: number;
          capabilities: number;
        }>
      >`
        select grant_value.status as "grantStatus",
          (select task.authority_revision::int from scheduled_tasks task where task.id = ${task.id})
            as "authorityRevision",
          (select count(*)::int from scheduled_task_runs run where run.task_id = ${task.id}) as runs,
          (select count(*)::int from scheduled_task_run_personal_resource_admissions admission
            where admission.task_id = ${task.id}) as admissions,
          (select count(*)::int from scheduled_task_run_personal_resource_snapshots snapshot
            where snapshot.task_id = ${task.id}) as "runSnapshots",
          (select count(*)::int from scheduled_task_run_personal_resource_once_receipts receipt
            where receipt.grant_id = grant_value.id) as "scheduledReceipts",
          (select count(*)::int from opengeni_private.scheduled_personal_resource_capabilities)
            as capabilities
        from organization_user_resource_grants grant_value
        where grant_value.id = ${fixture.grantId}
      `;
      expect(state).toEqual({
        grantStatus: "active",
        authorityRevision: 1,
        runs: 0,
        admissions: 0,
        runSnapshots: 0,
        scheduledReceipts: 0,
        capabilities: 0,
      });

      await admin`update scheduled_tasks set status = 'active', updated_at = now()
        where id = ${task.id}`;
      const resumedRun = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        ...executionBinding(task),
        triggerType: "scheduled",
        producerKey: "scheduled-personal-paused-resumed",
      });
      expect(resumedRun.taskAuthorityRevision).toBe(task.authorityRevision);
      expect(resumedRun.taskExecutionDigest).toBe(task.executionDigest);
      expect(await grantAndReceiptState(admin, fixture.grantId)).toMatchObject({
        status: "consumed",
        scheduledReceipts: 1,
      });
    } finally {
      await client.close().catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("pauses pre-migration personal tasks and rejects an old writer without a snapshot", async () => {
    const blank = await acquireMigrationTestDatabase("rolling-old-writer");
    if (!blank) return;
    const admin = postgres(blank.databaseUrl, { max: 2, prepare: false });
    const client = createDb(blank.databaseUrl, { max: 2 });
    try {
      await applyThrough0251(admin);
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
      ).toContain("scheduled task accepted execution binding changed");

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
      ).toContain("scheduled task accepted execution binding changed");
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
      if (!restored) throw new Error("restored scheduled task is missing");
      const restoredRun = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: createdByOtherHuman.id,
        ...executionBinding(restored),
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
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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
        ...executionBinding(task),
        triggerType: "scheduled",
        producerKey: "scheduled-personal-producer",
      });
      const replay = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        ...executionBinding(task),
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
        await createScheduledTaskRun(client.db, {
          workspaceId: fixture.targetWorkspaceId,
          taskId: task.id,
          ...executionBinding(task),
          triggerType: "scheduled",
          producerKey: "scheduled-personal-revoked",
        }),
      ).toMatchObject({
        status: "failed",
        error: "scheduled_run_authority_proof_rejected",
      });

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
        await createScheduledTaskRun(client.db, {
          workspaceId: fixture.targetWorkspaceId,
          taskId: task.id,
          ...executionBinding(task),
          triggerType: "scheduled",
          producerKey: "scheduled-personal-membership-lost",
        }),
      ).toMatchObject({
        status: "failed",
        error: "scheduled_run_authority_proof_rejected",
      });
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
      expect(
        await rejectedErrorChain(
          createScheduledTaskRun(client.db, {
            workspaceId: fixture.targetWorkspaceId,
            taskId: task.id,
            ...executionBinding(task),
            triggerType: "scheduled",
            producerKey: "scheduled-personal-stale-worker-binding",
          }),
        ),
      ).toContain("scheduled task accepted execution binding changed");
      const revisedRun = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        ...executionBinding(revised),
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

  test("rebinds only the admitted personal reusable-session occurrence", async () => {
    const blank = await acquireMigrationTestDatabase("reusable-session-rebind");
    if (!blank) {
      if (requireRealDatabase) {
        throw new Error(
          "[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
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
        name: "personal reusable materialization",
        status: "active",
        schedule: { type: "manual" },
        temporalScheduleId: `scheduled-personal-reusable-${crypto.randomUUID()}`,
        runMode: "reusable_session",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "reuse me", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: fixture.subjectId },
        variableSetId: fixture.variableSetId,
        metadata: {},
      });
      const run = await createScheduledTaskRun(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        ...executionBinding(task),
        triggerType: "scheduled",
        producerKey: "scheduled-personal-reusable-admitted",
      });
      const session = await createExactGeneratedSessionForRun(client.db, task, run);
      const nextRevision = await materializeScheduledTaskReusableSessionFromRun(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        taskId: task.id,
        runId: run.id,
        sessionId: session.id,
        sourceTaskAuthorityRevision: task.authorityRevision,
        sourceExecutionDigest: task.executionDigest,
      });
      expect(nextRevision).toBe(task.authorityRevision + 1);
      const reboundTask = await getScheduledTask(client.db, fixture.targetWorkspaceId, task.id);
      expect(reboundTask).toMatchObject({
        reusableSessionId: session.id,
        authorityRevision: nextRevision,
      });
      expect(reboundTask?.executionDigest).not.toBe(task.executionDigest);
      const reboundAuthority = await getScheduledTaskRunPersonalResourceAuthority(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        runId: run.id,
      });
      expect(reboundAuthority).toMatchObject({
        taskAuthorityRevision: nextRevision,
        executionDigest: reboundTask?.executionDigest,
      });
      expect(
        await materializeScheduledTaskReusableSessionFromRun(client.db, {
          accountId: fixture.accountId,
          workspaceId: fixture.targetWorkspaceId,
          taskId: task.id,
          runId: run.id,
          sessionId: session.id,
          sourceTaskAuthorityRevision: task.authorityRevision,
          sourceExecutionDigest: task.executionDigest,
        }),
      ).toBe(nextRevision);
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
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
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
        ...executionBinding(task),
        triggerType: "scheduled",
        producerKey: "scheduled-personal-once-run",
      });
      await bindScheduledTaskRunSessionInTransaction(client.db, {
        accountId: fixture.accountId,
        workspaceId: fixture.targetWorkspaceId,
        runId: run.id,
        sessionId: session.id,
      });
      expect(await grantAndReceiptState(admin, fixture.grantId)).toEqual({
        status: "consumed",
        scheduledReceipts: 1,
        attemptReceipts: 0,
        attemptId: null,
      });

      const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
        workspaceId: fixture.targetWorkspaceId,
        runId: run.id,
      });
      const targetExecution = accepted?.targetSessionExecution;
      if (!targetExecution) {
        throw new Error("scheduled once run is missing its target execution snapshot");
      }
      const turnId = crypto.randomUUID();
      const updateResult = await addSessionSystemUpdateWithSourceMutation(
        client.db,
        {
          accountId: fixture.accountId,
          workspaceId: fixture.targetWorkspaceId,
          sessionId: session.id,
          kind: "scheduled_occurrence",
          classification: "info",
          sourceId: run.id,
          dedupeKey: `scheduled-task-run:${run.id}`,
          summary: task.agentConfig.prompt,
          payload: {
            type: "scheduled_occurrence",
            text: task.agentConfig.prompt,
            scheduledTaskId: task.id,
            scheduledTaskRunId: run.id,
          },
          lineage: {
            scheduledTaskId: task.id,
            scheduledTaskRunId: run.id,
            causalHumanSubjectId: accepted.causalHumanSubjectId,
          },
          personalConnectionDelegations: accepted.personalConnectionDelegations,
          xaiProviderAccountAuthoritySnapshot: accepted.xaiProviderAccountAuthoritySnapshot,
          scheduledTaskRunId: run.id,
        },
        async (tx, wakeEventId) => {
          if (!wakeEventId) throw new Error("scheduled once update produced no wake event");
          await settleScheduledTaskRunInTransaction(tx, {
            workspaceId: fixture.targetWorkspaceId,
            runId: run.id,
            sessionId: session.id,
            triggerEventId: wakeEventId,
            status: "dispatched",
          });
        },
      );
      if (!updateResult.added) throw new Error("scheduled once update was not added");
      const updateId = updateResult.update.id;
      await admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${fixture.targetWorkspaceId}, true)`;
        await tx`
          insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, execution_generation, position, prompt,
          model, reasoning_effort, latency_mode, tools, sandbox_backend, sandbox_os,
          initiator_kind, initiator_subject_id, initiating_human_subject_id,
          personal_connection_delegations, xai_provider_account_authority_snapshot,
          scheduled_task_run_id
          ) values (
          ${turnId}, ${fixture.accountId}, ${fixture.targetWorkspaceId}, ${session.id},
          ${updateId}, 'scheduled-personal-once-workflow', 'running', 1, 1,
          ${task.agentConfig.prompt}, ${targetExecution.model},
          ${targetExecution.reasoningEffort},
          ${targetExecution.latencyMode},
          ${admin.json(targetExecution.tools)}::jsonb,
          ${targetExecution.sandboxBackend},
          ${targetExecution.sandboxOs},
          'service', 'scheduler', ${fixture.subjectId},
          ${admin.json(accepted.personalConnectionDelegations)}::jsonb,
          ${admin.json(accepted.xaiProviderAccountAuthoritySnapshot)}::jsonb,
          ${run.id}
          )
        `;
        const [history] = await tx<Array<{ id: string }>>`
          insert into session_history_items (
            account_id, workspace_id, session_id, turn_id, position, item
          ) values (
            ${fixture.accountId}, ${fixture.targetWorkspaceId}, ${session.id}, ${turnId},
            (
              select coalesce(max(item.position), -1) + 1
              from session_history_items item
              where item.workspace_id = ${fixture.targetWorkspaceId}
                and item.session_id = ${session.id}
            ),
            ${admin.json({
              type: "message",
              role: "user",
              content: task.agentConfig.prompt,
            })}::jsonb
          ) returning id
        `;
        if (!history) throw new Error("scheduled once delivery history was not created");
        await tx`
          update session_system_updates
          set state = 'delivered', delivered_turn_id = ${turnId},
            delivered_history_item_id = ${history.id}, delivered_at = now()
          where id = ${updateId}
        `;
      });
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

async function createPersonalScheduledTask(
  db: Parameters<typeof createScheduledTask>[0],
  fixture: Awaited<ReturnType<typeof createAuthorityFixture>>,
  name: string,
) {
  return await createScheduledTask(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.targetWorkspaceId,
    name,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-personal-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "exercise scheduled personal-resource authority",
      resources: [],
      tools: [],
      metadata: {},
    },
    createdBy: { kind: "subject", subjectId: fixture.subjectId },
    variableSetId: fixture.variableSetId,
    metadata: {},
  });
}

function executionBinding(task: { authorityRevision: number; executionDigest: string }) {
  return {
    taskAuthorityRevision: task.authorityRevision,
    taskExecutionDigest: task.executionDigest,
  };
}

async function createScheduledTaskRun(
  db: Parameters<typeof createScheduledTaskRunRaw>[0],
  input: Parameters<typeof createScheduledTaskRunRaw>[1],
) {
  if (input.acceptedExecutionSnapshot) {
    return await createScheduledTaskRunRaw(db, input);
  }
  const task = await getScheduledTask(db, input.workspaceId, input.taskId);
  if (!task) throw new Error(`Scheduled task not found: ${input.taskId}`);
  const runId = input.runId ?? crypto.randomUUID();
  const targetSessionId =
    task.status !== "active"
      ? null
      : task.runMode === "existing_session"
        ? task.targetSessionId
        : task.runMode === "reusable_session"
          ? task.reusableSessionId
          : null;
  const personalResourceAuthoritySubjectId = await getScheduledTaskPersonalResourceAuthoritySubject(
    db,
    {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    },
  );
  const targetSessionExecution = targetSessionId
    ? await getScheduledTargetSessionExecution(
        db,
        task.workspaceId,
        targetSessionId,
        personalResourceAuthoritySubjectId,
      )
    : null;
  const depthPolicy = targetSessionExecution ? null : await getNestedAgentDepthDeploymentPolicy(db);
  const causalHumanAuthority = await getScheduledTaskRevisionAuthority(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: task.authorityRevision,
  });
  return await createScheduledTaskRunRaw(db, {
    ...input,
    runId,
    acceptedExecutionSnapshot: {
      version: 1,
      task,
      resolvedModel: targetSessionExecution?.model ?? task.agentConfig.model ?? "test-model",
      resolvedReasoningEffort:
        targetSessionExecution?.reasoningEffort ?? task.agentConfig.reasoningEffort ?? "medium",
      resolvedLatencyMode: targetSessionExecution?.latencyMode ?? "standard",
      resolvedSandboxBackend:
        targetSessionExecution?.sandboxBackend ?? task.agentConfig.sandboxBackend ?? "modal",
      resolvedSandboxOs: targetSessionExecution?.sandboxOs ?? "linux",
      resolvedTools: targetSessionExecution?.tools ?? task.agentConfig.tools,
      resolvedFirstPartyMcpTools: targetSessionExecution?.firstPartyMcpTools ?? [
        ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
      ],
      resolvedFirstPartyMcpPermissions: targetSessionExecution?.firstPartyMcpPermissions ?? [
        ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
      ],
      resolvedVariableSet: task.variableSetId ? { id: task.variableSetId, generation: 1 } : null,
      resolvedRig:
        targetSessionExecution?.rigId && targetSessionExecution.rigVersionId
          ? {
              id: targetSessionExecution.rigId,
              versionId: targetSessionExecution.rigVersionId,
              defaultVariableSets: targetSessionExecution.rigDefaultVariableSets,
            }
          : null,
      resolvedSlackBotConnection: null,
      targetSessionExecution,
      generatedSessionBinding: depthPolicy
        ? {
            createIdempotencyKey: `migration-0252-run:${input.producerKey ?? runId}`,
            effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
            nestedAgentDepthPolicySource: depthPolicy.policySource,
            codexCompactionMode: "portable",
          }
        : null,
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId,
      causalHumanSubjectId:
        personalResourceAuthoritySubjectId ??
        causalHumanAuthority?.subjectId ??
        ((task.variableSetId || task.rigId) && task.createdBy.kind === "subject"
          ? task.createdBy.subjectId
          : null),
      causalHumanAuthority,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    },
  });
}

async function createExactGeneratedSessionForRun(
  db: Parameters<typeof createSession>[0],
  task: NonNullable<Awaited<ReturnType<typeof getScheduledTask>>>,
  run: Awaited<ReturnType<typeof createScheduledTaskRunRaw>>,
) {
  const accepted = await getScheduledTaskRunAcceptedExecution(db, {
    workspaceId: task.workspaceId,
    runId: run.id,
  });
  if (!accepted?.generatedSessionBinding) {
    throw new Error("scheduled generated run is missing its accepted binding");
  }
  return await createSession(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    initialMessage: task.agentConfig.prompt,
    resources: task.agentConfig.resources,
    tools: accepted.resolvedTools,
    firstPartyMcpTools: accepted.resolvedFirstPartyMcpTools,
    firstPartyMcpPermissions: accepted.resolvedFirstPartyMcpPermissions,
    metadata: {
      ...task.agentConfig.metadata,
      model: accepted.resolvedModel,
      reasoningEffort: accepted.resolvedReasoningEffort,
      scheduledTaskId: task.id,
      scheduledTaskRunMode: task.runMode,
      scheduledTaskRunId: run.id,
    },
    createdBy: {
      kind: "service",
      subjectId: "scheduler",
      label: "OpenGeni scheduler",
    },
    createdByContext: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
    model: accepted.resolvedModel,
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: accepted.resolvedSandboxBackend,
    sandboxOs: accepted.resolvedSandboxOs,
    variableSetId: accepted.resolvedVariableSet?.id ?? null,
    rigId: accepted.resolvedRig?.id ?? null,
    rigVersionId: accepted.resolvedRig?.versionId ?? null,
    personalConnectionDelegations: [],
    initialXaiProviderAccountAuthoritySnapshot: accepted.xaiProviderAccountAuthoritySnapshot,
    maxNestedAgentDepthOverride: task.agentConfig.maxNestedAgentDepth ?? null,
    frozenNestedAgentDepthPolicy: {
      effectiveMaxNestedAgentDepth: accepted.generatedSessionBinding.effectiveMaxNestedAgentDepth,
      nestedAgentDepthPolicySource: accepted.generatedSessionBinding.nestedAgentDepthPolicySource,
    },
    frozenCodexCompactionMode: accepted.generatedSessionBinding.codexCompactionMode,
    subjectId: `scheduled_task:${task.id}`,
    createIdempotencyKey: accepted.generatedSessionBinding.createIdempotencyKey,
    beforeCreateCommit: async (tx, sessionId) => {
      await bindScheduledTaskRunSessionInTransaction(tx, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        runId: run.id,
        sessionId,
      });
    },
  });
}

async function createOncePersonalScheduledTask(
  db: Parameters<typeof createScheduledTask>[0],
  sql: postgres.Sql,
  fixture: Awaited<ReturnType<typeof createAuthorityFixture>>,
  name: string,
) {
  const session = await createSession(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.targetWorkspaceId,
    initialMessage: `${name} target`,
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: fixture.subjectId },
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "modal",
    variableSetId: fixture.variableSetId,
    subjectId: fixture.subjectId,
  });
  const [sessionAuthority] = await sql<Array<{ authorityEpoch: number; visibility: string }>>`
    select authority_epoch as "authorityEpoch", visibility
    from sessions where id = ${session.id}
  `;
  if (!sessionAuthority) throw new Error("scheduled once target authority is missing");
  await sql`
    update organization_user_resource_grants
    set mode = 'once', session_id = ${session.id}, context = ${sessionAuthority.visibility},
      authority_epoch = ${sessionAuthority.authorityEpoch}, updated_at = now()
    where id = ${fixture.grantId}
  `;
  const task = await createScheduledTask(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.targetWorkspaceId,
    name,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-personal-once-${crypto.randomUUID()}`,
    runMode: "existing_session",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: name, resources: [], tools: [], metadata: {} },
    createdBy: { kind: "subject", subjectId: fixture.subjectId },
    targetSessionId: session.id,
    variableSetId: fixture.variableSetId,
    metadata: {},
  });
  return { task, session, sessionAuthority };
}

async function setLegacyScheduledTaskWriterContext(
  sql: postgres.Sql | postgres.TransactionSql,
  fixture: Awaited<ReturnType<typeof createAuthorityFixture>>,
  subjectId: string,
): Promise<void> {
  await sql.unsafe("set local role opengeni_app");
  await sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
  await sql`select set_config('opengeni.account_id', ${fixture.accountId}, true)`;
  await sql`select set_config('opengeni.workspace_id', ${fixture.targetWorkspaceId}, true)`;
  await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
  await sql`select set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
}

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
    await tx`select set_config('opengeni.account_id', ${input.fixture.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${input.fixture.targetWorkspaceId}, true)`;
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

async function applyThrough0251(admin: postgres.Sql): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file < "0252_")
    .sort();
  await admin.unsafe(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  for (const file of files) {
    await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
    await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
  }
}

async function acquireMigrationTestDatabase(label: string): Promise<BlankTestDatabase | null> {
  if (!explicitAdminDatabaseUrl) {
    const blank = await acquireBlankTestDatabase(`migration-0252-${label}`);
    if (!blank && requireRealDatabase) {
      throw new Error(
        `[migration-0252-scheduled-personal-resource-delegation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable for ${label}`,
      );
    }
    return blank;
  }

  const databaseName = `opengeni_0251_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${crypto
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
