import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0184_sandbox_drain_teardown_fence.sql",
);

describe("migration 0184 sandbox drain teardown fence", () => {
  test("is an online old/new-writer bridge around the exact drain capture claim", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain("'provider_deadline', 'operator', 'teardown_claim'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "archive_capture_operation_id" uuid');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "archive_capture_provider_request_id" uuid');
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "archive_capture_provider_replay_safe" boolean',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "archive_capture_attempt" integer');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "archive_capture_published_at" timestamptz');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "reaper_hold_id" uuid');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "reaper_hold_until" timestamptz');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "reaper_hold_reason" text');
    expect(sql).toContain('VALIDATE CONSTRAINT "sandbox_leases_reaper_hold_check"');
    expect(sql).toContain('BEFORE UPDATE OF "archive_capture_id", "liveness"');
    expect(sql).toContain("sandbox reaper hold blocks drain capture");
    expect(sql).toContain("sandbox reaper hold blocks cold commit");
    expect(sql).toContain("sandbox drain capture ownership blocks cold commit");
    expect(sql).toContain("current_setting('opengeni.sandbox_drain_capture_id', true)");
    expect(sql).toContain("OLD.archive_capture_id IS NULL");
    expect(sql).toContain("NEW.archive_capture_id IS NOT NULL");
    expect(sql).toContain("NEW.rotation_reason := 'teardown_claim'");
    expect(sql).toContain("NEW.archive_capture_operation_id := NEW.archive_capture_id");
    expect(sql).toContain("NEW.archive_capture_provider_request_id := NEW.archive_capture_id");
    expect(sql).toContain('"archive_capture_generation" IS NOT NULL');
    expect(sql).toContain('"archive_capture_provider_replay_safe" = false');
    expect(sql).toContain("\"backend\" = 'modal'");
    expect(sql).toContain("'{sessionState,providerState,workspacePersistence}'");
    expect(sql).toContain("= 'snapshot_filesystem'");
    expect(sql).toContain('"archive_capture_deadline_at" IS NOT NULL');
    expect(sql).toContain('"archive_capture_attempt" IS NOT NULL');
    expect(sql).toContain('"archive_capture_published_at" IS NULL');
    expect(sql).toContain("OR \"liveness\" = 'draining'");
    expect(sql).toContain('"rotation_reason" IS NOT NULL');
    expect(sql).toContain('VALIDATE CONSTRAINT "sandbox_leases_archive_capture_check"');
    expect(sql).toContain("WHERE \"liveness\" = 'draining'");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.request_due_sandbox_rotations(",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(",
    );
    expect(sql).toContain("lease.archive_capture_generation");
    expect(sql).toContain("= artifact.source_workspace_generation");
    expect(sql).toContain("Modal's request UUID and returned");
    expect(sql).not.toContain("lease.archive_capture_provider_request_id::text");
    expect(sql.match(/lease\.reaper_hold_until <= pg_catalog\.now\(\)/g)?.length).toBeGreaterThan(
      4,
    );
    expect(sql).not.toMatch(/ACCESS\s+EXCLUSIVE/i);
  });

  test("upgrades a live legacy claim and fences mixed-version teardown at the table boundary", async () => {
    const blank = await acquireBlankTestDatabase("migration-0184");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      // Let the canonical runner build the exact pre-0184 schema while marking
      // only this migration as already applied. Removing that marker then tests
      // the real runner/transaction path for 0184 against populated live state.
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      await sql`
        insert into schema_migrations (name)
        values
          ('0184_sandbox_drain_teardown_fence.sql'),
          ('0185_temporal_schedule_cleanup_outbox.sql'),
          ('0186_sandbox_capture_provider_contract.sql')`;
      await migrate(blank.databaseUrl);

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0184-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0184-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;
      const leaseId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      const legacyCaptureId = crypto.randomUUID();
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          workspace_generation, archive_generation, archive_capture_id,
          archive_capture_generation, archive_capture_started_at,
          archive_capture_deadline_at, resume_backend_id, resume_state, expires_at
        ) values (
          ${leaseId}, ${account!.id}, ${workspace!.id}, ${groupId}, 'draining', 0,
          0, 0, 'sb-migration-0184', 'modal', 7, 4, 3, ${legacyCaptureId},
          4, now() - interval '30 seconds', now() + interval '30 seconds',
          'modal',
          ${sql.json({
            backendId: "modal",
            sessionState: { providerState: { sandboxId: "sb-migration-0184" } },
          })},
          now() - interval '1 second'
        )`;

      await sql`
        delete from schema_migrations
        where name = '0184_sandbox_drain_teardown_fence.sql'`;
      await migrate(blank.databaseUrl);

      const [backfilled] = await sql<
        Array<{
          operationId: string;
          providerRequestId: string;
          providerReplaySafe: boolean;
          attempt: number;
          rotationReason: string;
        }>
      >`
        select
          archive_capture_operation_id as "operationId",
          archive_capture_provider_request_id as "providerRequestId",
          archive_capture_provider_replay_safe as "providerReplaySafe",
          archive_capture_attempt as attempt,
          rotation_reason as "rotationReason"
        from sandbox_leases where id = ${leaseId}`;
      expect(backfilled).toEqual({
        operationId: legacyCaptureId,
        providerRequestId: legacyCaptureId,
        providerReplaySafe: false,
        attempt: 1,
        rotationReason: "teardown_claim",
      });

      // An old publication clears only the fields it knows. The bridge clears
      // the new receipt atomically but deliberately retains rotation admission,
      // so old acquire paths still cannot re-arm the provider teardown window.
      await sql`
        update sandbox_leases set
          archive_capture_id = null,
          archive_capture_generation = null,
          archive_capture_started_at = null,
          archive_capture_deadline_at = null
        where id = ${leaseId}`;
      const [afterLegacyPublish] = await sql<
        Array<{
          operationId: string | null;
          providerRequestId: string | null;
          providerReplaySafe: boolean;
          attempt: number | null;
          rotationReason: string;
        }>
      >`
        select
          archive_capture_operation_id as "operationId",
          archive_capture_provider_request_id as "providerRequestId",
          archive_capture_provider_replay_safe as "providerReplaySafe",
          archive_capture_attempt as attempt,
          rotation_reason as "rotationReason"
        from sandbox_leases where id = ${leaseId}`;
      expect(afterLegacyPublish).toEqual({
        operationId: null,
        providerRequestId: null,
        providerReplaySafe: false,
        attempt: null,
        rotationReason: "teardown_claim",
      });

      const holdId = crypto.randomUUID();
      await sql`
        update sandbox_leases set
          reaper_hold_id = ${holdId},
          reaper_hold_until = now() + interval '1 minute',
          reaper_hold_reason = 'migration test'
        where id = ${leaseId}`;
      let heldCaptureError: unknown;
      try {
        await sql`
          update sandbox_leases set
            archive_capture_id = ${crypto.randomUUID()},
            archive_capture_generation = workspace_generation,
            archive_capture_started_at = now(),
            archive_capture_deadline_at = now() + interval '1 minute'
          where id = ${leaseId}`;
      } catch (error) {
        heldCaptureError = error;
      }
      expect(heldCaptureError).toMatchObject({ code: "55000" });
      await sql`
        update sandbox_leases set
          reaper_hold_id = null, reaper_hold_until = null, reaper_hold_reason = null
        where id = ${leaseId}`;

      const successorCaptureId = crypto.randomUUID();
      await sql`
        update sandbox_leases set
          archive_capture_id = ${successorCaptureId},
          archive_capture_generation = workspace_generation,
          archive_capture_started_at = now(),
          archive_capture_deadline_at = now() + interval '1 minute'
        where id = ${leaseId}`;

      // A pre-0184 cold writer carries no exact transaction-local receipt. It
      // cannot erase the successor claim even if it clears every visible field.
      let staleColdError: unknown;
      try {
        await sql`
          update sandbox_leases set
            liveness = 'cold', instance_id = null,
            archive_capture_id = null, archive_capture_generation = null,
            archive_capture_started_at = null, archive_capture_deadline_at = null,
            rotation_requested_at = null, rotation_reason = null
          where id = ${leaseId}`;
      } catch (error) {
        staleColdError = error;
      }
      expect(staleColdError).toMatchObject({ code: "55000" });
      const [stillOwned] = await sql<Array<{ liveness: string; captureId: string }>>`
        select liveness, archive_capture_id as "captureId"
        from sandbox_leases where id = ${leaseId}`;
      expect(stillOwned).toEqual({ liveness: "draining", captureId: successorCaptureId });

      // The exact new owner can atomically settle the same transition.
      await sql.begin(async (tx) => {
        await tx`
          select set_config(
            'opengeni.sandbox_drain_capture_id', ${successorCaptureId}, true
          )`;
        await tx`
          update sandbox_leases set
            liveness = 'cold', instance_id = null,
            archive_capture_id = null, archive_capture_generation = null,
            archive_capture_started_at = null, archive_capture_deadline_at = null,
            rotation_requested_at = null, rotation_reason = null
          where id = ${leaseId}`;
      });
      const [settled] = await sql<Array<{ liveness: string; captureId: string | null }>>`
        select liveness, archive_capture_id as "captureId"
        from sandbox_leases where id = ${leaseId}`;
      expect(settled).toEqual({ liveness: "cold", captureId: null });
    } finally {
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});
