import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration0108 = "0108_fence_invalidated_warming_epochs.sql";
const migration0117 = "0117_sandbox_recovery_generations.sql";
const appPassword = "apppw";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const explicitAdminDatabaseUrl = process.env.OPENGENI_MIGRATION_0117_TEST_DATABASE_ADMIN_URL;

let availabilityProbe: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  availabilityProbe = await acquireMigration0117TestDatabase("migration-0117-availability");
  if (!availabilityProbe) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0117] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await availabilityProbe?.release();
}, 180_000);

describe("0117 durable sandbox recovery generations (real PostgreSQL)", () => {
  test("cuts over atomically and enforces exact retained-process, PTY, reaper, generation, and RLS identity", async () => {
    await withBlankDatabase("migration-0117-public", async (admin, databaseUrl) => {
      await ensureAppRole(admin);
      await applyThrough(admin, migration0108);
      const scope = await seedScope(admin, "public");
      const leaseId = crypto.randomUUID();
      const legacyPtyId = crypto.randomUUID();
      await admin`
          insert into sandbox_leases (
            id, account_id, workspace_id, sandbox_group_id, liveness,
            instance_id, backend, lease_epoch, expires_at
          ) values (
            ${leaseId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
            'warm', 'provider-instance-public', 'modal', 7, now() + interval '1 hour'
          )`;
      await admin`
          insert into sandbox_pty_sessions (
            id, account_id, workspace_id, session_id, exec_session_id,
            lease_epoch, cols, rows, shell, cwd, opened_by
          ) values (
            ${legacyPtyId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
            41, 7, 80, 24, '/bin/bash', '/workspace', 'legacy-viewer'
          )`;

      const app = postgres(appUrl(databaseUrl), { max: 1, prepare: false });
      try {
        await app`select 1`;
        let liveGuardError: unknown;
        try {
          await applyFile(admin, migration0117);
        } catch (error) {
          liveGuardError = error;
        }
        expect(liveGuardError).toBeInstanceOf(Error);
        expect((liveGuardError as { code?: string }).code).toBe("55000");
        expect((liveGuardError as Error).message).toContain(
          "requires all opengeni_app sessions to be stopped",
        );

        const [rolledBack] = await admin<
          Array<{ admissions: string | null; workspaceGeneration: number }>
        >`
            select to_regclass('sandbox_workspace_mutation_admissions')::text as admissions,
              count(*)::integer as "workspaceGeneration"
            from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'sandbox_leases'
              and column_name = 'workspace_generation'`;
        expect(rolledBack).toEqual({ admissions: null, workspaceGeneration: 0 });
      } finally {
        await app.end();
      }

      await applyFile(admin, migration0117);

      const [legacyPty] = await admin<Array<{ status: string; closedAt: Date | null }>>`
          select status, closed_at as "closedAt"
          from sandbox_pty_sessions where id = ${legacyPtyId}`;
      expect(legacyPty?.status).toBe("closed");
      expect(legacyPty?.closedAt).toBeInstanceOf(Date);

      const constraints = await admin<Array<{ name: string }>>`
          select conname as name from pg_constraint
          where conname in (
            'sandbox_lease_holders_lease_scope_fk',
            'sandbox_workspace_mutation_admissions_lease_scope_fk',
            'sandbox_retained_processes_parent_admission_scope_fk',
            'sandbox_pty_sessions_retained_process_scope_fk',
            'sandbox_pty_sessions_open_identity_check'
          ) order by conname`;
      expect(constraints.map((row) => row.name)).toEqual([
        "sandbox_lease_holders_lease_scope_fk",
        "sandbox_pty_sessions_open_identity_check",
        "sandbox_pty_sessions_retained_process_scope_fk",
        "sandbox_retained_processes_parent_admission_scope_fk",
        "sandbox_workspace_mutation_admissions_lease_scope_fk",
      ]);

      const [rls] = await admin<Array<{ admissionsForced: boolean; processesForced: boolean }>>`
          select
            (select relforcerowsecurity from pg_class
              where oid = 'sandbox_workspace_mutation_admissions'::regclass)
              as "admissionsForced",
            (select relforcerowsecurity from pg_class
              where oid = 'sandbox_retained_processes'::regclass)
              as "processesForced"`;
      expect(rls).toEqual({ admissionsForced: true, processesForced: true });

      await expectAppTransactionError(
        databaseUrl,
        scope,
        async (tx) => {
          await tx`update sandbox_leases set updated_at = now() where id = ${leaseId}`;
        },
        "55000",
      );
      await withAppTransaction(databaseUrl, scope, true, async (tx) => {
        const updated = await tx`
            update sandbox_leases set updated_at = now()
            where id = ${leaseId} returning id`;
        expect(updated).toHaveLength(1);
      });

      const second = await seedScope(admin, "second");
      await expectSqlError(
        admin`
            insert into sandbox_lease_holders (
              account_id, workspace_id, lease_id, kind, holder_id, subject_id
            ) values (
              ${second.accountId}, ${scope.workspaceId}, ${leaseId},
              'viewer', 'cross-tenant-holder', ${scope.sessionId}
            )`,
        "sandbox_lease_holders_lease_scope_fk",
      );
      await expectSqlError(
        admin`update sandbox_leases set workspace_generation = -1 where id = ${leaseId}`,
        "sandbox_leases_workspace_generation_check",
      );
      await expectSqlError(
        admin`
            update sandbox_leases set workspace_generation = 1, archive_generation = 2
            where id = ${leaseId}`,
        "sandbox_leases_archive_generation_check",
      );

      const requestId = crypto.randomUUID();
      const processId = crypto.randomUUID();
      const admissionId = crypto.randomUUID();
      const ptyId = crypto.randomUUID();
      const directHolderId = `direct:${requestId}`;
      const processHolderId = `process:${processId}`;
      await admin.begin(async (tx) => {
        await tx`
            update sandbox_leases set workspace_generation = 1, archive_generation = 0,
              refcount = 2, updated_at = now()
            where id = ${leaseId}`;
        await tx`
            insert into sandbox_lease_holders (
              account_id, workspace_id, lease_id, kind, holder_id,
              subject_id, last_heartbeat_at
            ) values
              (${scope.accountId}, ${scope.workspaceId}, ${leaseId}, 'direct',
                ${directHolderId}, ${scope.sessionId}, now() - interval '1 hour'),
              (${scope.accountId}, ${scope.workspaceId}, ${leaseId}, 'process',
                ${processHolderId}, ${scope.sessionId}, now() - interval '1 hour')`;
        await tx`
            insert into sandbox_workspace_mutation_admissions (
              id, account_id, workspace_id, lease_id, sandbox_group_id, session_id,
              actor_kind, actor_id, holder_kind, holder_id, lease_epoch,
              provider_backend, provider_instance_id, route_kind, route_target_id,
              route_epoch, workspace_generation, operation, provider_outcome
            ) values (
              ${admissionId}, ${scope.accountId}, ${scope.workspaceId}, ${leaseId},
              ${scope.sessionId}, ${scope.sessionId}, 'direct', ${requestId},
              'direct', ${directHolderId}, 7, 'modal', 'provider-instance-public',
              'active', null, 0, 1, 'terminalExec', 'retained'
            )`;
        await tx`
            insert into sandbox_retained_processes (
              id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
              parent_admission_id, holder_id, owner_actor_kind, owner_actor_id,
              lease_epoch, provider_backend, provider_instance_id, route_kind,
              route_target_id, route_epoch, provider_session_id
            ) values (
              ${processId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
              ${leaseId}, ${scope.sessionId}, ${admissionId}, ${processHolderId},
              'direct', ${requestId}, 7, 'modal', 'provider-instance-public',
              'active', null, 0, 41
            )`;
        await tx`
            insert into sandbox_pty_sessions (
              id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
              retained_process_id, open_admission_id, exec_session_id, lease_epoch,
              provider_backend, provider_instance_id, route_kind, route_target_id,
              route_epoch, cols, rows, shell, cwd, opened_by
            ) values (
              ${ptyId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
              ${leaseId}, ${scope.sessionId}, ${processId}, ${admissionId}, 41, 7,
              'modal', 'provider-instance-public', 'active', null, 0,
              80, 24, '/bin/bash', '/workspace', 'viewer'
            )`;
      });

      await expectSqlError(
        admin`update sandbox_retained_processes set provider_session_id = 0
            where id = ${processId}`,
        "sandbox_retained_processes_identity_check",
      );
      await expectSqlError(
        admin`update sandbox_pty_sessions set provider_instance_id = 'wrong-instance'
            where id = ${ptyId}`,
        "open PTY does not match its exact retained process identity",
      );

      const reaperApp = postgres(appUrl(databaseUrl), { max: 1, prepare: false });
      try {
        await reaperApp`select * from opengeni_private.reap_sandbox_leases(1, 0, 1000)`;
        await reaperApp`select * from opengeni_private.reap_sandbox_leases(1, 0, 1000)`;
      } finally {
        await reaperApp.end();
      }
      const holdersAfterReap = await admin<Array<{ kind: string; holderId: string }>>`
          select kind, holder_id as "holderId" from sandbox_lease_holders
          where lease_id = ${leaseId} order by kind, holder_id`;
      expect(holdersAfterReap.map((row) => ({ ...row }))).toEqual([
        { kind: "process", holderId: processHolderId },
      ]);

      let terminalWithoutPtyClose: unknown;
      try {
        await admin.begin(async (tx) => {
          await tx`
              update sandbox_retained_processes set state = 'exited', exit_code = 0,
                settlement_reason = 'provider exited', settled_at = now()
              where id = ${processId}`;
          await tx`
              update sandbox_workspace_mutation_admissions set provider_outcome = 'resolved',
                settled_at = now() where id = ${admissionId}`;
          await tx`
              delete from sandbox_lease_holders
              where lease_id = ${leaseId} and kind = 'process'
                and holder_id = ${processHolderId}`;
        });
      } catch (error) {
        terminalWithoutPtyClose = error;
      }
      expect(terminalWithoutPtyClose).toBeInstanceOf(Error);
      expect((terminalWithoutPtyClose as Error).message).toContain(
        "retained process does not match its parent admission and holder state",
      );

      await admin.begin(async (tx) => {
        await tx`
            update sandbox_pty_sessions set status = 'closed', closed_at = now()
            where id = ${ptyId} and retained_process_id = ${processId}`;
        await tx`
            update sandbox_retained_processes set state = 'exited', exit_code = 0,
              settlement_reason = 'provider exited', settled_at = now()
            where id = ${processId}`;
        await tx`
            update sandbox_workspace_mutation_admissions set provider_outcome = 'resolved',
              settled_at = now() where id = ${admissionId}`;
        await tx`
            delete from sandbox_lease_holders
            where lease_id = ${leaseId} and kind = 'process'
              and holder_id = ${processHolderId}`;
      });
      const [terminal] = await admin<
        Array<{
          state: string;
          providerOutcome: string | null;
          ptyStatus: string;
          processHolders: number;
        }>
      >`
          select process.state,
            admission.provider_outcome as "providerOutcome",
            pty.status as "ptyStatus",
            (select count(*)::integer from sandbox_lease_holders holder
              where holder.lease_id = process.lease_id and holder.kind = 'process')
              as "processHolders"
          from sandbox_retained_processes process
          join sandbox_workspace_mutation_admissions admission
            on admission.id = process.parent_admission_id
          join sandbox_pty_sessions pty on pty.retained_process_id = process.id
          where process.id = ${processId}`;
      expect(terminal).toEqual({
        state: "exited",
        providerOutcome: "resolved",
        ptyStatus: "closed",
        processHolders: 0,
      });

      await withAppTransaction(databaseUrl, second, true, async (tx) => {
        const crossTenant = await tx`
            select id from sandbox_workspace_mutation_admissions where id = ${admissionId}`;
        expect(crossTenant).toHaveLength(0);
      });

      const exactArchiveLease = crypto.randomUUID();
      const staleArchiveLease = crypto.randomUUID();
      const archiveState = {
        backendId: "modal",
        sessionState: {
          workspaceArchive: "archive-current",
          workspaceArchiveMeta: { revision: "rev-current" },
        },
      };
      await admin`
          insert into sandbox_leases (
            id, account_id, workspace_id, sandbox_group_id, liveness, backend,
            lease_epoch, workspace_generation, archive_generation,
            resume_backend_id, resume_state, expires_at
          ) values
            (${exactArchiveLease}, ${scope.accountId}, ${scope.workspaceId},
              ${crypto.randomUUID()}, 'warming', 'modal', 11, 3, 3,
              'modal', ${admin.json(archiveState)}, now() - interval '1 hour'),
            (${staleArchiveLease}, ${scope.accountId}, ${scope.workspaceId},
              ${crypto.randomUUID()}, 'warming', 'modal', 15, 3, 2,
              'modal', ${admin.json(archiveState)}, now() - interval '1 hour')`;
      const warmingApp = postgres(appUrl(databaseUrl), { max: 1, prepare: false });
      try {
        await warmingApp`select * from opengeni_private.reap_sandbox_leases(1, 0, 1000)`;
      } finally {
        await warmingApp.end();
      }
      const warming = await admin<
        Array<{ id: string; liveness: string; leaseEpoch: number; resumeState: RecoveryState }>
      >`
          select id, liveness, lease_epoch as "leaseEpoch", resume_state as "resumeState"
          from sandbox_leases where id in (${exactArchiveLease}, ${staleArchiveLease})
          order by id`;
      const exact = warming.find((row) => row.id === exactArchiveLease)!;
      const stale = warming.find((row) => row.id === staleArchiveLease)!;
      expect(exact).toMatchObject({ liveness: "cold", leaseEpoch: 12 });
      expect(exact.resumeState.sessionState?.workspaceArchive).toBe("archive-current");
      expect(exact.resumeState.opengeniRecovery?.restore).toMatchObject({ status: "pending" });
      expect(stale).toMatchObject({ liveness: "cold", leaseEpoch: 16 });
      expect(stale.resumeState.opengeniRecovery?.restore).toMatchObject({
        status: "degraded",
        failureCode: "archive_generation_mismatch",
      });
    });
  }, 300_000);

  test("applies and grants the protocol in a dedicated data schema", async () => {
    await withBlankDatabase("migration-0117-dedicated", async (admin, databaseUrl) => {
      await ensureAppRole(admin);
      const schema = `sandbox_recovery_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await migrate(databaseUrl, schema);
      await provisionRoles(databaseUrl, {
        targetSchema: schema,
        rlsStrategy: "force",
        appRole: "opengeni_app",
        appPassword,
      });
      const [objects] = await admin<
        Array<{
          admissions: string | null;
          processes: string | null;
          publicAdmissions: string | null;
        }>
      >`
          select to_regclass(${`${schema}.sandbox_workspace_mutation_admissions`})::text
              as admissions,
            to_regclass(${`${schema}.sandbox_retained_processes`})::text as processes,
            to_regclass('public.sandbox_workspace_mutation_admissions')::text
              as "publicAdmissions"`;
      expect(objects).toEqual({
        admissions: `${schema}.sandbox_workspace_mutation_admissions`,
        processes: `${schema}.sandbox_retained_processes`,
        publicAdmissions: null,
      });

      const scope = await seedScope(admin, "dedicated", schema);
      const leaseId = crypto.randomUUID();
      await admin.unsafe(`set search_path = ${quoteIdentifier(schema)}, opengeni_private, public`);
      await admin`
          insert into sandbox_leases (
            id, account_id, workspace_id, sandbox_group_id, liveness,
            instance_id, backend, lease_epoch, expires_at
          ) values (
            ${leaseId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
            'warm', 'dedicated-provider', 'modal', 1, now() + interval '1 hour'
          )`;
      await withAppTransaction(databaseUrl, scope, true, async (tx) => {
        await tx.unsafe(
          `set local search_path = ${quoteIdentifier(schema)}, opengeni_private, public`,
        );
        const changed = await tx`
            update sandbox_leases set updated_at = now()
            where id = ${leaseId} returning id`;
        expect(changed).toHaveLength(1);
      });
    });
  }, 300_000);
});

type Scope = { accountId: string; workspaceId: string; sessionId: string };
type RecoveryState = {
  sessionState?: { workspaceArchive?: string };
  opengeniRecovery?: {
    restore?: { status?: string; failureCode?: string };
  };
};

async function withBlankDatabase(
  label: string,
  callback: (admin: postgres.Sql, databaseUrl: string) => Promise<void>,
): Promise<void> {
  if (!available) return;
  const blank = await acquireMigration0117TestDatabase(label);
  if (!blank) throw new Error(`[migration-0117] lost real PostgreSQL harness for ${label}`);
  const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
  try {
    await callback(admin, blank.databaseUrl);
  } finally {
    await admin.end();
    await blank.release();
  }
}

async function acquireMigration0117TestDatabase(label: string): Promise<BlankTestDatabase | null> {
  if (!explicitAdminDatabaseUrl) return acquireBlankTestDatabase(label);

  const databaseName = `opengeni_0117_${label.replaceAll(/[^a-zA-Z0-9]/g, "_")}_${crypto
    .randomUUID()
    .replaceAll("-", "")}`.slice(0, 63);
  const control = postgres(explicitAdminDatabaseUrl, { max: 1, prepare: false });
  try {
    await control.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    await control.end().catch(() => undefined);
    throw error;
  }

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
          where datname = ${databaseName} and pid <> pg_backend_pid()`;
        await control.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`);
      } finally {
        await control.end().catch(() => undefined);
      }
    },
  };
}

async function ensureAppRole(admin: postgres.Sql): Promise<void> {
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
        CREATE ROLE opengeni_app LOGIN PASSWORD '${appPassword}';
      END IF;
    END $$;
    ALTER ROLE opengeni_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}';
  `);
}

async function applyThrough(admin: postgres.Sql, through: string): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && file <= through)
    .sort();
  await admin.unsafe(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
  for (const file of files) {
    await applyFile(admin, file);
    await admin`
      insert into schema_migrations (name) values (${file})
      on conflict do nothing`;
  }
}

async function applyFile(admin: postgres.Sql, file: string): Promise<void> {
  await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

async function seedScope(admin: postgres.Sql, label: string, schema?: string): Promise<Scope> {
  if (schema) {
    await admin.unsafe(`set search_path = ${quoteIdentifier(schema)}, opengeni_private, public`);
  }
  const [account] = await admin<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`migration-0117-${label}-account`})
    returning id`;
  const [workspace] = await admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`migration-0117-${label}-workspace`}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const sessionId = crypto.randomUUID();
  await admin`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, tool_policy
    ) values (
      ${sessionId}, ${account!.id}, ${workspace!.id}, 'migration test',
      'scripted-model', 'modal', ${sessionId},
      jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
    )`;
  return { accountId: account!.id, workspaceId: workspace!.id, sessionId };
}

function appUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = "opengeni_app";
  url.password = appPassword;
  return url.toString();
}

async function withAppTransaction(
  databaseUrl: string,
  scope: Scope,
  marker: boolean,
  callback: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  const app = postgres(appUrl(databaseUrl), { max: 1, prepare: false });
  try {
    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${scope.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${scope.workspaceId}, true)`;
      if (marker) {
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
      }
      await callback(tx);
    });
  } finally {
    await app.end();
  }
}

async function expectAppTransactionError(
  databaseUrl: string,
  scope: Scope,
  callback: (tx: postgres.TransactionSql) => Promise<void>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await withAppTransaction(databaseUrl, scope, false, callback);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe(code);
}

async function expectSqlError(query: PromiseLike<unknown>, message: string): Promise<void> {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
