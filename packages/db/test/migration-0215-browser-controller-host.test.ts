import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0215_browser_controller_host.sql", import.meta.url);

describe("migration 0215 browser controller host", () => {
  test("separates remote browser placement from browserd lease authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('ADD COLUMN "controller_host_sandbox_group_id" uuid');
    expect(source).toContain("browser.controller_host_sandbox_group_id = lease.sandbox_group_id");

    const blank = await acquireBlankTestDatabase("migration-0215-browser-controller-host");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const [column] = await sql<Array<{ nullable: string }>>`
        select is_nullable as nullable
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'browser_sessions'
          and column_name = 'controller_host_sandbox_group_id'`;
      expect(column).toEqual({ nullable: "YES" });

      const [constraint] = await sql<Array<{ definition: string }>>`
        select pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema()
          and rel.relname = 'browser_sessions'
          and con.conname = 'browser_sessions_controller_host_check'`;
      expect(constraint?.definition).toContain("external_provider");
      expect(constraint?.definition).toContain("controller_host_sandbox_group_id IS NOT NULL");

      const [reaper] = await sql<Array<{ definition: string }>>`
        select pg_get_functiondef('opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure) as definition`;
      expect(reaper?.definition).toContain(
        "browser.controller_host_sandbox_group_id = lease.sandbox_group_id",
      );
      expect(reaper?.definition).toContain("updated.interaction_workspace_id");

      const accountId = crypto.randomUUID();
      const workspaceId = crypto.randomUUID();
      const sandboxGroupId = crypto.randomUUID();
      const leaseId = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const browserSessionId = crypto.randomUUID();
      await sql.begin(async (tx) => {
        await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
        await tx`
          insert into managed_accounts (id, name)
          values (${accountId}, 'migration-0215-account')`;
        await tx`
          insert into workspaces (id, account_id, name)
          values (${workspaceId}, ${accountId}, 'migration-0215-workspace')`;
        await tx`
          insert into workspace_inference_controls (workspace_id, account_id)
          values (${workspaceId}, ${accountId})`;
        await tx`
          insert into sandbox_leases (
            id, account_id, workspace_id, sandbox_group_id, liveness,
            instance_id, backend, lease_epoch, expires_at
          ) values (
            ${leaseId}, ${accountId}, ${workspaceId}, ${sandboxGroupId}, 'warm',
            'migration-0215-instance', 'modal', 1, now() + interval '1 hour'
          )`;
        await tx`
          insert into interaction_operations (
            operation_id, account_id, workspace_id, resource_kind, resource_id,
            kind, request_digest, state, controller_generation, actor_subject_id,
            dispatched_at, settled_at
          ) values (
            ${operationId}, ${accountId}, ${workspaceId}, 'browser_session',
            ${browserSessionId}, 'create', ${"0".repeat(64)}, 'completed',
            'migration-0215-generation', 'migration-0215', now(), now()
          )`;
        await tx`
          insert into browser_sessions (
            id, account_id, workspace_id, name, lifecycle, placement_kind,
            sandbox_group_id, controller_host_sandbox_group_id, controller_id,
            controller_generation, placement_instance_id, driver_id, engine,
            headless, capabilities, create_operation_id, created_by_subject_id,
            controller_heartbeat_at
          ) values (
            ${browserSessionId}, ${accountId}, ${workspaceId}, 'Stale browser',
            'active', 'sandbox_group', ${sandboxGroupId}, ${sandboxGroupId},
            'opengeni-browserd', 'migration-0215-generation',
            'migration-0215-instance', 'chromium', 'chromium', true,
            '{}'::jsonb, ${operationId}, 'migration-0215', now() - interval '1 hour'
          )`;
        await tx`
          insert into workspace_interaction_revisions (workspace_id, account_id)
          values (${workspaceId}, ${accountId})`;
        await tx`
          insert into sandbox_lease_holders (
            account_id, workspace_id, lease_id, kind, holder_id,
            last_heartbeat_at
          ) values (
            ${accountId}, ${workspaceId}, ${leaseId}, 'interaction',
            ${`browser-session:${browserSessionId}`}, now() - interval '1 hour'
          )`;
      });

      await sql`
        select * from opengeni_private.reap_sandbox_leases(90000, 90000, 1, 900000)`;

      const [reaped] = await sql<
        Array<{ lifecycle: string; failureCode: string | null; holders: number; revision: string }>
      >`
        select browser.lifecycle, browser.failure_code as "failureCode",
          (select count(*)::integer from sandbox_lease_holders holder
            where holder.lease_id = ${leaseId}) as holders,
          revision.revision::text as revision
        from browser_sessions browser
        join workspace_interaction_revisions revision
          on revision.workspace_id = browser.workspace_id
        where browser.id = ${browserSessionId}`;
      expect(reaped).toEqual({
        lifecycle: "lost",
        failureCode: "controller_heartbeat_expired",
        holders: 0,
        revision: "1",
      });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
