import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0186_sandbox_capture_provider_contract.sql";
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), `../drizzle/${migrationName}`);

describe("migration 0186 sandbox capture provider contract", () => {
  test("is rolling, provider-neutral, and makes dead-owner recovery immediate", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "archive_capture_takeover_safe" boolean');
    expect(sql).toContain(
      '"archive_capture_takeover_safe" = "archive_capture_provider_replay_safe"',
    );
    expect(sql).toContain("NEW.archive_capture_takeover_safe := false");
    expect(sql).toContain('OR "archive_capture_takeover_safe" = true');
    expect(sql).not.toContain("\"backend\" = 'modal'");
    expect(sql).toContain("attempt.state IN ('claimed', 'running')");
    expect(sql).toContain("OR lease.archive_capture_id IS NOT NULL");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(");
    expect(sql).not.toMatch(/ACCESS\s+EXCLUSIVE/i);
  });

  test("upgrades replay receipts and distinguishes old from policy-aware writers", async () => {
    const blank = await acquireBlankTestDatabase("migration-0186");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`insert into schema_migrations (name) values (${migrationName})`;
      await migrate(blank.databaseUrl);

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0186-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0186-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;

      const leaseId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      const replayCaptureId = crypto.randomUUID();
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          workspace_generation, archive_generation, archive_capture_id,
          archive_capture_operation_id, archive_capture_provider_request_id,
          archive_capture_provider_replay_safe, archive_capture_attempt,
          archive_capture_generation, archive_capture_started_at,
          archive_capture_deadline_at, resume_backend_id, resume_state, expires_at
        ) values (
          ${leaseId}, ${account!.id}, ${workspace!.id}, ${groupId}, 'draining', 0,
          0, 0, 'sb-migration-0186', 'modal', 7, 4, 3, ${replayCaptureId},
          ${replayCaptureId}, ${replayCaptureId}, true, 1, 4,
          now() - interval '1 second', now() + interval '1 minute', 'modal',
          ${sql.json({
            backendId: "modal",
            sessionState: {
              providerState: {
                sandboxId: "sb-migration-0186",
                workspacePersistence: "snapshot_filesystem",
              },
            },
          })},
          now() - interval '1 second'
        )`;

      await sql`delete from schema_migrations where name = ${migrationName}`;
      await migrate(blank.databaseUrl);

      const [upgraded] = await sql<Array<{ replaySafe: boolean; takeoverSafe: boolean }>>`
        select archive_capture_provider_replay_safe as "replaySafe",
          archive_capture_takeover_safe as "takeoverSafe"
        from sandbox_leases where id = ${leaseId}`;
      expect(upgraded).toEqual({ replaySafe: true, takeoverSafe: true });

      await sql`
        update sandbox_leases set
          archive_capture_id = null,
          archive_capture_generation = null,
          archive_capture_started_at = null,
          archive_capture_deadline_at = null
        where id = ${leaseId}`;
      const legacyCaptureId = crypto.randomUUID();
      await sql`
        update sandbox_leases set
          archive_capture_id = ${legacyCaptureId},
          archive_capture_generation = workspace_generation,
          archive_capture_started_at = now(),
          archive_capture_deadline_at = now() + interval '1 minute'
        where id = ${leaseId}`;
      const [legacy] = await sql<
        Array<{
          operationId: string;
          requestId: string;
          replaySafe: boolean;
          takeoverSafe: boolean;
          attempt: number;
        }>
      >`
        select archive_capture_operation_id as "operationId",
          archive_capture_provider_request_id as "requestId",
          archive_capture_provider_replay_safe as "replaySafe",
          archive_capture_takeover_safe as "takeoverSafe",
          archive_capture_attempt as attempt
        from sandbox_leases where id = ${leaseId}`;
      expect(legacy).toEqual({
        operationId: legacyCaptureId,
        requestId: legacyCaptureId,
        replaySafe: false,
        takeoverSafe: false,
        attempt: 1,
      });

      await sql`
        update sandbox_leases set
          archive_capture_id = null,
          archive_capture_generation = null,
          archive_capture_started_at = null,
          archive_capture_deadline_at = null
        where id = ${leaseId}`;
      const parallelCaptureId = crypto.randomUUID();
      const parallelOperationId = crypto.randomUUID();
      await sql`
        update sandbox_leases set
          archive_capture_id = ${parallelCaptureId},
          archive_capture_operation_id = ${parallelOperationId},
          archive_capture_provider_request_id = ${parallelOperationId},
          archive_capture_provider_replay_safe = false,
          archive_capture_takeover_safe = true,
          archive_capture_attempt = 2,
          archive_capture_generation = workspace_generation,
          archive_capture_started_at = now(),
          archive_capture_deadline_at = now() + interval '1 minute'
        where id = ${leaseId}`;
      const [parallel] = await sql<
        Array<{ replaySafe: boolean; takeoverSafe: boolean; attempt: number }>
      >`
        select archive_capture_provider_replay_safe as "replaySafe",
          archive_capture_takeover_safe as "takeoverSafe",
          archive_capture_attempt as attempt
        from sandbox_leases where id = ${leaseId}`;
      expect(parallel).toEqual({ replaySafe: false, takeoverSafe: true, attempt: 2 });
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
